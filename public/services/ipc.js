'use strict';

/**
 * Registro de handlers IPC.
 *
 * Regra de compatibilidade: TODOS os canais da versão 1.0 continuam existindo
 * com o mesmo formato de resposta, para não quebrar Dashboard/ProcessList/
 * NetworkMonitor/Optimizer/DNSChanger. Os canais novos são aditivos.
 *
 * Segurança: todo argumento vindo do renderer é validado aqui (PID numérico,
 * prioridade em whitelist, nome de processo/host sanitizado). O renderer roda
 * com conteúdo local, mas validação na fronteira é barata e evita que qualquer
 * falha de UI vire execução de comando arbitrário como Administrador.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const ps = require('./psRunner');
const platform = require('./platform');
const elevation = require('./elevation');
const stateStore = require('./stateStore');
const netif = require('./netInterfaces');
const probe = require('./latencyProbe');
const tcpip = require('./tcpip');
const wifi = require('./wifi');
const dnsService = require('./dnsService');
const mtuService = require('./mtuService');
const registry = require('./tweakRegistry');
const gameMode = require('./gameMode');
const reg = require('./registryOps');
const logger = require('./logger');

const log = logger.scope('ipc');

const PRIORITIES = ['Realtime', 'High', 'AboveNormal', 'Normal', 'BelowNormal', 'Idle'];

let pingTimers = new Map(); // windowId -> { timer, host }

function getWindows() {
  try {
    // eslint-disable-next-line global-require
    const { BrowserWindow } = require('electron');
    return BrowserWindow.getAllWindows();
  } catch (err) {
    return [];
  }
}

function broadcast(event, payload) {
  for (const win of getWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send(event, payload);
    } catch (err) {
      log.debug('broadcast falhou', { event, err: err.message });
    }
  }
}

function sendTo(event, payload, webContents) {
  try {
    if (webContents && !webContents.isDestroyed()) webContents.send(event, payload);
    else broadcast(event, payload);
  } catch (err) {
    log.debug('sendTo falhou', { event, err: err.message });
  }
}

/* ------------------------------------------------------------------ */
/* Validações                                                          */
/* ------------------------------------------------------------------ */

function validPid(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 0 && n <= 4294967295 ? n : null;
}

function validPriority(priority) {
  const p = String(priority || '');
  // A v1.0 oferecia 'Low' no select, mas ProcessPriorityClass não aceita 'Low'
  // (o valor válido é 'Idle'). Mantemos o alias para não quebrar a UI antiga.
  if (p.toLowerCase() === 'low') return 'Idle';
  return PRIORITIES.find((x) => x.toLowerCase() === p.toLowerCase()) || null;
}

function validProcessName(name) {
  const base = String(name || '')
    .replace(/[^\w\s\-.+()[\]À-ú]/g, '')
    .trim()
    .slice(0, 120);
  if (!base) return null;
  return base.toLowerCase().endsWith('.exe') ? base : base;
}

function validIp(value) {
  const v = String(value || '').trim();
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((o) => Number(o) <= 255) ? v : null;
}

/* ------------------------------------------------------------------ */
/* Registro                                                            */
/* ------------------------------------------------------------------ */

