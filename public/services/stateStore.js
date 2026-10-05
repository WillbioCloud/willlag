'use strict';

/**
 * Persistência de estado + backups reversíveis.
 *
 * Tudo que o willLag altera no sistema é registrado aqui ANTES de ser modificado,
 * permitindo reversão exata (inclusive "o valor não existia" -> remover).
 *
 * Arquivos (em userData):
 *   willlag-state.json   -> estado dos tweaks + backups + configurações do usuário
 *   willlag-session.lock -> marca que há uma sessão ativa com tweaks temporários
 *                           (permite recuperar o sistema após crash/queda de energia)
 *
 * As gravações são atômicas (escreve .tmp e renomeia) para nunca corromper o
 * estado se o processo for morto no meio.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const log = logger.scope('state');

const SCHEMA_VERSION = 2;
const LOCK_STALE_MS = 12 * 60 * 60 * 1000; // 12h

let dir = null;
let state = null;
let saveTimer = null;

function defaultDir() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (err) {
    // Fora do Electron (testes/CLI): usa pasta no home.
  }
  return path.join(os.homedir(), '.willlag');
}

function configure(options = {}) {
  dir = options.dir || defaultDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.error('Não foi possível criar diretório de estado', { dir, err: err.message });
  }
  state = load();
  return state;
}

function getDir() {
  if (!dir) configure();
  return dir;
}

function statePath() {
  return path.join(getDir(), 'willlag-state.json');
}

function lockPath() {
  return path.join(getDir(), 'willlag-session.lock');
}

function backupPath() {
  return path.join(getDir(), 'backups');
}

function emptyState() {
  return {
    version: SCHEMA_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    /** backups[tweakId] = [ { capturedAt, entries: [...], meta } ] (pilha; último no topo) */
    backups: {},
    /** applied[tweakId] = { appliedAt, by, scope, params, restoreHint } */
    applied: {},
    /** Preferências do usuário (quais tweaks entram no modo ultra, etc.) */
    settings: {
      ultraPreset: null,
      autoRestoreOnQuit: true,
      watchdogEnabled: true,
      watchdogIntervalMs: 15000,
      dnsProvider: null,
      mtu: null,
      lastGameMode: null,
    },
    /** Último benchmark antes/depois (para mostrar ganho real na UI) */
    benchmarks: [],
    history: [],
  };
}

function migrate(loaded) {
  const base = emptyState();
  if (!loaded || typeof loaded !== 'object') return base;

  return {
    ...base,
    ...loaded,
    version: SCHEMA_VERSION,
    backups: { ...(base.backups || {}), ...(loaded.backups || {}) },
    applied: { ...(base.applied || {}), ...(loaded.applied || {}) },
    settings: { ...base.settings, ...(loaded.settings || {}) },
    benchmarks: Array.isArray(loaded.benchmarks) ? loaded.benchmarks : [],
    history: Array.isArray(loaded.history) ? loaded.history : [],
  };
}

function load() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('Estado corrompido/inlegível — iniciando novo', { err: err.message });
      // Preserva uma cópia para auditoria.
      try {
        fs.copyFileSync(statePath(), statePath() + `.corrupt-${Date.now()}`);
      } catch (e) { /* melhor esforço */ }
    }
    return emptyState();
  }
}

function getState() {
  if (!state) state = load();
  return state;
}

/** Gravação atômica. */
function saveNow() {
  const s = getState();
  s.updatedAt = Date.now();
  const target = statePath();
  const tmp = target + '.tmp';
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    log.error('Falha ao salvar estado', { err: err.message });
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* noop */ }
    return false;
  }
}

/** Salva com debounce (evita I/O excessivo durante rajadas de tweaks). */
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 120);
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return saveNow();
}

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

const MAX_BACKUP_LAYERS = 5;

/**
 * Registra um backup para um tweak.
 * `entries` = lista de itens reversíveis, cada um com:
 *   { kind: 'registry'|'netsh'|'powercfg'|'dns'|'mtu'|'wlan'|'adapter'|'custom', ... }
 */
function pushBackup(tweakId, entries, meta = {}) {
  const s = getState();
  if (!s.backups[tweakId]) s.backups[tweakId] = [];

  // Se já existe uma camada NÃO CONSUMIDA com a mesma assinatura, ela guarda o
  // valor ORIGINAL do sistema. A segunda captura acontece com o tweak já
  // aplicado, então registraria o valor modificado como "anterior" — e o revert
  // deixaria de devolver o estado real de fábrica. Mantemos a camada antiga.
  const last = s.backups[tweakId][0];
  const layer = {
    capturedAt: Date.now(),
    consumed: false,
    meta,
    entries: Array.isArray(entries) ? entries : [entries],
  };

  if (last && !last.consumed && sameSignature(last.entries, layer.entries)) {
    last.recapturedAt = layer.capturedAt;
    last.meta = { ...(last.meta || {}), ...(meta || {}) };
    save();
    return last;
  }

  s.backups[tweakId].unshift(layer);
  s.backups[tweakId] = s.backups[tweakId].slice(0, MAX_BACKUP_LAYERS);

  save();
  return layer;
}

