'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateStore = require('../public/services/stateStore');
stateStore.configure({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'willlag-dns-')) });

const dns = require('../public/services/dnsService');
const probe = require('../public/services/latencyProbe');
const registry = require('../public/services/tweakRegistry');

const byId = (id) => dns.PROVIDERS.find((p) => p.id === id);

/* ================================================================== */
/* Provedores                                                          */
/* ================================================================== */

test('PROVIDERS: inclui os dois exigidos no requisito (Cloudflare 1.1.1.1 e Google 8.8.8.8)', () => {
  assert.strictEqual(byId('cloudflare').primary, '1.1.1.1');
  assert.strictEqual(byId('cloudflare').secondary, '1.0.0.1');
  assert.strictEqual(byId('google').primary, '8.8.8.8');
  assert.strictEqual(byId('google').secondary, '8.8.4.4');
});

test('PROVIDERS: todos têm id único, nome, IPs válidos e descrição', () => {
  const ids = new Set();
  for (const p of dns.PROVIDERS) {
    assert.ok(!ids.has(p.id), `id duplicado: ${p.id}`);
    ids.add(p.id);
    assert.ok(p.name && p.name.length > 2, `${p.id}: nome`);
    assert.ok(/^\d{1,3}(\.\d{1,3}){3}$/.test(p.primary), `${p.id}: primary ${p.primary}`);
    assert.ok(/^\d{1,3}(\.\d{1,3}){3}$/.test(p.secondary), `${p.id}: secondary ${p.secondary}`);
    assert.ok(p.description && p.description.length > 20, `${p.id}: descrição`);
    assert.ok(p.primary !== p.secondary, `${p.id}: primary e secondary iguais`);
  }
  assert.ok(dns.PROVIDERS.length >= 6);
});

test('TEST_HOSTNAMES: domínios relevantes para jogos (não só google.com)', () => {
  assert.ok(dns.TEST_HOSTNAMES.length >= 3);
  assert.ok(dns.TEST_HOSTNAMES.some((h) => /steampowered/.test(h)), 'CDN da Steam importa para patch/matchmaking');
  for (const h of dns.TEST_HOSTNAMES) assert.ok(/^[a-z0-9.-]+$/i.test(h), `hostname inválido: ${h}`);
});

test('findProviderByServers: identifica o provedor em uso a partir dos IPs', () => {
  assert.strictEqual(dns.findProviderByServers(['1.1.1.1', '1.0.0.1']).id, 'cloudflare');
  assert.strictEqual(dns.findProviderByServers(['8.8.8.8']).id, 'google');
  assert.strictEqual(dns.findProviderByServers(['9.9.9.9', '149.112.112.112']).id, 'quad9');
  assert.strictEqual(dns.findProviderByServers(['192.168.0.1']), null, 'DNS do roteador não é um provedor conhecido');
  assert.strictEqual(dns.findProviderByServers([]), null);
  assert.strictEqual(dns.findProviderByServers(null), null);
});

test('arraysEqual: compara como string (IPs podem vir como número/objeto do PowerShell)', () => {
  assert.strictEqual(dns.arraysEqual(['1.1.1.1', '1.0.0.1'], ['1.1.1.1', '1.0.0.1']), true);
  assert.strictEqual(dns.arraysEqual(['1.1.1.1'], ['1.0.0.1']), false);
  assert.strictEqual(dns.arraysEqual(['1.1.1.1'], ['1.1.1.1', '1.0.0.1']), false);
  assert.strictEqual(dns.arraysEqual(null, ['1.1.1.1']), false);
  assert.strictEqual(dns.arraysEqual([], []), true);
});

/* ================================================================== */
/* mergeStats — ponderação das 3 camadas de medição                    */
/* ================================================================== */

const tcp = probe.computeStats([20, 22, 18, 21]); // rede até o resolvedor
const res = probe.computeStats([40, 55, 38, 42]); // resolução real
const icmp = probe.computeStats([10, 12, 11, 10]); // ping comum

test('mergeStats: média ponderada 0.35 rede / 0.55 resolução / 0.10 ICMP', () => {
  const m = dns.mergeStats(tcp, res, icmp);
  const esperado = (tcp.avg * 0.35 + res.avg * 0.55 + icmp.avg * 0.1) / (0.35 + 0.55 + 0.1);
  assert.ok(Math.abs(m.avg - esperado) < 1e-9, `avg ${m.avg} != esperado ${esperado}`);
  assert.strictEqual(m.method, 'tcp+dns+icmp');
  assert.strictEqual(m.count, tcp.count + res.count + icmp.count);
  assert.strictEqual(m.success, m.count);
  assert.strictEqual(m.lossPercent, 0);
  assert.strictEqual(m.min, 10, 'menor valor entre todas as camadas');
  assert.strictEqual(m.max, 55, 'maior valor entre todas as camadas');
});

