'use strict';

/**
 * Modo Ultra Low-Latency — orquestrador.
 *
 * Responsabilidades que um "aplicar tweaks" simples NÃO tem, e que aqui são
 * obrigatórias porque estamos mexendo na rede de um jogador em tempo real:
 *
 *  1. BASELINE + MEDIÇÃO FINAL: mede latência/jitter/perda antes e depois e
 *     mostra o ganho real. Sem isso, tweak é placebo — não dá para provar nada.
 *
 *  2. GUARDA DE CONECTIVIDADE: logo após aplicar, valida gateway + internet.
 *     Se a rede caiu (driver Wi-Fi que derruba a conexão ao desativar autoconfig,
 *     MTU errado, DNS bloqueado), reverte TUDO automaticamente e avisa.
 *
 *  3. WATCHDOG: enquanto o modo está ativo, amostra a rede a cada N segundos.
 *     Perda consecutiva de conectividade dispara rollback automático.
 *
 *  4. CICLO DE VIDA: powerSaveBlocker (impede o Windows de suspender durante a
 *     partida), lock de sessão em disco e recuperação após crash/kill -9.
 *
 *  5. SHUTDOWN GARANTIDO: tweaks de sessão (autoconfig!) são revertidos ao
 *     fechar o app. Deixar autoconfig desativado permanentemente impediria o
 *     usuário de reconectar ao Wi-Fi — inaceitável.
 */

const ps = require('./psRunner');
const probe = require('./latencyProbe');
const netif = require('./netInterfaces');
const platform = require('./platform');
const elevation = require('./elevation');
const stateStore = require('./stateStore');
const registry = require('./tweakRegistry');
const logger = require('./logger');

const log = logger.scope('gamemode');

const DEFAULT_WATCHDOG_INTERVAL = 15000;
const MAX_CONSECUTIVE_FAILURES = 3;

let emitter = null;
let powerSaveBlocker = null;
let blockerId = null;

const state = {
  active: false,
  startedAt: null,
  stoppedAt: null,
  reason: null,
  tweakIds: [],
  appliedIds: [],
  failedIds: [],
  baseline: null,
  after: null,
  watchdog: {
    running: false,
    timer: null,
    intervalMs: DEFAULT_WATCHDOG_INTERVAL,
    consecutiveFailures: 0,
    lastCheckAt: null,
    lastResult: null,
    samples: [],
    alerts: [],
  },
  busy: false,
  lastError: null,
};

function configure(options = {}) {
  if (typeof options.emit === 'function') emitter = options.emit;
  if (options.powerSaveBlocker) powerSaveBlocker = options.powerSaveBlocker;
  if (options.watchdogIntervalMs) state.watchdog.intervalMs = options.watchdogIntervalMs;
}

function emit(event, payload) {
  if (!emitter) return;
  try {
    emitter(event, payload);
  } catch (err) {
    log.warn('Falha ao emitir evento', { event, err: err.message });
  }
}

function status() {
  return {
    active: state.active,
    busy: state.busy,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    reason: state.reason,
    tweakIds: state.tweakIds,
    appliedIds: state.appliedIds,
    failedIds: state.failedIds,
    baseline: state.baseline,
    after: state.after,
    improvement: computeImprovement(state.baseline, state.after),
    watchdog: {
      running: state.watchdog.running,
      intervalMs: state.watchdog.intervalMs,
      consecutiveFailures: state.watchdog.consecutiveFailures,
      lastCheckAt: state.watchdog.lastCheckAt,
      lastResult: state.watchdog.lastResult,
      samples: state.watchdog.samples.slice(-120),
      alerts: state.watchdog.alerts.slice(-20),
    },
    powerSaveBlocked: blockerId !== null,
    lastError: state.lastError,
    settings: stateStore.getSettings(),
  };
}

