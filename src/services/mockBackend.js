/**
 * Backend simulado ("modo demonstração").
 *
 * Usado SOMENTE quando o renderer roda fora do Electron (ex.: `npm start` e
 * abre no navegador). Permite desenvolver, revisar e demonstrar toda a UI sem
 * uma máquina Windows — e sem risco nenhum, porque nada aqui toca o sistema.
 *
 * O catálogo vem de src/shared/tweakCatalog.json, que é GERADO a partir do
 * código real do processo principal (scripts/sync-tweak-catalog.js). Ou seja:
 * a demonstração mostra exatamente os mesmos tweaks, textos e riscos do app.
 */

import catalog from '../shared/tweakCatalog.json';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

const FAKE = {
  platform: {
    platform: 'win32',
    arch: 'x64',
    release: '10.0.22631',
    hostname: 'GAMER-PC',
    isWindows: true,
    windowsBuild: 22631,
    windowsVersion: 'Windows 11',
    isModernWindows: true,
    cpus: 8,
    totalMemoryMB: 32687,
    uptimeSec: 4213,
    simulated: true,
  },
  adapter: {
    name: 'Wi-Fi',
    description: 'Realtek 8822CU Wireless LAN 802.11ac USB NIC',
    ifIndex: 12,
    guid: '{a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d}',
    status: 'Up',
    linkSpeed: '433 Mbps',
    mac: 'A4:5E:60:12:34:56',
    mediaType: '802.11',
    physicalMediaType: 'Native 802.11',
    pnpDeviceId: 'USB\\VID_0BDA&PID_C822\\5&1a2b3c4d&0&3',
    isWifi: true,
    isUsb: true,
    connected: true,
    mtu: 1500,
    dhcp: 'Enabled',
    ipAddress: '192.168.15.42',
    prefixLength: 24,
    gateway: '192.168.15.1',
    dnsServers: ['192.168.15.1'],
    driverVersion: '2024.0.10.129',
    driverDate: '2023-11-02',
    autoconfigEnabled: true,
    wlan: {
      name: 'Wi-Fi',
      state: 'conectado',
      ssid: 'CASA-5G',
      bssid: 'b4:5e:7c:aa:bb:cc',
      radioType: '802.11ac',
      authentication: 'WPA2-Personal',
      cipher: 'CCMP',
      channel: 6,
      receiveRateMbps: '390',
      transmitRateMbps: '175.5',
      signalPercent: '72%',
      profile: 'CASA-5G',
    },
  },
};

/** Estado "Windows sem otimizar" usado pelo detect() simulado. */
const BASELINE_STATE = {
  nagle: {
    applied: false,
    current: 'Wi-Fi: padrão (Nagle ativo)',
    target: 'TcpAckFrequency=1, TCPNoDelay=1, TcpDelAckTicks=0',
    interfaces: [
      { name: 'Wi-Fi', optimized: false, current: { TcpAckFrequency: null, TCPNoDelay: null, TcpDelAckTicks: null } },
    ],
  },
  networkThrottling: { applied: false, current: '10', target: '0xffffffff (4294967295)' },
  systemResponsiveness: { applied: false, current: '20', target: '0' },
  mmcssGames: {
    applied: false,
    current: 'GPU Priority=1, Priority=1, Scheduling Category=Medium, SFIO Priority=Normal',
    target: 'GPU Priority=8, Priority=6, Scheduling Category=High, SFIO Priority=High',
  },
  autoTuning: { applied: true, current: 'normal', target: 'normal', effective: 'normal', reason: 'Global' },
  ecn: { applied: true, current: 'disabled', target: 'disabled' },
  tcpFastOpen: { applied: false, current: 'disabled', target: 'enabled' },
  rss: { applied: true, current: 'enabled', target: 'enabled' },
  rsc: { applied: false, current: 'enabled', target: 'disabled' },
  timestamps: { applied: true, current: 'disabled', target: 'disabled' },
  initialRto: { applied: false, current: '3000', target: '1000' },
  chimneyOffload: {
    applied: false,
    supported: false,
    reason: 'TCP Chimney Offload foi removido a partir do Windows 8.',
    current: null,
    target: null,
  },
  congestionProvider: {
    applied: false,
    current: 'cubic',
    target: 'ctcp',
    available: ['ctcp', 'cubic'],
    bbrAvailable: false,
    note: 'BBR não é suportado pela pilha TCP/IP nativa do Windows.',
  },
  qosReservedBandwidth: { applied: false, current: 'não definido (padrão 20%)', target: '0%' },
  wlanAutoconfig: { applied: false, current: 'autoconfig ativo (varredura ligada)', target: 'autoconfig pausado durante o jogo', interfaceName: 'Wi-Fi', isUsb: true },
  usbSelectiveSuspend: { applied: false, current: 'AC=ativado / DC=ativado', target: 'AC=0 / DC=0 (desativado)' },
  adapterPowerManagement: {
    applied: false,
    current: 'AllowComputerToTurnOffDevice=Enabled, DeviceSleepOnDisconnect=Enabled, SelectiveSuspend=Enabled, D0PacketCoalescing=Enabled',
    target: 'AllowComputerToTurnOffDevice=Disabled, DeviceSleepOnDisconnect=Disabled, SelectiveSuspend=Disabled, D0PacketCoalescing=Disabled',
    adapter: 'Wi-Fi',
  },
  adapterPowerSaveAdvanced: {
    applied: false,
    supported: true,
    current: 'Power Saving Mode=Enabled, Roaming Aggressiveness=Medium, Advanced EEE=Enabled',
    target: 'Power Saving Mode=Disabled, Roaming Aggressiveness=Lowest, Advanced EEE=Disabled',
    adapter: 'Wi-Fi',
    plan: [
      { displayName: 'Power Saving Mode', keyword: 'PowerSaveMode', current: 'Enabled', suggested: { displayValue: 'Disabled', registryValue: '0', score: 100 } },
      { displayName: 'Roaming Aggressiveness', keyword: 'RoamAggr', current: 'Medium', suggested: { displayValue: 'Lowest', registryValue: '1', score: 70 } },
      { displayName: 'Advanced EEE', keyword: 'AdvancedEEE', current: 'Enabled', suggested: { displayValue: 'Disabled', registryValue: '0', score: 100 } },
    ],
  },
  autoDns: { applied: false, current: 'DHCP (automático)', target: 'o resolvedor de melhor score medido', source: 'dhcp', interface: 'Wi-Fi' },
  mtuOptimize: { applied: false, current: '1500 bytes', target: 'a medir (clique em "Detectar MTU")', needsDiscovery: true, interface: 'Wi-Fi' },
};