test('mergeStats: pesos configuráveis (a UI pode priorizar resolução)', () => {
  const m = dns.mergeStats(tcp, res, null, { weightNetwork: 0, weightResolution: 1 });
  assert.ok(Math.abs(m.avg - res.avg) < 1e-9);
  assert.strictEqual(m.method, 'tcp+dns');
});

test('mergeStats: camada ausente é renormalizada (não vira zero)', () => {
  const semIcmp = dns.mergeStats(tcp, res, null);
  const esperado = (tcp.avg * 0.35 + res.avg * 0.55) / 0.9;
  assert.ok(Math.abs(semIcmp.avg - esperado) < 1e-9);
});

test('mergeStats: camada totalmente perdida puxa a taxa de perda combinada', () => {
  const falha = probe.computeStats([null, null, null]);
  const m = dns.mergeStats(falha, res, null);
  assert.strictEqual(m.lost, 3);
  assert.ok(m.lossPercent > 0 && m.lossPercent < 100);
  assert.ok(Math.abs(m.avg - res.avg) < 1e-9, 'a média ignora a camada sem amostras válidas');
});

test('mergeStats: sem nenhuma camada utilizável não divide por zero', () => {
  const m = dns.mergeStats();
  assert.strictEqual(m.count, 0);
  assert.strictEqual(m.avg, null);
  assert.strictEqual(m.jitter, null);
  assert.strictEqual(m.min, null);
  assert.strictEqual(m.max, null);
  assert.strictEqual(m.lossPercent, 100);
  assert.strictEqual(m.method, '');
});

test('mergeStats: jitter e p95 também são ponderados', () => {
  const m = dns.mergeStats(tcp, res, icmp);
  const esperadoJitter = (tcp.jitter * 0.35 + res.jitter * 0.55 + icmp.jitter * 0.1) / 1.0;
  assert.ok(Math.abs(m.jitter - esperadoJitter) < 1e-9);
  assert.ok(m.p95 >= m.avg - 1e-9, 'p95 não pode ser menor que a média');
});

test('scoreLatency: perda de pacote desclassifica um resolvedor "rápido"', () => {
  const rapido = probe.computeStats([15, 16, 15, 16]);
  const instavel = probe.computeStats([15, 16, 15, null]); // 25% de perda
  assert.ok(probe.scoreLatency(instavel) > probe.scoreLatency(rapido));
});

/* ================================================================== */
/* Benchmark (pipeline completo)                                       */
/* ================================================================== */

test('benchmark: pipeline produz ranking, score e recomendação mesmo sem rede', async () => {
  const progresso = [];
  const out = await dns.benchmark({
    providers: ['cloudflare'],
    rounds: 1,
    timeoutMs: 250,
    hostnames: ['localhost'],
    onProgress: (p) => progresso.push(p),
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.results.length, 1);

  const r = out.results[0];
  assert.strictEqual(r.id, 'cloudflare');
  assert.strictEqual(r.primary, '1.1.1.1');
  assert.strictEqual(r.rank, 1);
  assert.ok(r.combined && typeof r.combined === 'object');
  assert.ok(r.network && r.resolution, 'as duas camadas obrigatórias aparecem no resultado');
  assert.strictEqual(typeof r.reachable, 'boolean');
  assert.ok(r.grade, 'grade para exibir na UI');
  assert.ok(Array.isArray(r.dnsErrors));

  assert.ok(progresso.some((p) => p.phase === 'start'));
  assert.ok(progresso.some((p) => p.phase === 'tcp'));
  assert.ok(progresso.some((p) => p.phase === 'dns'));
  assert.strictEqual(typeof out.recommendation, 'string');
  assert.ok(out.recommendation.length > 10);
  assert.ok(Array.isArray(out.current));
});

test('benchmark: ordena por score e coloca inacessíveis por último', async () => {
  const out = await dns.benchmark({
    providers: ['cloudflare', 'google', 'level3'],
    rounds: 1,
    timeoutMs: 200,
    hostnames: ['localhost'],
  });

  assert.strictEqual(out.results.length, 3);
  const ranks = out.results.map((r) => r.rank);
  assert.deepStrictEqual(ranks, [1, 2, 3], 'rank deve ser sequencial após a ordenação');

  const scores = out.results.map((r) => (r.score === null ? Infinity : r.score));
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] <= scores[i], 'resultados precisam estar em ordem crescente de score');
  }
});

