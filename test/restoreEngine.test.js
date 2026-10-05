'use strict';

const test = require('node:test');
const assert = require('node:assert');

const engine = require('../public/services/restoreEngine');

test('restoreEngine: aceita todos os kinds documentados', () => {
  for (const kind of engine.VALID_KINDS) {
    assert.ok(kind, kind);
  }
  const required = [
    'registry', 'netshGlobal', 'netshIpGlobal', 'netshSupplemental', 'wlanAutoconfig',
    'powercfgAcDc', 'adapterPowerManagement', 'adapterAdvanced', 'dns', 'mtu', 'qosPolicy',
  ];
  for (const k of required) assert.ok(engine.VALID_KINDS.has(k), `kind ausente: ${k}`);
});

test('restoreEngine: normaliza entrada de registro preservando tipo e valor', () => {
  const e = engine.normalizeEntry(
    { kind: 'registry', path: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile', name: 'NetworkThrottlingIndex', existed: true, kindType: 'DWord', value: '10' },
    3
  );
  assert.ok(e);
  assert.strictEqual(e.id, 3);
  assert.strictEqual(e.kindType, 'DWord');
  assert.strictEqual(e.value, '10');
  assert.strictEqual(e.existed, true);
});

test('restoreEngine: 0xffffffff não vira número negativo', () => {
  const e = engine.normalizeEntry(
    { kind: 'registry', path: 'HKLM\\A\\B', name: 'NetworkThrottlingIndex', existed: true, kindType: 'DWord', value: '4294967295' },
    0
  );
  assert.strictEqual(e.value, '4294967295');
  const script = engine.buildRestoreScript([e]);
  assert.ok(script.includes('4294967295'));
  assert.ok(script.includes('0xFFFFFFFF'), 'deve mascarar como uint32 no PowerShell');
});

test('restoreEngine: valor inexistente vira remoção (não escrita de zero)', () => {
  const e = engine.normalizeEntry({ kind: 'registry', path: 'HKLM\\A', name: 'TCPNoDelay', existed: false }, 0);
  assert.strictEqual(e.existed, false);
  const script = engine.buildRestoreScript([e]);
  assert.ok(script.includes('Remove-ItemProperty'));
});

test('restoreEngine: bloqueia caminhos de registro fora de HKLM/HKCU', () => {
  assert.strictEqual(engine.normalizeEntry({ kind: 'registry', path: 'C:\\Windows\\System32', name: 'X', existed: true }, 0), null);
  assert.strictEqual(engine.normalizeEntry({ kind: 'registry', path: '\\\\servidor\\share', name: 'Y', existed: true }, 0), null);
  assert.ok(engine.normalizeEntry({ kind: 'registry', path: 'HKCU\\Software\\X', name: 'Y', existed: true }, 0));
  assert.ok(engine.normalizeEntry({ kind: 'registry', path: 'HKEY_LOCAL_MACHINE\\X', name: 'Y', existed: true }, 0));
});

test('restoreEngine: rejeita tipos de valor desconhecidos (usa DWord como padrão seguro)', () => {
  const e = engine.normalizeEntry({ kind: 'registry', path: 'HKLM\\A', name: 'X', existed: true, kindType: 'SomethingWeird', value: '1' }, 0);
  assert.strictEqual(e.kindType, 'DWord');
});

test('restoreEngine: entrada binária é sanitizada byte a byte', () => {
  const e = engine.normalizeEntry(
    { kind: 'registry', path: 'HKLM\\A', name: 'Bin', existed: true, kindType: 'Binary', bytes: [0, 255, 999, -3, 'x'] },
    0
  );
  assert.deepStrictEqual(e.bytes, [0, 255, 231, 253, 0]);
  assert.ok(e.bytes.every((b) => b >= 0 && b <= 255));
});

test('restoreEngine: netsh exige setting/value alfanuméricos (bloqueia injeção)', () => {
  assert.ok(engine.normalizeEntry({ kind: 'netshGlobal', setting: 'autotuninglevel', value: 'normal' }, 0));
  assert.strictEqual(engine.normalizeEntry({ kind: 'netshGlobal', setting: 'autotuninglevel', value: 'normal & calc' }, 0), null);
  assert.strictEqual(engine.normalizeEntry({ kind: 'netshGlobal', setting: 'a; rm -rf', value: 'x' }, 0), null);
  assert.strictEqual(engine.normalizeEntry({ kind: 'netshGlobal', setting: 'ecncapability', value: "$(calc)" }, 0), null);
});

test('restoreEngine: wlanAutoconfig sanitiza nome de interface', () => {
  const ok = engine.normalizeEntry({ kind: 'wlanAutoconfig', interfaceName: 'Wi-Fi 2', enabled: true }, 0);
  assert.ok(ok);
  assert.strictEqual(ok.interfaceName, 'Wi-Fi 2');
  assert.strictEqual(ok.enabled, true);

  const bad = engine.normalizeEntry({ kind: 'wlanAutoconfig', interfaceName: 'Wi-Fi"; calc; "', enabled: true }, 0);
  assert.strictEqual(bad, null);
});

test('restoreEngine: DNS só aceita IPs válidos e ifIndex numérico', () => {
  const ok = engine.normalizeEntry({ kind: 'dns', ifIndex: 12, alias: 'Wi-Fi', servers: ['1.1.1.1', '1.0.0.1'], wasDhcp: false }, 0);
  assert.deepStrictEqual(ok.servers, ['1.1.1.1', '1.0.0.1']);

  const inj = engine.normalizeEntry({ kind: 'dns', ifIndex: 12, servers: ["1.1.1.1'; Remove-Item C:\\; '"] }, 0);
  assert.deepStrictEqual(inj.servers, [], 'servidor malicioso deve ser filtrado');

  assert.strictEqual(engine.normalizeEntry({ kind: 'dns', ifIndex: 'doze', servers: ['1.1.1.1'] }, 0), null);
  assert.strictEqual(engine.normalizeEntry({ kind: 'dns', ifIndex: -1, servers: ['1.1.1.1'] }, 0), null);
});

test('restoreEngine: MTU fora da faixa é rejeitado', () => {
  assert.ok(engine.normalizeEntry({ kind: 'mtu', ifIndex: 12, mtu: 1492 }, 0));
  assert.strictEqual(engine.normalizeEntry({ kind: 'mtu', ifIndex: 12, mtu: 100 }, 0), null);
  assert.strictEqual(engine.normalizeEntry({ kind: 'mtu', ifIndex: 12, mtu: 99999 }, 0), null);
});

test('restoreEngine: adapterPowerManagement só aceita Enabled/Disabled', () => {
  assert.ok(engine.normalizeEntry({ kind: 'adapterPowerManagement', name: 'Wi-Fi', property: 'SelectiveSuspend', value: 'Disabled' }, 0));
  assert.strictEqual(engine.normalizeEntry({ kind: 'adapterPowerManagement', name: 'Wi-Fi', property: 'SelectiveSuspend', value: 'Disabled; calc' }, 0), null);
  assert.strictEqual(engine.normalizeEntry({ kind: 'adapterPowerManagement', name: 'Wi-Fi', property: 'Sel;ective', value: 'Disabled' }, 0), null);
});

test('restoreEngine: powercfg valida GUIDs de subgrupo/configuração', () => {
  const ok = engine.normalizeEntry({
    kind: 'powercfgAcDc',
    scheme: 'SCHEME_CURRENT',
    subgroup: '2a737441-1930-4402-8d77-b2bebba308a3',
    setting: '48e6b7a6-50f5-4782-a5d4-53bb8f07e226',
    acValue: 1,
    dcValue: 1,
  }, 0);
  assert.ok(ok);
  assert.strictEqual(ok.acValue, 1);

  const bad = engine.normalizeEntry({ kind: 'powercfgAcDc', subgroup: 'abc; calc', setting: 'x', acValue: 1 }, 0);
  assert.strictEqual(bad, null);
});

test('restoreEngine: kinds desconhecidos são ignorados (não entram no script)', () => {
  assert.strictEqual(engine.normalizeEntry({ kind: 'formatDisk', path: 'C:' }, 0), null);
  assert.strictEqual(engine.normalizeEntry({ kind: null }, 0), null);
  assert.strictEqual(engine.normalizeEntry(null, 0), null);
});

test('restoreEngine: buildRestoreScript escapa apóstrofos do JSON embutido', () => {
  const entries = [
    engine.normalizeEntry({ kind: 'registry', path: "HKLM\\O'Brien", name: 'X', existed: true, kindType: 'String', value: "it's" }, 0),
  ].filter(Boolean);
  const script = engine.buildRestoreScript(entries);
  // O JSON vai dentro de string single-quoted do PowerShell: ' deve virar ''.
  assert.ok(script.includes("ConvertFrom-Json -InputObject '"));
  assert.ok(script.includes("it''s"), "apóstrofo deve ser duplicado para não fechar o literal");
  assert.ok(script.includes('Write-WillLagJson'));
});

test('restoreEngine: script gerado trata cada kind com try/catch individual', () => {
  const entries = [
    { kind: 'registry', path: 'HKLM\\A', name: 'X', existed: true, kindType: 'DWord', value: '1' },
    { kind: 'wlanAutoconfig', interfaceName: 'Wi-Fi', enabled: true },
    { kind: 'mtu', ifIndex: 12, mtu: 1500 },
    { kind: 'dns', ifIndex: 12, servers: ['8.8.8.8'], wasDhcp: false },
    { kind: 'netshGlobal', setting: 'ecncapability', value: 'disabled' },
    { kind: 'powercfgAcDc', scheme: 'SCHEME_CURRENT', subgroup: 'g', setting: 's', acValue: 1, dcValue: 1 },
  ];
  const script = engine.buildRestoreScript(entries);
  assert.ok(script.includes('foreach ($e in $entries)'));
  assert.ok(script.includes('catch'));
  for (const kind of ['registry', 'wlanAutoconfig', 'mtu', 'dns', 'netshGlobal', 'powercfgAcDc']) {
    assert.ok(script.includes(`'${kind}'`), `script deve tratar kind ${kind}`);
  }
});

test('restoreEngine: lista vazia retorna sucesso sem executar nada', async () => {
  const res = await engine.restoreEntries([]);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.code, 'NOTHING_TO_RESTORE');
});

test('restoreEngine: entradas todas inválidas não geram execução', async () => {
  const res = await engine.restoreEntries([{ kind: 'hacked' }, null, 'string']);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.code, 'NOTHING_TO_RESTORE');
  assert.strictEqual(res.skipped, 3);
});

test('restoreEngine: fora do Windows falha de forma estruturada', async () => {
  if (process.platform === 'win32') return;
  const res = await engine.restoreEntries([{ kind: 'netshGlobal', setting: 'rss', value: 'enabled' }]);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'UNSUPPORTED_PLATFORM');
});

test('restoreEngine: DNS com wasDhcp usa ResetServerAddresses (volta pro DHCP)', () => {
  const script = engine.buildRestoreScript([{ kind: 'dns', ifIndex: 12, servers: [], wasDhcp: true }]);
  assert.ok(script.includes('-ResetServerAddresses'));
});