function computeImprovement(before, after) {
  if (!before || !after || !before.combined || !after.combined) return null;
  const b = before.combined;
  const a = after.combined;
  const delta = (field) =>
    b[field] !== null && a[field] !== null && Number.isFinite(b[field]) && Number.isFinite(a[field])
      ? Math.round((a[field] - b[field]) * 10) / 10
      : null;

  return {
    avg: { before: b.avg, after: a.avg, delta: delta('avg') },
    p95: { before: b.p95, after: a.p95, delta: delta('p95') },
    jitter: { before: b.jitter, after: a.jitter, delta: delta('jitter') },
    loss: { before: b.lossPercent, after: a.lossPercent, delta: delta('lossPercent') },
    spikes: { before: b.spikeCount, after: a.spikeCount, delta: (a.spikeCount || 0) - (b.spikeCount || 0) },
  };
}

/* ------------------------------------------------------------------ */
/* Benchmark de conectividade (baseline / verificação / after)         */
/* ------------------------------------------------------------------ */

async function benchmarkConnection(options = {}) {
  const snap = await netif.getSnapshot({ force: true });
  const gateway = snap.gateway;
  const rounds = options.rounds || 4;
  const internetHosts = options.hosts || ['1.1.1.1'];

  const jobs = [];

  if (gateway) {
    jobs.push(
      probe.icmpProbe(gateway, { count: rounds, timeoutMs: options.timeoutMs || 1500 }).then((r) => ({
        role: 'gateway',
        host: gateway,
        ...r,
      }))
    );
  }

  for (const host of internetHosts) {
    jobs.push(
      probe
        .probeHost(host, { rounds, timeoutMs: options.timeoutMs || 2000, method: 'auto' })
        .then((r) => ({ role: 'internet', ...r }))
    );
  }

  if (jobs.length === 0) {
    return { ok: false, error: 'Sem gateway nem alvos para medir.', combined: null, targets: [] };
  }

  const targets = await Promise.all(jobs);

  // Consolida tudo em uma estatística única (média ponderada simples por amostra).
  const allSamples = [];
  for (const t of targets) {
    const samples = t.samples || [];
    for (let i = 0; i < (t.count || samples.length); i++) {
      allSamples.push(samples[i] !== undefined ? samples[i] : null);
    }
  }

  const combined = probe.computeStats(allSamples);
  const internetTarget = targets.find((t) => t.role === 'internet');
  const gatewayTarget = targets.find((t) => t.role === 'gateway');

  return {
    ok: true,
    measuredAt: Date.now(),
    rounds,
    targets: targets.map((t) => ({
      role: t.role,
      host: t.host,
      method: t.method,
      avg: t.avg === null || t.avg === undefined ? null : Math.round(t.avg * 10) / 10,
      p95: t.p95 === null || t.p95 === undefined ? null : Math.round(t.p95 * 10) / 10,
      jitter: t.jitter === undefined ? null : Math.round(t.jitter * 10) / 10,
      lossPercent: t.lossPercent === undefined ? null : Math.round(t.lossPercent * 10) / 10,
      success: t.success,
      count: t.count,
      error: t.error || null,
    })),
    combined: {
      avg: combined.avg === null ? null : Math.round(combined.avg * 10) / 10,
      min: combined.min === null ? null : Math.round(combined.min * 10) / 10,
      max: combined.max === null ? null : Math.round(combined.max * 10) / 10,
      p95: combined.p95 === null ? null : Math.round(combined.p95 * 10) / 10,
      median: combined.median === null ? null : Math.round(combined.median * 10) / 10,
      jitter: Math.round(combined.jitter * 10) / 10,
      stddev: combined.stddev === null ? null : Math.round(combined.stddev * 10) / 10,
      lossPercent: Math.round(combined.lossPercent * 10) / 10,
      spikeCount: combined.spikeCount,
      success: combined.success,
      count: combined.count,
    },
    gatewayReachable: gatewayTarget ? gatewayTarget.success > 0 : null,
    internetReachable: internetTarget ? internetTarget.success > 0 : null,
  };
}

