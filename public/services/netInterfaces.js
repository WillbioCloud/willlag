'use strict';

/**
 * Descoberta de interfaces de rede, adaptadores Wi-Fi/USB e rota padrão.
 *
 * Uma única chamada PowerShell devolve um "snapshot" completo (adaptadores,
 * rotas, MTU, DNS, gateway), com cache curto. Isso evita abrir 6 processos
 * powershell.exe por tela — cada um custa 300-800ms, o que tornaria a UI lenta.
 */

const ps = require('./psRunner');
const logger = require('./logger');

const log = logger.scope('netif');

const CACHE_TTL_MS = 8000;
let cache = { at: 0, snapshot: null };

const SNAPSHOT_BODY = `
$ErrorActionPreference = 'SilentlyContinue'

function To-Num($v) { if ($null -eq $v -or $v -eq '') { return $null }; return $v }

$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | ForEach-Object {
  $a = $_
  [pscustomobject]@{
    name                = $a.Name
    description         = $a.InterfaceDescription
    ifIndex             = $a.ifIndex
    guid                = $a.InterfaceGuid
    status              = "$($a.Status)"
    linkSpeed           = "$($a.LinkSpeed)"
    mac                 = $a.MacAddress
    mediaType           = "$($a.MediaType)"
    physicalMediaType   = "$($a.PhysicalMediaType)"
    pnpDeviceId         = "$($a.PnpDeviceID)"
    fullDuplex          = $a.FullDuplex
    driverVersion       = "$($a.DriverVersion)"
    driverDate          = if ($a.DriverDate) { $a.DriverDate.ToString('yyyy-MM-dd') } else { $null }
  }
})

$ipInterfaces = @(Get-NetIPInterface -ErrorAction SilentlyContinue | Where-Object { $_.AddressFamily -eq 'IPv4' } | ForEach-Object {
  [pscustomobject]@{
    ifIndex        = $_.InterfaceIndex
    alias          = $_.InterfaceAlias
    mtu            = $_.NlMtu
    dhcp           = "$($_.Dhcp)"
    connectionState= "$($_.ConnectionState)"
    forwarding     = "$($_.Forwarding)"
    ecn            = "$($_.EcnSensitivity)"
  }
})

$addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    ifIndex    = $_.InterfaceIndex
    alias      = $_.InterfaceAlias
    ipAddress  = $_.IPAddress
    prefixLen  = $_.PrefixLength
    type       = "$($_.Type)"
    suffix     = "$($_.AddressState)"
  }
})

$routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    ifIndex   = $_.ifIndex
    nextHop   = $_.NextHop
    metric    = $_.RouteMetric
    ifMetric  = $_.ifMetric
    protocol  = "$($_.Protocol)"
  }
})

$dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    ifIndex = $_.InterfaceIndex
    alias   = $_.InterfaceAlias
    servers = @($_.ServerAddresses)
  }
})

$wlan = $null
try {
  $wlanRaw = (netsh wlan show interfaces) 2>&1 | Out-String
  $wlan = @{ raw = $wlanRaw }
} catch { $wlan = $null }

$autoconfig = @{}
try {
  $acRaw = (netsh wlan show autoconfig) 2>&1 | Out-String
  $autoconfig = @{ raw = $acRaw }
} catch {}

Write-WillLagJson @{
  ok           = $true
  adapters     = @($adapters)
  ipInterfaces = @($ipInterfaces)
  addresses    = @($addresses)
  routes       = @($routes)
  dns          = @($dns)
  wlanRaw      = $wlan.raw
  autoconfigRaw= $autoconfig.raw
}
`;

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function isWifiAdapter(adapter) {
  const pm = String(adapter.physicalMediaType || '').toLowerCase();
  const mt = String(adapter.mediaType || '').toLowerCase();
  const desc = String(adapter.description || '').toLowerCase();
  const name = String(adapter.name || '').toLowerCase();

  if (pm.includes('802.11') || mt.includes('802.11') || mt.includes('wireless') || mt.includes('native 802.11')) return true;
  if (/wireless|wi-?fi|wlan|802\.11/.test(desc)) return true;
  if (/wi-?fi|wireless|wlan/.test(name)) return true;
  return false;
}

function isUsbDevice(adapter) {
  const pnp = String(adapter.pnpDeviceId || '').toUpperCase();
  if (pnp.startsWith('USB\\')) return true;
  // Adaptadores USB frequentemente têm descritivo com o fabricante do dongle.
  return /usb/i.test(String(adapter.description || '')) && !/root|hub|controller/i.test(String(adapter.description || ''));
}

