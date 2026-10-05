'use strict';

/**
 * Catálogo central de tweaks.
 *
 * Cada tweak é declarativo:
 *   { id, group, label, description, why, risk, requiresAdmin, scope,
 *     defaultInPreset, options, detect(ctx), apply(ctx), revert(ctx) }
 *
 * O renderer NUNCA hard-coda a lista: ele pede o catálogo via IPC e desenha.
 * Assim adicionar um tweak novo no main process aparece automaticamente na UI.
 *
 * `scope`:
 *   'persistent' -> fica aplicado até o usuário reverter (com backup).
 *   'session'    -> vive apenas enquanto o Modo Ultra Low-Latency está ativo;
 *                   é revertido ao desativar/fechar o app (e recuperado após crash).
 */

const ps = require('./psRunner');
const platform = require('./platform');
const elevation = require('./elevation');
const netif = require('./netInterfaces');
const stateStore = require('./stateStore');
const tcpip = require('./tcpip');
const wifi = require('./wifi');
const dnsService = require('./dnsService');
const mtuService = require('./mtuService');
const logger = require('./logger');

const log = logger.scope('tweaks');

const GROUPS = {
  tcpip: {
    id: 'tcpip',
    label: 'Pilha TCP/IP e Registro',
    icon: '🧠',
    description: 'Nagle, throttling multimídia, auto-tuning, ECN, provedor de congestionamento.',
  },
  wifi: {
    id: 'wifi',
    label: 'Wi-Fi e energia USB',
    icon: '📶',
    description: 'Varredura em segundo plano, selective suspend e economia de energia do adaptador.',
  },
  dns: {
    id: 'dns',
    label: 'DNS',
    icon: '🌐',
    description: 'Resolvedor de menor latência e jitter, com flush de cache.',
  },
  routing: {
    id: 'routing',
    label: 'Roteamento e MTU',
    icon: '🧭',
    description: 'MTU do caminho para eliminar fragmentação de pacotes UDP.',
  },
};

const RISK_LABELS = {
  low: { label: 'Baixo risco', color: 'success' },
  medium: { label: 'Risco médio', color: 'warning' },
  high: { label: 'Risco alto', color: 'danger' },
};

/* ------------------------------------------------------------------ */
/* Montagem do catálogo                                                */
/* ------------------------------------------------------------------ */

const ALL_TWEAKS = [
  ...tcpip.tweaks,
  ...wifi.tweaks,
  ...dnsService.tweaks,
  ...mtuService.tweaks,
].map((t, index) => ({ ...t, order: index }));

/** Validação de invariantes — roda no boot e nos testes. */
function validate(tweaks = ALL_TWEAKS) {
  const problems = [];
  const ids = new Set();

  for (const t of tweaks) {
    if (!t.id) problems.push('tweak sem id');
    if (ids.has(t.id)) problems.push(`id duplicado: ${t.id}`);
    ids.add(t.id);

    if (!GROUPS[t.group]) problems.push(`${t.id}: grupo inválido "${t.group}"`);
    if (!t.label) problems.push(`${t.id}: sem label`);
    if (!RISK_LABELS[t.risk]) problems.push(`${t.id}: risco inválido "${t.risk}"`);
    if (!['persistent', 'session'].includes(t.scope)) problems.push(`${t.id}: scope inválido "${t.scope}"`);
    if (typeof t.detect !== 'function') problems.push(`${t.id}: detect() ausente`);
    if (typeof t.apply !== 'function') problems.push(`${t.id}: apply() ausente`);
    if (typeof t.revert !== 'function') problems.push(`${t.id}: revert() ausente`);
    if (t.scope === 'session' && t.requiresAdmin === false) {
      problems.push(`${t.id}: tweak de sessão sem admin é suspeito`);
    }
  }

  return { ok: problems.length === 0, problems, count: tweaks.length };
}