/** Verificação rápida de conectividade usada pela guarda e pelo watchdog. */
async function checkConnectivity(options = {}) {
  const bench = await benchmarkConnection({ rounds: options.rounds || 2, timeoutMs: options.timeoutMs || 1500, hosts: options.hosts || ['1.1.1.1'] });
  const gatewayOk = bench.gatewayReachable !== false;
  const internetOk = bench.internetReachable === true;

  return {
    ok: bench.ok,
    gatewayReachable: bench.gatewayReachable,
    internetReachable: bench.internetReachable,
    healthy: gatewayOk && internetOk,
    partiallyHealthy: gatewayOk && !internetOk,
    avg: bench.combined ? bench.combined.avg : null,
    jitter: bench.combined ? bench.combined.jitter : null,
    lossPercent: bench.combined ? bench.combined.lossPercent : null,
    measuredAt: Date.now(),
    detail: bench.targets,
  };
}

/* ------------------------------------------------------------------ */
/* Power save blocker                                                  */
/* ------------------------------------------------------------------ */

function startPowerSaveBlocker() {
  if (!powerSaveBlocker || blockerId !== null) return blockerId;
  try {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
    log.info('powerSaveBlocker ativado', { id: blockerId });
  } catch (err) {
    log.warn('Falha ao ativar powerSaveBlocker', { err: err.message });
    blockerId = null;
  }
  return blockerId;
}

function stopPowerSaveBlocker() {
  if (!powerSaveBlocker || blockerId === null) return;
  try {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
  } catch (err) {
    log.warn('Falha ao desativar powerSaveBlocker', { err: err.message });
  }
  blockerId = null;
}

/* ------------------------------------------------------------------ */
/* Watchdog                                                            */
/* ------------------------------------------------------------------ */

function startWatchdog() {
  const settings = stateStore.getSettings();
  if (settings.watchdogEnabled === false) {
    log.info('Watchdog desativado pelas configurações');
    return;
  }

  stopWatchdog();
  state.watchdog.running = true;
  state.watchdog.intervalMs = settings.watchdogIntervalMs || DEFAULT_WATCHDOG_INTERVAL;
  state.watchdog.consecutiveFailures = 0;

  const tick = async () => {
    if (!state.active || state.busy) return;

    let check;
    try {
      check = await checkConnectivity();
    } catch (err) {
      log.warn('Watchdog: erro ao medir', { err: err.message });
      return;
    }

    state.watchdog.lastCheckAt = Date.now();
    state.watchdog.lastResult = check;
    state.watchdog.samples.push({
      ts: Date.now(),
      avg: check.avg,
      jitter: check.jitter,
      loss: check.lossPercent,
      gateway: check.gatewayReachable,
      internet: check.internetReachable,
    });
    state.watchdog.samples = state.watchdog.samples.slice(-240);

    emit('gamemode-metrics', { status: status() });

    if (check.healthy) {
      state.watchdog.consecutiveFailures = 0;
      return;
    }

    state.watchdog.consecutiveFailures += 1;
    log.warn('Watchdog: conectividade degradada', {
      failures: state.watchdog.consecutiveFailures,
      gateway: check.gatewayReachable,
      internet: check.internetReachable,
    });

    if (state.watchdog.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const alert = {
        ts: Date.now(),
        type: 'connectivity-lost',
        message:
          'Conectividade perdida com o Modo Ultra Low-Latency ativo. Revertendo ajustes de sessão automaticamente.',
        check,
      };
      state.watchdog.alerts.push(alert);
      emit('gamemode-alert', { alert, status: status() });
      await stop({ reason: 'watchdog-connectivity-loss', auto: true });
    } else {
      emit('gamemode-alert', {
        alert: {
          ts: Date.now(),
          type: 'degraded',
          message: `Conectividade instável (${state.watchdog.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}).`,
          check,
        },
        status: status(),
      });
    }
  };

  state.watchdog.timer = setInterval(() => {
    tick().catch((err) => log.error('Watchdog tick falhou', { err: err.message }));
  }, state.watchdog.intervalMs);

  if (state.watchdog.timer && typeof state.watchdog.timer.unref === 'function') {
    state.watchdog.timer.unref();
  }
}

function stopWatchdog() {
  if (state.watchdog.timer) {
    clearInterval(state.watchdog.timer);
    state.watchdog.timer = null;
  }
  state.watchdog.running = false;
  state.watchdog.consecutiveFailures = 0;
}