/**
 * Identidade do ALVO de uma entrada de backup — sem os valores.
 *
 * Os valores ficam de fora de propósito: ao aplicar um tweak duas vezes, a
 * segunda captura lê o sistema JÁ modificado. Comparando só o alvo, o store
 * percebe que é "o mesmo lugar" e mantém a camada antiga (o valor original).
 * Campos que distinguem alvos diferentes de verdade (MTU IPv4 vs IPv6, AC vs
 * DC, interface, keyword do driver) entram na chave.
 */
function entryTargetKey(e) {
  if (!e || typeof e !== 'object') return String(e);
  const name = String(e.name === undefined || e.name === null ? '' : e.name).toLowerCase();

  switch (e.kind) {
    case 'registry':
      return `registry|${e.path}|${e.name}`;
    case 'netshGlobal':
    case 'netshIpGlobal':
      return `${e.kind}|${e.setting}`;
    case 'netshSupplemental':
      return `netshSupplemental|${e.template}|${e.setting}`;
    case 'wlanAutoconfig':
      return `wlanAutoconfig|${name || String(e.interfaceName || '').toLowerCase()}`;
    case 'powercfgAcDc':
      return `powercfgAcDc|${e.scheme || ''}|${e.subgroup}|${e.setting}`;
    case 'adapterPowerManagement':
      return `adapterPowerManagement|${name}|${e.property}`;
    case 'adapterAdvanced':
      return `adapterAdvanced|${name}|${e.keyword}`;
    case 'dns':
      return `dns|${e.ifIndex}`;
    case 'mtu':
      return `mtu|${e.ifIndex}|${e.family || 'IPv4'}`;
    case 'qosPolicy':
      return `qosPolicy|${e.name}`;
    case 'service':
      return `service|${e.name}`;
    default:
      return `${e.kind}|${e.path || e.target || e.ifIndex || e.name || ''}|${e.setting || ''}`;
  }
}

function sameSignature(a, b) {
  try {
    const key = (list) => (Array.isArray(list) ? list : [list])
      .map(entryTargetKey)
      .sort()
      .join('||');
    return key(a) === key(b);
  } catch (err) {
    return false;
  }
}

/** Retorna a camada de backup mais recente e ainda não consumida. */
/**
 * Camada de backup PENDENTE mais recente (a que um revert usaria).
 *
 * Devolve `null` quando todas as camadas já foram consumidas. Cair para
 * `layers[0]` aqui seria perigoso: um segundo clique em "Reverter" reaplicaria
 * valores de um backup já utilizado (e `hasBackup` continuaria true, mostrando
 * um botão de restauração que não tem o que restaurar).
 */
function peekBackup(tweakId) {
  const s = getState();
  const layers = s.backups[tweakId] || [];
  return layers.find((l) => !l.consumed) || null;
}

/** Última camada gravada, consumida ou não (histórico/auditoria). */
function lastBackup(tweakId) {
  const s = getState();
  const layers = s.backups[tweakId] || [];
  return layers[0] || null;
}

/** Marca a camada mais recente como consumida (após um revert bem-sucedido). */
function consumeBackup(tweakId) {
  const s = getState();
  const layers = s.backups[tweakId] || [];
  const idx = layers.findIndex((l) => !l.consumed);
  if (idx >= 0) {
    layers[idx].consumed = true;
    layers[idx].consumedAt = Date.now();
    save();
    return layers[idx];
  }
  return null;
}

function hasBackup(tweakId) {
  return Boolean(peekBackup(tweakId));
}

function allBackups() {
  return getState().backups || {};
}

/* ------------------------------------------------------------------ */
/* Estado de aplicação                                                 */
/* ------------------------------------------------------------------ */

function markApplied(tweakId, info = {}) {
  const s = getState();
  s.applied[tweakId] = {
    appliedAt: Date.now(),
    scope: info.scope || 'persistent',
    by: info.by || 'user',
    params: info.params || null,
    note: info.note || null,
  };
  s.history.unshift({
    ts: Date.now(),
    action: 'apply',
    tweakId,
    by: info.by || 'user',
    success: info.success !== false,
    message: info.message || null,
  });
  s.history = s.history.slice(0, 300);
  save();
}

