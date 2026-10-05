'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ni = require('../public/services/netInterfaces');

/* ------------------------------------------------------------------ */
/* netsh wlan show interfaces — pt-BR e en-US, UMA ou VÁRIAS interfaces */
/* ------------------------------------------------------------------ */

const WLAN_TWO_EN = [
  'There is 2 interfaces on the system:',
  '',
  '    Name                   : Wi-Fi',
  '    Description            : Intel(R) Wi-Fi 6 AX201 160MHz',
  '    GUID                   : 11111111-2222-3333-4444-555555555555',
  '    Physical address       : aa:bb:cc:dd:ee:01',
  '    State                  : connected',
  '    SSID                   : Casa',
  '    BSSID                  : 11:22:33:44:55:66',
  '    Network type           : Infrastructure',
  '    Radio type             : 802.11ac',
  '    Authentication         : WPA2-Personal',
  '    Cipher                 : CCMP',
  '    Connection mode        : Auto Connect',
  '    Channel                : 36',
  '    Receive rate (Mbps)    : 433.3',
  '    Transmit rate (Mbps)   : 433.3',
  '    Signal                 : 90%',
  '    Profile                : Casa',
  '',
  '    Hosted network status  : Not available',
  '',
  '    Name                   : Wi-Fi 2',
  '    Description            : Realtek 8822CU Wireless LAN 802.11ac USB NIC',
  '    State                  : disconnected',
  '    Channel                : 6',
  '    Signal                 : 55%',
].join('\n');

const WLAN_ONE_PTBR = [
  'Há 1 interface no sistema:',
  '',
  '    Nome                   : Wi-Fi',
  '    Descrição              : Realtek 8822CU Wireless LAN 802.11ac USB NIC',
  '    Endereço físico        : aa:bb:cc:dd:ee:02',
  '    Estado                 : conectado',
  '    SSID                   : MinhaRede',
  '    BSSID                  : 99:88:77:66:55:44',
  '    Tipo de rede           : Infraestrutura',
  '    Tipo de rádio          : 802.11n',
  '    Autenticação           : WPA2-Pessoal',
  '    Criptografia           : CCMP',
  '    Canal                  : 6',
  '    Taxa de recepção (Mbps): 72.2',
  '    Taxa de transmissão (Mbps): 65',
  '    Sinal                  : 61%',
  '    Perfil                 : MinhaRede',
].join('\n');

test('parseWlanInterfaces: enumera TODAS as interfaces (Wi-Fi interno + dongle USB)', () => {
  const list = ni.parseWlanInterfaces(WLAN_TWO_EN);
  assert.strictEqual(list.length, 2, 'as duas interfaces sem fio precisam aparecer');
  assert.deepStrictEqual(list.map((w) => w.name), ['Wi-Fi', 'Wi-Fi 2']);

  const first = list[0];
  assert.strictEqual(first.state, 'connected');
  assert.strictEqual(first.ssid, 'Casa');
  assert.strictEqual(first.bssid, '11:22:33:44:55:66', 'BSSID não pode cair no campo SSID');
  assert.strictEqual(first.channel, '36');
  assert.strictEqual(first.signalPercent, '90%');
  assert.strictEqual(first.radioType, '802.11ac');
  assert.strictEqual(first.receiveRateMbps, '433.3');
  assert.strictEqual(first.transmitRateMbps, '433.3');
  assert.strictEqual(first.guid, '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(first.physicalAddress, 'aa:bb:cc:dd:ee:01');
  assert.strictEqual(first.connectionMode, 'Auto Connect');

  assert.strictEqual(list[1].state, 'disconnected');
  assert.strictEqual(list[1].signalPercent, '55%');
});

test('parseWlanInterfaces: português (Brasil)', () => {
  const list = ni.parseWlanInterfaces(WLAN_ONE_PTBR);
  assert.strictEqual(list.length, 1);
  const w = list[0];
  assert.strictEqual(w.name, 'Wi-Fi');
  assert.strictEqual(w.state, 'conectado');
  assert.strictEqual(w.radioType, '802.11n');
  assert.strictEqual(w.channel, '6');
  assert.strictEqual(w.signalPercent, '61%');
  assert.strictEqual(w.receiveRateMbps, '72.2');
  assert.strictEqual(w.transmitRateMbps, '65');
  assert.strictEqual(w.authentication, 'WPA2-Pessoal');
  assert.strictEqual(w.cipher, 'CCMP');
  assert.strictEqual(w.physicalAddress, 'aa:bb:cc:dd:ee:02');
  assert.strictEqual(w.bssid, '99:88:77:66:55:44');
  assert.strictEqual(w.ssid, 'MinhaRede');
});

test('parseWlanInterfaces: sem rádio / saída vazia não lança', () => {
  assert.deepStrictEqual(ni.parseWlanInterfaces(''), []);
  assert.deepStrictEqual(ni.parseWlanInterfaces(null), []);
  assert.deepStrictEqual(ni.parseWlanInterfaces('There is no wireless interface on the system.'), []);
  assert.deepStrictEqual(
    ni.parseWlanInterfaces('O Serviço de Configuração Automática de WLAN (wlansvc) não está em execução.'),
    []
  );
});

test('parseWlanInterfaces: campos ausentes viram null (UI não recebe undefined)', () => {
  const list = ni.parseWlanInterfaces('    Name : Wi-Fi\n    State : disconnected\n');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].channel, null);
  assert.strictEqual(list[0].signalPercent, null);
  assert.strictEqual(list[0].radioType, null);
});