function byId(id) {
  return ALL_TWEAKS.find((t) => t.id === id) || null;
}

function ids() {
  return ALL_TWEAKS.map((t) => t.id);
}

/* ------------------------------------------------------------------ */
/* Contexto de execução                                                */
/* ------------------------------------------------------------------ */

function createContext(overrides = {}) {
  return {
    isAdmin: overrides.isAdmin || (() => elevation.isAdmin()),
    allowPrompt: overrides.allowPrompt !== false,
    features: overrides.features || ((force) => platform.features(force)),
    snapshot: overrides.snapshot || ((opts) => netif.getSnapshot(opts)),
    params: overrides.params || {},
    onProgress: overrides.onProgress || null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Estado (rápido, sem tocar no sistema)                               */
/* ------------------------------------------------------------------ */

function toCatalogEntry(tweak) {
  const appliedRecord = stateStore.appliedMap()[tweak.id] || null;

  return {
    id: tweak.id,
    group: tweak.group,
    groupLabel: GROUPS[tweak.group] ? GROUPS[tweak.group].label : tweak.group,
    groupIcon: GROUPS[tweak.group] ? GROUPS[tweak.group].icon : '⚙️',
    label: tweak.label,
    description: tweak.description,
    why: tweak.why || null,
    risk: tweak.risk,
    riskLabel: RISK_LABELS[tweak.risk] ? RISK_LABELS[tweak.risk].label : tweak.risk,
    riskColor: RISK_LABELS[tweak.risk] ? RISK_LABELS[tweak.risk].color : 'warning',
    requiresAdmin: Boolean(tweak.requiresAdmin),
    scope: tweak.scope,
    defaultInPreset: Boolean(tweak.defaultInPreset),
    sessionCritical: Boolean(tweak.sessionCritical),
    rebootRecommended: Boolean(tweak.rebootRecommended),
    needsDiscovery: Boolean(tweak.needsDiscovery),
    legacy: Boolean(tweak.legacy),
    options: tweak.options || null,
    order: tweak.order,
    // Estado conhecido sem consultar o sistema:
    appliedRecorded: Boolean(appliedRecord),
    appliedAt: appliedRecord ? appliedRecord.appliedAt : null,
    hasBackup: stateStore.hasBackup(tweak.id),
  };
}

function getCatalog() {
  return {
    ok: true,
    platform: platform.basicInfo(),
    groups: Object.values(GROUPS),
    riskLabels: RISK_LABELS,
    tweaks: ALL_TWEAKS.map(toCatalogEntry),
    presets: getPresets(),
    settings: stateStore.getSettings(),
  };
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

const LEGACY_IDS = ['autoTuning', 'timestamps', 'rss', 'ecn', 'chimneyOffload', 'congestionProvider', 'tcpFastOpen'];

function getPresets() {
  return {
    ultra: {
      id: 'ultra',
      label: 'Modo Ultra Low-Latency',
      description: 'Todos os ajustes recomendados: TCP/IP, Wi-Fi/USB, DNS e prioridades multimídia.',
      tweakIds: ALL_TWEAKS.filter((t) => t.defaultInPreset).map((t) => t.id),
    },
    safe: {
      id: 'safe',
      label: 'Conservador (baixo risco)',
      description: 'Apenas ajustes de baixo risco, sem mexer em driver nem em DNS.',
      tweakIds: ALL_TWEAKS.filter((t) => t.defaultInPreset && t.risk === 'low').map((t) => t.id),
    },
    wifi: {
      id: 'wifi',
      label: 'Só Wi-Fi / USB',
      description: 'Focado em eliminar lag spikes de adaptadores Wi-Fi USB.',
      tweakIds: ALL_TWEAKS.filter((t) => t.group === 'wifi').map((t) => t.id),
    },
    all: {
      id: 'all',
      label: 'Tudo',
      description: 'Todos os ajustes disponíveis, inclusive os opcionais e legados.',
      tweakIds: ALL_TWEAKS.map((t) => t.id),
    },
    legacy: {
      id: 'legacy',
      label: 'Compatibilidade (versão anterior)',
      description: 'Reproduz o comportamento do "Otimizar TCP/IP" da versão 1.0.',
      tweakIds: LEGACY_IDS.filter((id) => byId(id)),
    },
  };
}

function presetIds(preset) {
  const presets = getPresets();
  if (Array.isArray(preset)) return preset.filter((id) => byId(id));
  const p = presets[preset] || presets.ultra;
  return p.tweakIds;
}

/**
 * Ordem de aplicação: ajustes persistentes primeiro, os de sessão por último
 * (assim, se algo derrubar a rede, o que está pendurado na sessão é revertido
 * primeiro). Reversão usa a ordem inversa.
 */
function sortForApply(list) {
  const arr = [...list];
  arr.sort((a, b) => {
    const ta = byId(a) || a;
    const tb = byId(b) || b;
    const scopeRank = (t) => (t.scope === 'session' ? 1 : 0);
    const s = scopeRank(ta) - scopeRank(tb);
    if (s !== 0) return s;
    return (ta.order || 0) - (tb.order || 0);
  });
  return arr;
}

function sortForRevert(list) {
  return sortForApply(list).reverse();
}

/* ------------------------------------------------------------------ */
/* Detecção (com concorrência limitada e cache)                        */
/* ------------------------------------------------------------------ */

const detectCache = new Map(); // id -> { at, data }
const DETECT_TTL = 10000;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { ok: false, error: err.message, exception: true };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

async function detect(id, ctxOptions = {}) {
  const tweak = byId(id);
  if (!tweak) return { ok: false, code: 'UNKNOWN_TWEAK', error: `Tweak desconhecido: ${id}` };

  const cached = detectCache.get(id);
  if (!ctxOptions.force && cached && Date.now() - cached.at < DETECT_TTL) {
    return cached.data;
  }

  const ctx = createContext(ctxOptions);
  let data;
  try {
    data = await tweak.detect(ctx);
  } catch (err) {
    log.error(`detect(${id}) lançou exceção`, { err: err.message, stack: err.stack });
    data = { ok: false, supported: false, error: `Erro interno: ${err.message}`, exception: true };
  }

  const normalized = {
    id,
    ok: data.ok !== false,
    supported: data.supported !== false,
    applied: Boolean(data.applied),
    reason: data.reason || null,
    error: data.error || null,
    current: data.current !== undefined ? data.current : null,
    target: data.target !== undefined ? data.target : null,
    recordedApplied: stateStore.isApplied(id),
    hasBackup: stateStore.hasBackup(id),
    detectedAt: Date.now(),
    raw: data,
  };

  detectCache.set(id, { at: Date.now(), data: normalized });
  return normalized;
}

async function detectAll(options = {}) {
  const list = options.ids ? options.ids.filter((id) => byId(id)) : ids();
  const detected = await mapWithConcurrency(list, options.concurrency || 3, (id) =>
    detect(id, { ...options, force: options.force })
  );
  return Object.fromEntries(detected.map((d, i) => [list[i], d]));
}

function invalidateDetect(idsToClear) {
  if (!idsToClear) return detectCache.clear();
  for (const id of Array.isArray(idsToClear) ? idsToClear : [idsToClear]) detectCache.delete(id);
}

/** Catálogo + estado detectado (usado pela tela principal). */
async function getDetailed(options = {}) {
  const catalog = getCatalog();
  const detection = await detectAll({ concurrency: options.concurrency || 3, force: options.force });

  return {
    ...catalog,
    tweaks: catalog.tweaks.map((t) => ({ ...t, ...(detection[t.id] ? { state: detection[t.id] } : { state: null }) })),
    detection,
  };
}

/* ------------------------------------------------------------------ */
/* Aplicar / reverter                                                  */
/* ------------------------------------------------------------------ */

async function apply(id, options = {}) {
  const tweak = byId(id);
  if (!tweak) return { success: false, code: 'UNKNOWN_TWEAK', applied: false, message: `Tweak desconhecido: ${id}` };

  const ctx = createContext({ params: options.params || {}, onProgress: options.onProgress, ...options });

  if (!ps.isWindows()) {
    return {
      success: false,
      code: 'UNSUPPORTED_PLATFORM',
      applied: false,
      message: 'Este ajuste só pode ser aplicado no Windows.',
    };
  }

  log.info(`Aplicando tweak "${id}"`, { params: ctx.params });
  const started = Date.now();

  let result;
  try {
    result = await tweak.apply(ctx);
  } catch (err) {
    log.error(`apply(${id}) lançou exceção`, { err: err.message, stack: err.stack });
    result = { success: false, code: 'EXCEPTION', applied: false, message: `Erro interno: ${err.message}` };
  }

  const normalized = normalizeResult(id, tweak, result, Date.now() - started);

  if (normalized.success && normalized.applied !== false) {
    stateStore.markApplied(id, {
      scope: tweak.scope,
      by: options.by || 'user',
      params: ctx.params,
      message: normalized.message,
    });
  } else {
    stateStore.markReverted(id, { by: options.by || 'user', success: false, message: normalized.message });
  }

  invalidateDetect([id, 'nagle']); // nagle altera o estado de várias interfaces
  netif.invalidate();
  tcpip.invalidateTcpCache();

  return normalized;
}

async function revert(id, options = {}) {
  const tweak = byId(id);
  if (!tweak) return { success: false, code: 'UNKNOWN_TWEAK', applied: false, message: `Tweak desconhecido: ${id}` };

  const ctx = createContext({ params: options.params || {}, ...options });

  if (!ps.isWindows()) {
    return { success: false, code: 'UNSUPPORTED_PLATFORM', applied: false, message: 'Somente Windows.' };
  }

  log.info(`Revertendo tweak "${id}"`);
  const started = Date.now();

  let result;
  try {
    result = await tweak.revert(ctx);
  } catch (err) {
    log.error(`revert(${id}) lançou exceção`, { err: err.message, stack: err.stack });
    result = { success: false, code: 'EXCEPTION', message: `Erro interno: ${err.message}` };
  }

  const normalized = normalizeResult(id, tweak, result, Date.now() - started);
  if (normalized.success) stateStore.markReverted(id, { by: options.by || 'user', message: normalized.message });

  invalidateDetect([id]);
  netif.invalidate();
  tcpip.invalidateTcpCache();

  return normalized;
}

function normalizeResult(id, tweak, result, durationMs) {
  const r = result && typeof result === 'object' ? result : { success: Boolean(result) };

  return {
    id,
    label: tweak.label,
    success: Boolean(r.success),
    code: r.code || (r.success ? 'OK' : 'FAILED'),
    applied: r.applied === undefined ? Boolean(r.success) : Boolean(r.applied),
    message: r.message || r.error || (r.success ? `${tweak.label} aplicado.` : `${tweak.label} falhou.`),
    error: r.error || null,
    current: r.current !== undefined ? r.current : null,
    target: r.target !== undefined ? r.target : null,
    previous: r.previous !== undefined ? r.previous : null,
    details: r.details || null,
    warnings: r.warnings || null,
    note: r.note || null,
    requiresReboot: Boolean(r.requiresReboot || tweak.rebootRecommended),
    scope: tweak.scope,
    durationMs,
    discovery: r.discovery || null,
    benchmark: r.benchmark || null,
    raw: r,
  };
}

/**
 * Reverte TUDO que tem backup, na ordem segura (sessão primeiro).
 * Usado por "Restaurar sistema" e pela recuperação pós-crash.
 */
async function revertAll(options = {}) {
  const withBackup = ids().filter((id) => stateStore.hasBackup(id));
  const recorded = stateStore.appliedIds();
  const targets = [...new Set([...withBackup, ...recorded.filter((id) => byId(id))])];

  if (targets.length === 0) {
    return {
      success: true,
      code: 'NOTHING_TO_RESTORE',
      message: 'Nenhuma alteração registrada — o sistema já está no estado original.',
      results: [],
    };
  }

  const ordered = sortForRevert(targets);
  const results = [];

  for (const id of ordered) {
    const res = await revert(id, options);
    results.push(res);
    if (options.onProgress) options.onProgress({ id, index: results.length, total: ordered.length, result: res });
  }

  const failed = results.filter((r) => !r.success);

  return {
    success: failed.length === 0,
    code: failed.length === 0 ? 'OK' : 'PARTIAL',
    message:
      failed.length === 0
        ? `Sistema restaurado: ${results.length} ajuste(s) revertido(s) para o estado anterior.`
        : `${results.length - failed.length} revertido(s), ${failed.length} com falha.`,
    results,
    failures: failed.map((f) => ({ id: f.id, label: f.label, message: f.message, code: f.code })),
    requiresReboot: results.some((r) => r.requiresReboot),
  };
}

/**
 * Aplica um conjunto (preset ou lista), na ordem segura.
 * Não faz guarda de conectividade aqui — isso é responsabilidade do gameMode,
 * que orquestra rollback em caso de queda de rede.
 */
async function applyMany(tweakIds, options = {}) {
  const ordered = sortForApply((Array.isArray(tweakIds) ? tweakIds : presetIds(tweakIds)).filter((id) => byId(id)));
  const results = [];

  for (const id of ordered) {
    const res = await apply(id, { ...options, by: options.by || 'preset' });
    results.push(res);
    if (options.onProgress) {
      options.onProgress({ id, index: results.length, total: ordered.length, result: res });
    }
    if (options.stopOnFatal && res.code === 'CONNECTIVITY_LOST') break;
  }

  const ok = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  return {
    success: failed.length === 0,
    code: failed.length === 0 ? 'OK' : ok.length > 0 ? 'PARTIAL' : 'FAILED',
    message:
      failed.length === 0
        ? `${ok.length} ajuste(s) aplicado(s).`
        : `${ok.length} aplicado(s), ${failed.length} com falha.`,
    results,
    applied: ok.map((r) => r.id),
    failed: failed.map((r) => ({ id: r.id, label: r.label, code: r.code, message: r.message })),
    requiresReboot: results.some((r) => r.requiresReboot),
  };
}

async function revertMany(tweakIds, options = {}) {
  const ordered = sortForRevert((Array.isArray(tweakIds) ? tweakIds : presetIds(tweakIds)).filter((id) => byId(id)));
  const results = [];

  for (const id of ordered) {
    const res = await revert(id, options);
    results.push(res);
    if (options.onProgress) options.onProgress({ id, index: results.length, total: ordered.length, result: res });
  }

  const failed = results.filter((r) => !r.success);
  return {
    success: failed.length === 0,
    code: failed.length === 0 ? 'OK' : 'PARTIAL',
    message: failed.length === 0 ? `${results.length} ajuste(s) revertido(s).` : `${results.length - failed.length} revertido(s), ${failed.length} com falha.`,
    results,
    failed: failed.map((r) => ({ id: r.id, label: r.label, message: r.message })),
  };
}

module.exports = {
  GROUPS,
  RISK_LABELS,
  ALL_TWEAKS,
  validate,
  byId,
  ids,
  createContext,
  getCatalog,
  getDetailed,
  getPresets,
  presetIds,
  sortForApply,
  sortForRevert,
  detect,
  detectAll,
  invalidateDetect,
  apply,
  revert,
  applyMany,
  revertMany,
  revertAll,
  toCatalogEntry,
  mapWithConcurrency,
};
