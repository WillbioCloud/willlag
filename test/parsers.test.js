'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tcpip = require('../public/services/tcpip');
const wifi = require('../public/services/wifi');
const registry = require('../public/services/tweakRegistry');

/* ================================================================== */
/* netsh int tcp show global — a mesma informação em pt-BR e en-US     */
/* ================================================================== */

const GLOBAL_EN = `Querying active state...

TCP Global Parameters
----------------------------------------------
Receive-Side Scaling State                    : enabled
Chimney Offload State                         : disabled
Receive Segment Coalescing State              : disabled
Direct Cache Access (DCA)                     : disabled
TCP Autotuning Level                          : normal
Congestion Control Provider                   : cubic
ECN Capability                                : disabled
RFC 1323 Timestamps                           : disabled
Initial RTO                                   : 3000
Receive Window Auto-Tuning Level              : normal
Non Sack Resiliency                           : disabled
Max SYN Retransmissions                       : 2
Pacing Rate                                   : disabled
ECN Policy                                    : default
Nagle                                         : enabled
Fast Open                                     : enabled
Hybrid Slow Start                             : disabled
Initial Congestion Window                     : 10
`;

const GLOBAL_PTBR = `Consultando o estado ativo...

Parâmetros Globais de TCP
----------------------------------------------
Estado de RSS (Receive-Side Scaling)          : habilitado
Estado de Chimney Offload                     : desabilitado
Coalescência de Segmento de Recepção          : desabilitada
Nível de Autoajuste de TCP                    : normal
Provedor de Controle de Congestionamento      : cubic
Capacidade ECN                                : desabilitado
Carimbos de Data/Hora RFC 1323                : desabilitado
RTO Inicial                                   : 3000
Retransmissões Máximas de SYN                 : 2
Nagle                                         : habilitado
Abertura Rápida                               : habilitada
Política de ECN                               : padrão
`;

test('parseNetshTcpGlobal: inglês', () => {
  const out = tcpip.parseNetshTcpGlobal(GLOBAL_EN);
  assert.strictEqual(out.rss, 'enabled');
  assert.strictEqual(out.chimney, 'disabled');
  assert.strictEqual(out.rsc, 'disabled');
  assert.strictEqual(out.autoTuningLevel, 'normal');
  assert.strictEqual(out.congestionProvider, 'cubic');
  assert.strictEqual(out.ecnCapability, 'disabled');
  assert.strictEqual(out.timestamps, 'disabled');
  assert.strictEqual(out.initialRto, '3000');
  assert.strictEqual(out.fastOpen, 'enabled');
});

test('parseNetshTcpGlobal: português (Brasil) normaliza para os MESMOS valores', () => {
  const en = tcpip.parseNetshTcpGlobal(GLOBAL_EN);
  const pt = tcpip.parseNetshTcpGlobal(GLOBAL_PTBR);

  // É isso que permite que detect() compare "estado atual" com "alvo" sem
  // depender do idioma do Windows do usuário.
  for (const key of ['rss', 'chimney', 'rsc', 'autoTuningLevel', 'congestionProvider', 'ecnCapability', 'timestamps', 'initialRto', 'fastOpen']) {
    assert.strictEqual(pt[key], en[key], `${key}: pt-BR "${pt[key]}" !== en-US "${en[key]}"`);
  }
});

test('parseNetshTcpGlobal: "ECN Policy" não contamina a capacidade ECN', () => {
  const out = tcpip.parseNetshTcpGlobal('ECN Policy : default\nECN Capability : enabled\n');
  assert.strictEqual(out.ecnCapability, 'enabled', 'a linha de política deve ser ignorada');
});

test('parseNetshTcpGlobal: on/off e valores com índice numérico', () => {
  const out = tcpip.parseNetshTcpGlobal('Receive-Side Scaling State : on\nECN Capability : off\nInitial RTO : 2000\n');
  assert.strictEqual(out.rss, 'enabled');
  assert.strictEqual(out.ecnCapability, 'disabled');
  assert.strictEqual(out.initialRto, '2000');
});