/** Interpreta a saída textual de `netsh wlan show interfaces`. */
/**
 * Rótulos do `netsh wlan show interfaces` em pt-BR e en-US.
 * A comparação é por rótulo EXATO (normalizado) para que "BSSID" não caia no
 * campo "SSID" e para que traduções parciais não quebrem a leitura.
 */
const WLAN_FIELD_LABELS = {
  description: ['descrição', 'descricao', 'description'],
  guid: ['guid', 'id'],
  physicalAddress: ['endereço físico', 'endereco fisico', 'physical address'],
  physicalMediaType: ['tipo de mídia física', 'tipo de midia fisica', 'physical media type'],
  state: ['estado', 'state'],
  ssid: ['ssid'],
  bssid: ['bssid'],
  radioType: ['tipo de rádio', 'tipo de radio', 'radio type'],
  authentication: ['autenticação', 'autenticacao', 'authentication'],
  cipher: ['criptografia', 'cipher'],
  channel: ['canal', 'channel'],
  receiveRateMbps: ['taxa de recepção (mbps)', 'taxa de recebimento (mbps)', 'receive rate (mbps)'],
  transmitRateMbps: ['taxa de transmissão (mbps)', 'taxa de transmissao (mbps)', 'transmit rate (mbps)'],
  signalPercent: ['sinal', 'signal'],
  profile: ['perfil', 'profile'],
  connectionMode: ['modo de conexão', 'modo de conexao', 'connection mode'],
  networkType: ['tipo de rede', 'network type'],
};

const WLAN_LABEL_TO_FIELD = (() => {
  const map = new Map();
  for (const [field, labels] of Object.entries(WLAN_FIELD_LABELS)) {
    for (const label of labels) map.set(label, field);
  }
  return map;
})();

function emptyWlanEntry() {
  return {
    name: null,
    description: null,
    guid: null,
    physicalAddress: null,
    physicalMediaType: null,
    state: null,
    ssid: null,
    bssid: null,
    radioType: null,
    authentication: null,
    cipher: null,
    channel: null,
    connectionMode: null,
    networkType: null,
    receiveRateMbps: null,
    transmitRateMbps: null,
    signalPercent: null,
    profile: null,
  };
}

/**
 * Interpreta `netsh wlan show interfaces`.
 *
 * A saída lista VÁRIAS interfaces separadas por linha em branco, todas com os
 * campos recuados em 4 espaços. Um splitter baseado em linha em branco não
 * funciona aí (o recuo impede o lookahead), então a leitura é feita linha a
 * linha: cada "Nome/Name" abre uma nova interface. Sem isso, numa máquina com
 * Wi-Fi interno + dongle USB só a primeira interface apareceria — e os tweaks
 * de autoconfig/energia seriam aplicados no adaptador errado.
 *
 * @param {string} raw Saída bruta de `netsh wlan show interfaces`
 * @returns {Array<object>} uma entrada por interface sem fio
 */
function parseWlanInterfaces(raw) {
  const text = String(raw || '');
  if (!text.trim()) return [];

  const nameRe = /^\s*(?:name|nome)\s*:\s*(.+?)\s*$/i;
  const fieldRe = /^\s*([^:]{2,64}?)\s*:\s*(.*)$/;

  const out = [];
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const nm = line.match(nameRe);
    if (nm) {
      current = emptyWlanEntry();
      current.name = nm[1];
      out.push(current);
      continue;
    }
    if (!current) continue; // cabeçalho ("There is 1 interface on the system:")

    const f = line.match(fieldRe);
    if (!f) continue;

    const field = WLAN_LABEL_TO_FIELD.get(f[1].trim().toLowerCase());
    if (!field) continue;

    const value = f[2].trim();
    current[field] = value === '' ? null : value;
  }

  return out.filter((w) => w.name);
}

