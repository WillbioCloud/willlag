'use strict';

/**
 * Descoberta e ajuste de MTU da interface ativa.
 *
 * Por que isso importa para jogo online:
 *   Tráfego de jogo é UDP. Quando um datagrama UDP excede o MTU do caminho, ele
 *   é fragmentado em IP. Fragmentação é tóxica para UDP de jogo porque:
 *     - se UM fragmento se perde, o datagrama INTEIRO é descartado na recepção
 *       (perda amplificada: 1 pacote perdido de 3 = 100% da mensagem do jogo);
 *     - muitos roteadores/NATs limitam ou despriorizam fragmentos;
 *     - alguns firewalls simplesmente descartam fragmentos UDP.
 *   Ajustar o MTU para o valor real do caminho evita fragmentar.
 *
 * Método: busca binária com o bit "Don't Fragment" ligado (`ping -f -l <tamanho>`),
 * que é a técnica padrão (mesma do mtu-path discovery). MTU = payload + 28
 * (20 bytes de cabeçalho IP + 8 de ICMP).
 */

const ps = require('./psRunner');
const netif = require('./netInterfaces');
const stateStore = require('./stateStore');
const logger = require('./logger');

const log = logger.scope('mtu');

const IP_ICMP_OVERHEAD = 28;
const MIN_PAYLOAD = 548; // MTU 576 (mínimo exigido por RFC 791)
const MAX_PAYLOAD = 1472; // MTU 1500 (Ethernet padrão)
const MAX_STEPS = 14;

/** Alvos padrão de teste. */
const DEFAULT_TARGETS = {
  internet: ['1.1.1.1', '8.8.8.8'],
};

/* ------------------------------------------------------------------ */
/* Busca binária (pura — testável com probe injetado)                  */
/* ------------------------------------------------------------------ */

/**
 * Encontra o maior payload que passa sem fragmentação.
 * `probe(payload)` deve retornar true quando NÃO há necessidade de fragmentação.
 *
 * Assume predicado monotônico (se X passa, tudo menor que X passa). Quando a
 * monotonicidade é violada (perda aleatória), reportamos `noisy` para a UI
 * não confiar cegamente no resultado.
 */