/* ------------------------------------------------------------------ */
/* Start / Stop                                                        */
/* ------------------------------------------------------------------ */

async function start(options = {}) {
  if (state.busy) {
    return { success: false, code: 'BUSY', message: 'Uma operação do Modo Jogo já está em andamento.' };
  }
  if (state.active) {
    return { success: true, code: 'ALREADY_ACTIVE', message: 'O Modo Ultra Low-Latency já está ativo.', status: status() };
  }
  if (!ps.isWindows()) {
    return {
      success: false,
      code: 'UNSUPPORTED_PLATFORM',
      message: 'O Modo Ultra Low-Latency aplica ajustes do Windows e não pode ser ativado nesta plataforma.',
    };
  }

  state.busy = true;
  emit('gamemode-state', { status: { ...status(), busy: true, phase: 'starting' } });

  try {
    const preset = options.preset || 'ultra';
    const tweakIds = options.tweakIds ? registry.presetIds(options.tweakIds) : registry.presetIds(preset);

    if (tweakIds.length === 0) {
      return { success: false, code: 'NO_TWEAKS', message: 'Nenhum ajuste selecionado.' };
    }

    const admin = await elevation.isAdmin();
    const allowPrompt = options.allowPrompt !== false;

    if (!admin && !allowPrompt) {
      return {
        success: false,
        code: 'ELEVATION_REQUIRED',
        message: 'Sem privilégios de Administrador e com prompts UAC desativados — nada foi aplicado.',
      };
    }

    state.tweakIds = tweakIds;
    state.startedAt = Date.now();
    state.reason = 'user';

    // 1) Baseline ANTES de mexer em qualquer coisa.
    emit('gamemode-progress', { phase: 'baseline', message: 'Medindo latência atual (baseline)...' });
    let baseline = null;
    if (options.skipBaseline !== true) {
      try {
        baseline = await benchmarkConnection({ rounds: options.baselineRounds || 4 });
      } catch (err) {
        log.warn('Baseline falhou', { err: err.message });
      }
    }
    state.baseline = baseline;

    // 2) Aplica na ordem segura.
    emit('gamemode-progress', { phase: 'apply', message: `Aplicando ${tweakIds.length} ajustes...` });
    const applied = await registry.applyMany(tweakIds, {
      by: 'gamemode',
      allowPrompt,
      stopOnFatal: true,
      onProgress: (p) =>
        emit('gamemode-progress', {
          phase: 'apply',
          message: `Aplicando: ${p.id} (${p.index}/${p.total})`,
          progress: p,
        }),
    });

    state.appliedIds = applied.applied || [];
    state.failedIds = (applied.failed || []).map((f) => f.id);

    // Se a aplicação já detectou perda de conectividade, reverte tudo.
    const connectivityFatal = (applied.results || []).some((r) => r.code === 'CONNECTIVITY_LOST');

    // 3) Guarda de conectividade pós-aplicação.
    emit('gamemode-progress', { phase: 'guard', message: 'Validando conectividade...' });
    const guard = connectivityFatal ? { healthy: false, reason: 'connectivity-lost-during-apply' } : await checkConnectivity({ rounds: 3 });

    if (!guard.healthy && !guard.partiallyHealthy) {
      log.error('Guarda de conectividade falhou — revertendo tudo', { guard });
      emit('gamemode-progress', { phase: 'rollback', message: 'Rede caiu após os ajustes. Revertendo automaticamente...' });

      const rollback = await registry.revertMany(applied.applied || [], { by: 'gamemode-guard', allowPrompt });
      stopPowerSaveBlocker();
      stateStore.clearSessionLock();

      state.active = false;
      state.busy = false;
      state.lastError = {
        code: 'CONNECTIVITY_GUARD_FAILED',
        message:
          'A conectividade foi perdida ao aplicar os ajustes. Tudo foi revertido automaticamente. ' +
          'Provável causa: driver Wi-Fi incompatível com a pausa de varredura, ou MTU/DNS incorreto.',
        guard,
      };

      const payload = {
        success: false,
        code: 'CONNECTIVITY_GUARD_FAILED',
        message: state.lastError.message,
        applied: applied.applied,
        failed: applied.failed,
        rollback,
        baseline,
        guard,
        status: status(),
      };
      emit('gamemode-state', { status: status(), result: payload });
      return payload;
    }

    // 4) Modo ativo: lock + blocker + watchdog.
    state.active = true;
    state.busy = false;
    state.lastError = null;
    stateStore.writeSessionLock({
      mode: 'ultra',
      tweakIds,
      appliedIds: state.appliedIds,
      baseline: baseline ? baseline.combined : null,
    });
    startPowerSaveBlocker();
    startWatchdog();
    stateStore.updateSettings({ lastGameMode: { startedAt: state.startedAt, tweakIds } });

    // 5) Medição final (dá tempo dos ajustes assentarem).
    let after = null;
    if (options.skipBaseline !== true) {
      emit('gamemode-progress', { phase: 'measure', message: 'Medindo latência com os ajustes ativos...' });
      await ps.sleep(options.settleMs || 2500);
      try {
        after = await benchmarkConnection({ rounds: options.baselineRounds || 4 });
        state.after = after;
      } catch (err) {
        log.warn('Medição pós-aplicação falhou', { err: err.message });
      }
    }

    if (baseline && after) {
      stateStore.pushBenchmark({ phase: 'gamemode-start', before: baseline.combined, after: after.combined });
    }

    const result = {
      success: true,
      code: applied.code,
      active: true,
      message:
        applied.failed && applied.failed.length
          ? `Modo Ultra Low-Latency ativo com ${applied.applied.length} ajuste(s); ${applied.failed.length} não puderam ser aplicados.`
          : `Modo Ultra Low-Latency ATIVO — ${applied.applied.length} ajustes aplicados.`,
      applied: applied.results,
      failed: applied.failed,
      baseline,
      after,
      improvement: computeImprovement(baseline, after),
      guard: guard.healthy ? guard : { ...guard, warning: 'Internet inalcançável no teste, mas gateway respondeu. Modo mantido.' },
      requiresReboot: applied.requiresReboot,
      status: status(),
    };

    emit('gamemode-state', { status: status(), result });
    return result;
  } catch (err) {
    state.busy = false;
    log.error('start() lançou exceção', { err: err.message, stack: err.stack });
    const payload = {
      success: false,
      code: 'EXCEPTION',
      message: `Falha inesperada ao ativar o modo: ${err.message}`,
      status: status(),
    };
    emit('gamemode-state', { status: status(), result: payload });
    return payload;
  }
}

