'use strict';

/**
 * Otimizações da pilha TCP/IP do Windows (Registro + netsh).
 *
 * Princípios:
 *  - Toda alteração registra backup ANTES de escrever (reversão exata).
 *  - `detect()` lê o estado real e a UI mostra "antes -> depois".
 *  - Nenhum valor é "chutado": se o Windows já está no alvo, marcamos
 *    `alreadyOptimal` e não gravamos nada (evita churn inútil no registro).
 *  - Recursos inexistentes na versão do Windows são reportados como
 *    `unsupported` em vez de falhar silenciosamente.
 */

const ps = require('./psRunner');
const reg = require('./registryOps');
const netif = require('./netInterfaces');
const platform = require('./platform');
const stateStore = require('./stateStore');
const logger = require('./logger');

const log = logger.scope('tcpip');

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const NETWORK_THROTTLING_INDEX_DISABLED = 4294967295; // 0xffffffff

/** Valores padrão do Windows client (fallback quando não conseguimos ler o atual). */
const NETSH_GLOBAL_DEFAULTS = {
  autotuninglevel: 'normal',
  ecncapability: 'disabled',
  timestamps: 'disabled',
  fastopen: 'enabled',
  rss: 'enabled',
  rsc: 'enabled',
  chimney: 'disabled',
  initialrto: '3000',
  maxsynretransmissions: '2',
  nonsackrttresiliency: 'enabled',
  scalingheuristics: 'disabled',
};

/** Templates TCP afetados pelo provedor de congestionamento. */
const SUPPLEMENTAL_TEMPLATES = ['Internet'];

const VALUE_ALIASES = {
  normal: 'normal',
  padrão: 'normal',
  padrao: 'normal',
  disabled: 'disabled',
  desabilitado: 'disabled',
  desabilitada: 'disabled',
  desativado: 'disabled',
  desativada: 'disabled',
  off: 'disabled',
  enabled: 'enabled',
  habilitado: 'enabled',
  habilitada: 'enabled',
  ativado: 'enabled',
  ativada: 'enabled',
  on: 'enabled',
  highlyrestricted: 'highlyrestricted',
  restritoaltamente: 'highlyrestricted',
  restricted: 'restricted',
  restrito: 'restricted',
  experimental: 'experimental',
  default: 'default',
};

function normalizeEnumValue(value) {
  const v = String(value || '').trim().toLowerCase();
  return VALUE_ALIASES[v] || v || null;
}

/* ------------------------------------------------------------------ */
/* Leitura estruturada do estado TCP global                            */
/* ------------------------------------------------------------------ */

let tcpGlobalCache = { at: 0, data: null };
const TCP_GLOBAL_TTL = 6000;

/**
 * Lê o estado global de TCP.
 * Fonte primária: CIM `Get-NetTCPSetting` (independente de idioma).
 * Fonte secundária: texto de `netsh int tcp show global` (tolerante a pt-BR).
 */
async function getTcpGlobal(options = {}) {
  if (!options.force && tcpGlobalCache.data && Date.now() - tcpGlobalCache.at < TCP_GLOBAL_TTL) {
    return tcpGlobalCache.data;
  }

  if (!ps.isWindows()) {
    return { ok: false, error: 'Disponível apenas no Windows.', settings: {}, raw: '' };
  }

  const body = `
$ErrorActionPreference = 'SilentlyContinue'

function Get-Prop($obj, $name) {
  if ($null -eq $obj) { return $null }
  $p = $obj.PSObject.Properties[$name]
  if ($null -eq $p -or $null -eq $p.Value) { return $null }
  return "$($p.Value)"
}

$candidates = @('Internet','InternetCustom','Datacenter','Compat')
$settings = @(Get-NetTCPSetting -ErrorAction SilentlyContinue)
$result = @{}
$result.settings = @()

foreach ($s in $settings) {
  $name = Get-Prop $s 'SettingName'
  $row = [ordered]@{
    settingName            = $name
    autoTuningLevelLocal   = Get-Prop $s 'AutoTuningLevelLocal'
    autoTuningLevelEff     = Get-Prop $s 'AutoTuningLevelEffective'
    autoTuningReason       = Get-Prop $s 'AutoTuningReason'
    ecnCapability          = Get-Prop $s 'EcnCapability'
    timestamps             = Get-Prop $s 'Timestamps'
    enableFastOpen         = Get-Prop $s 'EnableFastOpen'
    fastOpen               = Get-Prop $s 'FastOpen'
    rss                    = Get-Prop $s 'Rss'
    rsc                    = Get-Prop $s 'Rsc'
    chimney                = Get-Prop $s 'Chimney'
    initialRto             = Get-Prop $s 'InitialRto'
    maxSynRetransmissions  = Get-Prop $s 'MaxSynRetransmissions'
    nonSackRttResiliency   = Get-Prop $s 'NonSackRttResiliency'
    scalingHeuristics      = Get-Prop $s 'ScalingHeuristics'
    congestionProvider     = Get-Prop $s 'CongestionControlProvider'
    addOnCongestion        = Get-Prop $s 'AddOnCongestionControlProvider'
    minRto                 = Get-Prop $s 'MinRto'
    delayedAckTimeout      = Get-Prop $s 'DelayedAckTimeout'
    delayedAckFrequency    = Get-Prop $s 'DelayedAckFrequency'
  }
  $result.settings += [pscustomobject]$row
}

# netsh como fonte secundária (também usada para o provedor por template)
$result.netshGlobal = (netsh int tcp show global) 2>&1 | Out-String
$result.netshSupplemental = (netsh int tcp show supplemental) 2>&1 | Out-String

# RSS efetivo por adaptador
$result.rssAdapters = @(Get-NetAdapterRss -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; enabled = [bool]$_.Enabled }
})

# RSC efetivo por adaptador
$result.rscAdapters = @(Get-NetAdapterRsc -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; ipv4Enabled = [bool]$_.IPv4Enabled; ipv6Enabled = [bool]$_.IPv6Enabled }
})

Write-WillLagJson @{ ok = $true; result = $result }
`;

  const res = await ps.runPowerShell(body, { label: 'tcp:global', timeout: 40000 });
  if (!res.success) {
    log.warn('getTcpGlobal falhou', { code: res.code, error: res.error });
    return { ok: false, error: res.error, code: res.code, settings: [], raw: '' };
  }

  const raw = (res.data && res.data.result) || {};
  const rows = ps.asArray(raw.settings);
  const netshGlobal = String(raw.netshGlobal || '');
  const netshSupplemental = String(raw.netshSupplemental || '');

  const parsedNetsh = parseNetshTcpGlobal(netshGlobal);
  const providers = parseSupplementalProviders(netshSupplemental);

  // Escolhe a linha "Internet" (a que vale para tráfego comum) como principal.
  const primary = rows.find((r) => String(r.settingName).toLowerCase() === 'internet') || rows[0] || {};

  const pick = (cimValue, netshValue) => {
    const a = normalizeEnumValue(cimValue);
    if (a) return a;
    const b = normalizeEnumValue(netshValue);
    return b || null;
  };

  const data = {
    ok: true,
    capturedAt: Date.now(),
    autoTuningLevel: pick(primary.autoTuningLevelLocal, parsedNetsh.autoTuningLevel),
    autoTuningLevelEffective: normalizeEnumValue(primary.autoTuningLevelEff) || null,
    autoTuningReason: primary.autoTuningReason || null,
    ecnCapability: pick(primary.ecnCapability, parsedNetsh.ecnCapability),
    timestamps: pick(primary.timestamps, parsedNetsh.timestamps),
    fastOpen: pick(primary.enableFastOpen || primary.fastOpen, parsedNetsh.fastOpen),
    rss: pick(primary.rss, parsedNetsh.rss),
    rsc: pick(primary.rsc, parsedNetsh.rsc),
    chimney: pick(primary.chimney, parsedNetsh.chimney),
    initialRto: primary.initialRto || parsedNetsh.initialRto || null,
    maxSynRetransmissions: primary.maxSynRetransmissions || null,
    nonSackRttResiliency: normalizeEnumValue(primary.nonSackRttResiliency) || null,
    scalingHeuristics: normalizeEnumValue(primary.scalingHeuristics) || null,
    congestionProviders: providers,
    rssAdapters: ps.asArray(raw.rssAdapters),
    rscAdapters: ps.asArray(raw.rscAdapters),
    templates: rows,
    rawGlobal: netshGlobal,
    rawSupplemental: netshSupplemental,
  };

  tcpGlobalCache = { at: Date.now(), data };
  return data;
}

