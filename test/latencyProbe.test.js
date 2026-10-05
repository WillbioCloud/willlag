'use strict';

const test = require('node:test');
const assert = require('node:assert');

const probe = require('../public/services/latencyProbe');

test('computeStats: métricas básicas de uma série estável', () => {
  const s = probe.computeStats([10, 12, 11, 13, 10]);
  assert.strictEqual(s.count, 5);
  assert.strictEqual(s.success, 5);
  assert.strictEqual(s.lost, 0);
  assert.strictEqual(s.lossPercent, 0);
  assert.strictEqual(s.min, 10);
  assert.strictEqual(s.max, 13);
  assert.ok(Math.abs(s.avg - 11.2) < 1e-9);
  assert.strictEqual(s.jitter, 2); // |12-10|+|11-12|+|13-11|+|10-13| = 2+1+2+3 = 8 / 4 deltas
  assert.ok(s.stddev > 0);
  assert.strictEqual(s.spikeCount, 0);
});

test('computeStats: amostras nulas contam como perda', () => {
  const s = probe.computeStats([10, null, 12, undefined, -1]);
  assert.strictEqual(s.count, 5);
  assert.strictEqual(s.success, 2);
  assert.strictEqual(s.lost, 3);
  assert.strictEqual(s.lossPercent, 60);
  assert.strictEqual(s.min, 10);
});

test('computeStats: série totalmente perdida não divide por zero', () => {
  const s = probe.computeStats([null, null]);
  assert.strictEqual(s.lossPercent, 100);
  assert.strictEqual(s.avg, null);
  assert.strictEqual(s.jitter, 0);
  assert.strictEqual(s.score, Infinity);
});

test('computeStats: série vazia', () => {
  const s = probe.computeStats([]);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.lossPercent, 0);
  assert.strictEqual(s.avg, null);
});

test('computeStats: detecta spike quando há pico isolado', () => {
  const s = probe.computeStats([20, 21, 19, 20, 240, 20]);
  assert.strictEqual(s.spikeCount, 1);
  assert.ok(s.worstSpikeMs > 150);
  assert.ok(s.jitter > 50, 'jitter deve explodir com spike');
});

test('percentile: p95 interpola corretamente', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.ok(Math.abs(probe.percentile(sorted, 50) - 5.5) < 1e-9);
  assert.ok(Math.abs(probe.percentile(sorted, 95) - 9.55) < 1e-9);
  assert.strictEqual(probe.percentile([42], 95), 42);
  assert.strictEqual(probe.percentile([], 95), null);
});

test('scoreLatency: jitter e perda pesam mais que a média', () => {
  const estavel = probe.computeStats([30, 31, 30, 29, 30]);
  const instavel = probe.computeStats([20, 20, 20, 20, 120]);

  const sEstavel = probe.scoreLatency(estavel);
  const sInstavel = probe.scoreLatency(instavel);

  assert.ok(
    sInstavel > sEstavel,
    `servidor com spike (score ${sInstavel}) deve pontuar pior que o estável (${sEstavel})`
  );

  const comPerda = probe.computeStats([15, null, 15, null]);
  assert.ok(probe.scoreLatency(comPerda) > probe.scoreLatency(probe.computeStats([15, 16, 15, 16])));
});

test('scoreLatency: menor latência com mesmo jitter vence', () => {
  const rapido = probe.computeStats([10, 11, 10, 11]);
  const lento = probe.computeStats([60, 61, 60, 61]);
  assert.ok(probe.scoreLatency(rapido) < probe.scoreLatency(lento));
});

test('gradeLatency: classifica por score e perda', () => {
  assert.strictEqual(probe.gradeLatency(probe.computeStats([10, 11, 10])).grade, 'excelente');
  assert.strictEqual(probe.gradeLatency(probe.computeStats([400, 420, 410])).grade, 'ruim');
  assert.strictEqual(probe.gradeLatency(probe.computeStats([null, null])).grade, 'sem-dados');

  // Perda alta desclassifica mesmo com latência baixa.
  const comPerdaAlta = probe.computeStats([8, null, null, 8]);
  assert.strictEqual(probe.gradeLatency(comPerdaAlta).grade, 'critico');
});

test('parsePingRtts: inglês', () => {
  const out = [
    'Reply from 1.1.1.1: bytes=32 time=12ms TTL=58',
    'Reply from 1.1.1.1: bytes=32 time=11ms TTL=58',
    'Reply from 1.1.1.1: bytes=32 time<1ms TTL=58',
  ].join('\n');
  const rtts = probe.parsePingRtts(out);
  assert.deepStrictEqual(rtts, [12, 11, 0]);
});

test('parsePingRtts: português (Brasil)', () => {
  const out = [
    'Resposta de 8.8.8.8: bytes=32 tempo=23ms TTL=115',
    'Resposta de 8.8.8.8: bytes=32 tempo=21ms TTL=115',
    'Esgotado o tempo limite da solicitação.',
  ].join('\n');
  assert.deepStrictEqual(probe.parsePingRtts(out), [23, 21]);
});

test('parsePingRtts: alemão e espanhol', () => {
  assert.deepStrictEqual(probe.parsePingRtts('Antwort von 1.1.1.1: Bytes=32 Zeit=14ms TTL=58'), [14]);
  assert.deepStrictEqual(probe.parsePingRtts('Respuesta desde 1.1.1.1: bytes=32 tiempo=17ms TTL=58'), [17]);
});

test('parsePingAverage: resumo em vários idiomas', () => {
  assert.strictEqual(probe.parsePingAverage('    Minimum = 10ms, Maximum = 20ms, Average = 14ms'), 14);
  assert.strictEqual(probe.parsePingAverage('    Mínimo = 10ms, Máximo = 20ms, Média = 15ms'), 15);
  assert.strictEqual(probe.parsePingAverage('nada aqui'), null);
});

test('parsePingLossPercent: extrai perda relatada', () => {
  assert.strictEqual(probe.parsePingLossPercent('Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),'), 25);
  assert.strictEqual(probe.parsePingLossPercent('Pacotes: Enviados = 4, Recebidos = 2, Perdidos = 2 (50% perda),'), 50);
  assert.strictEqual(probe.parsePingLossPercent('sem perda aqui'), null);
});

test('jitterRfc3550: EWMA reage a spike isolado', () => {
  const limpo = probe.computeStats([20, 20, 20, 20, 20, 20]);
  const spike = probe.computeStats([20, 20, 20, 200, 20, 20]);
  assert.strictEqual(limpo.jitterRfc3550, 0);
  assert.ok(spike.jitterRfc3550 > 1);
});
