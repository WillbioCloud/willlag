'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../public/services/stateStore');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'willlag-state-'));
  store.configure({ dir });
  return dir;
}

test('stateStore: cria estado vazio com schema versionado', () => {
  freshStore();
  const s = store.getState();
  assert.strictEqual(s.version, store.SCHEMA_VERSION);
  assert.deepStrictEqual(s.backups, {});
  assert.deepStrictEqual(s.applied, {});
  assert.ok(s.settings);
});

test('stateStore: pushBackup / peekBackup / consumeBackup', () => {
  freshStore();
  const entries = [{ kind: 'registry', path: 'HKLM\\A', name: 'X', existed: true, kindType: 'DWord', value: '10' }];

  store.pushBackup('networkThrottling', entries, { via: 'test' });
  assert.ok(store.hasBackup('networkThrottling'));

  const peeked = store.peekBackup('networkThrottling');
  assert.strictEqual(peeked.entries.length, 1);
  assert.strictEqual(peeked.entries[0].value, '10');
  assert.strictEqual(peeked.consumed, false);

  store.consumeBackup('networkThrottling');
  assert.strictEqual(store.peekBackup('networkThrottling'), null, 'camada consumida não pode ser reutilizada');
  assert.strictEqual(store.hasBackup('networkThrottling'), false);
  assert.strictEqual(store.lastBackup('networkThrottling').consumed, true, 'fica no histórico');
});

test('stateStore: aplicar duas vezes não perde o valor ORIGINAL', () => {
  freshStore();
  const original = [{ kind: 'registry', path: 'HKLM\\A', name: 'X', existed: true, kindType: 'DWord', value: '20' }];
  const intermediate = [{ kind: 'registry', path: 'HKLM\\A', name: 'X', existed: true, kindType: 'DWord', value: '10' }];

  store.pushBackup('t', original);
  const second = store.pushBackup('t', intermediate); // mesma assinatura -> camada original é mantida

  const layer = store.peekBackup('t');
  assert.strictEqual(layer.entries[0].value, '20', 'deve preservar o valor original, não o intermediário');
  assert.strictEqual(store.allBackups().t.length, 1, 'não deve empilhar uma camada duplicada');
  assert.strictEqual(second, layer, 'pushBackup devolve a camada vigente');
  assert.ok(second.recapturedAt, 'registra que houve nova captura');
});

test('stateStore: camadas diferentes empilham (DNS -> MTU)', () => {
  freshStore();
  store.pushBackup('t', [{ kind: 'registry', path: 'HKLM\\A', name: 'X', existed: false }]);
  store.pushBackup('t', [{ kind: 'dns', ifIndex: 12, servers: ['1.1.1.1'], wasDhcp: true }]);
  const all = store.allBackups().t;
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].entries[0].kind, 'dns', 'mais recente primeiro');
});

test('stateStore: limita o número de camadas de backup', () => {
  freshStore();
  for (let i = 0; i < 12; i++) {
    store.pushBackup('t', [{ kind: 'registry', path: `HKLM\\K${i}`, name: `V${i}`, existed: true, kindType: 'DWord', value: String(i) }]);
    store.consumeBackup('t');
  }
  assert.ok(store.allBackups().t.length <= 5);
});

test('stateStore: markApplied / isApplied / markReverted', () => {
  freshStore();
  assert.strictEqual(store.isApplied('nagle'), false);
  store.markApplied('nagle', { scope: 'persistent', by: 'user' });
  assert.strictEqual(store.isApplied('nagle'), true);
  assert.deepStrictEqual(store.appliedIds(), ['nagle']);
  store.markReverted('nagle');
  assert.strictEqual(store.isApplied('nagle'), false);
  assert.deepStrictEqual(store.appliedIds(), []);
});

test('stateStore: histórico registra apply e revert', () => {
  freshStore();
  store.markApplied('ecn', { by: 'gamemode' });
  store.markReverted('ecn', { by: 'gamemode' });
  const h = store.getHistory(10);
  assert.strictEqual(h.length, 2);
  assert.strictEqual(h[0].action, 'revert');
  assert.strictEqual(h[1].action, 'apply');
});

test('stateStore: persiste em disco e recarrega (saveNow + load)', () => {
  const dir = freshStore();
  store.pushBackup('nagle', [{ kind: 'registry', path: 'HKLM\\X', name: 'TCPNoDelay', existed: false }]);
  store.markApplied('nagle', { scope: 'persistent' });
  store.updateSettings({ dnsProvider: 'cloudflare' });
  store.saveNow();

  const file = path.join(dir, 'willlag-state.json');
  assert.ok(fs.existsSync(file));

  const reloaded = store.load();
  assert.strictEqual(reloaded.settings.dnsProvider, 'cloudflare');
  assert.ok(reloaded.backups.nagle);
  assert.ok(reloaded.applied.nagle);
});