function invalidateTcpCache() {
  tcpGlobalCache = { at: 0, data: null };
}

/** Parser tolerante a idioma para `netsh int tcp show global`. */
function parseNetshTcpGlobal(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);

  const labelMap = [
    { re: /auto.?tun|auto.?ajuste/i, key: 'autoTuningLevel' },
    // "ECN Policy" é outra configuração: se ela aparecer antes no texto,
    // leríamos 'default' como se fosse a capacidade. Por isso o exclude.
    { re: /\becn\b/i, key: 'ecnCapability', exclude: /policy|política|politica/i },
    { re: /timestamp|rfc\s*1323|carimbo/i, key: 'timestamps' },
    { re: /fast\s*open|abertura\s*r[áa]pida|\bmms\b/i, key: 'fastOpen' },
    { re: /receive.?side scaling|rss|escala lateral/i, key: 'rss' },
    { re: /segment coalescing|\brsc\b|coalesc/i, key: 'rsc' },
    { re: /chimney/i, key: 'chimney' },
    { re: /initial\s*rto|rto inicial/i, key: 'initialRto' },
    { re: /congestion/i, key: 'congestionProvider' },
  ];

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const label = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!label || !value) continue;

    for (const { re, key, exclude } of labelMap) {
      if (exclude && exclude.test(label)) continue;
      if (re.test(label) && out[key] === undefined) {
        const m = value.match(/^([A-Za-zÀ-ú]+)\s*(\((\d+)\))?/);
        out[key] = m ? normalizeEnumValue(m[1]) || m[3] || value : value;
        if (m && m[3]) out[key] = m[3];
      }
    }
  }
  return out;
}

/**
 * Extrai o provedor de congestionamento por template de
 * `netsh int tcp show supplemental`. Os nomes de template e de provedor são
 * palavras-chave em inglês mesmo em Windows localizado, então o parser é estável.
 */