const state = {
  admin: false,
  applied: {}, // id -> { at, params }
  backups: {}, // id -> entries
  settings: {
    ultraPreset: 'ultra',
    autoRestoreOnQuit: true,
    watchdogEnabled: true,
    watchdogIntervalMs: 15000,
    selectedTweaks: null,
    dnsProvider: null,
    mtu: null,
  },
  gamemode: {
    active: false,
    busy: false,
    startedAt: null,
    stoppedAt: null,
    reason: null,
    tweakIds: [],
    appliedIds: [],
    failedIds: [],
    baseline: null,
    after: null,
  },
  watchdogSamples: [],
  dnsResults: null,
  mtuDiscovery: null,
  history: [],
  pingTimers: new Map(),
};

const subscribers = new Map();

function subscribe(channel, cb) {
  if (!subscribers.has(channel)) subscribers.set(channel, new Set());
  subscribers.get(channel).add(cb);
}

function unsubscribe(channel, cb) {
  const set = subscribers.get(channel);
  if (set) set.delete(cb);
}

function emit(channel, payload) {
  const set = subscribers.get(channel);
  if (set) set.forEach((cb) => { try { cb(payload); } catch (e) { /* noop */ } });
}

function logHistory(action, id, extra = {}) {
  state.history.unshift({ ts: Date.now(), action, tweakId: id, ...extra });
  state.history = state.history.slice(0, 200);
}

const tweakMeta = (id) => catalog.tweaks.find((t) => t.id === id) || null;

/* ------------------------------------------------------------------ */
/* Métricas simuladas                                                  */
/* ------------------------------------------------------------------ */