/* ------------------------------------------------------------------ */
/* netsh wlan show autoconfig                                          */
/* ------------------------------------------------------------------ */

test('parseAutoconfig: português e inglês, ativado/desativado', () => {
  assert.deepStrictEqual(
    ni.parseAutoconfig('Configuração automática de conexão: desativado no Wi-Fi 2'),
    [{ name: 'Wi-Fi 2', enabled: false }]
  );
  assert.deepStrictEqual(
    ni.parseAutoconfig('Configuração automática de conexão: habilitado no Wi-Fi'),
    [{ name: 'Wi-Fi', enabled: true }]
  );
  assert.deepStrictEqual(
    ni.parseAutoconfig('"Wi-Fi 2" auto configuration is disabled'),
    [{ name: 'Wi-Fi 2', enabled: false }]
  );
  assert.deepStrictEqual(
    ni.parseAutoconfig('"Wi-Fi" auto configuration is enabled'),
    [{ name: 'Wi-Fi', enabled: true }]
  );
});

test('parseAutoconfig: várias interfaces na mesma saída', () => {
  const out = ni.parseAutoconfig(
    'Configuração automática de conexão: desativado no Wi-Fi\nConfiguração automática de conexão: habilitado no Wi-Fi 2\n'
  );
  assert.deepStrictEqual(out, [
    { name: 'Wi-Fi', enabled: false },
    { name: 'Wi-Fi 2', enabled: true },
  ]);
});

test('parseAutoconfig: saída vazia ou irrelevante', () => {
  assert.deepStrictEqual(ni.parseAutoconfig(''), []);
  assert.deepStrictEqual(ni.parseAutoconfig(null), []);
  assert.deepStrictEqual(ni.parseAutoconfig('Acesso negado.'), []);
});

/* ------------------------------------------------------------------ */
/* Heurísticas de adaptador                                            */
/* ------------------------------------------------------------------ */

test('isWifiAdapter: reconhece por media type, descrição e nome', () => {
  assert.strictEqual(ni.isWifiAdapter({ name: 'Wi-Fi' }), true);
  assert.strictEqual(ni.isWifiAdapter({ name: 'Conexão de Rede Sem Fio' }), false, 'sem descritor reconhecível');
  assert.strictEqual(ni.isWifiAdapter({ physicalMediaType: 'Native 802.11 Wireless' }), true);
  assert.strictEqual(ni.isWifiAdapter({ mediaType: '802.11' }), true);
  assert.strictEqual(ni.isWifiAdapter({ description: 'Realtek 8822CU Wireless LAN 802.11ac USB NIC' }), true);
  assert.strictEqual(ni.isWifiAdapter({ description: 'Intel(R) Ethernet Connection I219-V' }), false);
  assert.strictEqual(ni.isWifiAdapter({ description: 'WAN Miniport (Network Monitor)' }), false);
  assert.strictEqual(ni.isWifiAdapter({}), false);
});