function parseAutoconfig(raw) {
  const text = String(raw || '');
  const result = [];

  // Saída típica (pt-BR):
  //   Configuração automática de conexão: desativado no Wi-Fi 2
  // Saída típica (en-US):
  //   "Wi-Fi 2" auto configuration is disabled
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    let m = line.match(/^(?:"|“)([^"”]+)(?:"|”)\s+auto configuration is\s+(enabled|disabled)/i);
    if (m) {
      result.push({ name: m[1], enabled: m[2].toLowerCase() === 'enabled' });
      continue;
    }
    m = line.match(/(?:conexão|configuração)\s+automática[^:]*:\s*(ativado|desativado|habilitado|desabilitado)\s+(?:no|na)\s+(.+)$/i);
    if (m) {
      result.push({ name: m[2].trim(), enabled: /ativado|habilitado/i.test(m[1]) && !/desativado|desabilitado/i.test(m[1]) });
      continue;
    }
    m = line.match(/^(.+?)\s*[:\-]\s*(ativado|desativado|habilitado|desabilitado|enabled|disabled)\s*$/i);
    if (m && /autoconfig|automát/i.test(line)) {
      result.push({ name: m[1].trim(), enabled: /^(ativado|habilitado|enabled)$/i.test(m[2]) });
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

async function getSnapshot(options = {}) {
  const force = Boolean(options.force);
  if (!force && cache.snapshot && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  const res = await ps.runPowerShell(SNAPSHOT_BODY, { label: 'net:snapshot', timeout: 40000 });

  if (!res.success) {
    log.warn('Snapshot de rede falhou', { code: res.code, error: res.error });
    // IMPORTANTE: o snapshot de falha tem a MESMA forma do de sucesso.
    // Chamadores fazem `snap.wifiAdapters.find(...)` — sem as chaves, uma
    // falha de plataforma/permissão viraria TypeError em vez de UI vazia.
    return {
      ok: false,
      error: res.error,
      code: res.code,
      capturedAt: Date.now(),
      adapters: [],
      ipInterfaces: [],
      addresses: [],
      routes: [],
      dns: [],
      wlan: [],
      autoconfig: [],
      activeAdapter: null,
      gateway: null,
      wifiAdapters: [],
      usbWifiAdapters: [],
    };
  }

  const data = res.data || {};
  const adapters = ps.asArray(data.adapters).map((a) => ({
    ...a,
    ifIndex: Number(a.ifIndex) || null,
    isWifi: isWifiAdapter(a),
    isUsb: isUsbDevice(a),
    isUp: String(a.status || '').toLowerCase() === 'up' || String(a.status).toLowerCase() === 'disconnected',
    connected: String(a.status || '').toLowerCase() === 'up',
  }));

  const ipInterfaces = ps.asArray(data.ipInterfaces).map((i) => ({
    ...i,
    ifIndex: Number(i.ifIndex) || null,
    mtu: Number(i.mtu) || null,
  }));

  const addresses = ps.asArray(data.addresses).map((i) => ({ ...i, ifIndex: Number(i.ifIndex) || null }));

  const routes = ps
    .asArray(data.routes)
    .map((r) => ({ ...r, ifIndex: Number(r.ifIndex) || null, metric: Number(r.metric) || 0, ifMetric: Number(r.ifMetric) || 0 }))
    .sort((a, b) => a.metric + a.ifMetric - (b.metric + b.ifMetric));

  const dnsList = ps.asArray(data.dns).map((d) => ({ ...d, ifIndex: Number(d.ifIndex) || null, servers: ps.asArray(d.servers) }));

  const wlan = parseWlanInterfaces(data.wlanRaw);
  const autoconfig = parseAutoconfig(data.autoconfigRaw);

  // Interface ativa = a que possui a rota padrão de menor métrica E um IP não-APIPA.
  const activeAdapter = pickActiveAdapter(adapters, routes, addresses, ipInterfaces);
  // routes[0] = rota padrão de menor métrica (a lista já vem ordenada acima).
  const gateway = routes.length ? routes[0].nextHop || null : null;

  // Une MTU/DNS/addresses ao adaptador ativo para consumo fácil pela UI.
  if (activeAdapter) {
    const ipi = ipInterfaces.find((i) => i.ifIndex === activeAdapter.ifIndex);
    const addr = addresses.find((a) => a.ifIndex === activeAdapter.ifIndex && !isApiapa(a.ipAddress));
    const dnsEntry = dnsList.find((d) => d.ifIndex === activeAdapter.ifIndex);
    const wlanEntry = wlan.find((w) => sameName(w.name, activeAdapter.name));
    const acEntry = autoconfig.find((a) => sameName(a.name, activeAdapter.name));

    activeAdapter.mtu = ipi ? ipi.mtu : null;
    activeAdapter.dhcp = ipi ? ipi.dhcp : null;
    activeAdapter.ipAddress = addr ? addr.ipAddress : null;
    activeAdapter.prefixLength = addr ? addr.prefixLen : null;
    activeAdapter.dnsServers = dnsEntry ? dnsEntry.servers : [];
    activeAdapter.gateway = gateway;
    activeAdapter.wlan = wlanEntry || null;
    activeAdapter.autoconfigEnabled = acEntry ? acEntry.enabled : null;
  }

  // Anexa MTU/DNS/WLAN em todos os adaptadores também.
  for (const a of adapters) {
    const ipi = ipInterfaces.find((i) => i.ifIndex === a.ifIndex);
    const dnsEntry = dnsList.find((d) => d.ifIndex === a.ifIndex);
    const wlanEntry = wlan.find((w) => sameName(w.name, a.name));
    const acEntry = autoconfig.find((x) => sameName(x.name, a.name));
    a.mtu = ipi ? ipi.mtu : undefined;
    a.dnsServers = dnsEntry ? dnsEntry.servers : [];
    if (wlanEntry) a.wlan = wlanEntry;
    if (acEntry) a.autoconfigEnabled = acEntry.enabled;
  }

  const snapshot = {
    ok: true,
    capturedAt: Date.now(),
    adapters,
    ipInterfaces,
    addresses,
    routes,
    dns: dnsList,
    wlan,
    autoconfig,
    activeAdapter,
    gateway,
    wifiAdapters: adapters.filter((a) => a.isWifi),
    usbWifiAdapters: adapters.filter((a) => a.isWifi && a.isUsb),
  };

  cache = { at: Date.now(), snapshot };
  return snapshot;
}

function isApiapa(ip) {
  return /^169\.254\./.test(String(ip || '')) || !ip || ip === '0.0.0.0';
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function pickActiveAdapter(adapters, routes, addresses, ipInterfaces) {
  const usable = addresses.filter((a) => !isApiapa(a.ipAddress));

  // `routes` normalmente já chega ordenado por métrica (getSnapshot ordena),
  // mas não dependemos disso: quem tem a rota padrão de menor métrica é a
  // interface ativa, e escolher errado aplicaria Nagle/MTU/DNS no adaptador
  // que não está sendo usado pelo jogo.
  const ordered = [...routes].sort(
    (a, b) => (Number(a.metric) || 0) + (Number(a.ifMetric) || 0) - ((Number(b.metric) || 0) + (Number(b.ifMetric) || 0))
  );

  for (const route of ordered) {
    if (!route.nextHop || isApiapa(route.nextHop)) continue;
    const withIp = usable.find((a) => a.ifIndex === route.ifIndex);
    if (!withIp) continue;
    const adapter = adapters.find((a) => a.ifIndex === route.ifIndex && a.connected);
    if (adapter) return adapter;
  }

  // Fallback: qualquer adaptador "Up" com IP válido, preferindo cabo/Wi-Fi não virtual.
  const candidates = adapters
    .filter((a) => a.connected && usable.some((u) => u.ifIndex === a.ifIndex))
    .filter((a) => !/virtual|loopback|tunnel|vethernet|hyper-v|vmware|virtualbox|wireguard|tailscale|zerotier|bluetooth|pan\b/i.test(String(a.description || '')));

  candidates.sort((a, b) => {
    const score = (x) => (x.isWifi ? 1 : 0) + (x.isUsb ? 1 : 0);
    return score(a) - score(b);
  });

  return candidates[0] || null;
}

async function getActiveAdapter(options = {}) {
  const snap = await getSnapshot(options);
  return snap.activeAdapter;
}

async function getAdapters(options = {}) {
  const snap = await getSnapshot(options);
  return snap.adapters;
}

async function getWifiAdapters(options = {}) {
  const snap = await getSnapshot(options);
  return snap.wifiAdapters;
}

async function getGateway(options = {}) {
  const snap = await getSnapshot(options);
  return snap.gateway;
}

/**
 * Resolve as interfaces-alvo para tweaks de registro (Nagle etc.).
 * Prioriza a ativa; com `all=true`, inclui todas com IP válido.
 */
async function getRegistryTargetInterfaces(options = {}) {
  const snap = await getSnapshot(options);
  const all = Boolean(options.all);

  const withGuid = snap.adapters.filter((a) => a.guid);
  const usableIndexes = new Set(
    snap.addresses.filter((a) => !isApiapa(a.ipAddress)).map((a) => a.ifIndex)
  );

  let targets;
  if (all) {
    targets = withGuid.filter((a) => a.connected || usableIndexes.has(a.ifIndex));
  } else {
    targets = snap.activeAdapter ? [snap.activeAdapter] : [];
  }

  if (targets.length === 0) {
    targets = withGuid.filter((a) => usableIndexes.has(a.ifIndex));
  }

  return targets.map((a) => ({
    name: a.name,
    guid: a.guid,
    ifIndex: a.ifIndex,
    description: a.description,
    isWifi: a.isWifi,
    isUsb: a.isUsb,
    status: a.status,
    regPath: `HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\${a.guid}`,
  }));
}

function invalidate() {
  cache = { at: 0, snapshot: null };
}

module.exports = {
  getSnapshot,
  getActiveAdapter,
  getAdapters,
  getWifiAdapters,
  getGateway,
  getRegistryTargetInterfaces,
  invalidate,
  isWifiAdapter,
  isUsbDevice,
  parseWlanInterfaces,
  parseAutoconfig,
  pickActiveAdapter,
  isApiapa,
  sameName,
};
