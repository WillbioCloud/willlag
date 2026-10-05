'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateStore = require('../public/services/stateStore');
stateStore.configure({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'willlag-reg-')) });

const registry = require('../public/services/tweakRegistry');

test('catálogo: validação de invariantes passa', () => {
  const v = registry.validate();
  assert.strictEqual(v.ok, true, v.problems.join('; '));
  assert.ok(v.count >= 18, `esperado um catálogo robusto, obtido ${v.count}`);
});

test('catálogo: ids únicos e metadados completos', () => {
  const ids = registry.ids();
  assert.strictEqual(new Set(ids).size, ids.length);

  for (const t of registry.ALL_TWEAKS) {
    assert.ok(t.label && t.label.length > 5, `${t.id}: label`);
    assert.ok(t.description && t.description.length > 10, `${t.id}: description`);
    assert.ok(t.why && t.why.length > 40, `${t.id}: why (explicação técnica) é obrigatória`);
    assert.ok(['low', 'medium', 'high'].includes(t.risk), `${t.id}: risk`);
    assert.ok(['persistent', 'session'].includes(t.scope), `${t.id}: scope`);
    assert.ok(registry.GROUPS[t.group], `${t.id}: group`);
  }
});

test('catálogo: cobre os 4 requisitos (TCP/IP, Wi-Fi/USB, DNS, MTU)', () => {
  const groups = new Set(registry.ALL_TWEAKS.map((t) => t.group));
  assert.ok(groups.has('tcpip'));
  assert.ok(groups.has('wifi'));
  assert.ok(groups.has('dns'));
  assert.ok(groups.has('routing'));
});

test('catálogo: Nagle, NetworkThrottlingIndex e SystemResponsiveness existem', () => {
  assert.ok(registry.byId('nagle'), 'Nagle (TcpAckFrequency/TCPNoDelay)');
  assert.ok(registry.byId('networkThrottling'), 'NetworkThrottlingIndex');
  assert.ok(registry.byId('systemResponsiveness'), 'SystemResponsiveness');
  assert.ok(registry.byId('autoTuning'), 'TCP Auto-Tuning');
  assert.ok(registry.byId('ecn'), 'ECN Capability');
  assert.ok(registry.byId('congestionProvider'), 'congestionprovider');
});

test('catálogo: mitigação Wi-Fi USB (autoconfig, selective suspend, energia do adaptador)', () => {
  assert.ok(registry.byId('wlanAutoconfig'), 'netsh wlan set autoconfig');
  assert.ok(registry.byId('usbSelectiveSuspend'), 'USB selective suspend');
  assert.ok(registry.byId('adapterPowerManagement'), '"computador pode desligar este dispositivo"');
  assert.ok(registry.byId('adapterPowerSaveAdvanced'), 'propriedades avançadas do driver');
});

test('catálogo: DNS com jitter e MTU', () => {
  assert.ok(registry.byId('autoDns'));
  assert.ok(registry.byId('mtuOptimize'));
});

test('wlanAutoconfig é o único tweak de sessão (reversão obrigatória ao sair)', () => {
  const session = registry.ALL_TWEAKS.filter((t) => t.scope === 'session');
  assert.strictEqual(session.length, 1);
  assert.strictEqual(session[0].id, 'wlanAutoconfig');
  assert.strictEqual(session[0].sessionCritical, true);
});

test('ordem de aplicação: persistentes antes, sessão por último', () => {
  const ordered = registry.sortForApply(registry.presetIds('ultra'));
  const firstSessionIdx = ordered.findIndex((id) => registry.byId(id).scope === 'session');
  const lastPersistentIdx = ordered.map((id) => registry.byId(id).scope).lastIndexOf('persistent');

  assert.ok(firstSessionIdx > lastPersistentIdx, 'tweak de sessão deve ser aplicado por último');
  assert.strictEqual(ordered[ordered.length - 1], 'wlanAutoconfig');
});