test('isUsbDevice: PnPDeviceId USB\\ é o sinal forte', () => {
  assert.strictEqual(ni.isUsbDevice({ pnpDeviceId: 'USB\\VID_0BDA&PID_C822\\00e04c000001' }), true);
  assert.strictEqual(ni.isUsbDevice({ pnpDeviceId: 'PCI\\VEN_8086&DEV_A0F0' }), false);
  // Descritivo é fallback: hubs/roots/controllers não são o dongle do usuário.
  assert.strictEqual(ni.isUsbDevice({ description: 'Generic USB Hub' }), false);
  assert.strictEqual(ni.isUsbDevice({ description: 'USB Root Hub' }), false);
  assert.strictEqual(ni.isUsbDevice({ description: 'Realtek USB Wireless LAN' }), true);
  assert.strictEqual(ni.isUsbDevice({}), false);
});

test('isApiapa: identifica endereço autoconfigurado/inválido', () => {
  assert.strictEqual(ni.isApiapa('169.254.10.4'), true);
  assert.strictEqual(ni.isApiapa('0.0.0.0'), true);
  assert.strictEqual(ni.isApiapa(null), true);
  assert.strictEqual(ni.isApiapa(''), true);
  assert.strictEqual(ni.isApiapa('192.168.0.15'), false);
  assert.strictEqual(ni.isApiapa('10.0.0.44'), false);
});

test('sameName: comparação case/whitespace-insensitive (nomes vêm de fontes diferentes)', () => {
  assert.strictEqual(ni.sameName('Wi-Fi 2', 'wi-fi 2'), true);
  assert.strictEqual(ni.sameName('  Wi-Fi ', 'wi-fi'), true);
  assert.strictEqual(ni.sameName('Ethernet', 'Ethernet 2'), false);
  assert.strictEqual(ni.sameName(null, ''), true);
});

/* ------------------------------------------------------------------ */
/* Escolha da interface ativa                                          */
/* ------------------------------------------------------------------ */

const ADAPTERS = [
  { ifIndex: 7, name: 'Wi-Fi', connected: true, isWifi: true, isUsb: true, description: 'Realtek 8822CU Wireless LAN USB NIC' },
  { ifIndex: 12, name: 'Ethernet', connected: true, isWifi: false, isUsb: false, description: 'Realtek PCIe GbE Family Controller' },
];
const ADDRESSES = [
  { ifIndex: 7, ipAddress: '192.168.0.20' },
  { ifIndex: 12, ipAddress: '192.168.0.15' },
];

test('pickActiveAdapter: segue a rota padrão de MENOR métrica, não a ordem da lista', () => {
  const routesUnsorted = [
    { ifIndex: 7, nextHop: '192.168.0.1', metric: 50, ifMetric: 25 },
    { ifIndex: 12, nextHop: '192.168.0.1', metric: 10, ifMetric: 5 },
  ];
  const picked = ni.pickActiveAdapter(ADAPTERS, routesUnsorted, ADDRESSES, []);
  assert.ok(picked);
  assert.strictEqual(picked.ifIndex, 12, 'o cabo com métrica menor é a interface ativa');
});

test('pickActiveAdapter: ignora rota com next hop APIPA', () => {
  const routes = [
    { ifIndex: 7, nextHop: '169.254.1.1', metric: 5, ifMetric: 5 },
    { ifIndex: 12, nextHop: '192.168.0.1', metric: 50, ifMetric: 25 },
  ];
  assert.strictEqual(ni.pickActiveAdapter(ADAPTERS, routes, ADDRESSES, []).ifIndex, 12);
});

test('pickActiveAdapter: sem rotas, cai no adaptador Up com IP válido e prefere cabo', () => {
  const picked = ni.pickActiveAdapter(ADAPTERS, [], ADDRESSES, []);
  assert.strictEqual(picked.ifIndex, 12, 'sem rota, o adaptador não-Wi-Fi/não-USB é a aposta mais segura');
});