async function stop(options = {}) {
  if (state.busy && !options.force) {
    return { success: false, code: 'BUSY', message: 'Uma operação está em andamento.' };
  }

  const wasActive = state.active;
  state.busy = true;
  stopWatchdog();

  emit('gamemode-state', { status: { ...status(), busy: true, phase: 'stopping' } });

  try {
    // O que reverter: tudo que o modo aplicou + qualquer tweak de sessão pendurado.
    const sessionTweaks = registry.ALL_TWEAKS.filter((t) => t.scope === 'session').map((t) => t.id);
    const recorded = stateStore.appliedIds();
    const targets = [...new Set([...(state.appliedIds.length ? state.appliedIds : recorded), ...sessionTweaks])].filter(
      (id) => registry.byId(id)
    );

    let revertResult = { success: true, code: 'NOTHING', results: [], message: 'Nada a reverter.' };

    if (options.restore === false) {
      // Usuário pediu para MANTER os ajustes (ex.: "aplicar e não reverter").
      revertResult = {
        success: true,
        code: 'KEPT',
        results: [],
        message: 'Ajustes mantidos no sistema (reversão manual disponível na aba de tweaks).',
      };
    } else if (targets.length > 0) {
      emit('gamemode-progress', { phase: 'revert', message: `Revertendo ${targets.length} ajuste(s)...` });
      revertResult = await registry.revertMany(targets, {
        by: options.auto ? 'gamemode-auto' : 'gamemode',
        allowPrompt: options.allowPrompt !== false,
        onProgress: (p) =>
          emit('gamemode-progress', {
            phase: 'revert',
            message: `Revertendo: ${p.id} (${p.index}/${p.total})`,
            progress: p,
          }),
      });
    }

    stopPowerSaveBlocker();
    stateStore.clearSessionLock();

    state.active = false;
    state.busy = false;
    state.stoppedAt = Date.now();
    state.reason = options.reason || 'user';
    state.appliedIds = [];
    state.failedIds = [];
    state.watchdog.samples = [];

    const result = {
      success: revertResult.success !== false,
      code: revertResult.code,
      active: false,
      message: wasActive
        ? `Modo Ultra Low-Latency desativado. ${revertResult.message || ''}`.trim()
        : 'Modo já estava desativado.',
      reverted: revertResult.results || [],
      failures: (revertResult.results || []).filter((r) => !r.success),
      reason: state.reason,
      status: status(),
    };

    emit('gamemode-state', { status: status(), result });
    return result;
  } catch (err) {
    state.busy = false;
    log.error('stop() lançou exceção', { err: err.message, stack: err.stack });
    return { success: false, code: 'EXCEPTION', message: `Falha ao desativar: ${err.message}`, status: status() };
  }
}