test('ordem de reversão: inversa da aplicação (sessão primeiro)', () => {
  const apply = registry.sortForApply(registry.presetIds('ultra'));
  const revert = registry.sortForRevert(registry.presetIds('ultra'));
  assert.deepStrictEqual(revert, [...apply].reverse());
  assert.strictEqual(revert[0], 'wlanAutoconfig', 'a pausa da varredura Wi-Fi é a primeira a ser desfeita');
});

test('presets: ultra inclui todos os defaultInPreset', () => {
  const presets = registry.getPresets();
  const expected = registry.ALL_TWEAKS.filter((t) => t.defaultInPreset).map((t) => t.id);
  assert.deepStrictEqual([...presets.ultra.tweakIds].sort(), [...expected].sort());
  assert.ok(presets.ultra.tweakIds.length >= 10);
});

test('presets: safe contém apenas risco baixo', () => {
  const presets = registry.getPresets();
  for (const id of presets.safe.tweakIds) {
    assert.strictEqual(registry.byId(id).risk, 'low', `${id} não deveria estar no preset conservador`);
  }
});

test('presets: legacy reproduz o comportamento da v1.0', () => {
  const presets = registry.getPresets();
  for (const id of ['autoTuning', 'timestamps', 'rss', 'ecn', 'congestionProvider', 'tcpFastOpen']) {
    assert.ok(presets.legacy.tweakIds.includes(id), `legacy deveria conter ${id}`);
  }
  assert.ok(presets.legacy.tweakIds.includes('chimneyOffload'), 'chimney existia na v1.0');
});

test('presets: wifi isola as mitigações de adaptador sem fio', () => {
  const presets = registry.getPresets();
  assert.deepStrictEqual(
    [...presets.wifi.tweakIds].sort(),
    registry.ALL_TWEAKS.filter((t) => t.group === 'wifi').map((t) => t.id).sort()
  );
});

test('presetIds: aceita nome de preset, array ou valor inválido', () => {
  assert.ok(registry.presetIds('ultra').length > 0);
  assert.deepStrictEqual(registry.presetIds(['nagle', 'ecn']), ['nagle', 'ecn']);
  assert.deepStrictEqual(registry.presetIds(['nagle', 'nao-existe']), ['nagle'], 'ids inválidos são descartados');
  assert.ok(registry.presetIds('preset-inexistente').length > 0, 'cai no ultra');
});

test('getCatalog: formato consumível pela UI', () => {
  const c = registry.getCatalog();
  assert.ok(Array.isArray(c.groups) && c.groups.length === 4);
  assert.ok(Array.isArray(c.tweaks) && c.tweaks.length === registry.ALL_TWEAKS.length);
  assert.ok(c.riskLabels.low && c.riskLabels.medium);

  const t = c.tweaks.find((x) => x.id === 'nagle');
  assert.strictEqual(t.groupLabel, 'Pilha TCP/IP e Registro');
  assert.strictEqual(typeof t.requiresAdmin, 'boolean');
  assert.strictEqual(t.appliedRecorded, false);
  assert.strictEqual(t.hasBackup, false);
});

test('getCatalog: expõe opções selecionáveis onde faz sentido', () => {
  const c = registry.getCatalog();
  const withOptions = c.tweaks.filter((t) => t.options && t.options.length);
  assert.ok(withOptions.some((t) => t.id === 'systemResponsiveness'));
  assert.ok(withOptions.some((t) => t.id === 'autoDns'));
  assert.ok(withOptions.some((t) => t.id === 'congestionProvider'));

  const sr = c.tweaks.find((t) => t.id === 'systemResponsiveness');
  assert.ok(sr.options.some((o) => String(o.value) === '0'));
  assert.ok(sr.options.some((o) => String(o.value) === '10'));
});

