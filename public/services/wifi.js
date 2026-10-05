'use strict';

/**
 * Mitigações específicas para adaptadores Wi-Fi (principalmente USB).
 *
 * O problema real do Wi-Fi em jogos não é a latência média — é o *spike*:
 *
 *  1. BACKGROUND SCAN: com o WLAN AutoConfig ativo, o Windows varre outros
 *     canais a cada ~30-60s para atualizar a lista de redes e decidir roaming.
 *     Durante a varredura, o rádio sai do canal ("off-channel") por dezenas de
 *     ms. Em adaptadores USB isso é pior: o driver serializa a varredura com o
 *     tráfego e ainda passa pelo barramento USB. Resultado clássico: pico de
 *     200-800ms ou burst de perda a cada minuto. Solução: `netsh wlan set
 *     autoconfig enabled=no` enquanto o jogo roda, e reativar ao sair.
 *
 *  2. POWER SAVE do adaptador (802.11 PS-Poll / U-APSD / D0 packet coalescing):
 *     o rádio dorme entre pacotes e o SO agrega entregas -> latência variável.
 *
 *  3. USB SELECTIVE SUSPEND + "O computador pode desligar este dispositivo
 *     para economizar energia": o dongle é desligado em períodos ociosos e leva
 *     centenas de ms para voltar -> primeiro pacote após idle é perdido.
 *
 *  4. Propriedades avançadas do driver (EEE / Green Ethernet / Power Saving Mode
 *     / Roaming Aggressiveness): variam por fabricante, então detectamos e
 *     fazemos backup dos valores reais em vez de chutar nomes.
 *
 * SEGURANÇA: desativar o autoconfig impede reconexão automática. Por isso esse
 * tweak é `scope: 'session'` — o gameMode restaura ao desativar/fechar o app, e
 * um watchdog reverte imediatamente se a conectividade cair.
 */

const ps = require('./psRunner');
const reg = require('./registryOps');
const netif = require('./netInterfaces');
const platform = require('./platform');
const stateStore = require('./stateStore');
const logger = require('./logger');

const log = logger.scope('wifi');

/* GUIDs oficiais de plano de energia (documentados pela Microsoft). */
const POWER_SUBGROUP_USB = '2a737441-1930-4402-8d77-b2bebba308a3';
const POWER_SETTING_USB_SELECTIVE_SUSPEND = '48e6b7a6-50f5-4782-a5d4-53bb8f07e226';

/* Propriedades de Set-NetAdapterPowerManagement que queremos desativar. */
const ADAPTER_POWER_TARGETS = [
  { property: 'AllowComputerToTurnOffDevice', value: 'Disabled' },
  { property: 'DeviceSleepOnDisconnect', value: 'Disabled' },
  { property: 'SelectiveSuspend', value: 'Disabled' },
  { property: 'D0PacketCoalescing', value: 'Disabled' },
  { property: 'PMWiFiRekeyOffload', value: 'Disabled' },
];

/* Palavras-chave (multi-idioma) para achar propriedades de economia de energia
 * do driver, cujo nome varia entre Realtek/Intel/MediaTek/TP-Link/etc. */
const POWER_SAVE_KEYWORDS = [
  /power\s*sav/i,
  /economia de energia/i,
  /u-?apsd/i,
  /device\s*sleep/i,
  /sleep\s*on\s*disconnect/i,
  /green\s*ethernet/i,
  /energy\s*efficient/i,
  /\beee\b/i,
  /power\s*down/i,
  /ps\s*mode/i,
  /idle\s*power/i,
  /advanced\s*eee/i,
];

/* ------------------------------------------------------------------ */
/* Descoberta                                                          */
/* ------------------------------------------------------------------ */

/** Retorna o adaptador Wi-Fi ativo (ou o primeiro Wi-Fi conectado). */
async function getTargetWifiAdapter(ctx) {
  const snap = await netif.getSnapshot({ force: Boolean(ctx && ctx.forceRefresh) });
  const preferredName = ctx && ctx.params && ctx.params.interfaceName;

  if (preferredName) {
    const found = snap.adapters.find((a) => netif.sameName(a.name, preferredName));
    if (found) return found;
  }

  const active = snap.activeAdapter;
  if (active && active.isWifi) return active;

  const wifiUp = snap.wifiAdapters.find((a) => a.connected);
  return wifiUp || snap.wifiAdapters[0] || null;
}

