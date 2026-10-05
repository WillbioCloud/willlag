'use strict';

/**
 * Preload — ponte segura entre renderer e main.
 *
 * A versão 1.0 rodava com `nodeIntegration: true` + `contextIsolation: false`,
 * o que dava à página acesso total a `require('child_process')` num aplicativo
 * que roda COMO ADMINISTRADOR. Qualquer XSS virava execução de comando com
 * privilégios máximos.
 *
 * Agora o renderer só enxerga `window.willlag`, com:
 *   - lista branca de canais (nada fora daqui atravessa a ponte);
 *   - nenhum acesso a Node, fs, child_process ou ao objeto `ipcRenderer` cru.
 */

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  // sistema / elevação
  'check-admin',
  'get-elevation-status',
  'relaunch-as-admin',
  'get-system-context',
  'get-network-snapshot',
  'get-network-info',
  'get-adapters',
  'get-wifi-diagnostics',
  'get-tcp-global',
  'get-logs',
  'get-settings',
  'set-settings',

  // tweaks
  'get-tweaks',
  'get-tweaks-detailed',
  'detect-tweak',
  'detect-all-tweaks',
  'apply-tweak',
  'revert-tweak',
  'apply-tweaks',
  'revert-tweaks',
  'revert-all',

  // backups
  'get-backups',
  'export-backup-reg',
  'export-state-bundle',
  'import-state-bundle',

  // modo jogo
  'gamemode-status',
  'gamemode-start',
  'gamemode-stop',
  'gamemode-toggle',
  'gamemode-benchmark',
  'check-connectivity',

  // dns
  'dns-providers',
  'dns-benchmark',
  'dns-current',
  'dns-apply',
  'dns-restore',
  'dns-cache',
  'change-dns',
  'flush-dns',

  // mtu
  'mtu-get',
  'mtu-discover',
  'mtu-apply',
  'mtu-restore',
  'mtu-auto-optimize',

  // latência
  'ping-host',
  'ping-stats',
  'speed-test',

  // processos (legado v1.0)
  'get-processes',
  'get-network-connections',
  'set-process-priority',
  'set-network-priority',
  'optimize-for-process',
  'optimize-tcp',
  'disable-nagle',
  'reset-optimizations',
]);

const SEND_CHANNELS = new Set([
  'minimize-window',
  'maximize-window',
  'close-window',
  'start-ping-monitor',
  'stop-ping-monitor',
  'cleanup-webcontents',
]);

const RECEIVE_CHANNELS = new Set([
  'ping-result',
  'gamemode-state',
  'gamemode-progress',
  'gamemode-metrics',
  'gamemode-alert',
  'tweak-updated',
  'tweaks-updated',
  'log',
  'dns-benchmark-progress',
  'mtu-progress',
]);

/** Sanitiza argumentos: só tipos serializáveis atravessam a ponte. */
function safeArgs(args) {
  return (Array.isArray(args) ? args : []).slice(0, 8).filter((a) => {
    if (a === null || a === undefined) return true;
    const t = typeof a;
    if (t === 'string' || t === 'number' || t === 'boolean') return true;
    if (Array.isArray(a)) return a.length <= 64;
    if (t === 'object') return true; // objetos planos de parâmetros
    return false;
  });
}

const api = {
  version: 2,

  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`Canal IPC não permitido: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...safeArgs(args));
  },

  send(channel, ...args) {
    if (!SEND_CHANNELS.has(channel)) {
      console.warn(`[willlag] Canal IPC não permitido: ${channel}`);
      return false;
    }
    ipcRenderer.send(channel, ...safeArgs(args));
    return true;
  },

  /**
   * Registra listener e devolve a função de remoção.
   * O handler recebe APENAS o payload — nunca o objeto `event` do Electron,
   * que exporia `sender` (e portanto `send`/`postMessage` arbitrário).
   */
  on(channel, handler) {
    if (!RECEIVE_CHANNELS.has(channel) || typeof handler !== 'function') {
      return () => {};
    }
    const listener = (_event, payload) => {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[willlag] erro no handler de ${channel}`, err);
      }
    };
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  once(channel, handler) {
    if (!RECEIVE_CHANNELS.has(channel) || typeof handler !== 'function') return Promise.resolve(null);
    return new Promise((resolve) => {
      const listener = (_event, payload) => {
        ipcRenderer.removeListener(channel, listener);
        try {
          handler(payload);
        } catch (err) {
          console.error(err);
        }
        resolve(payload);
      };
      ipcRenderer.once(channel, listener);
    });
  },

  removeAll(channel) {
    if (RECEIVE_CHANNELS.has(channel)) ipcRenderer.removeAllListeners(channel);
  },

  notifyClosed() {
    ipcRenderer.send('cleanup-webcontents');
  },
};

contextBridge.exposeInMainWorld('willlag', api);
