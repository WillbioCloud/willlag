'use strict';

/**
 * Operações de Registro do Windows com captura de tipo e valor.
 *
 * Por que não usar `reg add` direto?
 *  - Precisamos saber o *tipo* (DWORD/String/Binary) e se o valor *existia*,
 *    para reverter com fidelidade total.
 *  - Precisamos ler o estado atual para mostrar na UI ("antes: 10 / depois: 0xffffffff").
 *
 * Toda leitura/escrita usa `-LiteralPath` (nunca -Path) para que chaves com
 * caracteres especiais não sejam interpretadas como wildcard.
 */

const ps = require('./psRunner');
const logger = require('./logger');

const log = logger.scope('registry');

const HKLM_TCPIP_INTERFACES = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces';
const HKLM_TCPIP_PARAMS = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters';
const HKLM_MM_SYSTEMPROFILE = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile';
const HKLM_MM_TASKS_GAMES = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games';
const HKLM_SERVICES_WLAN = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\WlanSvc';

/** Converte "HKLM\..." para o formato do provider Registry:: do PowerShell. */
function toProviderPath(regPath) {
  const p = String(regPath || '').trim();
  if (/^Registry::/i.test(p)) return p;
  return `Registry::${p}`;
}

/** Converte para o formato aceito por reg.exe (HKLM\SOFTWARE\...). */
function toNativePath(regPath) {
  return String(regPath || '').replace(/^Registry::/i, '');
}

/**
 * Lê todos os valores de uma chave.
 * Retorna { exists, values: { NOME: { value, kind } }, error }
 */
async function readKeyValues(regPath) {
  const providerPath = toProviderPath(regPath);

  const body = `
$path = ${ps.psString(providerPath)}
if (-not (Test-Path -LiteralPath $path)) {
  Write-WillLagJson @{ ok = $true; exists = $false; values = @{} }
  return
}
$key = Get-Item -LiteralPath $path
$values = @{}
foreach ($name in $key.GetValueNames()) {
  $kind = 'Unknown'
  try { $kind = $key.GetValueKind($name).ToString() } catch {}
  $raw = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($raw -is [byte[]]) {
    $values[$name] = @{ kind = $kind; bytes = @($raw) }
  } elseif ($raw -is [array]) {
    $values[$name] = @{ kind = $kind; list = @($raw | ForEach-Object { "$_" }) }
  } else {
    $values[$name] = @{ kind = $kind; value = "$raw" }
  }
}
Write-WillLagJson @{ ok = $true; exists = $true; path = $path; values = $values }
`;

  const res = await ps.runPowerShell(body, { label: 'reg:read', timeout: 25000 });
  if (!res.success) {
    log.warn('readKeyValues falhou', { regPath, code: res.code, error: res.error });
    return { exists: false, values: {}, error: res.error, code: res.code };
  }

  const data = res.data || {};
  return {
    exists: Boolean(data.exists),
    path: regPath,
    values: data.values || {},
    error: null,
  };
}

/** Lê um único valor. */
async function readValue(regPath, name) {
  const all = await readKeyValues(regPath);
  const key = Object.keys(all.values || {}).find(
    (k) => k.toLowerCase() === String(name).toLowerCase()
  );
  if (!key) {
    return { exists: false, keyExists: all.exists, value: null, kind: null, error: all.error };
  }
  const entry = all.values[key];
  return {
    exists: true,
    keyExists: all.exists,
    name: key,
    value: entry.value !== undefined ? entry.value : entry.list !== undefined ? entry.list : entry.bytes,
    kind: entry.kind,
    error: null,
  };
}

/**
 * Escreve um valor, retornando o ANTERIOR para backup.
 * kind: DWord | QWord | String | ExpandString | MultiString | Binary
 */