function parseSupplementalProviders(text) {
  const t = String(text || '');
  const templates = ['internetcustom', 'datacentercustom', 'internet', 'datacenter', 'compat'];
  const providers = ['ctcp', 'cubic', 'compound', 'newreno', 'hypercube', 'bbr', 'ilink', 'none', 'default'];

  const lower = t.toLowerCase();
  const result = {};

  // Estratégia 1: linhas "Template : Provider" ou blocos por template.
  const lines = t.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const low = trimmed.toLowerCase();

    const tplHit = templates.find((tp) => low === tp || low.startsWith(tp + ' ') || low.includes(tp));
    if (tplHit && low.length < 60) {
      const canonical = tplHit === 'internetcustom' ? 'InternetCustom'
        : tplHit === 'datacentercustom' ? 'DatacenterCustom'
        : tplHit.charAt(0).toUpperCase() + tplHit.slice(1);
      if (low.length < 40) current = canonical;
    }

    const provHit = providers.find((p) => new RegExp(`\\b${p}\\b`).test(low));
    if (provHit && /congestion|congestionamento/i.test(low)) {
      const m = trimmed.split(':');
      const val = (m.length > 1 ? m[m.length - 1] : trimmed).trim().toLowerCase();
      const found = providers.find((p) => val.includes(p));
      const key = current || 'Internet';
      if (found && result[key] === undefined) result[key] = found;
    } else if (provHit && current && result[current] === undefined && low.length < 40) {
      result[current] = provHit;
    }
  }

  // Estratégia 2 (fallback): primeiro provedor citado em todo o texto.
  if (Object.keys(result).length === 0) {
    const first = providers.find((p) => new RegExp(`\\b${p}\\b`).test(lower));
    if (first) result.Internet = first;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Helper: aplicar um setting global via netsh, com backup             */
/* ------------------------------------------------------------------ */

async function setNetshGlobal(setting, value, ctx, options = {}) {
  const key = String(setting).toLowerCase();
  const state = await getTcpGlobal({ force: true });

  const stateKeyMap = {
    autotuninglevel: 'autoTuningLevel',
    ecncapability: 'ecnCapability',
    timestamps: 'timestamps',
    fastopen: 'fastOpen',
    rss: 'rss',
    rsc: 'rsc',
    chimney: 'chimney',
    initialrto: 'initialRto',
    maxsynretransmissions: 'maxSynRetransmissions',
    nonsackrttresiliency: 'nonSackRttResiliency',
    scalingheuristics: 'scalingHeuristics',
  };

  const previous = state.ok ? state[stateKeyMap[key]] : null;
  const fallback = NETSH_GLOBAL_DEFAULTS[key] || null;
  const restoreValue = previous || fallback;

  const res = await ps.runNetsh(['int', 'tcp', 'set', 'global', `${key}=${value}`], { timeout: 25000 });

  invalidateTcpCache();

  return {
    success: res.success,
    code: res.code,
    error: res.error || null,
    output: res.output,
    previous: restoreValue,
    entry: restoreValue
      ? { kind: 'netshGlobal', setting: key, value: restoreValue, note: options.note || null }
      : null,
  };
}

async function setNetshSupplemental(template, setting, value, ctx, options = {}) {
  const state = await getTcpGlobal({ force: true });
  const providers = (state.ok && state.congestionProviders) || {};
  const previous = providers[template] || providers.Internet || null;

  const res = await ps.runNetsh(
    ['int', 'tcp', 'set', 'supplemental', template, `${setting}=${value}`],
    { timeout: 25000 }
  );

  invalidateTcpCache();

  const fallback = setting.toLowerCase() === 'congestionprovider' ? 'cubic' : null;
  const restoreValue = previous || fallback;

  return {
    success: res.success,
    code: res.code,
    error: res.error || null,
    output: res.output,
    previous: restoreValue,
    entry: restoreValue
      ? {
          kind: 'netshSupplemental',
          template,
          setting,
          value: restoreValue,
          note: options.note || null,
        }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* TWEAK 1 — Nagle's Algorithm (TcpAckFrequency / TCPNoDelay)          */
/* ------------------------------------------------------------------ */

const NAGLE_VALUES = [
  { name: 'TcpAckFrequency', value: 1, kind: 'DWord' },
  { name: 'TCPNoDelay', value: 1, kind: 'DWord' },
  { name: 'TcpDelAckTicks', value: 0, kind: 'DWord' },
];

async function nagleTargets(ctx) {
  const opts = (ctx.params && ctx.params.nagle) || {};
  return netif.getRegistryTargetInterfaces({ all: Boolean(opts.allInterfaces), force: Boolean(opts.force) });
}

async function detectNagle(ctx) {
  if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };

  const targets = await nagleTargets(ctx);
  if (targets.length === 0) {
    return {
      ok: false,
      supported: true,
      applied: false,
      error: 'Nenhuma interface de rede ativa com GUID encontrado.',
      interfaces: [],
    };
  }

  const requests = targets.map((t) => ({
    path: t.regPath,
    names: NAGLE_VALUES.map((v) => v.name),
    note: t.name,
  }));

  const data = await reg.readValuesBatch(requests);
  if (data.__error) return { ok: false, supported: true, error: data.__error, code: data.__code };

  const interfaces = targets.map((t) => {
    const bucket = data[reg.toNativePath(t.regPath)] || {};
    const values = bucket.values || {};
    const current = {};
    let allOk = true;
    for (const spec of NAGLE_VALUES) {
      const found = Object.keys(values).find((k) => k.toLowerCase() === spec.name.toLowerCase());
      const entry = found ? values[found] : null;
      const num = entry && entry.exists ? Number(entry.value) : null;
      current[spec.name] = entry && entry.exists ? num : null;
      if (num !== spec.value) allOk = false;
    }
    return {
      name: t.name,
      guid: t.guid,
      ifIndex: t.ifIndex,
      isWifi: t.isWifi,
      isUsb: t.isUsb,
      keyExists: Boolean(bucket.exists),
      current,
      optimized: allOk,
    };
  });

  const optimizedCount = interfaces.filter((i) => i.optimized).length;

  return {
    ok: true,
    supported: true,
    applied: optimizedCount === interfaces.length && interfaces.length > 0,
    partiallyApplied: optimizedCount > 0 && optimizedCount < interfaces.length,
    interfaces,
    current: interfaces.map((i) => `${i.name}: ${describeNagle(i.current)}`).join(' | '),
    target: 'TcpAckFrequency=1, TCPNoDelay=1, TcpDelAckTicks=0',
  };
}

function describeNagle(current) {
  const ack = current.TcpAckFrequency;
  const nd = current.TCPNoDelay;
  if (ack === 1 && nd === 1) return 'otimizado';
  if (ack === null && nd === null) return 'padrão (Nagle ativo)';
  return `parcial (Ack=${ack === null ? '-' : ack}, NoDelay=${nd === null ? '-' : nd})`;
}

async function applyNagle(ctx) {
  const targets = await nagleTargets(ctx);
  if (targets.length === 0) {
    return { success: false, code: 'NO_INTERFACE', error: 'Nenhuma interface de rede ativa encontrada.' };
  }

  // 1) Backup ANTES de escrever.
  const requests = targets.map((t) => ({
    path: t.regPath,
    names: NAGLE_VALUES.map((v) => v.name),
    note: t.name,
  }));
  const before = await reg.readValuesBatch(requests);
  if (before.__error) {
    return { success: false, code: before.__code || 'READ_FAILED', error: `Falha ao ler estado atual: ${before.__error}` };
  }
  const entries = reg.toBackupEntries(before, requests);
  stateStore.pushBackup('nagle', entries, { interfaces: targets.map((t) => t.name) });

  // 2) Escrita em lote.
  const writes = [];
  for (const t of targets) {
    for (const spec of NAGLE_VALUES) {
      writes.push({ path: t.regPath, name: spec.name, value: spec.value, kind: spec.kind, createKey: false });
    }
  }

  const res = await reg.writeValuesBatch(writes, {
    elevated: true,
    isAdmin: ctx.isAdmin,
    allowPrompt: ctx.allowPrompt,
  });

  if (!res.success && res.code === 'UAC_DENIED') {
    stateStore.consumeBackup('nagle');
    return res;
  }

  invalidateTcpCache();
  netif.invalidate();

  const okCount = res.results.filter((r) => r.ok).length;

  return {
    success: res.success || okCount > 0,
    code: res.code,
    error: res.success ? null : res.error,
    applied: true,
    message: res.success
      ? `Nagle desativado em ${targets.length} interface(s). Novas conexões já nascem sem atraso de ACK.`
      : `${okCount}/${writes.length} valores gravados. ${res.error || ''}`.trim(),
    current: 'TcpAckFrequency=1, TCPNoDelay=1, TcpDelAckTicks=0',
    target: 'TcpAckFrequency=1, TCPNoDelay=1, TcpDelAckTicks=0',
    details: targets.map((t) => `${t.name}${t.isWifi ? ' (Wi-Fi)' : ''}${t.isUsb ? ' (USB)' : ''}`),
    requiresReboot: false,
    note: 'Vale para novas conexões TCP. Reinicie o jogo (não o Windows) para renegociar os sockets.',
  };
}

async function revertNagle(ctx) {
  const layer = stateStore.peekBackup('nagle');
  if (!layer || !layer.entries || layer.entries.length === 0) {
    // Sem backup: remove os valores (volta ao padrão do Windows).
    const targets = await nagleTargets(ctx);
    const entries = [];
    for (const t of targets) {
      for (const spec of NAGLE_VALUES) {
        entries.push({ kind: 'registry', path: reg.toNativePath(t.regPath), name: spec.name, existed: false });
      }
    }
    const res = await require('./restoreEngine').restoreEntries(entries, {
      isAdmin: ctx.isAdmin,
      allowPrompt: ctx.allowPrompt,
    });
    return { ...res, applied: false, note: 'Sem backup: valores removidos (padrão do Windows).' };
  }

  const res = await require('./restoreEngine').restoreEntries(layer.entries, {
    isAdmin: ctx.isAdmin,
    allowPrompt: ctx.allowPrompt,
  });

  if (res.success || res.code === 'PARTIAL') stateStore.consumeBackup('nagle');
  invalidateTcpCache();
  return { ...res, applied: false };
}

/* ------------------------------------------------------------------ */
/* TWEAK 2/3 — NetworkThrottlingIndex e SystemResponsiveness           */
/* ------------------------------------------------------------------ */

async function detectSystemProfileValue(ctx, valueName, target) {
  if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };

  const data = await reg.readValuesBatch([
    { path: reg.HKLM_MM_SYSTEMPROFILE, names: [valueName] },
  ]);
  if (data.__error) return { ok: false, supported: true, error: data.__error };

  const bucket = data[reg.HKLM_MM_SYSTEMPROFILE] || {};
  const values = bucket.values || {};
  const found = Object.keys(values).find((k) => k.toLowerCase() === valueName.toLowerCase());
  const entry = found ? values[found] : null;
  const current = entry && entry.exists ? Number(entry.value) : null;

  return {
    ok: true,
    supported: true,
    applied: current === target,
    current: current === null ? 'não definido (padrão Windows)' : reg.formatDword(current),
    currentRaw: current,
    target: reg.formatDword(target),
    targetRaw: target,
  };
}

async function applySystemProfileValue(ctx, valueName, target, tweakId, human) {
  const requests = [{ path: reg.HKLM_MM_SYSTEMPROFILE, names: [valueName] }];
  const before = await reg.readValuesBatch(requests);
  if (before.__error) {
    return { success: false, code: before.__code || 'READ_FAILED', error: `Falha ao ler ${valueName}: ${before.__error}` };
  }

  const entries = reg.toBackupEntries(before, requests);
  stateStore.pushBackup(tweakId, entries, { valueName });

  const res = await reg.writeValuesBatch(
    [{ path: reg.HKLM_MM_SYSTEMPROFILE, name: valueName, value: target, kind: 'DWord', createKey: true }],
    { elevated: true, isAdmin: ctx.isAdmin, allowPrompt: ctx.allowPrompt }
  );

  if (!res.success && res.code === 'UAC_DENIED') stateStore.consumeBackup(tweakId);

  return {
    success: res.success,
    code: res.code,
    error: res.success ? null : res.error,
    applied: res.success,
    message: res.success ? human : res.error,
    current: reg.formatDword(target),
    target: reg.formatDword(target),
  };
}

async function revertSystemProfileValue(ctx, tweakId) {
  const layer = stateStore.peekBackup(tweakId);
  if (!layer) {
    return {
      success: true,
      code: 'NO_BACKUP',
      applied: false,
      message: 'Nenhum backup encontrado — nada a reverter.',
    };
  }
  const res = await require('./restoreEngine').restoreEntries(layer.entries, {
    isAdmin: ctx.isAdmin,
    allowPrompt: ctx.allowPrompt,
  });
  if (res.success || res.code === 'PARTIAL') stateStore.consumeBackup(tweakId);
  return { ...res, applied: false };
}

/* ------------------------------------------------------------------ */
/* TWEAK 4 — MMCSS Tasks\Games                                         */
/* ------------------------------------------------------------------ */

const GAMES_TASK_VALUES = [
  { name: 'GPU Priority', value: 8, kind: 'DWord' },
  { name: 'Priority', value: 6, kind: 'DWord' },
  { name: 'Scheduling Category', value: 'High', kind: 'String' },
  { name: 'SFIO Priority', value: 'High', kind: 'String' },
];

async function detectGamesTask(ctx) {
  if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };

  const requests = [{ path: reg.HKLM_MM_TASKS_GAMES, names: GAMES_TASK_VALUES.map((v) => v.name) }];
  const data = await reg.readValuesBatch(requests);
  if (data.__error) return { ok: false, supported: true, error: data.__error };

  const bucket = data[reg.HKLM_MM_TASKS_GAMES] || {};
  const values = bucket.values || {};
  const current = {};
  let allOk = bucket.exists === true;

  for (const spec of GAMES_TASK_VALUES) {
    const found = Object.keys(values).find((k) => k.toLowerCase() === spec.name.toLowerCase());
    const entry = found ? values[found] : null;
    const cur = entry && entry.exists ? entry.value : null;
    current[spec.name] = cur;
    if (String(cur) !== String(spec.value)) allOk = false;
  }

  return {
    ok: true,
    supported: true,
    applied: allOk,
    current: Object.entries(current)
      .map(([k, v]) => `${k}=${v === null ? 'padrão' : v}`)
      .join(', '),
    target: GAMES_TASK_VALUES.map((v) => `${v.name}=${v.value}`).join(', '),
  };
}