test('stateStore: gravação é atômica (não deixa .tmp órfão)', () => {
  const dir = freshStore();
  store.markApplied('rss');
  store.saveNow();
  assert.ok(fs.existsSync(path.join(dir, 'willlag-state.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'willlag-state.json.tmp')));
});

test('stateStore: estado corrompido é substituído sem crash e preservado para auditoria', () => {
  const dir = freshStore();
  const file = path.join(dir, 'willlag-state.json');
  fs.writeFileSync(file, '{ json quebrado !!!', 'utf8');

  const s = store.load();
  assert.strictEqual(s.version, store.SCHEMA_VERSION);
  assert.deepStrictEqual(s.applied, {});
  assert.ok(
    fs.readdirSync(dir).some((f) => f.includes('.corrupt-')),
    'deve guardar uma cópia do arquivo corrompido'
  );
});

test('stateStore: migração de schema antigo preserva dados', () => {
  freshStore();
  const migrated = store.migrate
    ? store.migrate({ version: 1, backups: { nagle: [] }, applied: { ecn: { appliedAt: 1 } }, settings: { dnsProvider: 'google' } })
    : null;
  assert.ok(migrated);
  assert.strictEqual(migrated.version, store.SCHEMA_VERSION);
  assert.ok(migrated.backups.nagle);
  assert.ok(migrated.applied.ecn);
  assert.strictEqual(migrated.settings.dnsProvider, 'google');
  assert.strictEqual(migrated.settings.watchdogEnabled, true, 'defaults novos devem ser preenchidos');
});

test('stateStore: settings só aceita chaves conhecidas pelo merge', () => {
  freshStore();
  const before = store.getSettings();
  const after = store.updateSettings({ watchdogIntervalMs: 30000 });
  assert.strictEqual(after.watchdogIntervalMs, 30000);
  assert.strictEqual(after.autoRestoreOnQuit, before.autoRestoreOnQuit);
});

test('stateStore: benchmarks mantêm histórico limitado', () => {
  freshStore();
  for (let i = 0; i < 30; i++) store.pushBenchmark({ phase: 'test', i });
  assert.ok(store.getState().benchmarks.length <= 20);
});

test('stateStore: lock de sessão — escrita, leitura e limpeza', () => {
  const dir = freshStore();
  assert.strictEqual(store.readSessionLock(), null);
  store.writeSessionLock({ mode: 'ultra', tweakIds: ['nagle'] });
  const lock = store.readSessionLock();
  assert.strictEqual(lock.pid, process.pid);
  assert.strictEqual(lock.mode, 'ultra');
  assert.ok(fs.existsSync(path.join(dir, 'willlag-session.lock')));
  store.clearSessionLock();
  assert.strictEqual(store.readSessionLock(), null);
});

test('stateStore: lock do próprio processo vivo NÃO é tratado como crash', () => {
  freshStore();
  store.writeSessionLock({ mode: 'ultra' });
  assert.strictEqual(store.detectStaleSession(), null);
});

test('stateStore: lock de PID morto é detectado como encerramento anormal', () => {
  freshStore();
  fs.writeFileSync(store.lockPath(), JSON.stringify({ pid: 99999999, startedAt: Date.now(), mode: 'ultra' }), 'utf8');
  const stale = store.detectStaleSession();
  assert.ok(stale, 'deve detectar sessão órfã');
  assert.strictEqual(stale.reason, 'crash-or-forced-exit');
});

test('stateStore: lock muito antigo é tratado como stale mesmo com PID vivo', () => {
  freshStore();
  const old = Date.now() - 13 * 60 * 60 * 1000;
  fs.writeFileSync(store.lockPath(), JSON.stringify({ pid: process.pid, startedAt: old }), 'utf8');
  const stale = store.detectStaleSession();
  assert.ok(stale);
  assert.strictEqual(stale.reason, 'stale-timeout');
});

test('stateStore: export/import bundle ida e volta', () => {
  freshStore();
  store.pushBackup('nagle', [{ kind: 'registry', path: 'HKLM\\X', name: 'TCPNoDelay', existed: true, kindType: 'DWord', value: '1' }]);
  store.markApplied('nagle');
  store.saveNow();

  const bundle = store.exportBundle();
  assert.strictEqual(bundle.app, 'willLag');
  assert.ok(bundle.state.backups.nagle);

  const dir2 = freshStore();
  assert.strictEqual(store.isApplied('nagle'), false);
  const res = store.importBundle(bundle);
  assert.strictEqual(res.success, true);
  assert.strictEqual(store.isApplied('nagle'), true);
  assert.ok(fs.existsSync(path.join(dir2, 'willlag-state.json')));
});

test('stateStore: importBundle rejeita payload inválido', () => {
  freshStore();
  assert.strictEqual(store.importBundle(null).success, false);
  assert.strictEqual(store.importBundle({}).success, false);
  assert.strictEqual(store.importBundle({ state: 'não-objeto' }).success, false);
});

test('stateStore: flush cancela debounce pendente e grava', () => {
  const dir = freshStore();
  store.markApplied('rss');
  store.save(); // agendado (debounce)
  store.flush(); // força agora
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'willlag-state.json'), 'utf8'));
  assert.ok(raw.applied.rss);
});

