'use strict';

/**
 * willLag — processo principal (Electron).
 *
 * Este arquivo ficou propositalmente fino: janela, ciclo de vida e wiring.
 * Toda a lógica de sistema mora em ./services/*, o que permite testar as
 * rotinas de rede/registro fora do Electron.
 *
 * Ciclo de vida de segurança (importante):
 *   1. boot       -> recupera sessão anterior que morreu (crash/kill) e restaura
 *                    os ajustes temporários;
 *   2. before-quit-> reverte ajustes de sessão (ex.: WLAN AutoConfig) ANTES de sair;
 *   3. se a reversão falhar (sem UAC no encerramento), mostra um diálogo com o
 *      comando exato para o usuário não ficar sem reconexão automática de Wi-Fi.
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, powerSaveBlocker } = require('electron');

const logger = require('./services/logger');
const stateStore = require('./services/stateStore');
const psRunner = require('./services/psRunner');
const platform = require('./services/platform');
const elevation = require('./services/elevation');
const netif = require('./services/netInterfaces');
const registry = require('./services/tweakRegistry');
const gameMode = require('./services/gameMode');
const ipc = require('./services/ipc');

const log = logger.scope('main');

let mainWindow = null;
let ipcController = null;
let shuttingDown = false;

const isDev = !app.isPackaged;

/* ------------------------------------------------------------------ */
/* Boot dos serviços                                                   */
/* ------------------------------------------------------------------ */

function bootstrapServices() {
  const userData = app.getPath('userData');

  logger.configure({ dir: userData, level: isDev ? 'debug' : 'info' });
  stateStore.configure({ dir: userData });
  psRunner.configure({ tmpDir: path.join(userData, 'tmp') });

  // Logs também vão para a UI (aba de diagnóstico).
  logger.addSink((entry) => {
    try {
      ipc.broadcast('log', entry);
    } catch (err) {
      /* janela ainda não existe */
    }
  });

  gameMode.configure({
    emit: (event, payload) => ipc.broadcast(event, payload),
    powerSaveBlocker,
    watchdogIntervalMs: stateStore.getSetting('watchdogIntervalMs', 15000),
  });

  const info = platform.basicInfo();
  log.info('willLag iniciado', {
    version: app.getVersion(),
    dev: isDev,
    platform: info.platform,
    windows: info.windowsVersion,
    build: info.windowsBuild,
    userData,
  });

  const validation = registry.validate();
  if (!validation.ok) {
    log.error('Catálogo de tweaks inválido', { problems: validation.problems });
  } else {
    log.info('Catálogo de tweaks validado', { count: validation.count });
  }
}

/* ------------------------------------------------------------------ */
/* Janela                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a1a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Segurança: renderer sem Node e isolado. A ponte é window.willlag.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
    icon: path.join(__dirname, 'icon.ico'),
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    if (process.env.WILLLAG_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../build/index.html'));
  }

  // Links externos abrem no navegador do sistema, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      require('electron').shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith('http://localhost:3000') : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });

  mainWindow.webContents.on('destroyed', () => {
    if (ipcController) ipcController.stopAllPings();
  });

  mainWindow.on('closed', () => {
    if (ipcController) ipcController.stopAllPings();
    mainWindow = null;
  });

  return mainWindow;
}

/* ------------------------------------------------------------------ */
/* Instância única                                                     */
/* ------------------------------------------------------------------ */

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  log.warn('Outra instância já está aberta — encerrando esta.');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Duas instâncias brigando pelos mesmos tweaks corromperia os backups.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Hardware acceleration                                               */
/* ------------------------------------------------------------------ */