async function applyGamesTask(ctx) {
  const requests = [{ path: reg.HKLM_MM_TASKS_GAMES, names: GAMES_TASK_VALUES.map((v) => v.name) }];
  const before = await reg.readValuesBatch(requests);
  if (before.__error) {
    return { success: false, code: 'READ_FAILED', error: `Falha ao ler Tasks\\Games: ${before.__error}` };
  }
  const entries = reg.toBackupEntries(before, requests);
  stateStore.pushBackup('mmcssGames', entries);

  const res = await reg.writeValuesBatch(
    GAMES_TASK_VALUES.map((v) => ({
      path: reg.HKLM_MM_TASKS_GAMES,
      name: v.name,
      value: v.value,
      kind: v.kind,
      createKey: true,
    })),
    { elevated: true, isAdmin: ctx.isAdmin, allowPrompt: ctx.allowPrompt }
  );

  if (!res.success && res.code === 'UAC_DENIED') stateStore.consumeBackup('mmcssGames');

  return {
    success: res.success,
    code: res.code,
    error: res.success ? null : res.error,
    applied: res.success,
    message: res.success
      ? 'Tarefas multimídia de jogos priorizadas (GPU Priority=8, Priority=6, Scheduling=High, SFIO=High).'
      : res.error,
    current: GAMES_TASK_VALUES.map((v) => `${v.name}=${v.value}`).join(', '),
    target: GAMES_TASK_VALUES.map((v) => `${v.name}=${v.value}`).join(', '),
  };
}