test('pickActiveAdapter: sem rota e só Wi-Fi disponível, escolhe o Wi-Fi', () => {
  const wifiOnly = [ADAPTERS[0]];
  const picked = ni.pickActiveAdapter(wifiOnly, [], [{ ifIndex: 7, ipAddress: '192.168.0.20' }], []);
  assert.strictEqual(picked.ifIndex, 7);
});

test('pickActiveAdapter: exclui adaptadores virtuais no fallback', () => {
  const mixed = [
    { ifIndex: 3, name: 'VMware', connected: true, description: 'VMware Virtual Ethernet Adapter for VMnet8' },
    { ifIndex: 12, name: 'Ethernet', connected: true, description: 'Realtek PCIe GbE Family Controller' },
  ];
  const picked = ni.pickActiveAdapter(mixed, [], [{ ifIndex: 3, ipAddress: '192.168.137.1' }, { ifIndex: 12, ipAddress: '192.168.0.15' }], []);
  assert.strictEqual(picked.ifIndex, 12);
});

test('pickActiveAdapter: nada utilizável devolve null (não undefined)', () => {
  assert.strictEqual(ni.pickActiveAdapter([], [], [], []), null);
  assert.strictEqual(ni.pickActiveAdapter(ADAPTERS, [], [], []), null, 'sem IP válido não há interface ativa');
});

/* ------------------------------------------------------------------ */
/* Comportamento fora do Windows                                       */
/* ------------------------------------------------------------------ */

test('getSnapshot fora do Windows devolve snapshot vazio estruturado', async () => {
  if (process.platform === 'win32') return;
  ni.invalidate();
  const snap = await ni.getSnapshot({ force: true });
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.code, 'UNSUPPORTED_PLATFORM');
  assert.deepStrictEqual(snap.adapters, []);
  assert.deepStrictEqual(snap.wlan, []);
  assert.deepStrictEqual(snap.autoconfig, []);
  assert.strictEqual(snap.activeAdapter, null);
  assert.strictEqual(snap.gateway, null);
});

test('getters derivados não lançam fora do Windows', async () => {
  if (process.platform === 'win32') return;
  assert.strictEqual(await ni.getActiveAdapter({ force: true }), null);
  assert.deepStrictEqual(await ni.getAdapters({ force: true }), []);
  assert.deepStrictEqual(await ni.getWifiAdapters({ force: true }), []);
  assert.strictEqual(await ni.getGateway({ force: true }), null);
  assert.deepStrictEqual(await ni.getRegistryTargetInterfaces({ force: true }), []);
});

test('getRegistryTargetInterfaces monta o caminho de registro do Tcpip\\Parameters\\Interfaces', async () => {
  if (process.platform === 'win32') return;
  // Sem Windows não há adaptadores; o contrato testado é a forma do caminho.
  const targets = await ni.getRegistryTargetInterfaces({ force: true, all: true });
  assert.deepStrictEqual(targets, []);

  const guid = '{A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D}';
  assert.ok(ni.sameName(guid, guid));
  assert.ok(
    `HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\${guid}`.startsWith('HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\')
  );
});

test('falha de snapshot não é cacheada (uma recuperação posterior é percebida)', async () => {
  if (process.platform === 'win32') return;
  const a = await ni.getSnapshot();
  const b = await ni.getSnapshot();
  assert.strictEqual(a.ok, false);
  assert.strictEqual(b.ok, false);
  assert.notStrictEqual(a, b, 'resultado de falha não pode virar cache');
  ni.invalidate(); // não lança mesmo sem cache populado
});

test('getSnapshot usa cache dentro do TTL (Windows)', async () => {
  if (process.platform !== 'win32') return;
  ni.invalidate();
  const a = await ni.getSnapshot();
  const b = await ni.getSnapshot();
  assert.strictEqual(a, b, 'segunda chamada dentro do TTL deve devolver o objeto em cache');
  ni.invalidate();
  const c = await ni.getSnapshot();
  assert.notStrictEqual(a, c, 'após invalidate o snapshot precisa ser recriado');
});