async function writeValue(regPath, name, value, kind = 'DWord', options = {}) {
  const providerPath = toProviderPath(regPath);
  const previous = await readValue(regPath, name);

  const psKind = normalizeKind(kind);
  const literal = toPsValueLiteral(value, psKind);

  const body = `
$path = ${ps.psString(providerPath)}
if (-not (Test-Path -LiteralPath $path)) {
  ${options.createKey === false ? `
  Write-WillLagJson @{ ok = $false; error = ('Chave não existe: ' + $path) }
  return` : `
  $null = New-Item -LiteralPath $path -Force`}
}
$kind = [Microsoft.Win32.RegistryValueKind]::${psKind}
$value = ${literal}
$null = New-ItemProperty -LiteralPath $path -Name ${ps.psString(name)} -Value $value -PropertyType $kind -Force
$check = (Get-Item -LiteralPath $path).GetValue(${ps.psString(name)}, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
Write-WillLagJson @{ ok = $true; written = "$check"; kind = $kind.ToString() }
`;

  const res = options.elevated
    ? await ps.ensureElevated(body, { label: `reg:write:${name}`, isAdmin: options.isAdmin, timeout: 40000 })
    : await ps.runPowerShell(body, { label: `reg:write:${name}`, timeout: 30000 });

  if (!res.success) {
    log.warn('writeValue falhou', { regPath, name, code: res.code, error: res.error });
    return { success: false, code: res.code, error: res.error, previous };
  }

  return {
    success: true,
    code: 'OK',
    previous,
    written: res.data ? res.data.written : String(value),
    kind: psKind,
  };
}

function normalizeKind(kind) {
  const k = String(kind || 'DWord');
  const map = {
    dword: 'DWord',
    reg_dword: 'DWord',
    qword: 'QWord',
    reg_qword: 'QWord',
    string: 'String',
    reg_sz: 'String',
    expandstring: 'ExpandString',
    reg_expand_sz: 'ExpandString',
    multistring: 'MultiString',
    reg_multi_sz: 'MultiString',
    binary: 'Binary',
    reg_binary: 'Binary',
  };
  return map[k.toLowerCase()] || 'DWord';
}

function toPsValueLiteral(value, kind) {
  switch (kind) {
    case 'DWord': {
      // Suporta 0xffffffff (que estoura Int32 se tratado com sinal).
      const n = typeof value === 'string' ? parseDwordString(value) : Number(value);
      if (!Number.isFinite(n)) return '[uint32]0';
      return `[uint32]${Math.floor(n) >>> 0}`;
    }
    case 'QWord':
      return `[uint64]${ps.psNumber(value, 0)}`;
    case 'MultiString':
      return `[string[]]${ps.psStringArray(Array.isArray(value) ? value : String(value).split('\n'))}`;
    case 'Binary': {
      const arr = Array.isArray(value)
        ? value
        : String(value).match(/.{1,2}/g)?.map((h) => parseInt(h, 16)) || [];
      return `[byte[]]@(${arr.map((b) => ps.psNumber(b, 0)).join(',')})`;
    }
    case 'String':
    case 'ExpandString':
    default:
      return ps.psString(value);
  }
}

function parseDwordString(str) {
  const s = String(str).trim().toLowerCase();
  if (s.startsWith('0x')) return parseInt(s, 16);
  return parseInt(s, 10);
}

/** Formata 0xffffffff de forma legível para DWORDs. */
function formatDword(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n > 0xffff) return `0x${(n >>> 0).toString(16)} (${n})`;
  return String(n);
}

async function deleteValue(regPath, name, options = {}) {
  const providerPath = toProviderPath(regPath);
  const previous = await readValue(regPath, name);
  if (!previous.exists) {
    return { success: true, code: 'ALREADY_ABSENT', previous };
  }

  const body = `
$path = ${ps.psString(providerPath)}
if (Test-Path -LiteralPath $path) {
  $prop = Get-ItemProperty -LiteralPath $path -Name ${ps.psString(name)} -ErrorAction SilentlyContinue
  if ($null -ne $prop) {
    Remove-ItemProperty -LiteralPath $path -Name ${ps.psString(name)} -Force
  }
}
Write-WillLagJson @{ ok = $true }
`;

  const res = options.elevated
    ? await ps.ensureElevated(body, { label: `reg:delete:${name}`, isAdmin: options.isAdmin })
    : await ps.runPowerShell(body, { label: `reg:delete:${name}` });

  return res.success
    ? { success: true, code: 'OK', previous }
    : { success: false, code: res.code, error: res.error, previous };
}

/* ------------------------------------------------------------------ */
/* Operações em lote (1 processo PowerShell para N chaves/valores)     */
/* ------------------------------------------------------------------ */

/**
 * Lê vários valores de várias chaves de uma só vez.
 * `requests`: [{ path, names: ['TcpAckFrequency', ...] }]
 * Retorna: { [path]: { exists, values: { [name]: { value, kind, exists } } } }
 */