/* ------------------------------------------------------------------ */
/* Definições de tweaks                                                */
/* ------------------------------------------------------------------ */

/** Fábrica de tweaks baseados em um setting global do netsh int tcp. */
function netshGlobalTweak(def) {
  const stateKey = def.stateKey;
  const setting = def.setting;

  return {
    id: def.id,
    group: def.group || 'tcpip',
    label: def.label,
    description: def.description,
    why: def.why,
    risk: def.risk || 'low',
    requiresAdmin: true,
    scope: 'persistent',
    rebootRecommended: Boolean(def.rebootRecommended),
    defaultInPreset: def.defaultInPreset !== false,
    options: def.options || null,
    legacy: Boolean(def.legacy),

    async detect(ctx) {
      if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };

      const feats = ctx.features ? await ctx.features() : await platform.features();
      if (def.unsupportedOn && def.unsupportedOn(feats)) {
        return {
          ok: true,
          supported: false,
          applied: false,
          reason: def.unsupportedReason || 'Não suportado nesta versão do Windows.',
        };
      }

      const state = await getTcpGlobal();
      const current = state.ok ? normalizeEnumValue(state[stateKey]) : null;
      const target = def.resolveTarget ? def.resolveTarget(state, feats, ctx) : def.target;

      return {
        ok: state.ok,
        supported: true,
        applied: current !== null && String(current).toLowerCase() === String(target).toLowerCase(),
        current: current || (state.ok ? 'desconhecido' : 'indisponível'),
        target,
        error: state.ok ? null : state.error,
        effective: def.effectiveFrom ? def.effectiveFrom(state) : undefined,
      };
    },

    async apply(ctx) {
      const feats = ctx.features ? await ctx.features() : await platform.features();
      if (def.unsupportedOn && def.unsupportedOn(feats)) {
        return {
          success: false,
          code: 'UNSUPPORTED',
          applied: false,
          message: def.unsupportedReason || 'Não suportado nesta versão do Windows.',
        };
      }

      const state = await getTcpGlobal({ force: true });
      const target = def.resolveTarget ? def.resolveTarget(state, feats, ctx) : def.target;
      if (!target) {
        return { success: false, code: 'NO_TARGET', applied: false, message: 'Não foi possível determinar o valor alvo.' };
      }

      const res = await setNetshGlobal(setting, target, ctx, { note: def.id });
      if (!res.success) {
        return {
          success: false,
          code: res.code,
          applied: false,
          error: res.error,
          message: res.error || `Falha ao aplicar ${setting}=${target}.`,
          output: res.output,
        };
      }

      if (res.entry) stateStore.pushBackup(def.id, [res.entry], { setting, target });
      stateStore.markApplied(def.id, { scope: 'persistent', params: { setting, target } });

      return {
        success: true,
        code: 'OK',
        applied: true,
        message: `${def.label}: ${setting}=${target}` + (res.previous ? ` (anterior: ${res.previous})` : ''),
        current: target,
        target,
        previous: res.previous,
      };
    },

    async revert(ctx) {
      const layer = stateStore.peekBackup(def.id);
      const fallback = NETSH_GLOBAL_DEFAULTS[setting.toLowerCase()];

      const entries = layer && layer.entries
        ? layer.entries
        : fallback
          ? [{ kind: 'netshGlobal', setting: setting.toLowerCase(), value: fallback, note: 'padrão Windows' }]
          : [];

      if (entries.length === 0) {
        return { success: true, code: 'NO_BACKUP', applied: false, message: 'Sem backup e sem padrão conhecido.' };
      }

      const res = await require('./restoreEngine').restoreEntries(entries, {
        isAdmin: ctx.isAdmin,
        allowPrompt: ctx.allowPrompt,
      });
      if (res.success || res.code === 'PARTIAL') stateStore.consumeBackup(def.id);
      stateStore.markReverted(def.id);
      invalidateTcpCache();
      return { ...res, applied: false };
    },
  };
}