test('parseNetshTcpGlobal: detecta congestion providers suportados (CTCP/BBR)', () => {
  assert.strictEqual(tcpip.parseNetshTcpGlobal('Congestion Control Provider : ctcp\n').congestionProvider, 'ctcp');
  assert.strictEqual(tcpip.parseNetshTcpGlobal('Congestion Control Provider : cubic\n').congestionProvider, 'cubic');
  assert.strictEqual(tcpip.parseNetshTcpGlobal('Congestion Control Provider : compound\n').congestionProvider, 'compound');
  assert.strictEqual(tcpip.parseNetshTcpGlobal('Congestion Control Provider : none\n').congestionProvider, 'none');
});

test('parseNetshTcpGlobal: saída inválida devolve objeto vazio (detect() trata como desconhecido)', () => {
  assert.deepStrictEqual(tcpip.parseNetshTcpGlobal(''), {});
  assert.deepStrictEqual(tcpip.parseNetshTcpGlobal(null), {});
  assert.deepStrictEqual(tcpip.parseNetshTcpGlobal('Acesso negado.'), {});
});

test('normalizeEnumValue: dicionário de sinônimos pt-BR/en-US', () => {
  assert.strictEqual(tcpip.normalizeEnumValue('Habilitado'), 'enabled');
  assert.strictEqual(tcpip.normalizeEnumValue('habilitada'), 'enabled');
  assert.strictEqual(tcpip.normalizeEnumValue('Desabilitado'), 'disabled');
  assert.strictEqual(tcpip.normalizeEnumValue('desabilitada'), 'disabled');
  assert.strictEqual(tcpip.normalizeEnumValue('ativado'), 'enabled');
  assert.strictEqual(tcpip.normalizeEnumValue('Padrão'), 'normal');
  assert.strictEqual(tcpip.normalizeEnumValue('ctcp'), 'ctcp', 'valor não traduzível passa direto');
  assert.strictEqual(tcpip.normalizeEnumValue(''), null);
  assert.strictEqual(tcpip.normalizeEnumValue(null), null);
});

test('parseSupplementalProviders: lê o provedor por template (Internet/InternetCustom)', () => {
  const out = tcpip.parseSupplementalProviders(
    'Supplemental TCP Global Parameters\nInternet\n  Congestion Control Provider : ctcp\nInternetCustom\n  Congestion Control Provider : cubic\n'
  );
  assert.strictEqual(out.Internet, 'ctcp');
  assert.strictEqual(out.InternetCustom, 'cubic');
});

test('parseSupplementalProviders: fallback para o primeiro provedor citado', () => {
  const out = tcpip.parseSupplementalProviders('Congestion Control Provider : bbr');
  assert.strictEqual(out.Internet, 'bbr');
  assert.deepStrictEqual(tcpip.parseSupplementalProviders(''), {});
});

/* ================================================================== */
/* Constantes dos tweaks TCP/IP                                        */
/* ================================================================== */

test('NAGLE_VALUES: TcpAckFrequency=1 e TCPNoDelay=1 (o requisito clássico)', () => {
  const byName = Object.fromEntries(tcpip.NAGLE_VALUES.map((v) => [v.name, v]));
  assert.strictEqual(byName.TcpAckFrequency.value, 1);
  assert.strictEqual(byName.TCPNoDelay.value, 1);
  for (const v of tcpip.NAGLE_VALUES) assert.strictEqual(v.kind, 'DWord');
});

test('NETWORK_THROTTLING_INDEX_DISABLED é 0xffffffff sem virar número negativo', () => {
  assert.strictEqual(tcpip.NETWORK_THROTTLING_INDEX_DISABLED, 4294967295);
  assert.strictEqual(tcpip.NETWORK_THROTTLING_INDEX_DISABLED.toString(16), 'ffffffff');
});

