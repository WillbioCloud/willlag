'use strict';

/**
 * Motor de reversão.
 *
 * Recebe uma lista de "entradas de backup" (gravadas antes de qualquer
 * alteração) e restaura o estado anterior em UM único script PowerShell.
 *
 * Por que um script único?
 *  - Cada powershell.exe elevado custa um prompt UAC. Se o app não estiver
 *    elevado, restaurar 12 tweaks exigiria 12 prompts. Aqui é 1 (ou zero,
 *    se o app já for admin).
 *  - A restauração precisa ser atômica o suficiente para sobreviver a
 *    falhas parciais: cada entrada tem try/catch próprio e reporta status.
 *
 * Formatos de entrada suportados (campo `kind`):
 *   registry              -> { path, name, existed, kindType, value|list|bytes }
 *   netshGlobal           -> { setting, value }              (int tcp set global)
 *   netshIpGlobal         -> { setting, value }              (int ip set global)
 *   netshSupplemental     -> { template, setting, value }    (int tcp set supplemental)
 *   wlanAutoconfig        -> { interfaceName, enabled }
 *   powercfgAcDc          -> { subgroup, setting, acValue, dcValue, scheme }
 *   adapterPowerManagement-> { name, property, value }
 *   adapterAdvanced       -> { name, keyword, value, displayName }
 *   dns                   -> { ifIndex, alias, servers, wasDhcp }
 *   mtu                   -> { ifIndex, mtu, family }
 *   qosPolicy             -> { name, existed }
 *   service               -> { name, startupType, status }
 */

const ps = require('./psRunner');
const logger = require('./logger');

const log = logger.scope('restore');

const VALID_KINDS = new Set([
  'registry',
  'netshGlobal',
  'netshIpGlobal',
  'netshSupplemental',
  'wlanAutoconfig',
  'powercfgAcDc',
  'adapterPowerManagement',
  'adapterAdvanced',
  'dns',
  'mtu',
  'qosPolicy',
  'service',
]);

const SAFE_TOKEN = /^[A-Za-z0-9_.\-]+$/;
const SAFE_GUID_TOKEN = /^[A-Za-z0-9_.\-{}]+$/;