function markReverted(tweakId, info = {}) {
  const s = getState();
  delete s.applied[tweakId];
  s.history.unshift({
    ts: Date.now(),
    action: 'revert',
    tweakId,
    by: info.by || 'user',
    success: info.success !== false,
    message: info.message || null,
  });
  s.history = s.history.slice(0, 300);
  save();
}

function isApplied(tweakId) {
  return Boolean(getState().applied[tweakId]);
}

function appliedMap() {
  return getState().applied || {};
}

function appliedIds() {
  return Object.keys(getState().applied || {});
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function getSettings() {
  return getState().settings || {};
}

function updateSettings(patch = {}) {
  const s = getState();
  s.settings = { ...(s.settings || {}), ...patch };
  save();
  return s.settings;
}

function getSetting(key, fallback = null) {
  const s = getState().settings || {};
  return s[key] === undefined ? fallback : s[key];
}

function pushBenchmark(entry) {
  const s = getState();
  s.benchmarks.unshift({ ts: Date.now(), ...entry });
  s.benchmarks = s.benchmarks.slice(0, 20);
  save();
}

function getHistory(limit = 50) {
  return (getState().history || []).slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Lock de sessão (recuperação após crash)                             */
/* ------------------------------------------------------------------ */

function writeSessionLock(info = {}) {
  try {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: Date.now(),
          hostname: os.hostname(),
          ...info,
        },
        null,
        2
      ),
      'utf8'
    );
    return true;
  } catch (err) {
    log.warn('Falha ao gravar lock de sessão', { err: err.message });
    return false;
  }
}

function readSessionLock() {
  try {
    const raw = fs.readFileSync(lockPath(), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function clearSessionLock() {
  try {
    if (fs.existsSync(lockPath())) fs.unlinkSync(lockPath());
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Detecta encerramento anormal anterior: se existe lock e o PID não está vivo
 * (ou o lock é muito antigo), precisamos restaurar os tweaks de sessão.
 */
function detectStaleSession() {
  const lock = readSessionLock();
  if (!lock) return null;

  const isSelf = lock.pid === process.pid;
  const tooOld = Date.now() - (lock.startedAt || 0) > LOCK_STALE_MS;

  // Lock recente de um processo vivo (nós mesmos ou outra instância) não é
  // encerramento anormal — reverter aqui desligaria o Modo Jogo de alguém.
  if (!tooOld && (isSelf || isPidAlive(lock.pid))) {
    return null;
  }

  return { ...lock, reason: tooOld ? 'stale-timeout' : 'crash-or-forced-exit', isSelf, tooOld };
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/* ------------------------------------------------------------------ */
/* Exportação para o usuário (auditoria / suporte)                     */
/* ------------------------------------------------------------------ */

function exportBundle() {
  const s = getState();
  return {
    exportedAt: new Date().toISOString(),
    app: 'willLag',
    schemaVersion: SCHEMA_VERSION,
    platform: {
      node: process.version,
      os: process.platform,
      release: os.release(),
    },
    state: s,
  };
}

function importBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { success: false, error: 'Arquivo de backup inválido.' };
  }
  const incoming = bundle.state;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { success: false, error: 'Arquivo de backup inválido: sem estado utilizável.' };
  }
  if (bundle.app && bundle.app !== 'willLag') {
    return { success: false, error: `Arquivo de backup de outro aplicativo ("${bundle.app}").` };
  }

  const migrated = migrate(incoming);
  if (!migrated || typeof migrated !== 'object' || !migrated.backups) {
    return { success: false, error: 'Estado importado não pôde ser normalizado.' };
  }

  state = migrated;
  const ok = saveNow();
  return { success: ok, error: ok ? null : 'Falha ao gravar estado importado.' };
}

module.exports = {
  SCHEMA_VERSION,
  configure,
  getDir,
  statePath,
  lockPath,
  backupPath,
  getState,
  migrate,
  entryTargetKey,
  load,
  save,
  saveNow,
  flush,
  pushBackup,
  peekBackup,
  lastBackup,
  consumeBackup,
  hasBackup,
  allBackups,
  markApplied,
  markReverted,
  isApplied,
  appliedMap,
  appliedIds,
  getSettings,
  updateSettings,
  getSetting,
  pushBenchmark,
  getHistory,
  writeSessionLock,
  readSessionLock,
  clearSessionLock,
  detectStaleSession,
  exportBundle,
  importBundle,
  emptyState,
};