const tweaks = [
  {
    id: 'nagle',
    group: 'tcpip',
    label: "Desativar Nagle's Algorithm (TCP_NODELAY)",
    description:
      'Envia cada pacote imediatamente, sem esperar acumular dados ou o ACK atrasado.',
    why:
      "O algoritmo de Nagle segura pacotes pequenos até receber ACK (até ~40-200ms com delayed ACK). " +
      'Pacotes de jogo têm 40-120 bytes e são enviados 20-60x por segundo — exatamente o pior caso ' +
      'para Nagle. TcpAckFrequency=1 força ACK a cada pacote e TCPNoDelay=1 desliga o buffer de saída.',
    risk: 'low',
    requiresAdmin: true,
    scope: 'persistent',
    rebootRecommended: false,
    defaultInPreset: true,
    // Por padrão mexemos apenas na interface ATIVA (a que o jogo usa). A opção
    // "todas" existe porque máquinas com cabo + Wi-Fi + VPN podem querer o
    // mesmo comportamento em todas as interfaces com IP.
    options: [
      { value: false, label: 'Somente a interface ativa (recomendado)' },
      { value: true, label: 'Todas as interfaces com IP' },
    ],
    detect: detectNagle,
    apply: applyNagle,
    revert: revertNagle,
  },

  {
    id: 'networkThrottling',
    group: 'tcpip',
    label: 'Desativar Network Throttling (MMCSS)',
    description: 'NetworkThrottlingIndex = 0xffffffff (sem limite de pacotes/ms para multimídia).',
    why:
      'Por padrão o Windows limita o tráfego de rede não-multimídia a 10 pacotes/ms enquanto há ' +
      'uma sessão MMCSS ativa (jogos e players de áudio registram sessões MMCSS). Em jogos com ' +
      'tick rate alto ou voice chat simultâneo, esse limite causa micro-stalls. 0xffffffff remove o teto.',
    risk: 'low',
    requiresAdmin: true,
    scope: 'persistent',
    rebootRecommended: false,
    defaultInPreset: true,
    detect: (ctx) => detectSystemProfileValue(ctx, 'NetworkThrottlingIndex', NETWORK_THROTTLING_INDEX_DISABLED),
    apply: (ctx) =>
      applySystemProfileValue(
        ctx,
        'NetworkThrottlingIndex',
        NETWORK_THROTTLING_INDEX_DISABLED,
        'networkThrottling',
        'Network Throttling desativado (NetworkThrottlingIndex = 0xffffffff).'
      ),
    revert: (ctx) => revertSystemProfileValue(ctx, 'networkThrottling'),
  },

  {
    id: 'systemResponsiveness',
    group: 'tcpip',
    label: 'System Responsiveness = 0 (100% para o jogo)',
    description: 'Remove a reserva de CPU para tarefas de segundo plano durante sessões multimídia.',
    why:
      'SystemResponsiveness=20 (padrão) reserva 20% da CPU para tarefas em segundo plano. Com 0, o ' +
      'agendador dedica tudo ao jogo — menos preempção, menos variação de frame time e menos jitter ' +
      'na thread de rede. Efeito colateral: downloads/updates em segundo plano ficam mais lentos.',
    risk: 'medium',
    requiresAdmin: true,
    scope: 'persistent',
    rebootRecommended: false,
    defaultInPreset: true,
    options: [
      { value: 0, label: '0 — agressivo (máximo para o jogo)' },
      { value: 10, label: '10 — equilibrado (recomendado se houver stream/download)' },
      { value: 20, label: '20 — padrão do Windows' },
    ],
    detect: (ctx) => detectSystemProfileValue(ctx, 'SystemResponsiveness', ctx.params?.systemResponsiveness ?? 0),
    apply: (ctx) => {
      const target = Number(ctx.params?.systemResponsiveness ?? 0);
      return applySystemProfileValue(
        ctx,
        'SystemResponsiveness',
        target,
        'systemResponsiveness',
        `SystemResponsiveness definido como ${target}.`
      );
    },
    revert: (ctx) => revertSystemProfileValue(ctx, 'systemResponsiveness'),
  },

  {
    id: 'mmcssGames',
    group: 'tcpip',
    label: 'Priorizar tarefas MMCSS de jogos',
    description: 'GPU Priority=8, Priority=6, Scheduling Category=High, SFIO Priority=High.',
    why:
      'A chave Tasks\\Games do MMCSS define como o Windows agenda threads marcadas como "Games". ' +
      'Elevar GPU Priority e SFIO Priority reduz a chance de o thread de render/rede perder a CPU ' +
      'para serviços em segundo plano — fonte comum de stutter periódico.',
    risk: 'low',
    requiresAdmin: true,
    scope: 'persistent',
    rebootRecommended: false,
    defaultInPreset: true,
    detect: detectGamesTask,
    apply: applyGamesTask,
    revert: async (ctx) => {
      const layer = stateStore.peekBackup('mmcssGames');
      if (!layer) return { success: true, code: 'NO_BACKUP', applied: false, message: 'Nada a reverter.' };
      const res = await require('./restoreEngine').restoreEntries(layer.entries, {
        isAdmin: ctx.isAdmin,
        allowPrompt: ctx.allowPrompt,
      });
      if (res.success || res.code === 'PARTIAL') stateStore.consumeBackup('mmcssGames');
      return { ...res, applied: false };
    },
  },

  netshGlobalTweak({
    id: 'autoTuning',
    label: 'TCP Auto-Tuning = normal',
    description: 'Mantém a janela de recepção dinâmica no modo recomendado pela Microsoft.',
    why:
      'Auto-tuning em "disabled" trava a janela de recepção em 64KB, o que derruba throughput e faz o ' +
      'TCP entrar em congestionamento com mais frequência (mais retransmissões = mais jitter). ' +
      '"restricted"/"highlyrestricted" limitam o crescimento. "normal" é o ponto ótimo para jogos: ' +
      'janela cresce quando precisa, sem inflar buffers a ponto de causar bufferbloat.',
    stateKey: 'autoTuningLevel',
    setting: 'autotuninglevel',
    target: 'normal',
    risk: 'low',
    options: [
      { value: 'normal', label: 'normal (recomendado)' },
      { value: 'disabled', label: 'disabled (janela fixa 64KB — legacy)' },
      { value: 'restricted', label: 'restricted' },
      { value: 'highlyrestricted', label: 'highlyrestricted' },
      { value: 'experimental', label: 'experimental' },
    ],
    resolveTarget: (state, feats, ctx) => ctx.params?.autoTuning || 'normal',
  }),

  netshGlobalTweak({
    id: 'ecn',
    label: 'Desativar ECN Capability',
    description: 'Evita negociação explícita de congestionamento com roteadores problemáticos.',
    why:
      'ECN marca pacotes em vez de descartá-los, mas muitos roteadores domésticos e pontos de ' +
      'Wi-Fi implementam mal o RFC 3168 e acabam descartando pacotes com bits ECN setados — ' +
      'o que aparece como perda aleatória e spike de ping. Desativar elimina essa classe de falha. ' +
      'Se sua rede é moderna (roteador recente + cabo), manter habilitado também é válido.',
    stateKey: 'ecnCapability',
    setting: 'ecncapability',
    target: 'disabled',
    risk: 'low',
    options: [
      { value: 'disabled', label: 'disabled (recomendado p/ Wi-Fi e roteadores antigos)' },
      { value: 'enabled', label: 'enabled' },
      { value: 'default', label: 'default' },
    ],
    resolveTarget: (state, feats, ctx) => ctx.params?.ecn || 'disabled',
  }),

  netshGlobalTweak({
    id: 'tcpFastOpen',
    label: 'TCP Fast Open (TFO)',
    description: 'Permite enviar dados já no SYN, cortando 1 RTT na abertura de conexão.',
    why:
      'Em handshakes de lobby/autenticação (login do jogo, matchmaking, HTTP do launcher) cada RTT ' +
      'economizado é latência a menos. TFO não afeta o tráfego UDP do jogo em si, mas acelera ' +
      'toda a negociação inicial.',
    stateKey: 'fastOpen',
    setting: 'fastopen',
    target: 'enabled',
    risk: 'low',
  }),

  netshGlobalTweak({
    id: 'rss',
    label: 'Receive Side Scaling (RSS)',
    description: 'Distribui o processamento de pacotes entre vários núcleos de CPU.',
    why:
      'Sem RSS, toda a interrupção de rede cai em um único núcleo — que pode estar ocupado com o jogo. ' +
      'Com RSS o trabalho é paralelo, reduzindo o tempo entre a chegada do pacote e a entrega ao socket ' +
      '(menos jitter de processamento). Essencial em adaptadores USB, que já consomem CPU extra.',
    stateKey: 'rss',
    setting: 'rss',
    target: 'enabled',
    risk: 'low',
  }),

  {
    id: 'congestionProvider',
    group: 'tcpip',
    label: 'Provedor de congestionamento (CTCP / CUBIC)',
    description: 'Define o algoritmo de controle de congestionamento do template Internet.',
    why:
      'CTCP (Compound TCP) é mais agressivo em enlaces com banda×atraso alta e sobe a janela mais ' +
      'rápido — bom para downloads de patch, mas pode gerar bufferbloat (jitter) se o enlace saturar. ' +
      'CUBIC é o padrão do Windows 10/11 e é mais estável. BBR NÃO existe na pilha nativa do Windows: ' +
      'o willLag nunca promete ativá-lo, apenas detecta se o sistema oferece a opção.',
    risk: 'medium',
    requiresAdmin: true,
    scope: 'persistent',
    rebootRecommended: false,
    defaultInPreset: true,
    options: [
      { value: 'auto', label: 'auto — usa o melhor disponível no sistema' },
      { value: 'ctcp', label: 'ctcp (Compound TCP — mais agressivo)' },
      { value: 'cubic', label: 'cubic (padrão Win10/11 — mais estável)' },
    ],

    async detect(ctx) {
      if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };
      const feats = ctx.features ? await ctx.features() : await platform.features();
      const state = await getTcpGlobal();
      const providers = (state.ok && state.congestionProviders) || {};
      const available = feats.congestionProviders || [];
      const current = providers.Internet || providers.internet || null;
      const wanted = platform.pickCongestionProvider(available, ctx.params?.congestionProvider || 'auto');

      return {
        ok: true,
        supported: available.length > 0,
        applied: Boolean(current && wanted && current.toLowerCase() === wanted.toLowerCase()),
        current: current || 'desconhecido',
        target: wanted || 'n/a',
        available,
        bbrAvailable: Boolean(feats.bbr),
        note: feats.bbr
          ? 'BBR detectado como opção neste sistema.'
          : 'BBR não é suportado pela pilha TCP/IP nativa do Windows.',
        reason: available.length === 0 ? 'Não foi possível enumerar provedores suportados.' : undefined,
      };
    },

    async apply(ctx) {
      const feats = ctx.features ? await ctx.features() : await platform.features();
      const available = feats.congestionProviders || [];
      const wanted = platform.pickCongestionProvider(available, ctx.params?.congestionProvider || 'auto');

      if (!wanted) {
        return {
          success: false,
          code: 'UNSUPPORTED',
          applied: false,
          message: 'Nenhum provedor de congestionamento compatível foi detectado neste sistema.',
        };
      }

      const results = [];
      let anyOk = false;
      let firstError = null;

      for (const template of SUPPLEMENTAL_TEMPLATES) {
        const res = await setNetshSupplemental(template, 'congestionprovider', wanted, ctx, { note: 'congestionProvider' });
        if (res.success) {
          anyOk = true;
          if (res.entry) stateStore.pushBackup('congestionProvider', [res.entry], { template, wanted });
        } else {
          firstError = firstError || res.error;
        }
        results.push({ template, success: res.success, previous: res.previous, error: res.error });
      }

      if (!anyOk) {
        return {
          success: false,
          code: results[0]?.code || 'EXEC_FAILED',
          applied: false,
          error: firstError,
          message: firstError || 'Falha ao definir o provedor de congestionamento.',
        };
      }

      stateStore.markApplied('congestionProvider', { scope: 'persistent', params: { wanted } });
      return {
        success: true,
        code: 'OK',
        applied: true,
        message: `Provedor de congestionamento definido como "${wanted}" (template Internet).`,
        current: wanted,
        target: wanted,
        details: results.map((r) => `${r.template}: ${r.success ? 'ok' : 'falha'}${r.previous ? ` (antes: ${r.previous})` : ''}`),
      };
    },

    async revert(ctx) {
      const layer = stateStore.peekBackup('congestionProvider');
      const entries = layer && layer.entries ? layer.entries : [
        { kind: 'netshSupplemental', template: 'Internet', setting: 'congestionprovider', value: 'cubic' },
      ];
      const res = await require('./restoreEngine').restoreEntries(entries, {
        isAdmin: ctx.isAdmin,
        allowPrompt: ctx.allowPrompt,
      });
      if (res.success || res.code === 'PARTIAL') stateStore.consumeBackup('congestionProvider');
      stateStore.markReverted('congestionProvider');
      invalidateTcpCache();
      return { ...res, applied: false };
    },
  },

  // ---- Opcionais (fora do preset padrão) ----

  netshGlobalTweak({
    id: 'rsc',
    label: 'Desativar Receive Segment Coalescing (RSC)',
    description: 'Entrega os pacotes ao socket sem agregá-los antes.',
    why:
      'RSC junta vários segmentos TCP em um único antes de subir para a pilha, economizando CPU mas ' +
      'adicionando alguns milissegundos de espera. Desativar reduz a latência de entrega; o custo é ' +
      'mais CPU em conexões de alto throughput. Recomendado apenas se você tem CPU sobrando.',
    stateKey: 'rsc',
    setting: 'rsc',
    target: 'disabled',
    risk: 'medium',
    defaultInPreset: false,
    options: [
      { value: 'disabled', label: 'disabled (menor latência)' },
      { value: 'enabled', label: 'enabled (menor CPU — padrão)' },
    ],
    resolveTarget: (state, feats, ctx) => ctx.params?.rsc || 'disabled',
  }),

  netshGlobalTweak({
    id: 'timestamps',
    label: 'Desativar RFC 1323 Timestamps',
    description: 'Remove 12 bytes de overhead do cabeçalho TCP.',
    why:
      'Timestamps habilita PAWS e melhora a estimativa de RTT, mas adiciona 12 bytes por segmento. ' +
      'Em Wi-Fi, onde cada byte aéreo custa tempo, desativar pode reduzir marginalmente o tempo de ' +
      'transmissão. Trade-off real: pior estimativa de RTT em redes com reordenação. Teste com o ' +
      'Monitor de Rede antes de manter.',
    stateKey: 'timestamps',
    setting: 'timestamps',
    target: 'disabled',
    risk: 'medium',
    defaultInPreset: false,
    legacy: true,
    options: [
      { value: 'disabled', label: 'disabled' },
      { value: 'enabled', label: 'enabled' },
    ],
    resolveTarget: (state, feats, ctx) => ctx.params?.timestamps || 'disabled',
  }),

  netshGlobalTweak({
    id: 'initialRto',
    label: 'Initial RTO = 1000ms',
    description: 'Reduz o timeout inicial de retransmissão de 3s para 1s.',
    why:
      'Quando o SYN de conexão (login, matchmaking, handshake TLS do launcher) se perde, o Windows ' +
      'espera 3 segundos antes de retransmitir. Com 1s a recuperação é 3x mais rápida. Não afeta a ' +
      'latência em regime permanente, apenas o tempo de estabelecimento após perda.',
    stateKey: 'initialRto',
    setting: 'initialrto',
    target: '1000',
    risk: 'low',
    defaultInPreset: false,
    options: [
      { value: '1000', label: '1000 ms (recomendado)' },
      { value: '2000', label: '2000 ms' },
      { value: '3000', label: '3000 ms (padrão)' },
    ],
    resolveTarget: (state, feats, ctx) => String(ctx.params?.initialRto || '1000'),
  }),

  netshGlobalTweak({
    id: 'chimneyOffload',
    label: 'Chimney Offload = disabled (legado)',
    description: 'Mantido apenas para compatibilidade com versões antigas do Windows.',
    why:
      'TCP Chimney foi descontinuado no Windows 8/Server 2012 e removido nas versões modernas. ' +
      'O comando costuma retornar "parâmetro incorreto". Incluímos como legado e fora do preset.',
    stateKey: 'chimney',
    setting: 'chimney',
    target: 'disabled',
    risk: 'low',
    defaultInPreset: false,
    legacy: true,
    unsupportedOn: (feats) => Boolean(feats.detected) && platform.windowsBuild() >= 9200,
    unsupportedReason: 'TCP Chimney Offload foi removido a partir do Windows 8.',
  }),

  {
    id: 'qosReservedBandwidth',
    group: 'tcpip',
    label: 'Liberar banda reservada por QoS (Psched)',
    description: 'NonBestEffortLimit = 0 na política de agendador de pacotes.',
    why:
      'O agendador de pacotes do Windows pode reservar até 20% do enlace para tráfego com QoS. ' +
      'Zerar o limite devolve essa banda ao tráfego comum. Em enlaces saturados (download + jogo) ' +
      'isso reduz a fila e, portanto, o jitter.',
    risk: 'low',
    requiresAdmin: true,
    scope: 'persistent',
    defaultInPreset: false,

    async detect(ctx) {
      if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };
      const p = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched';
      const data = await reg.readValuesBatch([{ path: p, names: ['NonBestEffortLimit'] }]);
      const bucket = data[p] || {};
      const values = bucket.values || {};
      const found = Object.keys(values).find((k) => k.toLowerCase() === 'nonbesteffortlimit');
      const cur = found && values[found].exists ? Number(values[found].value) : null;
      return {
        ok: true,
        supported: true,
        applied: cur === 0,
        current: cur === null ? 'não definido (padrão 20%)' : `${cur}%`,
        target: '0%',
      };
    },

    async apply(ctx) {
      const p = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched';
      const requests = [{ path: p, names: ['NonBestEffortLimit'] }];
      const before = await reg.readValuesBatch(requests);
      if (before.__error) return { success: false, code: 'READ_FAILED', error: before.__error };

      stateStore.pushBackup('qosReservedBandwidth', reg.toBackupEntries(before, requests));

      const res = await reg.writeValuesBatch(
        [{ path: p, name: 'NonBestEffortLimit', value: 0, kind: 'DWord', createKey: true }],
        { elevated: true, isAdmin: ctx.isAdmin, allowPrompt: ctx.allowPrompt }
      );
      if (!res.success && res.code === 'UAC_DENIED') stateStore.consumeBackup('qosReservedBandwidth');

      return {
        success: res.success,
        code: res.code,
        applied: res.success,
        error: res.success ? null : res.error,
        message: res.success ? 'Banda reservada por QoS zerada (NonBestEffortLimit=0).' : res.error,
        current: '0%',
        target: '0%',
      };
    },

    async revert(ctx) {
      const layer = stateStore.peekBackup('qosReservedBandwidth');
      const entries = layer && layer.entries ? layer.entries : [
        { kind: 'registry', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Psched', name: 'NonBestEffortLimit', existed: false },
      ];
      const res = await require('./restoreEngine').restoreEntries(entries, {
        isAdmin: ctx.isAdmin,
        allowPrompt: ctx.allowPrompt,
      });
      if (res.success || res.code === 'PARTIAL') stateStore.consumeBackup('qosReservedBandwidth');
      return { ...res, applied: false };
    },
  },
];