/** Diagnóstico completo do rádio (canal, sinal, taxa, tipo) + análise heurística. */
async function getWifiDiagnostics(ctx) {
  const snap = await netif.getSnapshot({ force: true });
  const adapter = await getTargetWifiAdapter(ctx);

  if (!adapter) {
    return {
      ok: false,
      hasWifi: false,
      message: 'Nenhum adaptador Wi-Fi encontrado. Se você usa cabo, as otimizações de Wi-Fi não se aplicam.',
      adapters: snap.adapters.map((a) => ({ name: a.name, description: a.description, isWifi: a.isWifi })),
    };
  }

  const wlan = adapter.wlan || snap.wlan.find((w) => netif.sameName(w.name, adapter.name)) || null;
  const findings = [];

  const signal = wlan && wlan.signalPercent ? parseInt(String(wlan.signalPercent).replace('%', ''), 10) : null;
  const channel = wlan ? parseInt(wlan.channel, 10) : null;
  const radio = wlan ? String(wlan.radioType || '') : '';
  const txRate = wlan ? parseFloat(String(wlan.transmitRateMbps || '').replace(',', '.')) : null;
  const rxRate = wlan ? parseFloat(String(wlan.receiveRateMbps || '').replace(',', '.')) : null;

  if (adapter.isUsb) {
    findings.push({
      severity: 'info',
      title: 'Adaptador Wi-Fi USB detectado',
      detail:
        'Dongles USB somam latência de barramento e dependem de CPU para o driver. ' +
        'As otimizações de energia USB e de background scan têm impacto especialmente alto aqui.',
    });
  }

  if (signal !== null && signal < 60) {
    findings.push({
      severity: 'warn',
      title: `Sinal Wi-Fi fraco (${signal}%)`,
      detail:
        'Sinal baixo força retransmissões no nível do rádio (MCS menor), o que aparece como jitter e perda. ' +
        'Aproxime o adaptador do roteador ou use uma extensão USB/cabo — nenhum tweak de software compensa RF ruim.',
    });
  }

  if (channel && channel <= 14 && /802\.?11b|802\.?11g|2\.?4/i.test(radio + ' ' + String(wlan.radioType || ''))) {
    findings.push({
      severity: 'warn',
      title: `Conectado em 2.4 GHz (canal ${channel})`,
      detail:
        '2.4 GHz tem 3 canais não sobrepostos e sofre interferência de Bluetooth, micro-ondas e vizinhos. ' +
        'Migrar para 5 GHz costuma reduzir jitter mais do que qualquer ajuste de software.',
    });
  } else if (channel && channel <= 14) {
    findings.push({
      severity: 'info',
      title: `Canal 2.4 GHz (${channel})`,
      detail: 'Considere 5 GHz se o roteador oferecer — menos interferência e mais taxa por ms de ar.',
    });
  }

  if (txRate && rxRate && Math.abs(txRate - rxRate) / Math.max(txRate, rxRate) > 0.6) {
    findings.push({
      severity: 'info',
      title: 'Taxas de TX/RX muito assimétricas',
      detail: `TX ${txRate} Mbps / RX ${rxRate} Mbps. Assimetria grande indica posição ruim de antena ou interferência.`,
    });
  }

  return {
    ok: true,
    hasWifi: true,
    adapter: {
      name: adapter.name,
      description: adapter.description,
      ifIndex: adapter.ifIndex,
      guid: adapter.guid,
      linkSpeed: adapter.linkSpeed,
      isUsb: adapter.isUsb,
      pnpDeviceId: adapter.pnpDeviceId,
      driverVersion: adapter.driverVersion,
      driverDate: adapter.driverDate,
      mtu: adapter.mtu,
      status: adapter.status,
    },
    wlan,
    metrics: { signal, channel, radioType: radio, txRateMbps: txRate, rxRateMbps: rxRate },
    autoconfig: snap.autoconfig.find((a) => netif.sameName(a.name, adapter.name)) || null,
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* TWEAK — WLAN AutoConfig (background scan)                           */
/* ------------------------------------------------------------------ */

async function setAutoconfig(interfaceName, enabled, ctx) {
  if (!ps.isSafeName(interfaceName)) {
    return { success: false, code: 'INVALID_INTERFACE', error: `Nome de interface inválido: "${interfaceName}"` };
  }

  const state = enabled ? 'yes' : 'no';
  const res = await ps.ensureElevated(
    `
$name = ${ps.psString(ps.sanitizeName(interfaceName))}
$out = & netsh wlan set autoconfig enabled=${state} interface=$name 2>&1 | Out-String
$ok = -not ($out -match 'incorreto|incorrect|denied|negado|failed|falha|not found|não foi possível')
Write-WillLagJson @{ ok = $ok; output = $out.Trim() }
`,
    { label: 'wlan:autoconfig', isAdmin: ctx.isAdmin, allowPrompt: ctx.allowPrompt, timeout: 30000 }
  );

  netif.invalidate();

  if (!res.success) {
    return { success: false, code: res.code, error: res.error, output: (res.data && res.data.output) || '' };
  }
  if (res.data && res.data.ok === false) {
    return {
      success: false,
      code: 'NETSH_FAILED',
      error: res.data.output || 'netsh recusou o comando.',
      output: res.data.output,
    };
  }

  return { success: true, code: 'OK', output: res.data ? res.data.output : '' };
}

/** Confere se a interface continua conectada após mexer no autoconfig. */
async function verifyWifiStillConnected(interfaceName) {
  const snap = await netif.getSnapshot({ force: true });
  const wlan = snap.wlan.find((w) => netif.sameName(w.name, interfaceName));
  if (!wlan) return { connected: null, state: 'unknown' };
  const connected = /conectad|connected/i.test(String(wlan.state || ''));
  return { connected: Boolean(connected), state: wlan.state, ssid: wlan.ssid };
}

const wlanAutoconfigTweak = {
  id: 'wlanAutoconfig',
  group: 'wifi',
  label: 'Pausar varredura de redes em segundo plano (WLAN AutoConfig)',
  description:
    'netsh wlan set autoconfig enabled=no — elimina os picos de ping causados pela varredura periódica de canais.',
  why:
    'Com o AutoConfig ligado, o Windows sai do canal atual a cada 30-60s para procurar redes melhores. ' +
    'Enquanto o rádio está off-channel, seus pacotes de jogo ficam na fila do driver: é o clássico ' +
    '"lag spike a cada minuto". Desligar durante a partida congela o rádio no canal atual. ' +
    'Custo: o Windows não reconecta sozinho se a conexão cair — por isso o willLag reverte ' +
    'automaticamente ao sair do Modo Jogo (e imediatamente se detectar queda de conectividade).',
  risk: 'medium',
  requiresAdmin: true,
  scope: 'session',
  defaultInPreset: true,
  sessionCritical: true,

  async detect(ctx) {
    if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };

    const feats = ctx.features ? await ctx.features() : await platform.features();
    if (!feats.wlan) {
      return {
        ok: true,
        supported: false,
        applied: false,
        reason: `Serviço WLAN AutoConfig indisponível (status: ${feats.wlanServiceStatus || 'desconhecido'}).`,
      };
    }

    const adapter = await getTargetWifiAdapter(ctx);
    if (!adapter) {
      return {
        ok: true,
        supported: false,
        applied: false,
        reason: 'Nenhum adaptador Wi-Fi ativo (você provavelmente usa cabo Ethernet).',
      };
    }

    const snap = await netif.getSnapshot();
    const ac = snap.autoconfig.find((a) => netif.sameName(a.name, adapter.name));
    const enabled = ac ? ac.enabled : adapter.autoconfigEnabled;

    return {
      ok: true,
      supported: true,
      applied: enabled === false,
      interfaceName: adapter.name,
      isUsb: adapter.isUsb,
      current: enabled === true ? 'autoconfig ativo (varredura ligada)' : enabled === false ? 'autoconfig pausado' : 'desconhecido',
      target: 'autoconfig pausado durante o jogo',
      connected: adapter.connected,
    };
  },

  async apply(ctx) {
    const detected = await wlanAutoconfigTweak.detect(ctx);
    if (!detected.supported) {
      return { success: false, code: 'UNSUPPORTED', applied: false, message: detected.reason || 'Wi-Fi indisponível.' };
    }

    const interfaceName = (ctx.params && ctx.params.interfaceName) || detected.interfaceName;
    if (!ps.isSafeName(interfaceName)) {
      return { success: false, code: 'INVALID_INTERFACE', applied: false, message: 'Nome de interface inválido.' };
    }

    // Backup: estado anterior (sempre "enabled" na prática, mas registramos o real).
    stateStore.pushBackup(
      'wlanAutoconfig',
      [{ kind: 'wlanAutoconfig', interfaceName: ps.sanitizeName(interfaceName), enabled: true }],
      { previousState: detected.current }
    );

    const res = await setAutoconfig(interfaceName, false, ctx);
    if (!res.success) {
      stateStore.consumeBackup('wlanAutoconfig');
      return {
        success: false,
        code: res.code,
        applied: false,
        error: res.error,
        message: res.error || 'Falha ao pausar o WLAN AutoConfig.',
      };
    }

    // Guarda de segurança: se a conexão caiu, reverte na hora.
    const check = await verifyWifiStillConnected(interfaceName);
    if (check.connected === false) {
      log.warn('AutoConfig desativado derrubou a conexão — revertendo', { interfaceName });
      await setAutoconfig(interfaceName, true, ctx);
      stateStore.consumeBackup('wlanAutoconfig');
      return {
        success: false,
        code: 'CONNECTIVITY_LOST',
        applied: false,
        message:
          'A conexão Wi-Fi caiu ao pausar a varredura (driver incompatível). Configuração revertida automaticamente.',
      };
    }

    stateStore.markApplied('wlanAutoconfig', {
      scope: 'session',
      params: { interfaceName },
      note: 'Revertido automaticamente ao sair do Modo Jogo.',
    });

    return {
      success: true,
      code: 'OK',
      applied: true,
      interfaceName,
      message: `Varredura de redes pausada em "${interfaceName}". Picos periódicos de ping tendem a desaparecer.`,
      current: 'autoconfig pausado',
      target: 'autoconfig pausado',
      note: 'Será reativado automaticamente ao desativar o Modo Ultra Low-Latency ou fechar o willLag.',
    };
  },

  async revert(ctx) {
    const layer = stateStore.peekBackup('wlanAutoconfig');
    let interfaceName = layer && layer.entries && layer.entries[0] ? layer.entries[0].interfaceName : null;

    if (!interfaceName) {
      const adapter = await getTargetWifiAdapter(ctx);
      interfaceName = adapter ? adapter.name : null;
    }

    if (!interfaceName) {
      stateStore.consumeBackup('wlanAutoconfig');
      return { success: true, code: 'NO_INTERFACE', applied: false, message: 'Nenhuma interface Wi-Fi para restaurar.' };
    }

    const res = await setAutoconfig(interfaceName, true, ctx);
    if (res.success) {
      stateStore.consumeBackup('wlanAutoconfig');
      stateStore.markReverted('wlanAutoconfig');
      return {
        success: true,
        code: 'OK',
        applied: false,
        message: `Varredura de redes reativada em "${interfaceName}".`,
      };
    }

    log.error('Falha ao reativar WLAN AutoConfig', { interfaceName, code: res.code, error: res.error });
    return {
      success: false,
      code: res.code,
      applied: true,
      error: res.error,
      message:
        `ATENÇÃO: não foi possível reativar a varredura em "${interfaceName}" (${res.error}). ` +
        `Execute manualmente: netsh wlan set autoconfig enabled=yes interface="${interfaceName}"`,
      manualCommand: `netsh wlan set autoconfig enabled=yes interface="${interfaceName}"`,
    };
  },
};

/* ------------------------------------------------------------------ */
/* TWEAK — USB Selective Suspend (powercfg)                            */
/* ------------------------------------------------------------------ */

function parsePowercfgQuery(output) {
  const text = String(output || '');
  const ac = text.match(/Current AC Power Setting Index\s*:\s*0x([0-9a-fA-F]+)/i) ||
    text.match(/Índice de Configuração de Energia Atual \(CA\)\s*:\s*0x([0-9a-fA-F]+)/i) ||
    text.match(/\(AC\)[^\n]*0x([0-9a-fA-F]+)/i) ||
    text.match(/\(CA\)[^\n]*0x([0-9a-fA-F]+)/i);
  const dc = text.match(/Current DC Power Setting Index\s*:\s*0x([0-9a-fA-F]+)/i) ||
    text.match(/Índice de Configuração de Energia Atual \(CC\)\s*:\s*0x([0-9a-fA-F]+)/i) ||
    text.match(/\(DC\)[^\n]*0x([0-9a-fA-F]+)/i) ||
    text.match(/\(CC\)[^\n]*0x([0-9a-fA-F]+)/i);

  return {
    ac: ac ? parseInt(ac[1], 16) : null,
    dc: dc ? parseInt(dc[1], 16) : null,
  };
}

async function readUsbSelectiveSuspend() {
  if (!ps.isWindows()) return { ok: false, error: 'Somente Windows.' };

  const res = await ps.runPowerShell(
    `
$out = & powercfg /query SCHEME_CURRENT ${ps.psString(POWER_SUBGROUP_USB)} ${ps.psString(POWER_SETTING_USB_SELECTIVE_SUSPEND)} 2>&1 | Out-String
Write-WillLagJson @{ ok = $true; output = $out }
`,
    { label: 'powercfg:query', timeout: 25000 }
  );

  if (!res.success) return { ok: false, error: res.error, code: res.code };
  const output = String((res.data && res.data.output) || '');
  const parsed = parsePowercfgQuery(output);
  return { ok: true, ...parsed, output };
}

const usbSelectiveSuspendTweak = {
  id: 'usbSelectiveSuspend',
  group: 'wifi',
  label: 'Desativar USB Selective Suspend',
  description: 'Impede que o Windows corte a energia de portas/dongles USB ociosos.',
  why:
    'O selective suspend desliga o dispositivo USB após alguns segundos sem tráfego. Ao voltar, o ' +
    'dongle Wi-Fi precisa re-enumerar/reinicializar o rádio — o primeiro pacote depois do idle é ' +
    'perdido ou atrasado em centenas de ms. Em menus de lobby (pouco tráfego) isso aparece como ' +
    'spike exatamente quando a partida começa.',
  risk: 'low',
  requiresAdmin: true,
  scope: 'persistent',
  defaultInPreset: true,

  async detect(ctx) {
    const r = await readUsbSelectiveSuspend();
    if (!r.ok) return { ok: false, supported: false, error: r.error };
    return {
      ok: true,
      supported: true,
      applied: r.ac === 0 && r.dc === 0,
      current: r.ac === null ? 'desconhecido' : `AC=${r.ac === 0 ? 'desativado' : 'ativado'} / DC=${r.dc === 0 ? 'desativado' : 'ativado'}`,
      target: 'AC=0 / DC=0 (desativado)',
    };
  },

  async apply(ctx) {
    const before = await readUsbSelectiveSuspend();
    if (before.ok && (before.ac !== null || before.dc !== null)) {
      stateStore.pushBackup('usbSelectiveSuspend', [
        {
          kind: 'powercfgAcDc',
          scheme: 'SCHEME_CURRENT',
          subgroup: POWER_SUBGROUP_USB,
          setting: POWER_SETTING_USB_SELECTIVE_SUSPEND,
          acValue: before.ac === null ? 1 : before.ac,
          dcValue: before.dc === null ? 1 : before.dc,
        },
      ]);
    } else {
      stateStore.pushBackup('usbSelectiveSuspend', [
        {
          kind: 'powercfgAcDc',
          scheme: 'SCHEME_CURRENT',
          subgroup: POWER_SUBGROUP_USB,
          setting: POWER_SETTING_USB_SELECTIVE_SUSPEND,
          acValue: 1,
          dcValue: 1,
        },
      ], { note: 'backup inferido (padrão = ativado)' });
    }

    const body = `
$lines = @()
$lines += (& powercfg /setacvalueindex SCHEME_CURRENT ${ps.psString(POWER_SUBGROUP_USB)} ${ps.psString(POWER_SETTING_USB_SELECTIVE_SUSPEND)} 0 2>&1 | Out-String)
$lines += (& powercfg /setdcvalueindex SCHEME_CURRENT ${ps.psString(POWER_SUBGROUP_USB)} ${ps.psString(POWER_SETTING_USB_SELECTIVE_SUSPEND)} 0 2>&1 | Out-String)
$lines += (& powercfg /setactive SCHEME_CURRENT 2>&1 | Out-String)
Write-WillLagJson @{ ok = $true; output = ($lines -join ' ').Trim() }
`;

    const res = await ps.ensureElevated(body, {
      label: 'powercfg:usb-suspend',
      isAdmin: ctx.isAdmin,
      allowPrompt: ctx.allowPrompt,
      timeout: 30000,
    });

    if (!res.success) {
      stateStore.consumeBackup('usbSelectiveSuspend');
      return { success: false, code: res.code, applied: false, error: res.error, message: res.error };
    }

    stateStore.markApplied('usbSelectiveSuspend', { scope: 'persistent' });
    return {
      success: true,
      code: 'OK',
      applied: true,
      message: 'USB Selective Suspend desativado no plano de energia ativo (AC e bateria).',
      current: 'AC=0 / DC=0',
      target: 'AC=0 / DC=0',
      note: 'Aplica-se ao plano de energia atual. Se você trocar de plano, reaplique.',
    };
  },

  async revert(ctx) {
    const layer = stateStore.peekBackup('usbSelectiveSuspend');
    const entries = layer && layer.entries ? layer.entries : [
      {
        kind: 'powercfgAcDc',
        scheme: 'SCHEME_CURRENT',
        subgroup: POWER_SUBGROUP_USB,
        setting: POWER_SETTING_USB_SELECTIVE_SUSPEND,
        acValue: 1,
        dcValue: 1,
      },
    ];
    const res = await require('./restoreEngine').restoreEntries(entries, {
      isAdmin: ctx.isAdmin,
      allowPrompt: ctx.allowPrompt,
    });
    if (res.success || res.code === 'PARTIAL') stateStore.consumeBackup('usbSelectiveSuspend');
    stateStore.markReverted('usbSelectiveSuspend');
    return { ...res, applied: false };
  },
};

/* ------------------------------------------------------------------ */
/* TWEAK — Energia do adaptador ("O computador pode desligar...")      */
/* ------------------------------------------------------------------ */

async function readAdapterPowerManagement(adapterName) {
  const body = `
$name = ${ps.psString(ps.sanitizeName(adapterName))}
$adapter = Get-NetAdapter -Name $name -ErrorAction SilentlyContinue
if (-not $adapter) { Write-WillLagJson @{ ok = $false; error = ('Adaptador não encontrado: ' + $name) }; return }

$out = @{ ok = $true; name = $name; properties = @{}; available = @() }

if (Get-Command -Name 'Get-NetAdapterPowerManagement' -ErrorAction SilentlyContinue) {
  $pm = Get-NetAdapterPowerManagement -Name $name -ErrorAction SilentlyContinue
  if ($pm) {
    foreach ($p in $pm.PSObject.Properties) {
      if ($p.Value -is [string] -or $p.Value -is [enum] -or $p.Value -is [bool] -or $p.Value -is [int]) {
        $out.properties[$p.Name] = "$($p.Value)"
      }
    }
    $cmd = Get-Command -Name 'Set-NetAdapterPowerManagement' -ErrorAction SilentlyContinue
    if ($cmd) { $out.available = @($cmd.Parameters.Keys | ForEach-Object { "$_" }) }
  }
}

# Estado "AllowComputerToTurnOffDevice" visto pelo Gerenciador de Dispositivos (root\\WMI)
$pnp = "$($adapter.PnpDeviceID)"
$out.pnpDeviceId = $pnp
try {
  $dev = Get-CimInstance -Namespace 'root/WMI' -ClassName 'MSPower_DeviceEnable' -ErrorAction SilentlyContinue |
         Where-Object { $_.InstanceName -and $pnp -and $_.InstanceName.ToUpper().StartsWith($pnp.ToUpper()) }
  if ($dev) { $out.msPowerEnable = [bool]$dev.Enable; $out.msPowerInstance = "$($dev.InstanceName)" }
} catch {}

Write-WillLagJson $out
`;

  const res = await ps.runPowerShell(body, { label: 'adapter:pm-read', timeout: 35000 });
  if (!res.success) return { ok: false, error: res.error, code: res.code };
  const data = res.data || {};
  if (data.ok === false) return { ok: false, error: data.error, code: 'NOT_FOUND' };
  return { ok: true, ...data };
}

const adapterPowerTweak = {
  id: 'adapterPowerManagement',
  group: 'wifi',
  label: 'Desativar economia de energia do adaptador de rede',
  description:
    'Desmarca "O computador pode desligar este dispositivo para economizar energia" e desativa sleep/coalescing do driver.',
  why:
    'Além da caixa do Gerenciador de Dispositivos, o driver expõe vários estados de economia: ' +
    'DeviceSleepOnDisconnect (dorme ao desconectar), SelectiveSuspend (USB), PMWiFiRekeyOffload e ' +
    'D0PacketCoalescing — este último agrega pacotes antes de entregá-los à pilha, adicionando ' +
    'atraso variável mesmo com o PC ligado na tomada.',
  risk: 'low',
  requiresAdmin: true,
  scope: 'persistent',
  defaultInPreset: true,

  async detect(ctx) {
    if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };

    const adapter = await getTargetWifiAdapter(ctx);
    const snap = await netif.getSnapshot();
    // Aplica-se ao adaptador ativo, seja Wi-Fi ou cabo.
    const target = adapter || snap.activeAdapter;
    if (!target) return { ok: true, supported: false, applied: false, reason: 'Nenhum adaptador de rede ativo.' };

    const pm = await readAdapterPowerManagement(target.name);
    if (!pm.ok) {
      return { ok: true, supported: false, applied: false, reason: pm.error, adapter: target.name };
    }

    const props = pm.properties || {};
    const detail = {};
    let allOff = true;
    let anyFound = false;

    for (const t of ADAPTER_POWER_TARGETS) {
      const cur = props[t.property];
      if (cur === undefined) continue;
      anyFound = true;
      detail[t.property] = cur;
      if (String(cur).toLowerCase() !== t.value.toLowerCase()) allOff = false;
    }

    if (pm.msPowerEnable === true) allOff = false;

    return {
      ok: true,
      supported: anyFound || pm.msPowerEnable !== undefined,
      applied: allOff && anyFound,
      adapter: target.name,
      isWifi: target.isWifi,
      isUsb: target.isUsb,
      current: Object.entries(detail).map(([k, v]) => `${k}=${v}`).join(', ') || 'nenhuma propriedade exposta',
      target: ADAPTER_POWER_TARGETS.map((t) => `${t.property}=${t.value}`).join(', '),
      msPowerEnable: pm.msPowerEnable,
    };
  },

  async apply(ctx) {
    const detected = await adapterPowerTweak.detect(ctx);
    const snap = await netif.getSnapshot();
    const adapter = await getTargetWifiAdapter(ctx);
    const target = adapter || snap.activeAdapter;

    if (!target) return { success: false, code: 'NO_ADAPTER', applied: false, message: 'Nenhum adaptador de rede ativo.' };

    const pm = await readAdapterPowerManagement(target.name);
    const props = (pm.ok && pm.properties) || {};
    const available = (pm.ok && pm.available) || [];
    const entries = [];

    // Backup apenas do que existe e do que o cmdlet aceita.
    for (const t of ADAPTER_POWER_TARGETS) {
      if (props[t.property] !== undefined && available.some((a) => a.toLowerCase() === t.property.toLowerCase())) {
        entries.push({
          kind: 'adapterPowerManagement',
          name: ps.sanitizeName(target.name),
          property: t.property,
          value: String(props[t.property]) === 'Disabled' || String(props[t.property]) === 'Enabled'
            ? String(props[t.property])
            : 'Enabled',
          note: detected.current,
        });
      }
    }
    if (pm.ok && pm.msPowerEnable !== undefined) {
      entries.push({
        kind: 'adapterPowerManagement',
        name: ps.sanitizeName(target.name),
        property: 'AllowComputerToTurnOffDevice',
        value: pm.msPowerEnable ? 'Enabled' : 'Disabled',
        note: 'via root\\WMI MSPower_DeviceEnable',
      });
    }

    if (entries.length > 0) stateStore.pushBackup('adapterPowerManagement', entries, { adapter: target.name });

    const targetsJson = JSON.stringify(
      ADAPTER_POWER_TARGETS.filter((t) => available.some((a) => a.toLowerCase() === t.property.toLowerCase()))
    ).replace(/'/g, "''");

    const body = `
$name = ${ps.psString(ps.sanitizeName(target.name))}
$targets = ConvertFrom-Json -InputObject '${targetsJson}'
$done = New-Object System.Collections.ArrayList
$errors = New-Object System.Collections.ArrayList

foreach ($t in $targets) {
  try {
    $params = @{ Name = $name; NoRestart = $true; ErrorAction = 'Stop' }
    $params[$t.property] = $t.value
    Set-NetAdapterPowerManagement @params
    $null = $done.Add("$($t.property)=$($t.value)")
  } catch {
    $null = $errors.Add("$($t.property): $($_.Exception.Message)")
  }
}

# Fallback/complemento: root\\WMI MSPower_DeviceEnable (a caixa do Gerenciador de Dispositivos)
try {
  $adapter = Get-NetAdapter -Name $name -ErrorAction Stop
  $pnp = "$($adapter.PnpDeviceID)"
  $dev = Get-CimInstance -Namespace 'root/WMI' -ClassName 'MSPower_DeviceEnable' -ErrorAction SilentlyContinue |
         Where-Object { $_.InstanceName -and $_.InstanceName.ToUpper().StartsWith($pnp.ToUpper()) }
  foreach ($d in $dev) {
    if ($d.Enable) {
      Set-CimInstance -InputObject $d -Property @{ Enable = $false } -ErrorAction Stop
      $null = $done.Add("MSPower_DeviceEnable=false")
    }
  }
} catch {
  $null = $errors.Add("MSPower: $($_.Exception.Message)")
}

Write-WillLagJson @{ ok = $true; done = @($done); errors = @($errors) }
`;

    const res = await ps.ensureElevated(body, {
      label: 'adapter:pm-apply',
      isAdmin: ctx.isAdmin,
      allowPrompt: ctx.allowPrompt,
      timeout: 60000,
    });

    if (!res.success) {
      stateStore.consumeBackup('adapterPowerManagement');
      return { success: false, code: res.code, applied: false, error: res.error, message: res.error };
    }

    const done = ps.asArray(res.data && res.data.done);
    const errors = ps.asArray(res.data && res.data.errors);

    if (done.length === 0) {
      stateStore.consumeBackup('adapterPowerManagement');
      return {
        success: false,
        code: 'NO_EFFECT',
        applied: false,
        message: `O driver "${target.description}" não expõe propriedades de energia ajustáveis.${errors.length ? ' ' + errors[0] : ''}`,
        details: errors,
      };
    }

    stateStore.markApplied('adapterPowerManagement', { scope: 'persistent', params: { adapter: target.name } });
    netif.invalidate();

    return {
      success: true,
      code: errors.length ? 'PARTIAL' : 'OK',
      applied: true,
      message: `Economia de energia desativada em "${target.name}" (${done.length} propriedade(s)).`,
      details: done,
      warnings: errors,
    };
  },

  async revert(ctx) {
    const layer = stateStore.peekBackup('adapterPowerManagement');
    if (!layer || !layer.entries || layer.entries.length === 0) {
      return { success: true, code: 'NO_BACKUP', applied: false, message: 'Nada a reverter (nenhum backup).' };
    }
    const res = await require('./restoreEngine').restoreEntries(layer.entries, {
      isAdmin: ctx.isAdmin,
      allowPrompt: ctx.allowPrompt,
    });
    if (res.success || res.code === 'PARTIAL') stateStore.consumeBackup('adapterPowerManagement');
    stateStore.markReverted('adapterPowerManagement');
    return { ...res, applied: false };
  },
};

/* ------------------------------------------------------------------ */
/* TWEAK — Propriedades avançadas do driver (power save / EEE)         */
/* ------------------------------------------------------------------ */

/**
 * Escolhe, entre os valores válidos de uma propriedade, o que significa
 * "menos economia de energia / menor agregação".
 * Nomes variam por fabricante: "Disabled", "Desativado", "Off", "0", "None",
 * "Max Performance", "Lowest"...
 */
/**
 * Pontua um valor de display de propriedade do driver.
 * Quanto MAIOR, menos economia de energia (que é o que queremos em jogo).
 *
 * A pegadinha: a palavra "high/max" depende do que a propriedade mede.
 *   "Maximum Performance"      -> performance máxima  = BOM  (economia off)
 *   "High Power Saving"        -> economia alta       = RUIM
 * Por isso o texto é classificado primeiro pelo que ele mede (economia de
 * energia) e só depois pela intensidade.
 */
function pickPerformanceValue(validValues, validRegistryValues) {
  const display = ps.asArray(validValues).map((v) => String(v));
  const registry = ps.asArray(validRegistryValues).map((v) => String(v));

  const scoreDisplay = (v) => {
    const s = String(v).toLowerCase();
    const measuresPowerSave = /power\s*sav|economia|\bmps\b|u-?apsd|ps\s*mode|idle\s*power|green/.test(s);

    if (/^(disable|desativ|desabilit|off\b|no\b|none|nenhum|sem)/.test(s)) return 100;
    if (measuresPowerSave && /^(max|m[áa]xim|high|alt|aggressive|sempre|always)/.test(s)) return 5;
    if (measuresPowerSave && /^(min|m[íi]nim|low|baix|no\s*power)/.test(s)) return 95;
    if (/max.*performance|m[áa]ximo desempenho|always on|sempre ativ/.test(s)) return 90;
    if (/performance|desempenho/.test(s)) return 85;
    if (/^(lowest|low|m[íi]nim|min|baix)/.test(s)) return 70;
    if (/^(medium|m[ée]di)/.test(s)) return 40;
    if (/^(enable|ativ|habilit|on\b|yes|sim)/.test(s)) return 0;
    return 10;
  };

  if (display.length > 0) {
    const sorted = [...display].sort((a, b) => scoreDisplay(b) - scoreDisplay(a));
    const idx = display.indexOf(sorted[0]);
    return {
      displayValue: sorted[0],
      registryValue: registry.length === display.length ? registry[idx] : null,
      score: scoreDisplay(sorted[0]),
    };
  }

  if (registry.length > 0) {
    // Só numéricos: 0 costuma ser "desativado".
    const numeric = registry.filter((v) => /^\d+$/.test(v));
    if (numeric.length) {
      const sorted = [...numeric].sort((a, b) => Number(a) - Number(b));
      return { displayValue: null, registryValue: sorted[0], score: 60 };
    }
    return { displayValue: null, registryValue: registry[0], score: 20 };
  }

  return { displayValue: null, registryValue: null, score: -1 };
}

async function readAdvancedPowerProperties(adapterName) {
  const body = `
$name = ${ps.psString(ps.sanitizeName(adapterName))}
$patterns = ConvertFrom-Json -InputObject '${JSON.stringify(POWER_SAVE_KEYWORDS.map((r) => r.source)).replace(/'/g, "''")}'
$props = @(Get-NetAdapterAdvancedProperty -Name $name -ErrorAction SilentlyContinue)
$out = New-Object System.Collections.ArrayList
foreach ($p in $props) {
  $hay = ("$($p.DisplayName) $($p.RegistryKeyword) $($p.Description)").ToLower()
  $match = $false
  foreach ($pat in $patterns) { if ($hay -match $pat) { $match = $true; break } }
  if (-not $match) { continue }
  $null = $out.Add([pscustomobject]@{
    displayName      = "$($p.DisplayName)"
    registryKeyword  = "$($p.RegistryKeyword)"
    registryValue    = "$($p.RegistryValue)"
    displayValue     = "$($p.DisplayValue)"
    validDisplay     = @($p.ValidDisplayValues | ForEach-Object { "$_" })
    validRegistry    = @($p.ValidRegistryValues | ForEach-Object { "$_" })
    numericBase      = "$($p.NumericParameterBaseValue)"
  })
}
Write-WillLagJson @{ ok = $true; name = $name; properties = @($out) }
`;

  const res = await ps.runPowerShell(body, { label: 'adapter:advanced-read', timeout: 40000 });
  if (!res.success) return { ok: false, error: res.error, code: res.code };
  return { ok: true, properties: ps.asArray(res.data && res.data.properties) };
}

const advancedPowerTweak = {
  id: 'adapterPowerSaveAdvanced',
  group: 'wifi',
  label: 'Desativar economia de energia no driver (propriedades avançadas)',
  description:
    'Zera Power Saving Mode / U-APSD / EEE (Green Ethernet) e reduz Roaming Aggressiveness — detectados por fabricante.',
  why:
    'Cada fabricante expõe a economia de energia com um nome diferente (Realtek: "Power Saving Mode"; ' +
    'Intel: "U-APSD support" / "Advanced EEE"; TP-Link: "Green Ethernet"). O willLag enumera as ' +
    'propriedades reais do SEU driver, faz backup dos valores atuais e aplica o valor de maior ' +
    'performance — sem chutar nomes que não existem.',
  risk: 'medium',
  requiresAdmin: true,
  scope: 'persistent',
  defaultInPreset: false,

  async detect(ctx) {
    if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };
    const snap = await netif.getSnapshot();
    const adapter = (await getTargetWifiAdapter(ctx)) || snap.activeAdapter;
    if (!adapter) return { ok: true, supported: false, applied: false, reason: 'Nenhum adaptador ativo.' };

    const found = await readAdvancedPowerProperties(adapter.name);
    if (!found.ok) return { ok: true, supported: false, applied: false, reason: found.error, adapter: adapter.name };

    const props = found.properties || [];
    const plan = props.map((p) => ({
      displayName: p.displayName,
      keyword: p.registryKeyword,
      current: p.displayValue || p.registryValue,
      suggested: pickPerformanceValue(p.validDisplay, p.validRegistry),
    })).filter((p) => p.suggested.score > 30);

    const needsChange = plan.filter((p) => String(p.current).toLowerCase() !== String(p.suggested.displayValue || p.suggested.registryValue).toLowerCase());

    return {
      ok: true,
      supported: props.length > 0,
      applied: props.length > 0 && needsChange.length === 0,
      adapter: adapter.name,
      current: props.map((p) => `${p.displayName}=${p.displayValue || p.registryValue}`).join(', ') || 'nenhuma',
      target: plan.map((p) => `${p.displayName}=${p.suggested.displayValue || p.suggested.registryValue}`).join(', ') || 'nenhuma',
      plan,
      reason: props.length === 0 ? 'O driver não expõe propriedades de economia de energia.' : undefined,
    };
  },

  async apply(ctx) {
    const detected = await advancedPowerTweak.detect(ctx);
    if (!detected.supported) {
      return { success: false, code: 'UNSUPPORTED', applied: false, message: detected.reason || 'Sem propriedades ajustáveis.' };
    }

    const plan = (detected.plan || []).filter((p) => p.suggested && p.suggested.score > 30);
    if (plan.length === 0) {
      return { success: true, code: 'ALREADY_OPTIMAL', applied: true, message: 'Driver já está no modo de maior performance.' };
    }

    stateStore.pushBackup(
      'adapterPowerSaveAdvanced',
      plan.map((p) => ({
        kind: 'adapterAdvanced',
        name: ps.sanitizeName(detected.adapter),
        keyword: p.keyword,
        displayName: p.displayName,
        value: String(p.current === undefined || p.current === null ? '' : p.current),
      })),
      { adapter: detected.adapter }
    );

    const items = plan
      .filter((p) => p.suggested.registryValue !== null && p.suggested.registryValue !== undefined)
      .map((p) => ({ keyword: p.keyword, value: String(p.suggested.registryValue), display: p.displayName }));

    if (items.length === 0) {
      stateStore.consumeBackup('adapterPowerSaveAdvanced');
      return { success: false, code: 'NO_REGISTRY_VALUE', applied: false, message: 'Propriedades sem valor de registro mapeável.' };
    }

    const body = `
$name = ${ps.psString(ps.sanitizeName(detected.adapter))}
$items = ConvertFrom-Json -InputObject '${JSON.stringify(items).replace(/'/g, "''")}'
$done = New-Object System.Collections.ArrayList
$errors = New-Object System.Collections.ArrayList
foreach ($i in $items) {
  try {
    Set-NetAdapterAdvancedProperty -Name $name -RegistryKeyword $i.keyword -RegistryValue $i.value -NoRestart -ErrorAction Stop
    $null = $done.Add("$($i.display) -> $($i.value)")
  } catch {
    $null = $errors.Add("$($i.display): $($_.Exception.Message)")
  }
}
Write-WillLagJson @{ ok = $true; done = @($done); errors = @($errors) }
`;

    const res = await ps.ensureElevated(body, {
      label: 'adapter:advanced-apply',
      isAdmin: ctx.isAdmin,
      allowPrompt: ctx.allowPrompt,
      timeout: 90000,
    });

    if (!res.success) {
      stateStore.consumeBackup('adapterPowerSaveAdvanced');
      return { success: false, code: res.code, applied: false, error: res.error, message: res.error };
    }

    const done = ps.asArray(res.data && res.data.done);
    const errors = ps.asArray(res.data && res.data.errors);

    if (done.length === 0) {
      stateStore.consumeBackup('adapterPowerSaveAdvanced');
      return { success: false, code: 'NO_EFFECT', applied: false, message: errors[0] || 'Nenhuma propriedade pôde ser alterada.' };
    }

    stateStore.markApplied('adapterPowerSaveAdvanced', { scope: 'persistent', params: { adapter: detected.adapter, count: done.length } });
    netif.invalidate();

    return {
      success: true,
      code: errors.length ? 'PARTIAL' : 'OK',
      applied: true,
      message: `${done.length} propriedade(s) do driver ajustadas para performance máxima em "${detected.adapter}".`,
      details: done,
      warnings: errors,
      note: 'Alguns drivers reiniciam o adaptador ao aplicar. Se a conexão cair, reverta por esta tela.',
    };
  },

  async revert(ctx) {
    const layer = stateStore.peekBackup('adapterPowerSaveAdvanced');
    if (!layer || !layer.entries || layer.entries.length === 0) {
      return { success: true, code: 'NO_BACKUP', applied: false, message: 'Nada a reverter.' };
    }
    const res = await require('./restoreEngine').restoreEntries(layer.entries, {
      isAdmin: ctx.isAdmin,
      allowPrompt: ctx.allowPrompt,
    });
    if (res.success || res.code === 'PARTIAL') stateStore.consumeBackup('adapterPowerSaveAdvanced');
    stateStore.markReverted('adapterPowerSaveAdvanced');
    netif.invalidate();
    return { ...res, applied: false };
  },
};

module.exports = {
  tweaks: [wlanAutoconfigTweak, usbSelectiveSuspendTweak, adapterPowerTweak, advancedPowerTweak],
  POWER_SUBGROUP_USB,
  POWER_SETTING_USB_SELECTIVE_SUSPEND,
  ADAPTER_POWER_TARGETS,
  POWER_SAVE_KEYWORDS,
  getTargetWifiAdapter,
  getWifiDiagnostics,
  setAutoconfig,
  verifyWifiStillConnected,
  readUsbSelectiveSuspend,
  parsePowercfgQuery,
  readAdapterPowerManagement,
  readAdvancedPowerProperties,
  pickPerformanceValue,
};