test('GAMES_TASK_VALUES: MMCS otimizado para jogos', () => {
  const byName = Object.fromEntries(tcpip.GAMES_TASK_VALUES.map((v) => [v.name, v]));
  assert.strictEqual(byName.Priority.value, 6);
  assert.strictEqual(byName['GPU Priority'].value, 8);
  assert.strictEqual(byName['Scheduling Category'].value, 'High');
  assert.strictEqual(byName['SFIO Priority'].value, 'High');
});

test('NETSH_GLOBAL_DEFAULTS: valores de fábrica para o revert não "chutar"', () => {
  const d = tcpip.NETSH_GLOBAL_DEFAULTS;
  assert.strictEqual(d.autotuninglevel, 'normal');
  assert.strictEqual(d.ecncapability, 'disabled');
  assert.strictEqual(d.rss, 'enabled');
  assert.strictEqual(d.initialrto, '3000');
});

test('tcpip.tweaks: 14 ajustes, todos registrados no catálogo global', () => {
  assert.ok(tcpip.tweaks.length >= 14, `esperado >= 14, obtido ${tcpip.tweaks.length}`);
  for (const t of tcpip.tweaks) {
    assert.strictEqual(t.group, 'tcpip');
    assert.ok(registry.byId(t.id), `${t.id} precisa estar no catálogo`);
    assert.strictEqual(typeof t.detect, 'function');
    assert.strictEqual(typeof t.apply, 'function');
    assert.strictEqual(typeof t.revert, 'function');
  }
});

test('setNetshGlobal fora do Windows devolve falha estruturada + entrada de restauração', async () => {
  if (process.platform === 'win32') return;
  const ctx = registry.createContext({ allowPrompt: false });
  const res = await tcpip.setNetshGlobal('autotuninglevel', 'normal', ctx);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'UNSUPPORTED_PLATFORM');
  // Mesmo sem ler o estado atual, o revert tem para onde voltar (default de fábrica).
  assert.ok(res.entry, 'deve gerar entrada de backup com o default conhecido');
  assert.strictEqual(res.entry.kind, 'netshGlobal');
  assert.strictEqual(res.entry.setting, 'autotuninglevel');
  assert.strictEqual(res.entry.value, 'normal');
});

test('detectNagle fora do Windows informa "não suportado" sem lançar', async () => {
  if (process.platform === 'win32') return;
  const res = await tcpip.detectNagle(registry.createContext({ allowPrompt: false }));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.supported, false);
});

/* ================================================================== */
/* powercfg — USB Selective Suspend                                    */
/* ================================================================== */

test('GUIDs do USB Selective Suspend são os oficiais do Windows', () => {
  assert.strictEqual(wifi.POWER_SUBGROUP_USB.toLowerCase(), '2a737441-1930-4402-8d77-b2bebba308a3');
  assert.strictEqual(wifi.POWER_SETTING_USB_SELECTIVE_SUSPEND.toLowerCase(), '48e6b7a6-50f5-4782-a5d4-53bb8f07e226');
});

test('parsePowercfgQuery: en-US', () => {
  const out = wifi.parsePowercfgQuery([
    'Power Setting GUID: 48e6b7a6-50f5-4782-a5d4-53bb8f07e226  (USB selective suspend setting)',
    '  Current AC Power Setting Index: 0x00000000',
    '  Current DC Power Setting Index: 0x00000001',
  ].join('\n'));
  assert.deepStrictEqual(out, { ac: 0, dc: 1 });
});

test('parsePowercfgQuery: pt-BR (CA/CC)', () => {
  const out = wifi.parsePowercfgQuery([
    'Configuração de Energia: 48e6b7a6-50f5-4782-a5d4-53bb8f07e226  (Configuração de suspensão seletiva USB)',
    '    Índice de Configuração de Energia Atual (CA): 0x00000001',
    '    Índice de Configuração de Energia Atual (CC): 0x00000000',
  ].join('\n'));
  assert.deepStrictEqual(out, { ac: 1, dc: 0 });
});