test('benchmark: provedor desconhecido por id é ignorado (não quebra a tela)', async () => {
  const out = await dns.benchmark({
    providers: ['cloudflare', 'provedor-que-nao-existe'],
    rounds: 1,
    timeoutMs: 200,
    hostnames: ['localhost'],
  });
  assert.strictEqual(out.results.length, 1);
});

test('benchmark: aceita IP no lugar do id do provedor', async () => {
  const out = await dns.benchmark({ providers: ['9.9.9.9'], rounds: 1, timeoutMs: 200, hostnames: ['localhost'] });
  assert.strictEqual(out.results.length, 1);
  assert.strictEqual(out.results[0].id, 'quad9');
});

/* ================================================================== */
/* Aplicar / restaurar / cache                                         */
/* ================================================================== */

test('applyDns: valida os IPs antes de tocar no sistema', async () => {
  const ctx = registry.createContext({ allowPrompt: false });
  for (const bad of [[], ['1.1.1.1; calc'], ['$(whoami)'], ['999.999.999.999'], [''], null]) {
    const r = await dns.applyDns(bad, ctx);
    assert.strictEqual(r.success, false, `deveria rejeitar ${JSON.stringify(bad)}`);
    assert.strictEqual(r.code, 'INVALID_DNS');
  }
});

test('applyDns: aceita IPv4 e IPv6, limita a 4 servidores', async () => {
  if (process.platform === 'win32') return;
  const ctx = registry.createContext({ allowPrompt: false });
  // Sem Windows não há interface ativa: o ponto é que a validação passou
  // (código NO_INTERFACE, e não INVALID_DNS).
  const r = await dns.applyDns(['1.1.1.1', '1.0.0.1', '2606:4700:4700::1111', '8.8.8.8', '9.9.9.9'], ctx);
  assert.strictEqual(r.code, 'NO_INTERFACE');
});

test('applyDns: funciona sem ctx (chamada defensiva a partir do IPC)', async () => {
  if (process.platform === 'win32') return;
  const r = await dns.applyDns(['1.1.1.1']);
  assert.strictEqual(r.success, false);
  assert.ok(['NO_INTERFACE', 'UNSUPPORTED_PLATFORM'].includes(r.code));
});

test('restoreDns: sem backup informa NO_BACKUP (não falha)', async () => {
  stateStore.configure({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'willlag-dns2-')) });
  const r = await dns.restoreDns(registry.createContext({ allowPrompt: false }));
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.code, 'NO_BACKUP');
  assert.strictEqual(r.applied, false);
});

test('restoreDns: falha na restauração NÃO consome o backup', async () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'willlag-dns3-'));
  stateStore.configure({ dir });

  stateStore.pushBackup('dns', [
    { kind: 'dns', ifIndex: 12, alias: 'Ethernet', servers: ['192.168.0.1'], wasDhcp: false },
  ]);

  // allowPrompt:false + sem admin => ELEVATION_REQUIRED (fora do Windows, UNSUPPORTED_PLATFORM).
  const r = await dns.restoreDns(registry.createContext({ allowPrompt: false }));
  assert.strictEqual(r.success, false);
  assert.ok(
    ['ELEVATION_REQUIRED', 'UNSUPPORTED_PLATFORM'].includes(r.code),
    `código inesperado: ${r.code}`
  );

  const layer = stateStore.peekBackup('dns');
  assert.ok(layer, 'o backup precisa sobreviver a uma restauração falha');
  assert.strictEqual(layer.consumed, false);
  assert.deepStrictEqual(layer.entries[0].servers, ['192.168.0.1'], 'o DNS original continua recuperável');
});

test('flushCache / readCache fora do Windows: resposta estruturada', async () => {
  if (process.platform === 'win32') return;
  const flush = await dns.flushCache();
  assert.strictEqual(flush.success, false);
  assert.strictEqual(flush.code, 'UNSUPPORTED_PLATFORM');

  const cache = await dns.readCache();
  assert.strictEqual(cache.ok, false);
  assert.deepStrictEqual(cache.entries, []);
});

test('getCurrentDns fora do Windows devolve lista vazia', async () => {
  if (process.platform === 'win32') return;
  assert.deepStrictEqual(await dns.getCurrentDns(), []);
  assert.deepStrictEqual(await dns.getCurrentDns(12), []);
});

test('dns.tweaks: o ajuste autoDns existe e é persistente', () => {
  const ids = dns.tweaks.map((t) => t.id);
  assert.ok(ids.includes('autoDns'));
  const t = registry.byId('autoDns');
  assert.strictEqual(t.group, 'dns');
  assert.strictEqual(t.scope, 'persistent');
  assert.strictEqual(t.requiresAdmin, true);
  assert.ok(Array.isArray(t.options) && t.options.length >= 3, 'UI precisa de opções: automático / provedores / DHCP');
});