/* ------------------------------------------------------------------ */
/* Assinatura de alvo (regra que protege o valor original)             */
/* ------------------------------------------------------------------ */

test('stateStore: mesmo alvo com valor diferente mantém a camada ORIGINAL', () => {
  freshStore();
  store.pushBackup('mtuOptimize', [{ kind: 'mtu', ifIndex: 12, mtu: 1500, family: 'IPv4' }]);
  store.pushBackup('mtuOptimize', [{ kind: 'mtu', ifIndex: 12, mtu: 1400, family: 'IPv4' }]);

  const layers = store.allBackups().mtuOptimize;
  assert.strictEqual(layers.length, 1, 'segunda captura do mesmo alvo não pode empilhar');
  assert.strictEqual(layers[0].entries[0].mtu, 1500, 'o valor original (1500) é o que deve ser restaurado');
});

test('stateStore: alvos realmente distintos empilham (MTU IPv4 e IPv6)', () => {
  freshStore();
  store.pushBackup('mtuOptimize', [{ kind: 'mtu', ifIndex: 12, mtu: 1500, family: 'IPv4' }]);
  store.pushBackup('mtuOptimize', [{ kind: 'mtu', ifIndex: 12, mtu: 1500, family: 'IPv6' }]);

  const layers = store.allBackups().mtuOptimize;
  assert.strictEqual(layers.length, 2);
  assert.deepStrictEqual(layers.map((l) => l.entries[0].family).sort(), ['IPv4', 'IPv6']);
});

test('stateStore: camadas empilhadas são consumidas como pilha (LIFO)', () => {
  freshStore();
  store.pushBackup('t', [{ kind: 'registry', path: 'HKLM\\A', name: 'X', existed: true, kindType: 'DWord', value: '1' }]);
  store.pushBackup('t', [{ kind: 'dns', ifIndex: 12, servers: ['1.1.1.1'], wasDhcp: false }]);

  assert.strictEqual(store.peekBackup('t').entries[0].kind, 'dns');
  assert.strictEqual(store.hasBackup('t'), true);

  store.consumeBackup('t');
  assert.strictEqual(store.peekBackup('t').entries[0].kind, 'registry', 'desfaz a camada mais recente primeiro');
  assert.strictEqual(store.hasBackup('t'), true);

  store.consumeBackup('t');
  assert.strictEqual(store.hasBackup('t'), false, 'nada pendente para restaurar');
  assert.strictEqual(store.peekBackup('t'), null, 'camadas consumidas não são mais alvo de revert');
  assert.strictEqual(store.lastBackup('t').entries[0].kind, 'dns', 'histórico preservado para auditoria');
  assert.strictEqual(store.consumeBackup('t'), null, 'consumir de novo não retorna nada');
});

test('stateStore: entryTargetKey ignora valores e diferencia alvos', () => {
  assert.strictEqual(
    store.entryTargetKey({ kind: 'registry', path: 'HKLM\\A', name: 'TCPNoDelay', value: '1' }),
    store.entryTargetKey({ kind: 'registry', path: 'HKLM\\A', name: 'TCPNoDelay', value: '0' })
  );
  assert.notStrictEqual(
    store.entryTargetKey({ kind: 'registry', path: 'HKLM\\A', name: 'TCPNoDelay' }),
    store.entryTargetKey({ kind: 'registry', path: 'HKLM\\A', name: 'TcpAckFrequency' })
  );
  assert.notStrictEqual(
    store.entryTargetKey({ kind: 'mtu', ifIndex: 12, family: 'IPv4' }),
    store.entryTargetKey({ kind: 'mtu', ifIndex: 12, family: 'IPv6' })
  );
  assert.strictEqual(
    store.entryTargetKey({ kind: 'wlanAutoconfig', interfaceName: 'Wi-Fi', enabled: true }),
    store.entryTargetKey({ kind: 'wlanAutoconfig', interfaceName: 'Wi-Fi', enabled: false })
  );
  assert.notStrictEqual(
    store.entryTargetKey({ kind: 'dns', ifIndex: 12 }),
    store.entryTargetKey({ kind: 'dns', ifIndex: 7 })
  );
});