test('parsePowercfgQuery: variante "(AC) ... 0x" e ausência de dados', () => {
  assert.deepStrictEqual(wifi.parsePowercfgQuery('(AC) 0x00000001\n(DC) 0x00000000'), { ac: 1, dc: 0 });
  assert.deepStrictEqual(wifi.parsePowercfgQuery('Acesso negado.'), { ac: null, dc: null });
  assert.deepStrictEqual(wifi.parsePowercfgQuery(''), { ac: null, dc: null });
  assert.deepStrictEqual(wifi.parsePowercfgQuery(null), { ac: null, dc: null });
});

/* ================================================================== */
/* Propriedades avançadas do driver (economia de energia)              */
/* ================================================================== */

test('ADAPTER_POWER_TARGETS: cobre "o computador pode desligar este dispositivo"', () => {
  const byProp = Object.fromEntries(wifi.ADAPTER_POWER_TARGETS.map((t) => [t.property, t.value]));
  assert.strictEqual(byProp.AllowComputerToTurnOffDevice, 'Disabled');
  assert.strictEqual(byProp.DeviceSleepOnDisconnect, 'Disabled');
  assert.strictEqual(byProp.SelectiveSuspend, 'Disabled');
});

test('POWER_SAVE_KEYWORDS: reconhece nomes de drivers Realtek/Intel/Atheros', () => {
  const matches = (name) => wifi.POWER_SAVE_KEYWORDS.some((re) => re.test(name));

  assert.ok(matches('Power Saving Mode'), 'Realtek');
  assert.ok(matches('U-APSD support'), 'Intel');
  assert.ok(matches('Advanced EEE'), 'Intel/Atheros');
  assert.ok(matches('Energy Efficient Ethernet'), 'padrão 802.3az');
  assert.ok(matches('Green Ethernet'), 'Realtek');
  assert.ok(matches('Economia de Energia'), 'driver localizado');
  assert.ok(matches('Device Sleep on Disconnect'), 'Qualcomm/Atheros');

  assert.ok(!matches('Roaming Aggressiveness'), 'propriedade de roaming não é economia de energia');
  assert.ok(!matches('Speed & Duplex'), 'negociação de link não é economia de energia');
  assert.ok(!matches('MAC Address'), 'não deve mexer em identidade do adaptador');
});

test('pickPerformanceValue: escolhe "desativado" quando o objetivo é economizar energia = OFF', () => {
  const r = wifi.pickPerformanceValue(['Enabled', 'Disabled'], [1, 0]);
  assert.strictEqual(r.displayValue, 'Disabled');
  assert.strictEqual(r.registryValue, '0', 'o índice deve acompanhar o display escolhido');
  assert.ok(r.score > 0);
});

test('pickPerformanceValue: entende localized e sinônimos', () => {
  assert.strictEqual(wifi.pickPerformanceValue(['Ativado', 'Desativado'], [1, 0]).displayValue, 'Desativado');
  assert.strictEqual(wifi.pickPerformanceValue(['Maximum Performance', 'Lowest Power'], [0, 1]).displayValue, 'Maximum Performance');
  assert.strictEqual(wifi.pickPerformanceValue(['Máximo desempenho', 'Mínimo desempenho'], [0, 1]).displayValue, 'Máximo desempenho');
});

test('pickPerformanceValue: roaming aggressiveness -> baixo (menos varredura)', () => {
  const r = wifi.pickPerformanceValue(['Medium', 'Lowest', 'Highest'], [2, 1, 3]);
  assert.strictEqual(r.displayValue, 'Lowest');
  assert.strictEqual(r.registryValue, '1');
});

test('pickPerformanceValue: só valores de registro (sem display) escolhe o menor', () => {
  const r = wifi.pickPerformanceValue(null, [3, 0, 1]);
  assert.strictEqual(r.displayValue, null);
  assert.strictEqual(r.registryValue, '0');
});