async function searchMaxPayload(probe, options = {}) {
  const min = options.minPayload !== undefined ? options.minPayload : MIN_PAYLOAD;
  const max = options.maxPayload !== undefined ? options.maxPayload : MAX_PAYLOAD;
  const maxSteps = options.maxSteps || MAX_STEPS;
  const onStep = options.onStep;

  const trace = [];
  let steps = 0;

  const call = async (payload) => {
    steps += 1;
    let ok = false;
    let detail = null;
    try {
      const r = await probe(payload);
      ok = Boolean(r && r.success);
      detail = r || null;
    } catch (err) {
      ok = false;
      detail = { success: false, error: err.message };
    }
    trace.push({ payload, ok, reason: detail ? detail.reason : null });
    if (onStep) onStep({ payload, ok, step: steps });
    return ok;
  };

  if (max <= min) return { payload: null, mtu: null, steps, trace, error: 'INVALID_RANGE' };

  // Otimização: se o máximo já passa, não há o que buscar.
  if (await call(max)) {
    return { payload: max, mtu: max + IP_ICMP_OVERHEAD, steps, trace, conclusive: true, noisy: false };
  }

  // Se o mínimo falha, o alvo está inalcançável/bloqueando ICMP.
  const minOk = await call(min);
  if (!minOk) {
    return {
      payload: null,
      mtu: null,
      steps,
      trace,
      conclusive: false,
      error: 'MIN_FAILED',
      message: 'Nem o menor pacote passou com DF ligado — o alvo está bloqueando ICMP ou está inalcançável.',
    };
  }

  let lo = min;
  let hi = max - 1;
  let best = min;

  while (lo <= hi && steps < maxSteps) {
    const mid = Math.floor((lo + hi) / 2);
    const ok = await call(mid);
    if (ok) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const noisy = trace.length > 3 && hasMonotonicityViolation(trace);

  return {
    payload: best,
    mtu: best + IP_ICMP_OVERHEAD,
    steps,
    trace,
    conclusive: true,
    noisy,
    hitStepLimit: steps >= maxSteps,
  };
}

/** Detecta violação de monotonicidade (tamanho menor falhando após maior passar). */
function hasMonotonicityViolation(trace) {
  let maxOk = -1;
  for (const t of trace) {
    if (t.ok) maxOk = Math.max(maxOk, t.payload);
  }
  return trace.some((t) => !t.ok && t.payload < maxOk);
}

/* ------------------------------------------------------------------ */
/* Probe real via ping do sistema                                      */
/* ------------------------------------------------------------------ */

function makePingProbe(host, options = {}) {
  return async (payload) => {
    const res = await ps.runPing(host, {
      count: options.count || 1,
      timeoutMs: options.timeoutMs || 2000,
      dontFragment: true,
      size: payload,
    });

    if (res.code === 'INVALID_HOST') {
      return { success: false, reason: 'INVALID_HOST', payload };
    }

    if (res.needsFragmentation) {
      return { success: false, reason: 'FRAGMENTATION_NEEDED', payload };
    }

    const rtts = require('./latencyProbe').parsePingRtts(res.output);
    if (rtts.length > 0) {
      return { success: true, reason: 'OK', payload, rtt: rtts[0] };
    }

    // Sem resposta e sem erro de fragmentação: inconclusivo (host pode
    // descartar pacotes grandes silenciosamente). Tratamos como falha.
    return { success: false, reason: 'NO_REPLY', payload };
  };
}

/* ------------------------------------------------------------------ */
/* Estado atual                                                        */
/* ------------------------------------------------------------------ */

async function getCurrentMtu(ifIndex, family = 'IPv4') {
  const snap = await netif.getSnapshot({ force: true });
  const target = ifIndex
    ? snap.ipInterfaces.find((i) => i.ifIndex === Number(ifIndex))
    : snap.ipInterfaces.find((i) => snap.activeAdapter && i.ifIndex === snap.activeAdapter.ifIndex);

  if (!target) return { ok: false, mtu: null, error: 'Interface não encontrada.' };
  return {
    ok: true,
    mtu: target.mtu,
    ifIndex: target.ifIndex,
    alias: target.alias,
    dhcp: target.dhcp,
    family,
  };
}

/* ------------------------------------------------------------------ */
/* Descoberta completa                                                 */
/* ------------------------------------------------------------------ */

/**
 * Descobre o MTU ideal testando gateway (MTU do enlace local) e um alvo
 * na internet (path MTU, que inclui PPPoE/VPN/túneis).
 */
async function discover(options = {}) {
  const snap = await netif.getSnapshot({ force: true });
  const adapter = options.ifIndex
    ? snap.adapters.find((a) => a.ifIndex === Number(options.ifIndex))
    : snap.activeAdapter;

  if (!adapter) {
    return { ok: false, error: 'Nenhuma interface de rede ativa encontrada.' };
  }

  const gateway = snap.gateway || (adapter.gateway || null);
  const internetTargets = options.targets || DEFAULT_TARGETS.internet;
  const onStep = options.onStep;

  const results = {
    ok: true,
    adapter: {
      name: adapter.name,
      description: adapter.description,
      ifIndex: adapter.ifIndex,
      isWifi: adapter.isWifi,
      isUsb: adapter.isUsb,
      linkSpeed: adapter.linkSpeed,
    },
    currentMtu: adapter.mtu || null,
    gateway: gateway ? { target: gateway } : null,
    internet: [],
    startedAt: Date.now(),
  };

  // --- Enlace local (gateway) ---
  if (gateway) {
    const r = await searchMaxPayload(makePingProbe(gateway, { timeoutMs: options.timeoutMs || 1500 }), { onStep });
    results.gateway = {
      target: gateway,
      payload: r.payload,
      mtu: r.mtu,
      steps: r.steps,
      conclusive: r.conclusive,
      noisy: r.noisy,
      error: r.error || null,
      trace: r.trace,
    };
  }

  // --- Path MTU (internet) ---
  for (const host of internetTargets) {
    if (!ps.isSafeHost(host)) continue;
    const r = await searchMaxPayload(makePingProbe(host, { timeoutMs: options.timeoutMs || 2000 }), { onStep });
    results.internet.push({
      target: host,
      payload: r.payload,
      mtu: r.mtu,
      steps: r.steps,
      conclusive: r.conclusive,
      noisy: r.noisy,
      error: r.error || null,
      trace: r.trace,
    });
    // Se o primeiro alvo respondeu de forma conclusiva, não precisamos do segundo.
    if (r.conclusive && !r.error) break;
  }

  // --- Recomendação ---
  const candidates = [];
  if (results.gateway && results.gateway.mtu) candidates.push({ mtu: results.gateway.mtu, source: 'gateway' });
  for (const i of results.internet) {
    if (i.mtu) candidates.push({ mtu: i.mtu, source: `internet:${i.target}` });
  }

  if (candidates.length === 0) {
    results.recommendation = {
      mtu: null,
      action: 'inconclusive',
      message:
        'Não foi possível medir o MTU (ICMP provavelmente bloqueado no caminho). ' +
        'Nada será alterado. Se você suspeita de fragmentação, teste com o roteador permitindo ICMP.',
    };
    return results;
  }

  const pathMtu = Math.min(...candidates.map((c) => c.mtu));
  const source = candidates.find((c) => c.mtu === pathMtu);
  const current = results.currentMtu;

  let action = 'keep';
  let message = '';

  if (current === null) {
    action = 'unknown';
    message = 'MTU atual não pôde ser lido; recomendação calculada mas não aplicada automaticamente.';
  } else if (pathMtu === current) {
    action = 'ok';
    message = `MTU atual (${current}) já é o ideal para este caminho. Nada a alterar.`;
  } else if (pathMtu < current) {
    action = 'reduce';
    message =
      `MTU atual ${current} é MAIOR que o do caminho (${pathMtu}). Pacotes acima de ${pathMtu} bytes ` +
      'estão sendo fragmentados — ou descartados silenciosamente. Reduzir elimina fragmentação UDP.';
  } else {
    action = 'raise';
    message =
      `O caminho suporta ${pathMtu} mas a interface está em ${current}. Aumentar dá um pouco mais de ` +
      'payload por pacote (menos overhead), mas só vale se TODOS os caminhos suportarem — na dúvida, mantenha.';
  }

  results.recommendation = {
    mtu: pathMtu,
    payload: pathMtu - IP_ICMP_OVERHEAD,
    source: source.source,
    current,
    action,
    message,
    isPppoe: pathMtu === 1492,
    isVpnLike: pathMtu < 1450,
    note:
      pathMtu === 1492
        ? '1492 é o MTU típico de PPPoE (8 bytes de overhead do protocolo).'
        : pathMtu < 1450
          ? 'Valor abaixo de 1450 indica túnel (VPN, hotspot celular, CGNAT com encapsulamento).'
          : pathMtu === 1500
            ? '1500 é o Ethernet padrão.'
            : null,
  };

  results.finishedAt = Date.now();
  return results;
}

/* ------------------------------------------------------------------ */
/* Aplicação / reversão                                                */
/* ------------------------------------------------------------------ */

function isValidMtu(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 576 && n <= 9000;
}

async function applyMtu(mtu, ctx, options = {}) {
  if (!isValidMtu(mtu)) {
    return { success: false, code: 'INVALID_MTU', error: `MTU inválido: ${mtu} (use 576 a 9000).` };
  }

  const snap = await netif.getSnapshot({ force: true });
  const adapter = options.ifIndex
    ? snap.adapters.find((a) => a.ifIndex === Number(options.ifIndex))
    : snap.activeAdapter;

  if (!adapter) return { success: false, code: 'NO_INTERFACE', error: 'Nenhuma interface ativa.' };

  const current = await getCurrentMtu(adapter.ifIndex);
  const previous = current.ok ? current.mtu : null;

  if (previous === Number(mtu)) {
    return {
      success: true,
      code: 'ALREADY_SET',
      applied: true,
      mtu: Number(mtu),
      message: `MTU da interface "${adapter.name}" já é ${mtu}.`,
    };
  }

  if (previous) {
    stateStore.pushBackup(
      options.tweakId || 'mtuOptimize',
      [{ kind: 'mtu', ifIndex: adapter.ifIndex, mtu: previous, family: 'IPv4' }],
      { adapter: adapter.name, previous }
    );
  } else {
    stateStore.pushBackup(
      options.tweakId || 'mtuOptimize',
      [{ kind: 'mtu', ifIndex: adapter.ifIndex, mtu: 1500, family: 'IPv4' }],
      { adapter: adapter.name, note: 'anterior desconhecido; assumido 1500 (Ethernet padrão)' }
    );
  }

  const body = `
$ifIndex = ${ps.psNumber(adapter.ifIndex)}
$mtu = ${ps.psNumber(mtu)}
$out = & netsh interface ipv4 set subinterface $ifIndex mtu=$mtu store=persistent 2>&1 | Out-String
$ok = -not ($out -match 'incorreto|incorrect|denied|negado|failed|falha|não foi')
$check = (Get-NetIPInterface -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).NlMtu
Write-WillLagJson @{ ok = $ok; output = $out.Trim(); effective = $check }
`;

  const res = await ps.ensureElevated(body, {
    label: 'mtu:apply',
    isAdmin: ctx.isAdmin,
    allowPrompt: ctx.allowPrompt,
    timeout: 40000,
  });

  netif.invalidate();

  if (!res.success) {
    stateStore.consumeBackup(options.tweakId || 'mtuOptimize');
    return { success: false, code: res.code, applied: false, error: res.error, message: res.error };
  }

  if (res.data && res.data.ok === false) {
    stateStore.consumeBackup(options.tweakId || 'mtuOptimize');
    return {
      success: false,
      code: 'NETSH_FAILED',
      applied: false,
      error: res.data.output || 'netsh recusou o novo MTU.',
      message: `Não foi possível aplicar MTU ${mtu}: ${res.data.output || 'erro desconhecido'}`,
    };
  }

  stateStore.markApplied(options.tweakId || 'mtuOptimize', {
    scope: 'persistent',
    params: { mtu: Number(mtu), ifIndex: adapter.ifIndex },
  });
  stateStore.updateSettings({ mtu: Number(mtu) });

  return {
    success: true,
    code: 'OK',
    applied: true,
    mtu: Number(res.data && res.data.effective ? res.data.effective : mtu),
    previous,
    interface: adapter.name,
    message: `MTU definido como ${mtu} em "${adapter.name}"${previous ? ` (antes: ${previous})` : ''}. Fragmentação UDP eliminada neste caminho.`,
    note: 'Se você usa VPN, o MTU ideal pode mudar enquanto ela estiver ativa. Rode a detecção novamente.',
  };
}

async function restoreMtu(ctx, options = {}) {
  const layer = stateStore.peekBackup(options.tweakId || 'mtuOptimize');
  if (!layer || !layer.entries || layer.entries.length === 0) {
    return { success: true, code: 'NO_BACKUP', applied: false, message: 'Nenhum backup de MTU encontrado.' };
  }

  const res = await require('./restoreEngine').restoreEntries(layer.entries, {
    isAdmin: ctx.isAdmin,
    allowPrompt: ctx.allowPrompt,
  });

  if (res.success || res.code === 'PARTIAL') {
    stateStore.consumeBackup(options.tweakId || 'mtuOptimize');
    stateStore.markReverted(options.tweakId || 'mtuOptimize');
    netif.invalidate();
  }
  return { ...res, applied: false };
}

/* ------------------------------------------------------------------ */
/* Tweak do catálogo                                                   */
/* ------------------------------------------------------------------ */

const mtuTweak = {
  id: 'mtuOptimize',
  group: 'routing',
  label: 'MTU ideal (evitar fragmentação UDP)',
  description:
    'Descobre o MTU real do caminho com ping DF e ajusta a interface ativa para não fragmentar pacotes de jogo.',
  why:
    'Datagrama UDP fragmentado: se um único fragmento se perde, o jogo descarta a mensagem inteira. ' +
    'Em PPPoE (1492) ou túneis de VPN, deixar o MTU em 1500 significa que TODO pacote grande é ' +
    'fragmentado — e a perda de pacotes percebida pelo jogo sobe mesmo com enlace saudável.',
  risk: 'medium',
  requiresAdmin: true,
  scope: 'persistent',
  defaultInPreset: false, // exige medição; entra no preset só se o usuário marcar
  needsDiscovery: true,

  async detect(ctx) {
    if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };
    const snap = await netif.getSnapshot();
    const adapter = snap.activeAdapter;
    if (!adapter) return { ok: true, supported: false, applied: false, reason: 'Sem interface ativa.' };

    const current = await getCurrentMtu(adapter.ifIndex);
    const stored = stateStore.getSetting('mtu', null);

    return {
      ok: true,
      supported: true,
      applied: Boolean(stored && Number(stored) === Number(current.mtu)),
      interface: adapter.name,
      current: current.mtu ? `${current.mtu} bytes` : 'desconhecido',
      target: stored ? `${stored} bytes (medido)` : 'a medir (clique em "Detectar MTU")',
      needsDiscovery: !stored,
    };
  },

  async apply(ctx) {
    const requested = ctx.params && ctx.params.mtu;

    let mtu = requested ? Number(requested) : null;
    let discovery = null;

    if (!mtu) {
      discovery = await discover({ onStep: ctx.onProgress, timeoutMs: 1800 });
      if (!discovery.ok) {
        return { success: false, code: 'DISCOVERY_FAILED', applied: false, message: discovery.error };
      }
      const rec = discovery.recommendation;
      if (!rec || !rec.mtu) {
        return {
          success: false,
          code: 'INCONCLUSIVE',
          applied: false,
          message: rec ? rec.message : 'Não foi possível determinar o MTU do caminho.',
          discovery,
        };
      }
      if (rec.action === 'ok') {
        return {
          success: true,
          code: 'ALREADY_OPTIMAL',
          applied: false,
          message: rec.message,
          discovery,
          mtu: rec.mtu,
        };
      }
      if (rec.action === 'raise') {
        // Não aumentamos sozinhos: pode fragmentar em outros caminhos.
        return {
          success: true,
          code: 'KEEP',
          applied: false,
          message: rec.message + ' Mantendo o valor atual por segurança.',
          discovery,
          mtu: rec.current,
        };
      }
      mtu = rec.mtu;
    }

    const res = await applyMtu(mtu, ctx, { tweakId: 'mtuOptimize' });
    if (res.success && discovery) res.discovery = discovery;
    return res;
  },

  async revert(ctx) {
    return restoreMtu(ctx, { tweakId: 'mtuOptimize' });
  },
};

module.exports = {
  IP_ICMP_OVERHEAD,
  MIN_PAYLOAD,
  MAX_PAYLOAD,
  tweaks: [mtuTweak],
  searchMaxPayload,
  hasMonotonicityViolation,
  makePingProbe,
  getCurrentMtu,
  discover,
  applyMtu,
  restoreMtu,
  isValidMtu,
};