async function readValuesBatch(requests, options = {}) {
  const list = (Array.isArray(requests) ? requests : [])
    .filter((r) => r && typeof r.path === 'string')
    .map((r) => ({
      path: toNativePath(r.path).slice(0, 512),
      names: (Array.isArray(r.names) ? r.names : []).map((n) => String(n).slice(0, 200)).slice(0, 40),
    }));

  if (list.length === 0) return {};

  const json = JSON.stringify(list).replace(/'/g, "''");

  const body = `
$requests = ConvertFrom-Json -InputObject '${json}'
$out = @{}
foreach ($req in $requests) {
  $p = 'Registry::' + $req.path
  $entry = @{ exists = $false; values = @{} }
  if (Test-Path -LiteralPath $p) {
    $entry.exists = $true
    $key = Get-Item -LiteralPath $p
    $names = @($req.names)
    if ($names.Count -eq 0) { $names = @($key.GetValueNames()) }
    foreach ($n in $names) {
      $found = $key.GetValueNames() | Where-Object { $_ -ieq $n } | Select-Object -First 1
      if ($null -eq $found) {
        $entry.values[$n] = @{ exists = $false }
        continue
      }
      $kind = 'Unknown'
      try { $kind = $key.GetValueKind($found).ToString() } catch {}
      $raw = $key.GetValue($found, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($raw -is [byte[]]) {
        $entry.values[$n] = @{ exists = $true; kind = $kind; name = $found; bytes = @($raw) }
      } elseif ($raw -is [array]) {
        $entry.values[$n] = @{ exists = $true; kind = $kind; name = $found; list = @($raw | ForEach-Object { "$_" }) }
      } else {
        $entry.values[$n] = @{ exists = $true; kind = $kind; name = $found; value = "$raw" }
      }
    }
  }
  $out[$req.path] = $entry
}
Write-WillLagJson @{ ok = $true; data = $out }
`;

  const res = await ps.runPowerShell(body, { label: 'reg:readBatch', timeout: options.timeout || 30000 });
  if (!res.success) {
    log.warn('readValuesBatch falhou', { code: res.code, error: res.error });
    return { __error: res.error, __code: res.code };
  }
  return (res.data && res.data.data) || {};
}

/**
 * Escreve vários valores em lote.
 * `requests`: [{ path, name, value, kind, createKey? }]
 * Retorna resultado por item, na mesma ordem.
 */
async function writeValuesBatch(requests, options = {}) {
  const list = (Array.isArray(requests) ? requests : [])
    .filter((r) => r && typeof r.path === 'string' && typeof r.name === 'string')
    .map((r) => ({
      path: toNativePath(r.path).slice(0, 512),
      name: r.name.slice(0, 200),
      kind: normalizeKind(r.kind || 'DWord'),
      value: r.value === undefined || r.value === null ? '' : String(r.value),
      list: Array.isArray(r.list) ? r.list.map(String) : null,
      bytes: Array.isArray(r.bytes) ? r.bytes.map((b) => Number(b) & 0xff) : null,
      createKey: r.createKey !== false,
    }));

  if (list.length === 0) return { success: true, results: [] };

  const json = JSON.stringify(list).replace(/'/g, "''");

  const body = `
$requests = ConvertFrom-Json -InputObject '${json}'
$results = New-Object System.Collections.ArrayList
foreach ($req in $requests) {
  try {
    $p = 'Registry::' + $req.path
    if (-not (Test-Path -LiteralPath $p)) {
      if ($req.createKey) { $null = New-Item -LiteralPath $p -Force }
      else {
        $null = $results.Add(@{ ok = $false; path = $req.path; name = $req.name; error = 'chave não existe' })
        continue
      }
    }
    $vk = [Microsoft.Win32.RegistryValueKind]$req.kind
    switch ($req.kind) {
      'DWord'       { $val = [uint32]([convert]::ToUInt64($req.value) -band 0xFFFFFFFF) }
      'QWord'       { $val = [uint64]$req.value }
      'MultiString' { $val = [string[]]@($req.list) }
      'Binary'      { $val = [byte[]]@($req.bytes) }
      default       { $val = [string]$req.value }
    }
    $null = New-ItemProperty -LiteralPath $p -Name $req.name -Value $val -PropertyType $vk -Force
    $null = $results.Add(@{ ok = $true; path = $req.path; name = $req.name; written = "$val"; kind = $req.kind })
  } catch {
    $null = $results.Add(@{ ok = $false; path = $req.path; name = $req.name; error = $_.Exception.Message })
  }
}
Write-WillLagJson @{ ok = $true; results = @($results) }
`;

  const res = options.elevated
    ? await ps.ensureElevated(body, {
        label: 'reg:writeBatch',
        isAdmin: options.isAdmin,
        allowPrompt: options.allowPrompt !== false,
        timeout: options.timeout || 60000,
      })
    : await ps.runPowerShell(body, { label: 'reg:writeBatch', timeout: options.timeout || 45000 });

  if (!res.success) {
    return { success: false, code: res.code, error: res.error, results: [] };
  }

  const results = ps.asArray(res.data && res.data.results).map((r) => ({
    ok: Boolean(r.ok),
    path: r.path,
    name: r.name,
    written: r.written,
    error: r.error || null,
  }));

  return {
    success: results.every((r) => r.ok),
    code: results.every((r) => r.ok) ? 'OK' : 'PARTIAL',
    results,
    error: results.find((r) => !r.ok)?.error || null,
  };
}

/** Converte o resultado de readValuesBatch em entradas de backup normalizadas. */
function toBackupEntries(batchData, requests) {
  const entries = [];
  for (const req of requests) {
    const native = toNativePath(req.path);
    const bucket = batchData[native] || batchData[req.path] || {};
    const values = bucket.values || {};
    for (const name of req.names || []) {
      const found = Object.keys(values).find((k) => k.toLowerCase() === String(name).toLowerCase());
      const v = found ? values[found] : null;
      const entry = {
        kind: 'registry',
        path: native,
        name,
        existed: Boolean(v && v.exists),
        note: req.note || null,
      };
      if (v && v.exists) {
        entry.kindType = ['DWord', 'QWord', 'String', 'ExpandString', 'MultiString', 'Binary'].includes(v.kind)
          ? v.kind
          : 'String';
        if (entry.kindType === 'MultiString') entry.list = v.list || [];
        else if (entry.kindType === 'Binary') entry.bytes = v.bytes || [];
        else entry.value = v.value !== undefined ? v.value : '';
      }
      entries.push(entry);
    }
  }
  return entries;
}

/** Lista subchaves (ex.: GUIDs de interfaces). */
async function listSubkeys(regPath) {
  const providerPath = toProviderPath(regPath);
  const body = `
$path = ${ps.psString(providerPath)}
if (-not (Test-Path -LiteralPath $path)) {
  Write-WillLagJson @{ ok = $true; exists = $false; keys = @() }
  return
}
$keys = @(Get-ChildItem -LiteralPath $path | ForEach-Object { $_.PSChildName })
Write-WillLagJson @{ ok = $true; exists = $true; keys = @($keys) }
`;
  const res = await ps.runPowerShell(body, { label: 'reg:list', timeout: 25000 });
  if (!res.success) return { exists: false, keys: [], error: res.error };
  return { exists: Boolean(res.data.exists), keys: ps.asArray(res.data.keys), error: null };
}

/**
 * Exporta uma chave para .reg (backup "de verdade", que o usuário pode
 * aplicar com dois cliques caso tudo mais falhe).
 */
async function exportKeyToFile(regPath, outFile) {
  const native = toNativePath(regPath);
  const res = await ps.runReg(['export', native, outFile, '/y']);
  return res.success
    ? { success: true, file: outFile }
    : { success: false, code: res.code, error: res.error };
}

async function importFromFile(regFile) {
  const res = await ps.runReg(['import', regFile]);
  return res.success
    ? { success: true, message: `Backup importado: ${path_basename(regFile)}` }
    : { success: false, code: res.code, error: res.error };
}

function path_basename(p) {
  try {
    return require('path').basename(String(p));
  } catch (err) {
    return String(p);
  }
}

module.exports = {
  HKLM_TCPIP_INTERFACES,
  HKLM_TCPIP_PARAMS,
  HKLM_MM_SYSTEMPROFILE,
  HKLM_MM_TASKS_GAMES,
  HKLM_SERVICES_WLAN,
  toProviderPath,
  toNativePath,
  readKeyValues,
  readValue,
  readValuesBatch,
  writeValue,
  writeValuesBatch,
  toBackupEntries,
  deleteValue,
  listSubkeys,
  exportKeyToFile,
  importFromFile,
  normalizeKind,
  formatDword,
  parseDwordString,
};