test('pickPerformanceValue: listas vazias não lançam', () => {
  assert.deepStrictEqual(wifi.pickPerformanceValue([], []), { displayValue: null, registryValue: null, score: -1 });
  assert.deepStrictEqual(wifi.pickPerformanceValue(null, null), { displayValue: null, registryValue: null, score: -1 });
});

test('pickPerformanceValue: display e registry de tamanhos diferentes não desalinham índices', () => {
  const r = wifi.pickPerformanceValue(['Enabled', 'Disabled'], [1]);
  assert.strictEqual(r.displayValue, 'Disabled');
  assert.strictEqual(r.registryValue, null, 'melhor não chutar do que gravar o valor errado');
});

/* ================================================================== */
/* TWEAKS de Wi-Fi                                                     */
/* ================================================================== */

test('wifi.tweaks: os 4 ajustes de Wi-Fi/USB energia estão presentes', () => {
  const ids = wifi.tweaks.map((t) => t.id);
  assert.deepStrictEqual(ids, ['wlanAutoconfig', 'usbSelectiveSuspend', 'adapterPowerManagement', 'adapterPowerSaveAdvanced']);
  for (const t of wifi.tweaks) {
    assert.strictEqual(t.group, 'wifi');
    assert.ok(registry.byId(t.id), `${t.id} precisa estar no catálogo`);
  }
});

test('wlanAutoconfig: único tweak de sessão, marcado como crítico', () => {
  const t = registry.byId('wlanAutoconfig');
  assert.strictEqual(t.scope, 'session');
  assert.strictEqual(t.sessionCritical, true);
  assert.strictEqual(t.requiresAdmin, true);
  assert.ok(/autoconfig/i.test(t.description + t.why), 'deve explicar que pausa a varredura em segundo plano');
});

test('setAutoconfig: nome de interface inválido é bloqueado antes de qualquer execução', async () => {
  const ctx = registry.createContext({ allowPrompt: false });
  for (const bad of ['Wi-Fi"; calc; "', 'a$b', 'a`b', 'a;b', '', null]) {
    const res = await wifi.setAutoconfig(bad, false, ctx);
    assert.strictEqual(res.success, false, `deveria rejeitar ${JSON.stringify(bad)}`);
    assert.strictEqual(res.code, 'INVALID_INTERFACE');
  }
});

test('setAutoconfig fora do Windows: falha estruturada (nunca lança)', async () => {
  if (process.platform === 'win32') return;
  const ctx = registry.createContext({ allowPrompt: false });
  const res = await wifi.setAutoconfig('Wi-Fi', true, ctx);
  assert.strictEqual(res.success, false);
  assert.ok(res.code, 'sempre com código estável para a UI');
});

test('verifyWifiStillConnected fora do Windows devolve estado desconhecido', async () => {
  if (process.platform === 'win32') return;
  const res = await wifi.verifyWifiStillConnected('Wi-Fi');
  assert.strictEqual(res.connected, null);
  assert.strictEqual(res.state, 'unknown');
});

test('getWifiDiagnostics fora do Windows informa ausência de Wi-Fi sem lançar', async () => {
  if (process.platform === 'win32') return;
  const res = await wifi.getWifiDiagnostics(registry.createContext({ allowPrompt: false }));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.hasWifi, false);
  assert.ok(res.message.length > 20, 'mensagem explicativa para a UI');
  assert.deepStrictEqual(res.adapters, []);
});

test('readUsbSelectiveSuspend fora do Windows não lança', async () => {
  if (process.platform === 'win32') return;
  const res = await wifi.readUsbSelectiveSuspend();
  assert.strictEqual(res.ok, false);
});

test('readAdapterPowerManagement fora do Windows não lança', async () => {
  if (process.platform === 'win32') return;
  const res = await wifi.readAdapterPowerManagement('Wi-Fi');
  assert.strictEqual(res.ok, false);
});