// O tweak autoTuning precisa de detect() próprio para expor o nível efetivo.
const autoTuningIdx = tweaks.findIndex((t) => t.id === 'autoTuning');
if (autoTuningIdx >= 0) {
  const base = tweaks[autoTuningIdx];
  base.detect = async (ctx) => {
    if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };
    const state = await getTcpGlobal();
    const current = state.ok ? normalizeEnumValue(state.autoTuningLevel) : null;
    const target = ctx.params?.autoTuning || 'normal';
    return {
      ok: state.ok,
      supported: true,
      applied: current === String(target).toLowerCase(),
      current: current || 'desconhecido',
      effective: state.ok ? state.autoTuningLevelEffective || current : null,
      reason: state.ok ? state.autoTuningReason || null : null,
      target,
      error: state.ok ? null : state.error,
    };
  };
  tweaks[autoTuningIdx] = base;
}

module.exports = {
  tweaks,
  getTcpGlobal,
  invalidateTcpCache,
  parseNetshTcpGlobal,
  parseSupplementalProviders,
  setNetshGlobal,
  setNetshSupplemental,
  detectNagle,
  applyNagle,
  revertNagle,
  NAGLE_VALUES,
  GAMES_TASK_VALUES,
  NETSH_GLOBAL_DEFAULTS,
  NETWORK_THROTTLING_INDEX_DISABLED,
  normalizeEnumValue,
};