async function toggle(options = {}) {
  return state.active ? stop(options) : start(options);
}

/* ------------------------------------------------------------------ */
/* Recuperação e shutdown                                              */
/* ------------------------------------------------------------------ */

/**
 * Chamado no boot: se houver lock de uma sessão anterior que morreu
 * (crash, kill -9, queda de energia), restaura o sistema.
 */
async function recoverFromCrash(options = {}) {
  const stale = stateStore.detectStaleSession();
  if (!stale) return { recovered: false, reason: null };

  log.warn('Sessão anterior não encerrou corretamente — restaurando ajustes de sessão', {
    pid: stale.pid,
    reason: stale.reason,
  });

  const sessionTweaks = registry.ALL_TWEAKS.filter((t) => t.scope === 'session').map((t) => t.id);
  const applied = Array.isArray(stale.appliedIds) ? stale.appliedIds : [];
  const targets = [...new Set([...sessionTweaks, ...applied])].filter((id) => registry.byId(id));

  stateStore.clearSessionLock();

  if (targets.length === 0) return { recovered: true, reason: stale.reason, restored: [] };

  const res = await registry.revertMany(targets, { by: 'crash-recovery', allowPrompt: options.allowPrompt !== false });

  return {
    recovered: true,
    reason: stale.reason,
    lock: stale,
    restored: res.results || [],
    success: res.success,
    message:
      'O willLag foi encerrado de forma inesperada na última execução. ' +
      `Os ajustes temporários (${targets.length}) foram restaurados automaticamente.`,
  };
}

/**
 * Shutdown garantido. Usado em before-quit (com preventDefault) e em
 * sinais de término. Nunca lança.
 */
async function shutdown(options = {}) {
  stopWatchdog();

  const needsRestore =
    state.active ||
    registry.ALL_TWEAKS.some((t) => t.scope === 'session' && stateStore.hasBackup(t.id)) ||
    stateStore.readSessionLock() !== null;

  if (!needsRestore) {
    stopPowerSaveBlocker();
    stateStore.flush();
    return { restored: false };
  }

  log.info('Shutdown: restaurando ajustes de sessão');

  try {
    const res = await stop({ reason: 'app-quit', allowPrompt: options.allowPrompt === true, force: true });
    return { restored: true, result: res };
  } catch (err) {
    log.error('Shutdown: falha ao restaurar', { err: err.message });
    return { restored: false, error: err.message };
  } finally {
    stopPowerSaveBlocker();
    stateStore.clearSessionLock();
    stateStore.flush();
  }
}

module.exports = {
  configure,
  status,
  start,
  stop,
  toggle,
  benchmarkConnection,
  checkConnectivity,
  computeImprovement,
  recoverFromCrash,
  shutdown,
  startWatchdog,
  stopWatchdog,
  startPowerSaveBlocker,
  stopPowerSaveBlocker,
  MAX_CONSECUTIVE_FAILURES,
};
