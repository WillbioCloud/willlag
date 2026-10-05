/**
 * Ponte única de IPC do renderer.
 *
 * Três modos, detectados automaticamente nesta ordem:
 *
 *  1. `preload`  — Electron moderno (contextIsolation: true). Usa window.willlag,
 *                  a API exposta pelo public/preload.js. Este é o caminho padrão.
 *  2. `legacy`   — Electron com nodeIntegration (builds antigos). Usa
 *                  window.require('electron').ipcRenderer. Mantido para não
 *                  quebrar nada caso alguém rode com as flags antigas.
 *  3. `demo`     — navegador puro (npm start fora do Electron). Usa o
 *                  mockBackend, permitindo desenvolver/validar a UI e mostrar
 *                  o app sem Windows. A UI exibe um aviso claro de demonstração.
 *
 * Nenhum componente deve chamar `window.require('electron')` diretamente:
 * centralizar aqui é o que torna a migração para contextIsolation segura.
 */

import mock from './mockBackend';

function detectLegacyIpc() {
  try {
    if (typeof window === 'undefined') return null;
    if (typeof window.require !== 'function') return null;
    const electron = window.require('electron');
    if (electron && electron.ipcRenderer && typeof electron.ipcRenderer.invoke === 'function') {
      return electron.ipcRenderer;
    }
  } catch (err) {
    // esperado fora do Electron
  }
  return null;
}

const preloadApi = typeof window !== 'undefined' ? window.willlag : null;
const legacyIpc = preloadApi ? null : detectLegacyIpc();

export const mode = preloadApi ? 'preload' : legacyIpc ? 'legacy' : 'demo';
export const isElectron = mode !== 'demo';
export const isDemo = mode === 'demo';

const listeners = new Map(); // channel -> Set<callback> do renderer
const dispatchers = new Map(); // channel -> função única assinada no backend
const backendUnsubs = new Map(); // channel -> unsubscribe devolvido pelo backend

function safeCall(cb, channel, payload) {
  try {
    cb(payload);
  } catch (err) {
    // Um listener quebrado não pode derrubar os outros listeners do canal
    // (nem vazar exceção para dentro do main process / do mock).
    // eslint-disable-next-line no-console
    console.error(`[willlag] handler do canal "${channel}" falhou`, err);
  }
}

/**
 * Assina UMA função dispatch por canal no backend (preload, legacy ou mock) e
 * distribui para todos os listeners do renderer.
 *
 * Um único caminho para os três modos é o que garante comportamento igual:
 * antes, o modo demo assinava cada callback direto no mock — o que fazia
 * `removeAll()` limpar só a lista local e deixar componentes desmontados
 * continuando a receber eventos (setState em componente morto).
 */
function ensureChannel(channel) {
  if (listeners.has(channel)) return;
  const set = new Set();
  listeners.set(channel, set);

  const dispatch = (payload) => {
    set.forEach((cb) => safeCall(cb, channel, payload));
  };
  dispatchers.set(channel, dispatch);

  if (preloadApi) {
    // O preload devolve uma função de unsubscribe por assinatura: guardamos ela
    // para cancelar exatamente este canal (removeAll do preload é mais bruto).
    backendUnsubs.set(channel, preloadApi.on(channel, dispatch) || null);
  } else if (legacyIpc) {
    legacyIpc.on(channel, (_event, payload) => dispatch(payload));
  } else {
    mock.subscribe(channel, dispatch);
  }
}

function dropChannel(channel) {
  const dispatch = dispatchers.get(channel);
  if (!dispatch) return;

  const backendOff = backendUnsubs.get(channel);
  if (typeof backendOff === 'function') backendOff();
  else if (preloadApi) preloadApi.removeAll(channel);
  else if (legacyIpc) legacyIpc.removeAllListeners(channel);
  else mock.unsubscribe(channel, dispatch);

  backendUnsubs.delete(channel);
  dispatchers.delete(channel);
  listeners.delete(channel);
}

export const ipc = {
  mode,
  isElectron,
  isDemo,

  async invoke(channel, ...args) {
    if (preloadApi) return preloadApi.invoke(channel, ...args);
    if (legacyIpc) return legacyIpc.invoke(channel, ...args);
    return mock.invoke(channel, ...args);
  },

  send(channel, ...args) {
    if (preloadApi) return preloadApi.send(channel, ...args);
    if (legacyIpc) {
      legacyIpc.send(channel, ...args);
      return true;
    }
    return mock.send(channel, ...args);
  },

  /**
   * Registra listener e devolve função de remoção.
   * O handler recebe APENAS o payload (o objeto `event` do Electron fica no
   * main process) — componente que usar `(event, data) => …` quebra em silêncio.
   */
  on(channel, callback) {
    if (typeof callback !== 'function') return () => {};
    ensureChannel(channel);
    const set = listeners.get(channel);
    set.add(callback);

    return () => {
      const current = listeners.get(channel);
      if (!current) return;
      current.delete(callback);
      // Sem listeners, devolve a assinatura do backend também.
      if (current.size === 0) dropChannel(channel);
    };
  },

  /**
   * Espera um único evento. O callback é OPCIONAL: `await ipc.once('canal')`
   * é o uso natural dentro de um async/await, e antes isso pendurava a promise
   * para sempre (o TypeError acontecia antes do resolve).
   */
  once(channel, callback) {
    return new Promise((resolve) => {
      const off = ipc.on(channel, (payload) => {
        off();
        if (typeof callback === 'function') {
          safeCall(callback, channel, payload);
        }
        resolve(payload);
      });
    });
  },

  removeAll(channel) {
    const set = listeners.get(channel);
    if (set) set.clear();
    dropChannel(channel);
  },
};

export default ipc;