test('validate: detecta catálogo quebrado (teste do próprio validador)', () => {
  const broken = [
    { id: 'a', group: 'tcpip', label: 'ok label', description: 'd', risk: 'low', scope: 'persistent', requiresAdmin: true, detect() {}, apply() {}, revert() {} },
    { id: 'a', group: 'tcpip', label: 'ok label', description: 'd', risk: 'low', scope: 'persistent', requiresAdmin: true, detect() {}, apply() {}, revert() {} },
    { id: 'b', group: 'nao-existe', label: 'x', description: 'd', risk: 'extremo', scope: 'talvez', detect() {} },
  ];
  const v = registry.validate(broken);
  assert.strictEqual(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('duplicado')));
  assert.ok(v.problems.some((p) => p.includes('grupo inválido')));
  assert.ok(v.problems.some((p) => p.includes('risco inválido')));
  assert.ok(v.problems.some((p) => p.includes('apply() ausente')));
});

test('apply/revert de tweak desconhecido não lança', async () => {
  const a = await registry.apply('nao-existe');
  assert.strictEqual(a.success, false);
  assert.strictEqual(a.code, 'UNKNOWN_TWEAK');

  const r = await registry.revert('nao-existe');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.code, 'UNKNOWN_TWEAK');

  const d = await registry.detect('nao-existe');
  assert.strictEqual(d.ok, false);
});

test('apply fora do Windows devolve UNSUPPORTED_PLATFORM (nunca lança)', async () => {
  if (process.platform === 'win32') return;
  const res = await registry.apply('nagle');
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'UNSUPPORTED_PLATFORM');
});

test('detect fora do Windows devolve estado "não suportado" legível', async () => {
  if (process.platform === 'win32') return;
  const res = await registry.detect('nagle', { force: true });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.supported, false);
  assert.ok(res.error || res.reason);
});

test('detectAll retorna uma entrada por tweak, sem lançar em caso de erro', async () => {
  if (process.platform === 'win32') return;
  const all = await registry.detectAll({ force: true, concurrency: 4 });
  assert.strictEqual(Object.keys(all).length, registry.ids().length);
  for (const [id, d] of Object.entries(all)) {
    assert.strictEqual(d.id, id);
    assert.strictEqual(typeof d.applied, 'boolean');
    assert.strictEqual(d.exception, undefined, `${id} não deveria lançar`);
  }
});

test('mapWithConcurrency respeita o limite de concorrência', async () => {
  let running = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);

  await registry.mapWithConcurrency(items, 3, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
  });

  assert.ok(peak <= 3, `pico de concorrência foi ${peak}`);
});

test('mapWithConcurrency captura exceção de um item sem abortar os outros', async () => {
  const res = await registry.mapWithConcurrency([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('falha no 2');
    return n * 10;
  });
  assert.deepStrictEqual(res, [10, { ok: false, error: 'falha no 2', exception: true }, 30]);
});

test('revertAll sem nada aplicado informa claramente', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'willlag-reg2-'));
  stateStore.configure({ dir });
  registry.invalidateDetect();
  const res = await registry.revertAll();
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.code, 'NOTHING_TO_RESTORE');
});

test('toCatalogEntry reflete backup/aplicação registrados no estado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'willlag-reg3-'));
  stateStore.configure({ dir });

  let entry = registry.toCatalogEntry(registry.byId('nagle'));
  assert.strictEqual(entry.appliedRecorded, false);
  assert.strictEqual(entry.hasBackup, false);

  stateStore.pushBackup('nagle', [{ kind: 'registry', path: 'HKLM\\X', name: 'TCPNoDelay', existed: false }]);
  stateStore.markApplied('nagle', { scope: 'persistent' });

  entry = registry.toCatalogEntry(registry.byId('nagle'));
  assert.strictEqual(entry.appliedRecorded, true);
  assert.strictEqual(entry.hasBackup, true);
});

test('createContext fornece isAdmin/allowPrompt/snapshot por padrão', () => {
  const ctx = registry.createContext();
  assert.strictEqual(typeof ctx.isAdmin, 'function');
  assert.strictEqual(ctx.allowPrompt, true);
  assert.strictEqual(typeof ctx.features, 'function');
  assert.strictEqual(typeof ctx.snapshot, 'function');
  assert.deepStrictEqual(ctx.params, {});

  const custom = registry.createContext({ allowPrompt: false, params: { a: 1 } });
  assert.strictEqual(custom.allowPrompt, false);
  assert.deepStrictEqual(custom.params, { a: 1 });
});