function simulatedStats(base, jitterBase, lossBase, optimized) {
  const factor = optimized ? 0.62 : 1;
  const samples = [];
  const n = 12;
  for (let i = 0; i < n; i++) {
    // Otimizado: menos spikes. Sem otimizar: spike periódico (background scan).
    const spike = !optimized && i % 6 === 5 ? rand(120, 380) : 0;
    samples.push(round1(base * factor + rand(-jitterBase, jitterBase) + spike));
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  let delta = 0;
  for (let i = 1; i < samples.length; i++) delta += Math.abs(samples[i] - samples[i - 1]);

  return {
    count: n,
    success: n,
    lost: 0,
    lossPercent: round1(lossBase * (optimized ? 0.15 : 1)),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: round1(avg),
    median: sorted[Math.floor(n / 2)],
    p95: sorted[Math.floor(n * 0.95)],
    stddev: round1(jitterBase * (optimized ? 0.6 : 1.3)),
    jitter: round1(delta / (n - 1)),
    spikeCount: samples.filter((s) => s > avg * 1.8).length,
    samples,
  };
}

function benchmarkSim(optimized) {
  const gw = simulatedStats(2.4, 0.9, 0, optimized);
  const net = simulatedStats(38, 6, 0.6, optimized);
  const combined = {
    avg: round1((gw.avg * 2 + net.avg * 4) / 6),
    min: gw.min,
    max: net.max,
    p95: round1((gw.p95 + net.p95 * 2) / 3),
    median: round1((gw.median + net.median * 2) / 3),
    jitter: round1((gw.jitter * 2 + net.jitter * 4) / 6),
    stddev: round1((gw.stddev + net.stddev * 2) / 3),
    lossPercent: round1(net.lossPercent),
    spikeCount: gw.spikeCount + net.spikeCount,
    success: gw.count + net.count,
    count: gw.count + net.count,
  };

  return {
    ok: true,
    measuredAt: Date.now(),
    rounds: 4,
    targets: [
      { role: 'gateway', host: FAKE.adapter.gateway, method: 'icmp', avg: gw.avg, p95: gw.p95, jitter: gw.jitter, lossPercent: gw.lossPercent, success: gw.count, count: gw.count, error: null },
      { role: 'internet', host: '1.1.1.1', method: 'tcp', avg: net.avg, p95: net.p95, jitter: net.jitter, lossPercent: net.lossPercent, success: net.count, count: net.count, error: null },
    ],
    combined,
    gatewayReachable: true,
    internetReachable: true,
  };
}

function improvement(before, after) {
  if (!before || !after) return null;
  const d = (f) => (before[f] !== null && after[f] !== null ? round1(after[f] - before[f]) : null);
  return {
    avg: { before: before.avg, after: after.avg, delta: d('avg') },
    p95: { before: before.p95, after: after.p95, delta: d('p95') },
    jitter: { before: before.jitter, after: after.jitter, delta: d('jitter') },
    loss: { before: before.lossPercent, after: after.lossPercent, delta: d('lossPercent') },
    spikes: { before: before.spikeCount, after: after.spikeCount, delta: after.spikeCount - before.spikeCount },
  };
}

/* ------------------------------------------------------------------ */
/* Simulação de apply/revert                                           */
/* ------------------------------------------------------------------ */

function requireAdmin() {
  return state.admin
    ? null
    : {
        success: false,
        code: 'UAC_DENIED',
        applied: false,
        message:
          '[DEMO] Você negou a permissão de Administrador (UAC). Nenhuma alteração foi aplicada. ' +
          'Clique em "Reiniciar como Administrador" para simular a elevação.',
      };
}

async function simulateApply(id, params = {}) {
  const meta = tweakMeta(id);
  if (!meta) return { success: false, code: 'UNKNOWN_TWEAK', applied: false, message: `Tweak desconhecido: ${id}` };

  await delay(rand(220, 700));

  if (id === 'chimneyOffload') {
    return {
      success: false,
      code: 'UNSUPPORTED',
      applied: false,
      message: BASELINE_STATE.chimneyOffload.reason,
    };
  }

  if (meta.requiresAdmin) {
    const denied = requireAdmin();
    if (denied) return denied;
  }

  const base = BASELINE_STATE[id] || {};
  state.backups[id] = [{ kind: 'simulated', id, previous: base.current }];
  state.applied[id] = { at: Date.now(), params };
  logHistory('apply', id, { success: true });

  let message = `${meta.label} aplicado.`;
  if (id === 'nagle') message = 'Nagle desativado em 1 interface(s). Novas conexões já nascem sem atraso de ACK.';
  if (id === 'networkThrottling') message = 'Network Throttling desativado (NetworkThrottlingIndex = 0xffffffff).';
  if (id === 'systemResponsiveness') message = `SystemResponsiveness definido como ${params.systemResponsiveness ?? 0}.`;
  if (id === 'wlanAutoconfig') message = 'Varredura de redes pausada em "Wi-Fi". Picos periódicos de ping tendem a desaparecer.';
  if (id === 'usbSelectiveSuspend') message = 'USB Selective Suspend desativado no plano de energia ativo (AC e bateria).';
  if (id === 'adapterPowerManagement') message = 'Economia de energia desativada em "Wi-Fi" (4 propriedades).';
  if (id === 'autoDns') message = 'DNS otimizado: Cloudflare (1.1.1.1 / 1.0.0.1) em "Wi-Fi". Score 41.2 — 12.4ms médio, jitter 2.1ms.';
  if (id === 'congestionProvider') message = 'Provedor de congestionamento definido como "ctcp" (template Internet).';
  if (id === 'mtuOptimize') message = 'MTU definido como 1492 em "Wi-Fi" (antes: 1500). Fragmentação UDP eliminada neste caminho.';

  return {
    id,
    label: meta.label,
    success: true,
    code: 'OK',
    applied: true,
    message,
    error: null,
    current: params.mtu ? `${params.mtu} bytes` : base.target,
    target: base.target,
    previous: base.current,
    details: id === 'adapterPowerManagement'
      ? ['AllowComputerToTurnOffDevice=Disabled', 'DeviceSleepOnDisconnect=Disabled', 'SelectiveSuspend=Disabled', 'D0PacketCoalescing=Disabled']
      : id === 'nagle' ? ['Wi-Fi (Wi-Fi) (USB)'] : null,
    note: id === 'wlanAutoconfig' ? 'Será reativado automaticamente ao desativar o Modo Ultra Low-Latency ou fechar o willLag.' : null,
    requiresReboot: Boolean(meta.rebootRecommended),
    scope: meta.scope,
    durationMs: Math.round(rand(180, 900)),
    discovery: id === 'mtuOptimize' ? simulateMtuDiscovery() : null,
  };
}

async function simulateRevert(id) {
  const meta = tweakMeta(id);
  if (!meta) return { success: false, code: 'UNKNOWN_TWEAK', applied: false, message: `Tweak desconhecido: ${id}` };

  await delay(rand(180, 500));

  if (meta.requiresAdmin) {
    const denied = requireAdmin();
    if (denied) return denied;
  }

  const had = Boolean(state.applied[id] || state.backups[id]);
  delete state.applied[id];
  delete state.backups[id];
  logHistory('revert', id, { success: true });

  return {
    id,
    label: meta.label,
    success: true,
    code: had ? 'OK' : 'NO_BACKUP',
    applied: false,
    message: had
      ? `${meta.label} revertido para o estado anterior.`
      : 'Nenhuma alteração registrada — nada a reverter.',
    error: null,
    durationMs: Math.round(rand(120, 600)),
  };
}

function simulateDetect(id) {
  const meta = tweakMeta(id);
  const base = BASELINE_STATE[id] || {};
  const isApplied = Boolean(state.applied[id]);

  return {
    id,
    ok: true,
    supported: base.supported !== false,
    applied: isApplied ? true : Boolean(base.applied),
    reason: base.reason || null,
    error: null,
    current: isApplied ? base.target || 'aplicado' : base.current ?? null,
    target: base.target ?? null,
    recordedApplied: isApplied,
    hasBackup: Boolean(state.backups[id]),
    detectedAt: Date.now(),
    raw: { ...base, simulated: true },
  };
}

function simulateMtuDiscovery() {
  return {
    ok: true,
    adapter: { name: 'Wi-Fi', description: FAKE.adapter.description, ifIndex: 12, isWifi: true, isUsb: true, linkSpeed: '433 Mbps' },
    currentMtu: 1500,
    gateway: { target: '192.168.15.1', payload: 1472, mtu: 1500, steps: 1, conclusive: true, noisy: false, error: null },
    internet: [
      { target: '1.1.1.1', payload: 1464, mtu: 1492, steps: 8, conclusive: true, noisy: false, error: null },
    ],
    recommendation: {
      mtu: 1492,
      payload: 1464,
      source: 'internet:1.1.1.1',
      current: 1500,
      action: 'reduce',
      message:
        'MTU atual 1500 é MAIOR que o do caminho (1492). Pacotes acima de 1492 bytes estão sendo fragmentados. ' +
        'Reduzir elimina fragmentação UDP.',
      isPppoe: true,
      isVpnLike: false,
      note: '1492 é o MTU típico de PPPoE (8 bytes de overhead do protocolo).',
    },
    simulated: true,
  };
}

function simulateDnsBenchmark() {
  const rows = [
    { id: 'cloudflare', name: 'Cloudflare', icon: '🟠', primary: '1.1.1.1', secondary: '1.0.0.1', net: 11.2, res: 9.4, jit: 1.8, loss: 0 },
    { id: 'cloudflare-malware', name: 'Cloudflare (anti-malware)', icon: '🎮', primary: '1.1.1.2', secondary: '1.0.0.2', net: 12.1, res: 10.2, jit: 2.2, loss: 0 },
    { id: 'google', name: 'Google Public DNS', icon: '🔵', primary: '8.8.8.8', secondary: '8.8.4.4', net: 14.8, res: 12.9, jit: 3.1, loss: 0 },
    { id: 'quad9', name: 'Quad9', icon: '🟣', primary: '9.9.9.9', secondary: '149.112.112.112', net: 22.4, res: 19.8, jit: 5.4, loss: 0 },
    { id: 'opendns', name: 'OpenDNS (Cisco)', icon: '🟢', primary: '208.67.222.222', secondary: '208.67.220.220', net: 26.1, res: 23.5, jit: 6.8, loss: 2 },
    { id: 'adguard', name: 'AdGuard DNS', icon: '🛡️', primary: '94.140.14.14', secondary: '94.140.15.15', net: 48.2, res: 44.7, jit: 11.3, loss: 4 },
    { id: 'cloudflare-family', name: 'Cloudflare (família)', icon: '👨‍👩‍👧', primary: '1.1.1.3', secondary: '1.0.0.3', net: 12.8, res: 11.1, jit: 2.6, loss: 0 },
    { id: 'level3', name: 'Level3 / CenturyLink', icon: '⚪', primary: '4.2.2.2', secondary: '4.2.2.1', net: 31.5, res: 28.9, jit: 8.2, loss: 1 },
  ];

  const mk = (avg, jit, loss) => ({
    count: 8, success: Math.round(8 * (1 - loss / 100)), lost: Math.round(8 * (loss / 100)),
    lossPercent: loss, min: round1(avg * 0.8), max: round1(avg * (1.6 + jit / 20)),
    avg: round1(avg), median: round1(avg), p95: round1(avg * 1.5 + jit),
    stddev: round1(jit * 0.9), jitter: round1(jit), jitterRfc3550: round1(jit * 0.7),
    spikeCount: loss > 1 ? 1 : 0, samples: [],
  });

  const results = rows
    .map((r) => {
      const network = mk(r.net, r.jit, r.loss);
      const resolution = mk(r.res, r.jit * 1.1, r.loss);
      const combined = mk(r.net * 0.35 + r.res * 0.65, r.jit, r.loss);
      const score = round1(combined.avg + 1.25 * combined.p95 + 2 * combined.jitter + 40 * (combined.lossPercent / 100));
      return {
        id: r.id, name: r.name, icon: r.icon, primary: r.primary, secondary: r.secondary,
        description: (catalog.tweaks.find((t) => t.id === 'autoDns') ? '' : '') || r.name,
        network, resolution, icmp: null, combined, score,
        grade: score < 60 ? 'excelente' : score < 110 ? 'otimo' : score < 200 ? 'bom' : 'regular',
        gradeLabel: score < 60 ? 'Excelente' : score < 110 ? 'Ótimo' : score < 200 ? 'Bom' : 'Regular',
        gradeColor: score < 110 ? 'success' : score < 200 ? 'info' : 'warning',
        reachable: true, dnsErrors: [],
      };
    })
    .sort((a, b) => a.score - b.score);

  results.forEach((r, i) => { r.rank = i + 1; });

  const best = results[0];
  return {
    ok: true,
    testedAt: Date.now(),
    rounds: 4,
    hostnames: ['www.google.com', 'store.steampowered.com', 'cloudflare.com', 'www.roblox.com'],
    results,
    best,
    current: ['192.168.15.1'],
    currentProvider: null,
    recommendation: `${best.name} (${best.primary}) — score ${best.score} | rede ${best.combined.avg}ms | jitter ${best.combined.jitter}ms | perda ${best.combined.lossPercent}%`,
    simulated: true,
  };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

const handlers = {
  'check-admin': async () => state.admin,

  'get-elevation-status': async () =>
    state.admin
      ? { isAdmin: true, isWindows: true, canApplyTweaks: true, message: '[DEMO] Executando com privilégios de Administrador.', recommendation: 'ready' }
      : {
          isAdmin: false,
          isWindows: true,
          canApplyTweaks: true,
          message:
            '[DEMO] Executando sem privilégios de Administrador. Ao aplicar um ajuste o Windows pedirá permissão (UAC) — na demo, a primeira tentativa será negada para você ver o tratamento de erro.',
          recommendation: 'relaunch-or-prompt',
          hint: 'Use "Reiniciar como Administrador" para simular a elevação.',
        },

  'relaunch-as-admin': async () => {
    await delay(900);
    state.admin = true;
    return { success: true, code: 'OK', message: '[DEMO] Privilégios de Administrador concedidos (simulado).' };
  },

  'get-system-context': async () => ({
    platform: FAKE.platform,
    features: {
      detected: true, registry: true, netsh: true, wlan: true, wlanServiceStatus: 'Running',
      powerManagement: true, hasNetAdapterPowerManagement: true, hasMsPower: true, hasNetQosPolicy: true,
      hasNetIPInterface: true, congestionProviders: ['ctcp', 'cubic'], ctcp: true, bbr: false,
      tcpFastOpen: true, mtuProbe: true, dnsProbe: true,
    },
    elevation: await handlers['get-elevation-status'](),
    activeAdapter: FAKE.adapter,
    gateway: FAKE.adapter.gateway,
    adapterCount: 4,
    wifiAdapters: [{ name: FAKE.adapter.name, description: FAKE.adapter.description, isUsb: true, connected: true, linkSpeed: FAKE.adapter.linkSpeed }],
    catalogValid: true,
    catalogProblems: [],
    stateDir: 'C:\\Users\\gamer\\AppData\\Roaming\\willLag',
    settings: state.settings,
    gamemode: gamemodeStatus(),
  }),

  'get-network-snapshot': async () => ({
    ok: true,
    capturedAt: Date.now(),
    adapters: [FAKE.adapter, { name: 'Ethernet', description: 'Realtek PCIe GbE Family Controller', ifIndex: 7, status: 'Disconnected', isWifi: false, isUsb: false, connected: false, linkSpeed: '' }],
    activeAdapter: FAKE.adapter,
    gateway: FAKE.adapter.gateway,
    wifiAdapters: [FAKE.adapter],
    usbWifiAdapters: [FAKE.adapter],
    wlan: [FAKE.adapter.wlan],
    autoconfig: [{ name: 'Wi-Fi', enabled: !state.applied.wlanAutoconfig }],
    dns: [{ ifIndex: 12, alias: 'Wi-Fi', servers: state.applied.autoDns ? ['1.1.1.1', '1.0.0.1'] : ['192.168.15.1'] }],
    routes: [{ ifIndex: 12, nextHop: '192.168.15.1', metric: 25, ifMetric: 25, protocol: 'Local' }],
    addresses: [{ ifIndex: 12, alias: 'Wi-Fi', ipAddress: '192.168.15.42', prefixLen: 24, type: 'Manual' }],
    ipInterfaces: [{ ifIndex: 12, alias: 'Wi-Fi', mtu: state.applied.mtuOptimize ? 1492 : 1500, dhcp: 'Enabled', connectionState: 'Connected' }],
  }),

  'get-network-info': async () => [
    { name: 'Wi-Fi', address: '192.168.15.42', netmask: '255.255.255.0', mac: 'a4:5e:60:12:34:56' },
  ],

  'get-adapters': async () => (await handlers['get-network-snapshot']()).adapters,

  'get-wifi-diagnostics': async () => ({
    ok: true,
    hasWifi: true,
    adapter: {
      name: FAKE.adapter.name, description: FAKE.adapter.description, ifIndex: 12, guid: FAKE.adapter.guid,
      linkSpeed: FAKE.adapter.linkSpeed, isUsb: true, pnpDeviceId: FAKE.adapter.pnpDeviceId,
      driverVersion: FAKE.adapter.driverVersion, driverDate: FAKE.adapter.driverDate, mtu: 1500, status: 'Up',
    },
    wlan: FAKE.adapter.wlan,
    metrics: { signal: 72, channel: 6, radioType: '802.11ac', txRateMbps: 175.5, rxRateMbps: 390 },
    autoconfig: { name: 'Wi-Fi', enabled: !state.applied.wlanAutoconfig },
    findings: [
      { severity: 'info', title: 'Adaptador Wi-Fi USB detectado', detail: 'Dongles USB somam latência de barramento e dependem de CPU para o driver. As otimizações de energia USB e de background scan têm impacto especialmente alto aqui.' },
      { severity: 'warn', title: 'Conectado em 2.4 GHz (canal 6)', detail: '2.4 GHz tem 3 canais não sobrepostos e sofre interferência de Bluetooth, micro-ondas e vizinhos. Migrar para 5 GHz costuma reduzir jitter mais do que qualquer ajuste de software.' },
      { severity: 'info', title: 'Taxas de TX/RX muito assimétricas', detail: 'TX 175.5 Mbps / RX 390 Mbps. Assimetria grande indica posição ruim de antena ou interferência.' },
    ],
  }),

  'get-tcp-global': async () => ({
    ok: true,
    autoTuningLevel: 'normal',
    autoTuningLevelEffective: 'normal',
    autoTuningReason: 'Global',
    ecnCapability: 'disabled',
    timestamps: 'disabled',
    fastOpen: state.applied.tcpFastOpen ? 'enabled' : 'disabled',
    rss: 'enabled',
    rsc: state.applied.rsc ? 'disabled' : 'enabled',
    initialRto: state.applied.initialRto ? '1000' : '3000',
    congestionProviders: { Internet: state.applied.congestionProvider ? 'ctcp' : 'cubic' },
    templates: [],
    rawGlobal: '',
    rawSupplemental: '',
  }),

  'get-tweaks': async () => ({
    ok: true,
    platform: FAKE.platform,
    groups: catalog.groups,
    riskLabels: catalog.riskLabels,
    presets: catalog.presets,
    settings: state.settings,
    tweaks: catalog.tweaks.map((t) => ({
      ...t,
      appliedRecorded: Boolean(state.applied[t.id]),
      appliedAt: state.applied[t.id] ? state.applied[t.id].at : null,
      hasBackup: Boolean(state.backups[t.id]),
    })),
  }),

  'get-tweaks-detailed': async () => {
    const base = await handlers['get-tweaks']();
    const detection = {};
    for (const t of catalog.tweaks) detection[t.id] = simulateDetect(t.id);
    return { ...base, tweaks: base.tweaks.map((t) => ({ ...t, state: detection[t.id] })), detection };
  },

  'detect-tweak': async (id) => simulateDetect(id),
  'detect-all-tweaks': async () => {
    const out = {};
    for (const t of catalog.tweaks) out[t.id] = simulateDetect(t.id);
    return out;
  },

  'apply-tweak': async (id, params) => {
    const res = await simulateApply(id, params);
    emit('tweak-updated', { id, result: res });
    return res;
  },
  'revert-tweak': async (id) => {
    const res = await simulateRevert(id);
    emit('tweak-updated', { id, result: res });
    return res;
  },

  'apply-tweaks': async (idsOrPreset, params) => {
    const preset = catalog.presets.find((p) => p.id === idsOrPreset);
    const ids = Array.isArray(idsOrPreset) ? idsOrPreset : preset ? preset.tweakIds : [];
    const results = [];
    for (const id of ids) {
      const r = await simulateApply(id, params);
      results.push(r);
      emit('tweak-updated', { id, result: r });
    }
    const ok = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    return {
      success: failed.length === 0,
      code: failed.length === 0 ? 'OK' : ok.length ? 'PARTIAL' : 'FAILED',
      message: `${ok.length} ajuste(s) aplicado(s)${failed.length ? `, ${failed.length} com falha` : ''}.`,
      results,
      applied: ok.map((r) => r.id),
      failed: failed.map((r) => ({ id: r.id, label: r.label, code: r.code, message: r.message })),
      requiresReboot: false,
    };
  },

  'revert-tweaks': async (idsOrPreset) => {
    const preset = catalog.presets.find((p) => p.id === idsOrPreset);
    const ids = Array.isArray(idsOrPreset) ? idsOrPreset : preset ? preset.tweakIds : [];
    const results = [];
    for (const id of ids) results.push(await simulateRevert(id));
    return { success: true, code: 'OK', message: `${results.length} ajuste(s) revertido(s).`, results, failed: [] };
  },

  'revert-all': async () => {
    const ids = Object.keys(state.applied);
    const results = [];
    for (const id of ids) results.push(await simulateRevert(id));
    return {
      success: true,
      code: results.length ? 'OK' : 'NOTHING_TO_RESTORE',
      message: results.length ? `Sistema restaurado: ${results.length} ajuste(s) revertido(s).` : 'Nenhuma alteração registrada — o sistema já está no estado original.',
      results,
      failures: [],
      requiresReboot: false,
    };
  },

  'get-backups': async () => ({
    ok: true,
    backups: state.backups,
    applied: Object.fromEntries(Object.entries(state.applied).map(([k, v]) => [k, { appliedAt: v.at, scope: 'persistent', by: 'user' }])),
    history: state.history.slice(0, 100),
    dir: 'C:\\Users\\gamer\\AppData\\Roaming\\willLag',
  }),

  'export-backup-reg': async () => ({
    success: true,
    files: ['C:\\Users\\gamer\\AppData\\Roaming\\willLag\\backups\\willlag-network-backup-demo.reg'],
    jsonFile: 'C:\\Users\\gamer\\AppData\\Roaming\\willLag\\backups\\willlag-network-backup-demo.json',
    message: '[DEMO] Backups exportados (simulado).',
  }),

  'export-state-bundle': async () => ({ ok: true, bundle: { exportedAt: new Date().toISOString(), state: { applied: state.applied, settings: state.settings } } }),
  'import-state-bundle': async () => ({ success: true }),

  'get-settings': async () => state.settings,
  'set-settings': async (patch) => {
    Object.assign(state.settings, patch || {});
    return { ok: true, settings: state.settings };
  },

  'get-logs': async () => ({
    ok: true,
    entries: [
      { ts: Date.now(), time: new Date().toISOString(), level: 'info', scope: 'main', message: '[DEMO] willLag iniciado em modo demonstração' },
      { ts: Date.now(), time: new Date().toISOString(), level: 'info', scope: 'tweaks', message: `Catálogo de tweaks validado (${catalog.tweaks.length} itens)` },
      { ts: Date.now(), time: new Date().toISOString(), level: 'warn', scope: 'wifi', message: 'Adaptador Wi-Fi USB detectado — background scan é a causa provável de lag spikes' },
    ],
  }),

  'gamemode-status': async () => gamemodeStatus(),

  'gamemode-start': async (opts = {}) => {
    if (state.gamemode.active) return { success: true, code: 'ALREADY_ACTIVE', message: 'O Modo Ultra Low-Latency já está ativo.', status: gamemodeStatus() };

    const denied = requireAdmin();
    if (denied) return { ...denied, status: gamemodeStatus() };

    state.gamemode.busy = true;
    emit('gamemode-progress', { phase: 'baseline', message: 'Medindo latência atual (baseline)...' });
    await delay(1400);
    const baseline = benchmarkSim(false);

    const preset = catalog.presets.find((p) => p.id === (opts.preset || 'ultra')) || catalog.presets[0];
    const ids = Array.isArray(opts.tweakIds) ? opts.tweakIds : preset.tweakIds;

    emit('gamemode-progress', { phase: 'apply', message: `Aplicando ${ids.length} ajustes...` });
    const results = [];
    for (let i = 0; i < ids.length; i++) {
      emit('gamemode-progress', { phase: 'apply', message: `Aplicando: ${ids[i]} (${i + 1}/${ids.length})` });
      results.push(await simulateApply(ids[i], {}));
    }

    emit('gamemode-progress', { phase: 'guard', message: 'Validando conectividade...' });
    await delay(900);

    state.gamemode = {
      ...state.gamemode,
      active: true, busy: false, startedAt: Date.now(), reason: 'user',
      tweakIds: ids, appliedIds: results.filter((r) => r.success).map((r) => r.id),
      failedIds: results.filter((r) => !r.success).map((r) => r.id), baseline,
    };

    emit('gamemode-progress', { phase: 'measure', message: 'Medindo latência com os ajustes ativos...' });
    await delay(1600);
    const after = benchmarkSim(true);
    state.gamemode.after = after;

    startWatchdogSim();

    const payload = {
      success: true,
      code: 'OK',
      active: true,
      message: `Modo Ultra Low-Latency ATIVO — ${state.gamemode.appliedIds.length} ajustes aplicados.`,
      applied: results,
      failed: results.filter((r) => !r.success).map((r) => ({ id: r.id, label: r.label, code: r.code, message: r.message })),
      baseline, after,
      improvement: improvement(baseline.combined, after.combined),
      guard: { healthy: true, gatewayReachable: true, internetReachable: true },
      requiresReboot: false,
      status: gamemodeStatus(),
    };
    emit('gamemode-state', { status: gamemodeStatus(), result: payload });
    return payload;
  },

  'gamemode-stop': async (opts = {}) => {
    if (!state.gamemode.active) return { success: true, code: 'NOT_ACTIVE', message: 'Modo já estava desativado.', status: gamemodeStatus() };
    stopWatchdogSim();

    const ids = state.gamemode.appliedIds.length ? state.gamemode.appliedIds : Object.keys(state.applied);
    const results = [];
    for (const id of ids) {
      emit('gamemode-progress', { phase: 'revert', message: `Revertendo: ${id}` });
      results.push(await simulateRevert(id));
    }

    state.gamemode = { ...state.gamemode, active: false, busy: false, stoppedAt: Date.now(), reason: opts.reason || 'user', appliedIds: [], failedIds: [], after: null };

    const payload = {
      success: true,
      code: 'OK',
      active: false,
      message: `Modo Ultra Low-Latency desativado. ${results.length} ajuste(s) revertido(s) para o estado anterior.`,
      reverted: results,
      failures: [],
      reason: state.gamemode.reason,
      status: gamemodeStatus(),
    };
    emit('gamemode-state', { status: gamemodeStatus(), result: payload });
    return payload;
  },

  'gamemode-toggle': async (opts) => (state.gamemode.active ? handlers['gamemode-stop'](opts) : handlers['gamemode-start'](opts)),

  'gamemode-benchmark': async () => benchmarkSim(state.gamemode.active),
  'check-connectivity': async () => ({ ok: true, healthy: true, gatewayReachable: true, internetReachable: true, avg: state.gamemode.active ? 24.1 : 31.8, jitter: state.gamemode.active ? 3.1 : 9.4, lossPercent: state.gamemode.active ? 0 : 0.8, measuredAt: Date.now(), detail: [] }),

  'dns-providers': async () => ({ ok: true, providers: [] }),

  'dns-benchmark': async () => {
    const bench = simulateDnsBenchmark();
    for (let i = 1; i <= bench.results.length; i++) {
      emit('dns-benchmark-progress', { providerId: bench.results[i - 1].id, phase: 'dns', index: i, total: bench.results.length });
      await delay(180);
    }
    state.dnsResults = bench;
    return bench;
  },

  'dns-current': async () => ({
    ok: true,
    servers: state.applied.autoDns ? ['1.1.1.1', '1.0.0.1'] : ['192.168.15.1'],
    provider: state.applied.autoDns ? { id: 'cloudflare', name: 'Cloudflare' } : null,
    interface: 'Wi-Fi',
    ifIndex: 12,
    source: 'dhcp',
  }),

  'dns-apply': async (serversOrProvider) => {
    const denied = requireAdmin();
    if (denied) return denied;
    await delay(600);
    const servers = Array.isArray(serversOrProvider) ? serversOrProvider : ['1.1.1.1', '1.0.0.1'];
    state.applied.autoDns = { at: Date.now(), params: { servers } };
    state.backups.autoDns = [{ kind: 'dns', servers: ['192.168.15.1'], wasDhcp: true }];
    return { success: true, code: 'OK', applied: true, interface: 'Wi-Fi', ifIndex: 12, servers, previous: ['192.168.15.1'], message: `DNS definido como ${servers.join(' / ')} em "Wi-Fi". Cache limpo.` };
  },

  'dns-restore': async () => {
    await delay(400);
    delete state.applied.autoDns;
    delete state.backups.autoDns;
    return { success: true, code: 'OK', applied: false, message: 'DNS devolvido para automático (DHCP).' };
  },

  'change-dns': async (primary, secondary) => {
    const res = await handlers['dns-apply']([primary, secondary].filter(Boolean));
    return res.success ? { success: true, message: res.message } : { success: false, message: res.message };
  },

  'flush-dns': async () => {
    await delay(350);
    return { success: true, message: 'Cache DNS do sistema limpo com sucesso.' };
  },

  'dns-cache': async () => ({
    ok: true,
    entries: [
      { entry: 'store.steampowered.com', name: 'store.steampowered.com', data: '23.215.18.176', type: 'A', ttl: 42, section: 'Answer' },
      { entry: 'prod.ritsumo.net', name: 'prod.ritsumo.net', data: '52.208.14.99', type: 'A', ttl: 18, section: 'Answer' },
      { entry: 'www.roblox.com', name: 'www.roblox.com', data: '128.116.0.6', type: 'A', ttl: 120, section: 'Answer' },
    ],
  }),

  'mtu-get': async () => ({ ok: true, adapter: { name: 'Wi-Fi', ifIndex: 12, isWifi: true }, mtu: state.applied.mtuOptimize ? 1492 : 1500, ifIndex: 12, alias: 'Wi-Fi', dhcp: 'Enabled', family: 'IPv4' }),

  'mtu-discover': async () => {
    for (let i = 0; i < 6; i++) {
      emit('mtu-progress', { payload: 548 + i * 150, ok: i < 5, step: i + 1 });
      await delay(220);
    }
    state.mtuDiscovery = simulateMtuDiscovery();
    return state.mtuDiscovery;
  },

  'mtu-apply': async (mtu) => {
    const denied = requireAdmin();
    if (denied) return denied;
    await delay(500);
    state.applied.mtuOptimize = { at: Date.now(), params: { mtu } };
    state.backups.mtuOptimize = [{ kind: 'mtu', mtu: 1500 }];
    return { success: true, code: 'OK', applied: true, mtu: Number(mtu), previous: 1500, interface: 'Wi-Fi', message: `MTU definido como ${mtu} em "Wi-Fi" (antes: 1500). Fragmentação UDP eliminada neste caminho.` };
  },

  'mtu-restore': async () => {
    await delay(400);
    delete state.applied.mtuOptimize;
    delete state.backups.mtuOptimize;
    return { success: true, code: 'OK', applied: false, message: 'MTU restaurado para 1500.' };
  },

  'mtu-auto-optimize': async () => simulateApply('mtuOptimize', {}),

  'ping-host': async (host) => {
    await delay(rand(120, 500));
    const ms = /1\.1\.1\.1/.test(host) ? Math.round(rand(9, 16)) : /8\.8\.8\.8/.test(host) ? Math.round(rand(12, 22)) : Math.round(rand(20, 60));
    return { host, ms, status: 'ok', jitter: round1(rand(0.4, 3)), lossPercent: 0 };
  },

  'ping-stats': async (host, opts = {}) => {
    const rounds = Number(opts.rounds) || 5;
    await delay(rounds * 220);
    const base = /1\.1\.1\.1/.test(host) ? 12 : /8\.8\.8\.8/.test(host) ? 15 : 34;
    const s = simulatedStats(base, base * 0.14, 0.4, state.gamemode.active);
    return { ok: true, host, ...s, grade: { grade: 'otimo', label: 'Ótimo', color: 'success', score: round1(s.avg + s.jitter * 2) } };
  },

  'speed-test': async () => {
    const hosts = [
      { name: 'Google DNS', host: '8.8.8.8', base: 15 },
      { name: 'Cloudflare', host: '1.1.1.1', base: 11 },
      { name: 'OpenDNS', host: '208.67.222.222', base: 27 },
      { name: 'Quad9', host: '9.9.9.9', base: 23 },
      { name: 'Google', host: 'google.com', base: 19 },
      { name: 'AWS São Paulo', host: 'sa-east-1.amazonaws.com', base: 33 },
    ];
    const out = [];
    for (const h of hosts) {
      await delay(260);
      const jitter = state.gamemode.active ? rand(0.4, 1.6) : rand(2, 9);
      out.push({
        name: h.name, host: h.host,
        avgMs: Math.round(h.base * (state.gamemode.active ? 0.85 : 1) + rand(-2, 4)),
        status: 'ok',
        jitter: round1(jitter),
        lossPercent: 0,
        p95: Math.round(h.base * 1.4 + jitter),
      });
    }
    return out;
  },

  'get-processes': async () => {
    await delay(400);
    return [
      { pid: 12480, name: 'cs2', title: 'Counter-Strike 2', memory: 3820, cpu: '412.7', priority: 'High', responding: true },
      { pid: 8840, name: 'steam', title: 'Steam', memory: 640, cpu: '88.2', priority: 'Normal', responding: true },
      { pid: 15220, name: 'Discord', title: 'Discord', memory: 412, cpu: '31.4', priority: 'Normal', responding: true },
      { pid: 3092, name: 'chrome', title: 'Twitch — Google Chrome', memory: 1840, cpu: '204.1', priority: 'Normal', responding: true },
      { pid: 9912, name: 'RiotClientServices', title: 'Riot Client', memory: 288, cpu: '12.0', priority: 'Normal', responding: true },
      { pid: 1120, name: 'explorer', title: 'Área de Trabalho', memory: 190, cpu: '6.4', priority: 'Normal', responding: true },
    ];
  },

  'get-network-connections': async () => {
    await delay(300);
    return [
      { pid: 12480, localPort: 52114, remoteAddress: '104.160.131.3', remotePort: 5223, state: 'Established' },
      { pid: 12480, localPort: 52115, remoteAddress: '142.251.132.46', remotePort: 443, state: 'Established' },
      { pid: 8840, localPort: 51002, remoteAddress: '23.215.18.176', remotePort: 443, state: 'Established' },
      { pid: 15220, localPort: 49881, remoteAddress: '162.159.135.234', remotePort: 443, state: 'Established' },
    ];
  },

  'set-process-priority': async (pid, priority) => {
    await delay(400);
    const denied = requireAdmin();
    if (denied) return { success: false, message: denied.message };
    return { success: true, message: `[DEMO] Prioridade do PID ${pid} definida como ${priority}` };
  },

  'set-network-priority': async (processName) => {
    await delay(500);
    const denied = requireAdmin();
    if (denied) return { success: false, message: denied.message };
    return { success: true, message: `[DEMO] Prioridade de rede máxima (DSCP 46) configurada para ${processName}.exe` };
  },

  'optimize-for-process': async (pid, processName) => {
    await delay(700);
    const denied = requireAdmin();
    if (denied) return { success: false, message: denied.message };
    return {
      success: true,
      message: `[DEMO] Otimizações aplicadas para ${processName}`,
      details: ['✅ Prioridade do processo definida como Alta', '✅ Afinidade de CPU definida (8 cores)', '✅ Política QoS de alta prioridade aplicada'],
    };
  },

  'optimize-tcp': async () => {
    const res = await handlers['apply-tweaks']('legacy', {});
    return { success: res.success, message: res.success ? 'Otimizações TCP aplicadas!' : res.message, details: res.results.map((r) => ({ cmd: r.id, success: r.success })) };
  },

  'disable-nagle': async () => {
    const res = await simulateApply('nagle');
    return { success: res.success, message: res.message, details: res.details };
  },

  'reset-optimizations': async () => {
    const res = await handlers['revert-all']();
    return { success: res.success, message: 'Configurações restauradas ao padrão!', details: res.results.map((r) => `${r.success ? '✅' : '❌'} ${r.label}`) };
  },
};

function gamemodeStatus() {
  return {
    ...state.gamemode,
    improvement: improvement(state.gamemode.baseline ? state.gamemode.baseline.combined : null, state.gamemode.after ? state.gamemode.after.combined : null),
    watchdog: {
      running: watchdogTimer !== null,
      intervalMs: state.settings.watchdogIntervalMs,
      consecutiveFailures: 0,
      lastCheckAt: state.watchdogSamples.length ? state.watchdogSamples[state.watchdogSamples.length - 1].ts : null,
      lastResult: state.watchdogSamples.length ? state.watchdogSamples[state.watchdogSamples.length - 1] : null,
      samples: state.watchdogSamples.slice(-120),
      alerts: [],
    },
    powerSaveBlocked: state.gamemode.active,
    lastError: null,
    settings: state.settings,
  };
}

let watchdogTimer = null;

function startWatchdogSim() {
  stopWatchdogSim();
  watchdogTimer = setInterval(() => {
    const sample = {
      ts: Date.now(),
      avg: round1(rand(21, 29)),
      jitter: round1(rand(1.2, 4.4)),
      loss: 0,
      gateway: true,
      internet: true,
    };
    state.watchdogSamples.push(sample);
    state.watchdogSamples = state.watchdogSamples.slice(-120);
    emit('gamemode-metrics', { status: gamemodeStatus() });
  }, 4000);
}

function stopWatchdogSim() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  state.watchdogSamples = [];
}

/* ------------------------------------------------------------------ */
/* Canais "send" (janela + monitor de ping)                            */
/* ------------------------------------------------------------------ */

const sendHandlers = {
  'minimize-window': () => true,
  'maximize-window': () => true,
  'close-window': () => true,

  'start-ping-monitor': (host) => {
    stopWatchdogSimPing();
    const tick = async () => {
      const base = /1\.1\.1\.1/.test(host) ? 12 : /8\.8\.8\.8/.test(host) ? 15 : 30;
      const optimized = state.gamemode.active;
      const spike = !optimized && Math.random() < 0.12;
      const ms = Math.round(base * (optimized ? 0.82 : 1) + rand(-2.5, 3.5) + (spike ? rand(90, 320) : 0));
      const lost = Math.random() < (optimized ? 0.005 : 0.03);
      emit('ping-result', {
        host,
        ms: lost ? -1 : ms,
        timestamp: Date.now(),
        jitter: round1(rand(0.5, optimized ? 3 : 9)),
        lossPercent: lost ? 100 : 0,
      });
    };
    tick();
    pingTimer = setInterval(tick, 1000);
  },

  'stop-ping-monitor': () => stopWatchdogSimPing(),
  'cleanup-webcontents': () => stopWatchdogSimPing(),
};

let pingTimer = null;
function stopWatchdogSimPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

const mock = {
  async invoke(channel, ...args) {
    const handler = handlers[channel];
    if (!handler) {
      // eslint-disable-next-line no-console
      console.warn(`[demo] canal não implementado no mock: ${channel}`);
      return null;
    }
    try {
      return await handler(...args);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[demo] erro em ${channel}`, err);
      return { success: false, code: 'DEMO_ERROR', message: err.message };
    }
  },

  send(channel, ...args) {
    const handler = sendHandlers[channel];
    if (handler) {
      try {
        handler(...args);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[demo] erro em send(${channel})`, err);
      }
      return true;
    }
    return false;
  },

  subscribe,
  unsubscribe,

  /** Permite a UI de demonstração simular cenários (ex.: negar UAC). */
  __setAdmin(value) {
    state.admin = Boolean(value);
  },
  __getState() {
    return state;
  },
  __catalog: catalog,
};

export default mock;