/** Valida/saneia uma entrada antes de virar script. Entradas inválidas são ignoradas. */
function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== 'object') return null;
  if (!VALID_KINDS.has(entry.kind)) {
    log.warn('Entrada de backup com kind desconhecido — ignorada', { kind: entry.kind });
    return null;
  }

  const e = { id: index, kind: entry.kind, note: entry.note || null };

  switch (entry.kind) {
    case 'registry': {
      if (typeof entry.path !== 'string' || entry.path.length > 512) return null;
      if (!/^HKLM\\|^HKCU\\|^HKEY_/i.test(entry.path)) return null;
      if (typeof entry.name !== 'string' || entry.name.length > 200) return null;
      e.path = entry.path;
      e.name = entry.name;
      e.existed = Boolean(entry.existed);
      e.kindType = ['DWord', 'QWord', 'String', 'ExpandString', 'MultiString', 'Binary'].includes(entry.kindType)
        ? entry.kindType
        : 'DWord';
      if (e.kindType === 'MultiString') e.list = Array.isArray(entry.list) ? entry.list.map(String) : [];
      else if (e.kindType === 'Binary') e.bytes = Array.isArray(entry.bytes) ? entry.bytes.map((b) => Number(b) & 0xff) : [];
      else e.value = entry.value === undefined || entry.value === null ? '' : String(entry.value);
      return e;
    }

    case 'netshGlobal':
    case 'netshIpGlobal': {
      if (!SAFE_TOKEN.test(String(entry.setting || ''))) return null;
      if (!SAFE_TOKEN.test(String(entry.value || ''))) return null;
      e.setting = String(entry.setting);
      e.value = String(entry.value);
      return e;
    }

    case 'netshSupplemental': {
      if (!SAFE_TOKEN.test(String(entry.template || ''))) return null;
      if (!SAFE_TOKEN.test(String(entry.setting || ''))) return null;
      if (!SAFE_TOKEN.test(String(entry.value || ''))) return null;
      e.template = String(entry.template);
      e.setting = String(entry.setting);
      e.value = String(entry.value);
      return e;
    }

    case 'wlanAutoconfig': {
      if (!ps.isSafeName(entry.interfaceName)) return null;
      e.interfaceName = ps.sanitizeName(entry.interfaceName);
      e.enabled = entry.enabled === undefined ? true : Boolean(entry.enabled);
      return e;
    }

    case 'powercfgAcDc': {
      if (!SAFE_GUID_TOKEN.test(String(entry.subgroup || ''))) return null;
      if (!SAFE_GUID_TOKEN.test(String(entry.setting || ''))) return null;
      e.scheme = SAFE_TOKEN.test(String(entry.scheme || '')) ? String(entry.scheme) : 'SCHEME_CURRENT';
      e.subgroup = String(entry.subgroup);
      e.setting = String(entry.setting);
      e.acValue = Number.isFinite(Number(entry.acValue)) ? Math.trunc(Number(entry.acValue)) : null;
      e.dcValue = Number.isFinite(Number(entry.dcValue)) ? Math.trunc(Number(entry.dcValue)) : null;
      return e;
    }

    case 'adapterPowerManagement': {
      if (!ps.isSafeName(entry.name)) return null;
      if (!/^[A-Za-z]+$/.test(String(entry.property || ''))) return null;
      if (!['Enabled', 'Disabled'].includes(String(entry.value))) return null;
      e.name = ps.sanitizeName(entry.name);
      e.property = String(entry.property);
      e.value = String(entry.value);
      return e;
    }

    case 'adapterAdvanced': {
      if (!ps.isSafeName(entry.name)) return null;
      if (!SAFE_TOKEN.test(String(entry.keyword || ''))) return null;
      e.name = ps.sanitizeName(entry.name);
      e.keyword = String(entry.keyword);
      e.value = entry.value === undefined || entry.value === null ? '' : String(entry.value).slice(0, 200);
      e.displayName = String(entry.displayName || '');
      return e;
    }

    case 'dns': {
      const ifIndex = Number(entry.ifIndex);
      if (!Number.isFinite(ifIndex) || ifIndex <= 0 || ifIndex > 4294967295) return null;
      e.ifIndex = Math.trunc(ifIndex);
      e.alias = ps.isSafeName(entry.alias) ? ps.sanitizeName(entry.alias) : '';
      e.wasDhcp = Boolean(entry.wasDhcp);
      e.servers = (Array.isArray(entry.servers) ? entry.servers : [])
        .map((s) => String(s).trim())
        .filter((s) => /^[0-9a-fA-F.:]{3,45}$/.test(s))
        .slice(0, 8);
      return e;
    }

    case 'mtu': {
      const ifIndex = Number(entry.ifIndex);
      const mtu = Number(entry.mtu);
      if (!Number.isFinite(ifIndex) || ifIndex <= 0) return null;
      if (!Number.isFinite(mtu) || mtu < 576 || mtu > 9000) return null;
      e.ifIndex = Math.trunc(ifIndex);
      e.mtu = Math.trunc(mtu);
      e.family = ['IPv4', 'IPv6'].includes(entry.family) ? entry.family : 'IPv4';
      return e;
    }

    case 'qosPolicy': {
      if (typeof entry.name !== 'string' || entry.name.length > 100) return null;
      e.name = entry.name.replace(/["'`$;]/g, '');
      e.existed = Boolean(entry.existed);
      return e;
    }

    case 'service': {
      if (!SAFE_TOKEN.test(String(entry.name || ''))) return null;
      e.name = String(entry.name);
      e.startupType = ['Automatic', 'Manual', 'Disabled'].includes(entry.startupType) ? entry.startupType : null;
      e.status = ['Running', 'Stopped'].includes(entry.status) ? entry.status : null;
      return e;
    }

    default:
      return null;
  }
}

/** Gera o corpo PowerShell que restaura uma lista de entradas. */
function buildRestoreScript(entries) {
  const json = JSON.stringify(entries).replace(/'/g, "''");

  return `
$entries = ConvertFrom-Json -InputObject '${json}'
$results = New-Object System.Collections.ArrayList

function Add-Result($id, $ok, $msg, $action) {
  $null = $results.Add(@{ id = $id; ok = [bool]$ok; message = "$msg"; action = "$action" })
}

foreach ($e in $entries) {
  $id = $e.id
  try {
    switch ($e.kind) {

      'registry' {
        $p = 'Registry::' + $e.path
        if (-not $e.existed) {
          if (Test-Path -LiteralPath $p) {
            $prop = Get-ItemProperty -LiteralPath $p -Name $e.name -ErrorAction SilentlyContinue
            if ($null -ne $prop) {
              Remove-ItemProperty -LiteralPath $p -Name $e.name -Force -ErrorAction Stop
              Add-Result $id $true 'valor removido (não existia antes)' 'removed'
            } else { Add-Result $id $true 'já estava ausente' 'noop' }
          } else { Add-Result $id $true 'chave não existe' 'noop' }
          continue
        }
        if (-not (Test-Path -LiteralPath $p)) { $null = New-Item -LiteralPath $p -Force }
        $vk = [Microsoft.Win32.RegistryValueKind]$e.kindType
        switch ($e.kindType) {
          'DWord'        { $val = [uint32]([convert]::ToUInt64($e.value) -band 0xFFFFFFFF) }
          'QWord'        { $val = [uint64]$e.value }
          'MultiString'  { $val = [string[]]@($e.list) }
          'Binary'       { $val = [byte[]]@($e.bytes) }
          default        { $val = [string]$e.value }
        }
        $null = New-ItemProperty -LiteralPath $p -Name $e.name -Value $val -PropertyType $vk -Force
        Add-Result $id $true ("restaurado " + $e.name + " = " + $val) 'restored'
      }

      'netshGlobal' {
        $out = & netsh int tcp set global "$($e.setting)=$($e.value)" 2>&1 | Out-String
        $ok = -not ($out -match 'incorreto|incorrect|denied|negado|failed|falha')
        Add-Result $id $ok $out.Trim() 'netsh-tcp-global'
      }

      'netshIpGlobal' {
        $out = & netsh int ip set global "$($e.setting)=$($e.value)" 2>&1 | Out-String
        $ok = -not ($out -match 'incorreto|incorrect|denied|negado|failed|falha')
        Add-Result $id $ok $out.Trim() 'netsh-ip-global'
      }

      'netshSupplemental' {
        $out = & netsh int tcp set supplemental $e.template "$($e.setting)=$($e.value)" 2>&1 | Out-String
        $ok = -not ($out -match 'incorreto|incorrect|denied|negado|failed|falha')
        Add-Result $id $ok $out.Trim() 'netsh-supplemental'
      }

      'wlanAutoconfig' {
        $state = if ($e.enabled) { 'yes' } else { 'no' }
        $out = & netsh wlan set autoconfig enabled=$state interface=$e.interfaceName 2>&1 | Out-String
        $ok = -not ($out -match 'incorreto|incorrect|denied|negado|failed|falha|not found|não foi')
        Add-Result $id $ok $out.Trim() "autoconfig=$state"
      }

      'powercfgAcDc' {
        $scheme = $e.scheme
        $out = ''
        if ($null -ne $e.acValue) {
          $out += (& powercfg /setacvalueindex $scheme $e.subgroup $e.setting $e.acValue 2>&1 | Out-String)
        }
        if ($null -ne $e.dcValue) {
          $out += (& powercfg /setdcvalueindex $scheme $e.subgroup $e.setting $e.dcValue 2>&1 | Out-String)
        }
        $out += (& powercfg /setactive $scheme 2>&1 | Out-String)
        Add-Result $id $true $out.Trim() 'powercfg'
      }

      'adapterPowerManagement' {
        $params = @{ Name = $e.name; $e.property = $e.value }
        Set-NetAdapterPowerManagement @params -NoRestart -ErrorAction Stop
        Add-Result $id $true ("$($e.property) = $($e.value)") 'adapter-power'
      }

      'adapterAdvanced' {
        Set-NetAdapterAdvancedProperty -Name $e.name -RegistryKeyword $e.keyword -RegistryValue $e.value -NoRestart -ErrorAction Stop
        Add-Result $id $true ("$($e.keyword) = $($e.value)") 'adapter-advanced'
      }

      'dns' {
        if ($e.wasDhcp -or (@($e.servers).Count -eq 0)) {
          Set-DnsClientServerAddress -InterfaceIndex $e.ifIndex -ResetServerAddresses -ErrorAction Stop
          Add-Result $id $true 'DNS devolvido para automático (DHCP)' 'dns-reset'
        } else {
          Set-DnsClientServerAddress -InterfaceIndex $e.ifIndex -ServerAddresses @($e.servers) -ErrorAction Stop
          Add-Result $id $true ("DNS restaurado: " + ($e.servers -join ', ')) 'dns-set'
        }
      }

      'mtu' {
        $fam = if ($e.family -eq 'IPv6') { 'ipv6' } else { 'ipv4' }
        $out = & netsh interface $fam set subinterface $e.ifIndex mtu=$e.mtu store=persistent 2>&1 | Out-String
        $ok = -not ($out -match 'incorreto|incorrect|denied|negado|failed|falha')
        Add-Result $id $ok ("MTU=$($e.mtu) " + $out.Trim()) 'mtu'
      }

      'qosPolicy' {
        if (-not $e.existed) {
          Remove-NetQosPolicy -Name $e.name -Confirm:$false -ErrorAction SilentlyContinue
          Add-Result $id $true 'política QoS removida' 'qos-removed'
        } else {
          Add-Result $id $true 'política QoS pré-existente mantida' 'qos-kept'
        }
      }

      'service' {
        if ($e.startupType) { Set-Service -Name $e.name -StartupType $e.startupType -ErrorAction SilentlyContinue }
        if ($e.status -eq 'Running') { Start-Service -Name $e.name -ErrorAction SilentlyContinue }
        elseif ($e.status -eq 'Stopped') { Stop-Service -Name $e.name -Force -ErrorAction SilentlyContinue }
        Add-Result $id $true ("serviço $($e.name) -> $($e.startupType)/$($e.status)") 'service'
      }

      default {
        Add-Result $id $false "tipo não suportado: $($e.kind)" 'unsupported'
      }
    }
  } catch {
    Add-Result $id $false $_.Exception.Message 'error'
  }
}

Write-WillLagJson @{ ok = $true; results = @($results) }
`;
}

/**
 * Restaura um conjunto de entradas de backup.
 * `options.isAdmin` — função que informa se o processo já é admin.
 * `options.allowPrompt` — se false, não abre UAC (retorna ELEVATION_REQUIRED).
 */
async function restoreEntries(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [entries];
  const normalized = [];
  list.forEach((raw, i) => {
    const e = normalizeEntry(raw, i);
    if (e) normalized.push(e);
  });

  if (normalized.length === 0) {
    return {
      success: true,
      code: 'NOTHING_TO_RESTORE',
      message: 'Nada a restaurar (nenhuma alteração registrada).',
      results: [],
      skipped: list.length,
    };
  }

  const body = buildRestoreScript(normalized);

  const res = await ps.ensureElevated(body, {
    label: 'restore',
    isAdmin: options.isAdmin,
    allowPrompt: options.allowPrompt !== false,
    timeout: options.timeout || 90000,
    uacTimeout: options.uacTimeout || 180000,
  });

  if (!res.success) {
    log.error('Falha ao executar restauração', { code: res.code, error: res.error });
    return {
      success: false,
      code: res.code,
      error: res.error,
      message: res.error || 'Falha ao restaurar configurações.',
      results: [],
    };
  }

  const results = ps.asArray(res.data && res.data.results).map((r) => ({
    id: Number(r.id),
    ok: Boolean(r.ok),
    message: String(r.message || ''),
    action: String(r.action || ''),
  }));

  const byId = new Map(results.map((r) => [r.id, r]));
  const detailed = normalized.map((e) => {
    const r = byId.get(e.id) || { ok: false, message: 'sem resultado', action: 'unknown' };
    return { ...e, ok: r.ok, message: r.message, action: r.action };
  });

  const failed = detailed.filter((d) => !d.ok);

  return {
    success: failed.length === 0,
    code: failed.length === 0 ? 'OK' : 'PARTIAL',
    restored: detailed.length - failed.length,
    failed: failed.length,
    message:
      failed.length === 0
        ? `${detailed.length} configuração(ões) restaurada(s) com sucesso.`
        : `${detailed.length - failed.length} restaurada(s), ${failed.length} com falha.`,
    results: detailed,
    failures: failed.map((f) => ({ kind: f.kind, message: f.message })),
  };
}

module.exports = {
  VALID_KINDS,
  normalizeEntry,
  buildRestoreScript,
  restoreEntries,
};
