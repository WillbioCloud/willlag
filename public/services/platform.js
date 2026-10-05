'use strict';

/**
 * Detecção de plataforma e matriz de recursos suportados.
 *
 * Vários tweaks dependem da versão do Windows (CTCP foi removido no Windows 10,
 * chimney/taskoffload foram descontinuados, BBR não existe na pilha inbox do
 * Windows). Em vez de "chutar", consultamos o sistema e marcamos o recurso como
 * suportado / não suportado, para que a UI nunca ofereça algo que vai falhar.
 */

const os = require('os');
const logger = require('./logger');

const log = logger.scope('platform');

const cache = {
  info: null,
  features: null,
  featuresAt: 0,
};

const FEATURES_TTL_MS = 60 * 1000;

function isWindows() {
  return process.platform === 'win32';
}

/** Build do Windows a partir de os.release() — ex.: "10.0.19045" -> 19045 */
function windowsBuild() {
  const rel = os.release() || '';
  const parts = rel.split('.');
  return parts.length >= 4 ? parseInt(parts[3], 10) || 0 : 0;
}

function windowsMajor() {
  const rel = os.release() || '';
  return parseInt(rel.split('.')[0], 10) || 0;
}

function basicInfo() {
  if (cache.info) return cache.info;

  const build = windowsBuild();
  let friendly = 'Desconhecido';
  if (build >= 22000) friendly = 'Windows 11';
  else if (build >= 10240) friendly = 'Windows 10';
  else if (build >= 9600) friendly = 'Windows 8.1';
  else if (build >= 9200) friendly = 'Windows 8';
  else if (build >= 7600) friendly = 'Windows 7';

  cache.info = {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    isWindows: isWindows(),
    windowsBuild: build,
    windowsVersion: friendly,
    // Windows 10 1607+ / Windows 11: várias configurações legadas não existem mais.
    isModernWindows: build >= 14393 || !isWindows(),
    cpus: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    uptimeSec: Math.round(os.uptime()),
  };
  return cache.info;
}

/**
 * Matriz de recursos. `force` ignora o cache.
 *
 * A detecção é conservadora: na dúvida, marcamos como suportado e deixamos o
 * próprio comando reportar a falha (com mensagem amigável) — isso evita bloquear
 * tweaks válidos em builds menos comuns.
 */
async function features(force = false) {
  const info = basicInfo();

  if (!info.isWindows) {
    return {
      detected: false,
      reason: 'Plataforma não-Windows: ajustes de registry/netsh indisponíveis.',
      registry: false,
      netsh: false,
      wlan: false,
      powerManagement: false,
      congestionProviders: [],
      ctcp: false,
      bbr: false,
      tcpFastOpen: false,
      mtuProbe: true,
      dnsProbe: true,
    };
  }

  if (!force && cache.features && Date.now() - cache.featuresAt < FEATURES_TTL_MS) {
    return cache.features;
  }

  // Import tardio para evitar dependência circular em testes.
  const ps = require('./psRunner');

  const body = `
$ErrorActionPreference = 'SilentlyContinue'
$result = @{ ok = $true }

# --- netsh int tcp show global (auto-tuning, ECN, FastOpen...) ---
$tcpGlobal = (netsh int tcp show global) 2>&1 | Out-String
$result.tcpGlobal = $tcpGlobal

# --- Provedores de congestionamento disponíveis por template ---
$supplemental = (netsh int tcp show supplemental) 2>&1 | Out-String
$result.supplemental = $supplemental

# --- Serviço WLAN AutoConfig presente? ---
$svc = Get-Service -Name WlanSvc -ErrorAction SilentlyContinue
$result.wlanService = if ($svc) { $svc.Status.ToString() } else { 'missing' }

# --- Cmdlets de gerenciamento de energia do adaptador ---
$result.hasNetAdapterPowerManagement = [bool](Get-Command -Name 'Set-NetAdapterPowerManagement' -ErrorAction SilentlyContinue)
$result.hasNetQosPolicy = [bool](Get-Command -Name 'New-NetQosPolicy' -ErrorAction SilentlyContinue)
$result.hasNetIPInterface = [bool](Get-Command -Name 'Get-NetIPInterface' -ErrorAction SilentlyContinue)

# --- WMI de energia (root\\WMI MSPower_DeviceEnable) ---
$result.hasMsPower = [bool](Get-CimClass -Namespace 'root/WMI' -ClassName 'MSPower_DeviceEnable' -ErrorAction SilentlyContinue)

Write-WillLagJson $result
`;

  const res = await ps.runPowerShell(body, { timeout: 25000 });

  if (!res.success) {
    log.warn('Falha ao detectar recursos do sistema', { error: res.error });
    cache.features = {
      detected: false,
      reason: res.error || 'Não foi possível consultar o sistema.',
      registry: true,
      netsh: true,
      wlan: true,
      powerManagement: true,
      congestionProviders: [],
      ctcp: false,
      bbr: false,
      tcpFastOpen: false,
      mtuProbe: true,
      dnsProbe: true,
    };
    cache.featuresAt = Date.now();
    return cache.features;
  }

  const data = res.data || {};
  const supplemental = String(data.supplemental || '');
  const tcpGlobal = String(data.tcpGlobal || '');

  const providers = parseCongestionProviders(supplemental);

  cache.features = {
    detected: true,
    registry: true,
    netsh: true,
    wlan: String(data.wlanService || '') !== 'missing',
    wlanServiceStatus: data.wlanService || 'unknown',
    powerManagement: Boolean(data.hasNetAdapterPowerManagement) || Boolean(data.hasMsPower),
    hasNetAdapterPowerManagement: Boolean(data.hasNetAdapterPowerManagement),
    hasMsPower: Boolean(data.hasMsPower),
    hasNetQosPolicy: Boolean(data.hasNetQosPolicy),
    hasNetIPInterface: Boolean(data.hasNetIPInterface),
    congestionProviders: providers,
    // CTCP só existe até o Windows 8.1 / builds antigos do 10.
    ctcp: providers.includes('ctcp'),
    // BBR não faz parte da pilha TCP/IP nativa do Windows — nunca "fingimos" ativá-lo.
    bbr: providers.includes('bbr'),
    tcpFastOpen: /fast\s*open/i.test(tcpGlobal),
    tcpGlobalRaw: tcpGlobal,
    supplementalRaw: supplemental,
    mtuProbe: true,
    dnsProbe: true,
  };
  cache.featuresAt = Date.now();
  return cache.features;
}