// Mantido o comportamento da v1.0 (evita glitches em drivers antigos).
// Para reativar GPU: WILLLAG_ENABLE_GPU=1
if (process.env.WILLLAG_ENABLE_GPU !== '1') {
  app.disableHardwareAcceleration();
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida                                                       */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  bootstrapServices();

  ipcController = ipc.register(ipcMain, {
    app,
    windowFromEvent: (event) => BrowserWindow.fromWebContents(event.sender) || mainWindow,
    strictAdmin: false,
  });

  // Recuperação de sessão anterior interrompida (crash, kill -9, energia).
  try {
    const recovery = await gameMode.recoverFromCrash({ allowPrompt: false });
    if (recovery.recovered) {
      log.warn('Recuperação pós-crash executada', {
        reason: recovery.reason,
        restored: (recovery.restored || []).length,
      });
      const pendingDialog = recovery.message;
      app.whenReady().then(() => {
        if (mainWindow && pendingDialog) {
          setTimeout(() => {
            ipc.broadcast('recovery-notice', { message: pendingDialog });
          }, 1500);
        }
      });
    }
  } catch (err) {
    log.error('Falha na recuperação pós-crash', { err: err.message });
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Encerramento seguro.
 * `before-quit` é síncrono, então bloqueamos a saída, restauramos e chamamos
 * `app.exit()`. Sem isso, o WLAN AutoConfig ficaria desativado para sempre e o
 * usuário perderia a reconexão automática do Wi-Fi.
 */
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;

  const finish = () => {
    try {
      if (ipcController) ipcController.stopAllPings();
    } catch (err) {
      /* noop */
    }
    stateStore.flush();
    app.exit(0);
  };

  const timeout = setTimeout(() => {
    log.warn('Shutdown excedeu o tempo limite — saindo mesmo assim.');
    finish();
  }, 25000);

  gameMode
    .shutdown({ allowPrompt: false })
    .then(async (res) => {
      await warnIfSessionTweaksRemain();
      return res;
    })
    .catch((err) => {
      log.error('Erro no shutdown', { err: err && err.message });
    })
    .finally(() => {
      clearTimeout(timeout);
      finish();
    });
});

/**
 * Se algum ajuste de sessão não pôde ser revertido (tipicamente porque o app
 * não estava elevado e não podemos abrir UAC no encerramento), avisamos o
 * usuário com o comando exato. Nunca deixamos o sistema "pendurado" em silêncio.
 */
async function warnIfSessionTweaksRemain() {
  try {
    const pending = registry.ALL_TWEAKS.filter((t) => t.scope === 'session' && stateStore.hasBackup(t.id));
    if (pending.length === 0) return;

    const lines = [];
    for (const tweak of pending) {
      const layer = stateStore.peekBackup(tweak.id);
      const entry = layer && layer.entries ? layer.entries[0] : null;
      if (tweak.id === 'wlanAutoconfig' && entry && entry.interfaceName) {
        lines.push(`netsh wlan set autoconfig enabled=yes interface="${entry.interfaceName}"`);
      } else {
        lines.push(`${tweak.label}: reverta pela aba "Ultra Low-Latency" na próxima abertura.`);
      }
    }

    log.warn('Ajustes de sessão pendentes no encerramento', { ids: pending.map((p) => p.id) });

    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'willLag — ajustes pendentes',
        message: 'Alguns ajustes temporários não puderam ser revertidos automaticamente.',
        detail:
          'Isso acontece quando o willLag é fechado sem privilégios de Administrador.\n\n' +
          'Para restaurar agora, execute em um Prompt de Comando como Administrador:\n\n' +
          lines.join('\n') +
          '\n\nOu abra o willLag novamente e clique em "Reverter tudo".',
        buttons: ['Entendi'],
        noLink: true,
      });
    }
  } catch (err) {
    log.error('Falha ao avisar sobre ajustes pendentes', { err: err.message });
  }
}

/* ------------------------------------------------------------------ */
/* Falhas não tratadas — nunca derrubar sem restaurar                  */
/* ------------------------------------------------------------------ */

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { message: err && err.message, stack: err && err.stack });
  if (!shuttingDown) {
    shuttingDown = true;
    gameMode
      .shutdown({ allowPrompt: false })
      .catch(() => {})
      .finally(() => app.exit(1));
  }
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: String(reason && reason.message ? reason.message : reason) });
});

/* SIGINT/SIGTERM (fechamento via terminal) também restauram. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    gameMode
      .shutdown({ allowPrompt: false })
      .catch(() => {})
      .finally(() => app.exit(0));
  });
}

module.exports = { createWindow, bootstrapServices };
