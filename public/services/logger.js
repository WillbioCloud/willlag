'use strict';

/**
 * Logger estruturado do processo principal.
 *
 * Mantém um buffer circular em memória (para exibir na UI), grava em arquivo
 * dentro de userData/logs e repassa cada entrada para "sinks" registrados
 * (usado para enviar logs ao renderer via IPC).
 *
 * Não depende do Electron em tempo de import — o diretório é configurado
 * depois, o que permite testar este módulo fora do app.
 */

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 800;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let buffer = [];
let sinks = new Set();
let logDir = null;
let logFile = null;
let minLevel = LEVELS.info;
let writeFailures = 0;

function configure(options = {}) {
  if (options.level && LEVELS[options.level] !== undefined) {
    minLevel = LEVELS[options.level];
  }
  if (options.dir) {
    logDir = options.dir;
    try {
      fs.mkdirSync(path.join(logDir, 'logs'), { recursive: true });
      logFile = path.join(
        logDir,
        'logs',
        `willlag-${new Date().toISOString().slice(0, 10)}.log`
      );
    } catch (err) {
      logFile = null;
    }
  }
}

function addSink(fn) {
  if (typeof fn === 'function') sinks.add(fn);
  return () => sinks.delete(fn);
}

function getEntries(limit = 200) {
  return buffer.slice(-limit);
}

function clear() {
  buffer = [];
}

function write(level, scope, message, meta) {
  if (LEVELS[level] < minLevel) return null;

  const entry = {
    ts: Date.now(),
    time: new Date().toISOString(),
    level,
    scope,
    message: String(message),
    meta: meta === undefined ? undefined : safeMeta(meta),
  };

  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);

  if (logFile && writeFailures < 5) {
    try {
      const line = `${entry.time} [${level.toUpperCase()}] (${scope}) ${entry.message}` +
        (entry.meta !== undefined ? ' ' + JSON.stringify(entry.meta) : '');
      fs.appendFileSync(logFile, line + '\n');
    } catch (err) {
      writeFailures += 1;
    }
  }

  for (const sink of sinks) {
    try {
      sink(entry);
    } catch (err) {
      sinks.delete(sink);
    }
  }

  return entry;
}

function safeMeta(meta) {
  try {
    const json = JSON.stringify(meta);
    if (json === undefined) return String(meta);
    // Evita estourar o IPC / arquivo de log com objetos gigantes.
    return json.length > 8000 ? JSON.parse(json.slice(0, 8000) + '"}') : JSON.parse(json);
  } catch (err) {
    try {
      return String(meta);
    } catch (e) {
      return '[unserializable]';
    }
  }
}

/** Cria um logger com escopo fixo. */
function scope(name) {
  return {
    debug: (msg, meta) => write('debug', name, msg, meta),
    info: (msg, meta) => write('info', name, msg, meta),
    warn: (msg, meta) => write('warn', name, msg, meta),
    error: (msg, meta) => write('error', name, msg, meta),
  };
}

module.exports = {
  configure,
  addSink,
  getEntries,
  clear,
  scope,
  debug: (s, m, meta) => write('debug', s, m, meta),
  info: (s, m, meta) => write('info', s, m, meta),
  warn: (s, m, meta) => write('warn', s, m, meta),
  error: (s, m, meta) => write('error', s, m, meta),
};