/**
 * Extrai a lista de provedores de congestionamento aceitos pelo sistema.
 * A saída de `netsh int tcp show supplemental` lista, por template, algo como:
 *   "Congestion Control Provider: cubic"  e em builds antigos uma lista de opções.
 * Fazemos uma varredura tolerante por nomes conhecidos.
 */
function parseCongestionProviders(text) {
  const known = ['cubic', 'ctcp', 'compound', 'newreno', 'hypercube', 'bbr', 'ilink', 'none', 'default'];
  const lower = String(text || '').toLowerCase();
  const found = known.filter((p) => lower.includes(p));

  // `cubic` e `ctcp` são os relevantes na prática; garantimos presença mínima
  // quando a saída veio vazia (algumas localizações/builds não imprimem a lista).
  if (found.length === 0 && lower.length > 0) return ['cubic'];
  if (found.length === 0) return [];

  // Ordena por preferência para escolha automática.
  const preference = ['ctcp', 'cubic', 'compound', 'newreno', 'bbr'];
  return found.sort((a, b) => {
    const ia = preference.indexOf(a);
    const ib = preference.indexOf(b);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/**
 * Escolhe o melhor provedor de congestionamento disponível.
 *
 * Justificativa técnica:
 *  - CTCP (Compound TCP) é mais agressivo em enlaces com banda*atraso alta e
 *    costuma reduzir o tempo de ramp-up — bom para downloads de jogos, mas pode
 *    aumentar bufferbloat (jitter) em conexões saturadas.
 *  - CUBIC é o padrão do Windows 10/11, mais justo e estável.
 *  - BBR não existe no Windows inbox.
 * Para *jogos* (pacotes pequenos, baixa utilização de banda) o provedor tem
 * impacto marginal; o ganho real vem de Nagle/auto-tuning/throttling. Por isso
 * tratamos este tweak como opcional e de risco baixo/médio.
 */
function pickCongestionProvider(available = [], preferred = 'auto') {
  const list = Array.isArray(available) ? available.map((s) => String(s).toLowerCase()) : [];
  if (preferred && preferred !== 'auto') {
    if (list.length === 0 || list.includes(preferred.toLowerCase())) return preferred.toLowerCase();
    return null;
  }
  if (list.includes('ctcp')) return 'ctcp';
  if (list.includes('cubic')) return 'cubic';
  return null;
}

function invalidate() {
  cache.info = null;
  cache.features = null;
  cache.featuresAt = 0;
}

module.exports = {
  isWindows,
  windowsBuild,
  windowsMajor,
  basicInfo,
  features,
  parseCongestionProviders,
  pickCongestionProvider,
  invalidate,
};