function register(ipcMain, options = {}) {
  const app = options.app || null;

  /* =============== JANELA (legado) =============== */
  ipcMain.on('minimize-window', (event) => {
    const win = options.windowFromEvent ? options.windowFromEvent(event) : null;
    if (win) win.minimize();
  });

  ipcMain.on('maximize-window', (event) => {
    const win = options.windowFromEvent ? options.windowFromEvent(event) : null;
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on('close-window', (event) => {
    const win = options.windowFromEvent ? options.windowFromEvent(event) : null;
    if (win) win.close();
  });

  /* =============== ADMIN / ELEVACAO =============== */
  ipcMain.handle('check-admin', async () => elevation.isAdmin());

  ipcMain.handle('get-elevation-status', async () => elevation.getStatus());

  ipcMain.handle('relaunch-as-admin', async () => {
    const res = await elevation.relaunchAsAdmin(app, {
      beforeQuit: () => {
        gameMode.shutdown({ allowPrompt: false }).catch(() => {});
      },
    });
    return res;
  });

  /* =============== CONTEXTO / SISTEMA =============== */
  ipcMain.handle('get-system-context', async () => {
    const info = platform.basicInfo();
    const feats = await platform.features().catch(() => ({}));
    const elev = await elevation.getStatus();
    const snapshot = await netif.getSnapshot().catch(() => ({ ok: false, adapters: [] }));
    const validation = registry.validate();

    return {
      platform: info,
      features: feats,
      elevation: elev,
      activeAdapter: snapshot.activeAdapter || null,
      gateway: snapshot.gateway || null,
      adapterCount: (snapshot.adapters || []).length,
      wifiAdapters: (snapshot.wifiAdapters || []).map((a) => ({
        name: a.name,
        description: a.description,
        isUsb: a.isUsb,
        connected: a.connected,
        linkSpeed: a.linkSpeed,
      })),
      catalogValid: validation.ok,
      catalogProblems: validation.problems,
      stateDir: stateStore.getDir(),
      settings: stateStore.getSettings(),
      gamemode: gameMode.status(),
    };
  });

  ipcMain.handle('get-network-snapshot', async (event, opts = {}) => {
    const snap = await netif.getSnapshot({ force: Boolean(opts.force) });
    return snap;
  });

  // Legado: formato esperado pelo Dashboard [{ name, address, netmask, mac }]
  ipcMain.handle('get-network-info', async () => {
    const interfaces = os.networkInterfaces();
    const info = [];
    for (const [name, nets] of Object.entries(interfaces)) {
      for (const n of nets || []) {
        if (n.family === 'IPv4' && !n.internal) {
          info.push({ name, address: n.address, netmask: n.netmask, mac: n.mac });
        }
      }
    }
    return info;
  });

  ipcMain.handle('get-adapters', async () => netif.getAdapters({ force: true }));

  ipcMain.handle('get-wifi-diagnostics', async () => wifi.getWifiDiagnostics({}));

  /* =============== TWEAKS =============== */
  ipcMain.handle('get-tweaks', async () => registry.getCatalog());

  ipcMain.handle('get-tweaks-detailed', async (event, opts = {}) =>
    registry.getDetailed({ concurrency: opts.concurrency || 3, force: Boolean(opts.force) })
  );

  ipcMain.handle('detect-tweak', async (event, id, opts = {}) => {
    if (typeof id !== 'string' || !registry.byId(id)) {
      return { ok: false, code: 'UNKNOWN_TWEAK', error: `Tweak desconhecido: ${id}` };
    }
    return registry.detect(id, { force: Boolean(opts.force) });
  });

  ipcMain.handle('detect-all-tweaks', async (event, opts = {}) => registry.detectAll({ force: true, concurrency: opts.concurrency || 3 }));

  ipcMain.handle('apply-tweak', async (event, id, params = {}) => {
    if (typeof id !== 'string' || !registry.byId(id)) {
      return { success: false, code: 'UNKNOWN_TWEAK', applied: false, message: `Tweak desconhecido: ${id}` };
    }
    const res = await registry.apply(id, { params: sanitizeParams(params), by: 'user' });
    broadcast('tweak-updated', { id, result: res });
    return res;
  });

  ipcMain.handle('revert-tweak', async (event, id, params = {}) => {
    if (typeof id !== 'string' || !registry.byId(id)) {
      return { success: false, code: 'UNKNOWN_TWEAK', applied: false, message: `Tweak desconhecido: ${id}` };
    }
    const res = await registry.revert(id, { params: sanitizeParams(params), by: 'user' });
    broadcast('tweak-updated', { id, result: res });
    return res;
  });

  ipcMain.handle('apply-tweaks', async (event, idsOrPreset, params = {}) => {
    const res = await registry.applyMany(idsOrPreset, { params: sanitizeParams(params), by: 'user' });
    broadcast('tweaks-updated', { result: res });
    return res;
  });

  ipcMain.handle('revert-tweaks', async (event, idsOrPreset) => {
    const res = await registry.revertMany(idsOrPreset, { by: 'user' });
    broadcast('tweaks-updated', { result: res });
    return res;
  });

  ipcMain.handle('revert-all', async () => {
    const res = await registry.revertAll({ by: 'user' });
    broadcast('tweaks-updated', { result: res });
    return res;
  });

  /* =============== BACKUPS / ESTADO =============== */
  ipcMain.handle('get-backups', async () => ({
    ok: true,
    backups: stateStore.allBackups(),
    applied: stateStore.appliedMap(),
    history: stateStore.getHistory(100),
    dir: stateStore.getDir(),
  }));

  ipcMain.handle('export-backup-reg', async (event, targetPath) => {
    const dir = stateStore.getDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.join(dir, 'backups');
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (err) {
      return { success: false, error: `Não foi possível criar a pasta de backups: ${err.message}` };
    }

    const file = targetPath || path.join(outDir, `willlag-network-backup-${stamp}.reg`);
    const keys = [
      'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters',
      'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile',
    ];

    const results = [];
    for (const key of keys) {
      const res = await reg.exportKeyToFile(key, file.replace(/\.reg$/, '') + '-' + path.basename(key) + '.reg');
      results.push({ key, ...res });
    }

    // Também exporta o bundle JSON (reversão fina pelo próprio app).
    const jsonFile = file.replace(/\.reg$/, '.json');
    try {
      fs.writeFileSync(jsonFile, JSON.stringify(stateStore.exportBundle(), null, 2), 'utf8');
    } catch (err) {
      results.push({ key: 'json-bundle', success: false, error: err.message });
    }

    return {
      success: results.some((r) => r.success),
      files: results.filter((r) => r.success).map((r) => r.file || jsonFile),
      jsonFile,
      results,
      message: `Backups exportados para ${outDir}`,
    };
  });

  ipcMain.handle('export-state-bundle', async () => ({ ok: true, bundle: stateStore.exportBundle() }));

  ipcMain.handle('import-state-bundle', async (event, bundle) => stateStore.importBundle(bundle));

  ipcMain.handle('get-settings', async () => stateStore.getSettings());

  ipcMain.handle('set-settings', async (event, patch = {}) => {
    const allowed = [
      'ultraPreset',
      'autoRestoreOnQuit',
      'watchdogEnabled',
      'watchdogIntervalMs',
      'dnsProvider',
      'mtu',
      'selectedTweaks',
      'systemResponsiveness',
      'congestionProvider',
      'autoTuning',
      'ecn',
    ];
    const clean = {};
    for (const key of allowed) {
      if (patch[key] !== undefined) clean[key] = patch[key];
    }
    if (clean.watchdogIntervalMs !== undefined) {
      clean.watchdogIntervalMs = Math.max(5000, Math.min(120000, Number(clean.watchdogIntervalMs) || 15000));
    }
    const settings = stateStore.updateSettings(clean);
    return { ok: true, settings };
  });

  ipcMain.handle('get-logs', async (event, limit = 200) => ({
    ok: true,
    entries: logger.getEntries(Number(limit) || 200),
  }));

  /* =============== MODO ULTRA LOW-LATENCY =============== */
  ipcMain.handle('gamemode-status', async () => gameMode.status());

  ipcMain.handle('gamemode-start', async (event, opts = {}) => {
    const res = await gameMode.start({
      preset: typeof opts.preset === 'string' ? opts.preset : 'ultra',
      tweakIds: Array.isArray(opts.tweakIds) ? opts.tweakIds.filter((i) => registry.byId(i)) : null,
      skipBaseline: Boolean(opts.skipBaseline),
      allowPrompt: opts.allowPrompt !== false,
    });
    broadcast('tweaks-updated', { result: { source: 'gamemode-start', ...res } });
    return res;
  });

  ipcMain.handle('gamemode-stop', async (event, opts = {}) => {
    const res = await gameMode.stop({
      reason: opts.reason || 'user',
      restore: opts.restore !== false,
      allowPrompt: opts.allowPrompt !== false,
    });
    broadcast('tweaks-updated', { result: { source: 'gamemode-stop', ...res } });
    return res;
  });

  ipcMain.handle('gamemode-toggle', async (event, opts = {}) => {
    const active = gameMode.status().active;
    return active ? gameMode.stop({ reason: 'user-toggle', ...opts }) : gameMode.start(opts);
  });

  ipcMain.handle('gamemode-benchmark', async (event, opts = {}) =>
    gameMode.benchmarkConnection({
      rounds: Math.min(10, Number(opts.rounds) || 4),
      hosts: Array.isArray(opts.hosts) && opts.hosts.length ? opts.hosts.filter(ps.isSafeHost) : ['1.1.1.1', '8.8.8.8'],
    })
  );

  ipcMain.handle('check-connectivity', async () => gameMode.checkConnectivity());

  /* =============== DNS =============== */
  ipcMain.handle('dns-providers', async () => ({ ok: true, providers: dnsService.PROVIDERS }));

  ipcMain.handle('dns-benchmark', async (event, opts = {}) => {
    const sender = event && event.sender;
    return dnsService.benchmark({
      rounds: Math.min(10, Number(opts.rounds) || 4),
      timeoutMs: Math.min(6000, Number(opts.timeoutMs) || 2000),
      includeIcmp: Boolean(opts.includeIcmp),
      providers: Array.isArray(opts.providers) && opts.providers.length ? opts.providers : undefined,
      onProgress: (p) => sendTo('dns-benchmark-progress', p, sender),
    });
  });

  ipcMain.handle('dns-current', async () => {
    const current = await dnsService.getCurrentDns();
    const adapter = await netif.getActiveAdapter();
    return {
      ok: true,
      servers: current,
      provider: dnsService.findProviderByServers(current),
      interface: adapter ? adapter.name : null,
      ifIndex: adapter ? adapter.ifIndex : null,
      source: adapter ? await dnsService.getDnsSource(adapter.ifIndex) : null,
    };
  });

  ipcMain.handle('dns-apply', async (event, serversOrProvider, opts = {}) => {
    let servers;
    let providerId = null;

    if (typeof serversOrProvider === 'string') {
      const provider = dnsService.PROVIDERS.find((p) => p.id === serversOrProvider);
      if (provider) {
        servers = [provider.primary, provider.secondary];
        providerId = provider.id;
      } else {
        servers = [serversOrProvider, opts.secondary].filter(Boolean);
      }
    } else if (Array.isArray(serversOrProvider)) {
      servers = serversOrProvider;
    } else {
      return { success: false, code: 'INVALID_INPUT', message: 'Informe um provedor ou lista de servidores DNS.' };
    }

    const res = await dnsService.applyDns(servers, {}, { tweakId: 'autoDns', providerId });
    broadcast('tweak-updated', { id: 'autoDns', result: res });
    return res;
  });

  ipcMain.handle('dns-restore', async () => {
    const res = await dnsService.restoreDns({}, { tweakId: 'autoDns' });
    broadcast('tweak-updated', { id: 'autoDns', result: res });
    return res;
  });

  // Legado (v1.0): change-dns(primary, secondary)
  ipcMain.handle('change-dns', async (event, primary, secondary) => {
    const p = validIp(primary);
    const s = validIp(secondary);
    if (!p) return { success: false, message: `Endereço DNS primário inválido: "${primary}"` };
    if (!(await elevation.isAdmin()) && options.strictAdmin) {
      return { success: false, message: 'Necessário executar como Administrador!' };
    }
    const res = await dnsService.applyDns(s ? [p, s] : [p], {}, { tweakId: 'autoDns' });
    return res.success
      ? { success: true, message: `DNS alterado para ${p}${s ? ' / ' + s : ''} na interface ${res.interface}` }
      : { success: false, message: res.message || res.error || 'Falha ao alterar DNS.' };
  });

  // Legado (v1.0)
  ipcMain.handle('flush-dns', async () => {
    const res = await dnsService.flushCache();
    return { success: res.success, message: res.message };
  });

  ipcMain.handle('dns-cache', async (event, limit = 60) => dnsService.readCache(limit));

  /* =============== MTU =============== */
  ipcMain.handle('mtu-get', async () => {
    const adapter = await netif.getActiveAdapter();
    if (!adapter) return { ok: false, error: 'Nenhuma interface ativa.' };
    const current = await mtuService.getCurrentMtu(adapter.ifIndex);
    return { ok: true, adapter: { name: adapter.name, ifIndex: adapter.ifIndex, isWifi: adapter.isWifi }, ...current };
  });

  ipcMain.handle('mtu-discover', async (event, opts = {}) => {
    const sender = event && event.sender;
    return mtuService.discover({
      ifIndex: opts.ifIndex,
      targets: Array.isArray(opts.targets) && opts.targets.length ? opts.targets.filter(ps.isSafeHost) : undefined,
      onStep: (s) => sendTo('mtu-progress', s, sender),
    });
  });

  ipcMain.handle('mtu-apply', async (event, mtu, opts = {}) => {
    if (!mtuService.isValidMtu(mtu)) {
      return { success: false, code: 'INVALID_MTU', message: `MTU inválido: ${mtu}. Use um valor entre 576 e 9000.` };
    }
    const res = await mtuService.applyMtu(Number(mtu), {}, { tweakId: 'mtuOptimize', ifIndex: opts.ifIndex });
    broadcast('tweak-updated', { id: 'mtuOptimize', result: res });
    return res;
  });

  ipcMain.handle('mtu-restore', async () => {
    const res = await mtuService.restoreMtu({}, { tweakId: 'mtuOptimize' });
    broadcast('tweak-updated', { id: 'mtuOptimize', result: res });
    return res;
  });

  ipcMain.handle('mtu-auto-optimize', async (event, opts = {}) => registry.apply('mtuOptimize', { params: opts }));

  /* =============== PING / LATENCIA =============== */
  // Legado (v1.0): { host, ms, status }
  ipcMain.handle('ping-host', async (event, host) => {
    if (!ps.isSafeHost(host)) return { host, ms: -1, status: 'invalid-host' };
    const stats = await probe.icmpProbe(host, { count: 1, timeoutMs: 3000 });
    const ms = stats.success > 0 ? Math.round(stats.avg) : -1;
    return { host, ms, status: ms >= 0 ? 'ok' : 'timeout' };
  });

  /** Estatísticas completas (média, p95, jitter, perda) para um host. */
  ipcMain.handle('ping-stats', async (event, host, opts = {}) => {
    if (!ps.isSafeHost(host)) return { ok: false, error: `Host inválido: "${host}"` };
    const stats = await probe.probeHost(host, {
      rounds: Math.min(20, Number(opts.rounds) || 5),
      method: opts.method || 'auto',
      timeoutMs: Math.min(6000, Number(opts.timeoutMs) || 2000),
    });
    return { ok: true, host, ...stats, grade: probe.gradeLatency(stats) };
  });

  // Legado (v1.0): monitoramento contínuo via 'ping-result'
  ipcMain.on('start-ping-monitor', (event, host) => {
    const id = event && event.sender ? event.sender.id : 'default';
    if (!ps.isSafeHost(host)) {
      sendTo('ping-result', { host, ms: -1, status: 'invalid-host', timestamp: Date.now() }, event.sender);
      return;
    }

    stopPingFor(id);

    const run = async () => {
      const stats = await probe.icmpProbe(host, { count: 1, timeoutMs: 2000 });
      const ms = stats.success > 0 ? Math.round(stats.avg) : -1;
      sendTo(
        'ping-result',
        {
          host,
          ms,
          timestamp: Date.now(),
          // Campos novos (aditivos): UI antiga ignora, nova aproveita.
          jitter: Math.round((stats.jitter || 0) * 10) / 10,
          lossPercent: Math.round((stats.lossPercent || 0) * 10) / 10,
        },
        event.sender
      );
    };

    run();
    const timer = setInterval(() => {
      run().catch((err) => log.debug('ping monitor erro', { err: err.message }));
    }, 1000);

    pingTimers.set(id, { timer, host, sender: event.sender });
  });

  ipcMain.on('stop-ping-monitor', (event) => {
    const id = event && event.sender ? event.sender.id : 'default';
    stopPingFor(id);
  });

  function stopPingFor(id) {
    const entry = pingTimers.get(id);
    if (entry) {
      clearInterval(entry.timer);
      pingTimers.delete(id);
    }
  }

  ipcMain.on('cleanup-webcontents', (event) => {
    const id = event && event.sender ? event.sender.id : null;
    if (id !== null) stopPingFor(id);
  });

  // Legado (v1.0): speed-test retorna [{ name, host, avgMs, status }]
  ipcMain.handle('speed-test', async () => {
    const hosts = [
      { name: 'Google DNS', host: '8.8.8.8' },
      { name: 'Cloudflare', host: '1.1.1.1' },
      { name: 'OpenDNS', host: '208.67.222.222' },
      { name: 'Quad9', host: '9.9.9.9' },
      { name: 'Google', host: 'google.com' },
      { name: 'AWS São Paulo', host: 'sa-east-1.amazonaws.com' },
    ];

    const out = [];
    for (const { name, host } of hosts) {
      if (!ps.isSafeHost(host)) {
        out.push({ name, host, avgMs: -1, status: 'invalid-host' });
        continue;
      }
      const stats = await probe.icmpProbe(host, { count: 3, timeoutMs: 2000 });
      out.push({
        name,
        host,
        avgMs: stats.success > 0 ? Math.round(stats.avg) : -1,
        status: stats.success > 0 ? 'ok' : 'error',
        // aditivos:
        jitter: Math.round((stats.jitter || 0) * 10) / 10,
        lossPercent: Math.round((stats.lossPercent || 0) * 10) / 10,
        p95: stats.p95 === null ? null : Math.round(stats.p95),
      });
    }
    return out;
  });

  /* =============== PROCESSOS (legado + melhorias) =============== */
  ipcMain.handle('get-processes', async () => {
    const res = await ps.runPowerShell(
      `
$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
  [pscustomobject]@{
    Id            = $_.Id
    ProcessName   = "$($_.ProcessName)"
    MainWindowTitle = "$($_.MainWindowTitle)"
    WorkingSet    = $_.WorkingSet64
    CPU           = $_.CPU
    PriorityClass = "$($_.PriorityClass)"
    Responding    = [bool]$_.Responding
  }
})
Write-WillLagJson @{ ok = $true; items = @($procs) }
`,
      { label: 'processes:list', timeout: 30000 }
    );

    if (!res.success) return [];

    return ps.asArray(res.data && res.data.items).map((p) => ({
      pid: p.Id,
      name: p.ProcessName,
      title: p.MainWindowTitle,
      memory: Math.round((Number(p.WorkingSet) || 0) / 1024 / 1024),
      cpu: p.CPU ? parseFloat(p.CPU).toFixed(1) : '0.0',
      // aditivos (não quebram a UI antiga):
      priority: p.PriorityClass || null,
      responding: p.Responding !== false,
    }));
  });

  ipcMain.handle('get-network-connections', async () => {
    const res = await ps.runPowerShell(
      `
$conns = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
  Where-Object { $_.RemoteAddress -ne '127.0.0.1' -and $_.RemoteAddress -ne '::1' } |
  Select-Object -First 40 |
  ForEach-Object {
    [pscustomobject]@{
      OwningProcess = $_.OwningProcess
      LocalPort     = $_.LocalPort
      RemoteAddress = "$($_.RemoteAddress)"
      RemotePort    = $_.RemotePort
      State         = "$($_.State)"
    }
  })
Write-WillLagJson @{ ok = $true; items = @($conns) }
`,
      { label: 'net:connections', timeout: 30000 }
    );

    if (!res.success) return [];

    return ps.asArray(res.data && res.data.items).map((c) => ({
      pid: c.OwningProcess,
      localPort: c.LocalPort,
      remoteAddress: c.RemoteAddress,
      remotePort: c.RemotePort,
      state: c.State,
    }));
  });

  // Legado (v1.0)
  ipcMain.handle('set-process-priority', async (event, pid, priority) => {
    const p = validPid(pid);
    const pr = validPriority(priority);
    if (!p) return { success: false, message: `PID inválido: ${pid}` };
    if (!pr) return { success: false, message: `Prioridade inválida: ${priority}` };

    const res = await ps.runPowerShell(
      `
$proc = Get-Process -Id ${p} -ErrorAction SilentlyContinue
if (-not $proc) { Write-WillLagJson @{ ok = $false; error = 'Processo não encontrado' }; return }
try {
  $proc.PriorityClass = '${pr}'
  Write-WillLagJson @{ ok = $true; priority = "$($proc.PriorityClass)" }
} catch {
  Write-WillLagJson @{ ok = $false; error = $_.Exception.Message }
}
`,
      { label: `proc:priority:${p}` }
    );

    if (!res.success) {
      const msg = String((res.data && res.data.error) || res.error || '');
      if (/privil|permission|denied|acesso/i.test(msg)) {
        return {
          success: false,
          code: 'ACCESS_DENIED',
          message: `Sem permissão para alterar a prioridade do PID ${p}. Processos elevados exigem que o willLag também esteja elevado.`,
        };
      }
      return { success: false, code: res.code, message: msg || 'Falha ao alterar prioridade.' };
    }
    if (res.data && res.data.ok === false) return { success: false, message: res.data.error };

    return { success: true, message: `Prioridade do PID ${p} definida como ${pr}` };
  });

  // Legado (v1.0)
  ipcMain.handle('set-network-priority', async (event, processName) => {
    const name = validProcessName(processName);
    if (!name) return { success: false, message: 'Nome de processo inválido.' };

    const res = await ps.runPowerShell(
      `
Remove-NetQosPolicy -Name 'GamePriority' -Confirm:$false -ErrorAction SilentlyContinue
New-NetQosPolicy -Name 'GamePriority' -AppPathNameMatchCondition ${ps.psString(name + '.exe')} -DSCPAction 46 -NetworkProfile All -Confirm:$false -ErrorAction Stop
Write-WillLagJson @{ ok = $true }
`,
      { label: 'qos:create' }
    );

    if (!res.success) {
      return {
        success: false,
        code: res.code,
        message:
          res.code === 'UAC_DENIED'
            ? res.error
            : `Erro ao criar política QoS: ${res.error || 'desconhecido'}`,
      };
    }

    stateStore.pushBackup('qosGamePriority', [{ kind: 'qosPolicy', name: 'GamePriority', existed: false }]);
    stateStore.markApplied('qosGamePriority', { scope: 'persistent', params: { processName: name } });

    return { success: true, message: `Prioridade de rede máxima (DSCP 46) configurada para ${name}.exe` };
  });

  // Legado (v1.0)
  ipcMain.handle('optimize-for-process', async (event, pid, processName) => {
    const p = validPid(pid);
    const name = validProcessName(processName);
    if (!p) return { success: false, message: `PID inválido: ${pid}` };

    const results = [];

    const prio = await ps.runPowerShell(
      `
$proc = Get-Process -Id ${p} -ErrorAction SilentlyContinue
if ($proc) { $proc.PriorityClass = 'High' }
Write-WillLagJson @{ ok = [bool]$proc }
`,
      { label: `proc:boost:${p}` }
    );
    results.push(prio.success && prio.data && prio.data.ok ? '✅ Prioridade do processo definida como Alta' : '❌ Erro ao definir prioridade do processo');

    const cpuCount = os.cpus().length;
    const affinity = Math.pow(2, Math.min(cpuCount, 62)) - 1;
    const aff = await ps.runPowerShell(
      `
$proc = Get-Process -Id ${p} -ErrorAction SilentlyContinue
if ($proc) { $proc.ProcessorAffinity = [IntPtr]${affinity} }
Write-WillLagJson @{ ok = [bool]$proc }
`,
      { label: `proc:affinity:${p}` }
    );
    results.push(aff.success && aff.data && aff.data.ok ? `✅ Afinidade de CPU definida (${cpuCount} cores)` : '❌ Erro ao definir afinidade de CPU');

    if (name) {
      const qos = await ps.runPowerShell(
        `
Remove-NetQosPolicy -Name 'GameBoost' -Confirm:$false -ErrorAction SilentlyContinue
New-NetQosPolicy -Name 'GameBoost' -AppPathNameMatchCondition ${ps.psString(name + '.exe')} -DSCPAction 46 -NetworkProfile All -Confirm:$false -ErrorAction Stop
Write-WillLagJson @{ ok = $true }
`,
        { label: 'qos:boost' }
      );
      results.push(qos.success ? '✅ Política QoS de alta prioridade aplicada' : '⚠️ QoS: pode precisar de reinicialização');
      if (qos.success) {
        stateStore.pushBackup('qosGameBoost', [{ kind: 'qosPolicy', name: 'GameBoost', existed: false }]);
        stateStore.markApplied('qosGameBoost', { scope: 'persistent', params: { processName: name } });
      }
    }

    return { success: true, message: `Otimizações aplicadas para ${name || 'PID ' + p}`, details: results };
  });

  /* =============== LEGADO: otimizações TCP =============== */
  ipcMain.handle('optimize-tcp', async () => {
    if (!(await elevation.isAdmin())) {
      // Não bloqueamos mais: elevamos sob demanda. Mas mantemos a mensagem
      // original caso o UAC seja negado.
      log.info('optimize-tcp sem admin — tentando elevação sob demanda');
    }

    const res = await registry.applyMany('legacy', { by: 'legacy-optimize-tcp' });
    return {
      success: res.success || res.code === 'PARTIAL',
      message: res.success
        ? 'Otimizações TCP aplicadas!'
        : res.code === 'PARTIAL'
          ? 'Otimizações TCP aplicadas parcialmente (alguns parâmetros não existem nesta versão do Windows).'
          : 'Necessário executar como Administrador!',
      details: res.results.map((r) => ({ cmd: `${r.id}: ${r.current || r.target || ''}`, success: r.success, error: r.error })),
    };
  });

  // Legado (v1.0)
  ipcMain.handle('disable-nagle', async () => {
    const res = await registry.apply('nagle', { by: 'legacy-disable-nagle' });
    return {
      success: res.success,
      message: res.success ? res.message : res.message || 'Necessário executar como Administrador!',
      details: res.details,
    };
  });

  // Legado (v1.0)
  ipcMain.handle('reset-optimizations', async () => {
    const res = await registry.revertAll({ by: 'legacy-reset' });

    // Mantém o comportamento antigo de também remover políticas QoS e limpar DNS.
    for (const id of ['qosGamePriority', 'qosGameBoost']) {
      const layer = stateStore.peekBackup(id);
      if (layer && layer.entries) {
        await require('./restoreEngine').restoreEntries(layer.entries, { isAdmin: elevation.isAdmin });
        stateStore.consumeBackup(id);
        stateStore.markReverted(id);
      }
    }
    await dnsService.flushCache();

    return {
      success: res.success || res.code === 'PARTIAL',
      message: res.success ? 'Configurações restauradas ao padrão!' : res.message,
      details: res.results ? res.results.map((r) => `${r.success ? '✅' : '❌'} ${r.label}`) : [],
    };
  });

  /* =============== TCP GLOBAL (leitura p/ UI) =============== */
  ipcMain.handle('get-tcp-global', async (event, opts = {}) => tcpip.getTcpGlobal({ force: Boolean(opts.force) }));

  return {
    broadcast,
    stopPingFor,
    stopAllPings() {
      for (const id of [...pingTimers.keys()]) stopPingFor(id);
    },
  };
}

/** Remove qualquer campo não serializável/inesperado vindo do renderer. */
function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.filter((v) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 32);
  }
  return out;
}

module.exports = {
  register,
  broadcast,
  sanitizeParams,
  validPid,
  validPriority,
  validProcessName,
  validIp,
  PRIORITIES,
};
