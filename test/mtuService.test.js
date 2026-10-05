'use strict';

const test = require('node:test');
const assert = require('node:assert');

const mtu = require('../public/services/mtuService');

/** Simula um caminho com MTU fixo: payload <= mtuPath-28 passa. */
function fakePath(pathMtu, options = {}) {
  const maxPayload = pathMtu - mtu.IP_ICMP_OVERHEAD;
  const calls = [];
  return {
    calls,
    probe: async (payload) => {
      calls.push(payload);
      let ok = payload <= maxPayload;
      if (options.flaky && ok && Math.random() < options.flaky) ok = false;
      return { success: ok, reason: ok ? 'OK' : 'FRAGMENTATION_NEEDED', payload };
    },
  };
}

test('MTU: Ethernet padrão 1500 é detectado no primeiro teste', async () => {
  const path = fakePath(1500);
  const r = await mtu.searchMaxPayload(path.probe);
  assert.strictEqual(r.mtu, 1500);
  assert.strictEqual(r.payload, 1472);
  assert.strictEqual(r.steps, 1, 'deve acertar de primeira sem busca binária');
  assert.strictEqual(r.conclusive, true);
});

test('MTU: PPPoE 1492 é descoberto por busca binária', async () => {
  const path = fakePath(1492);
  const r = await mtu.searchMaxPayload(path.probe);
  assert.strictEqual(r.mtu, 1492);
  assert.strictEqual(r.payload, 1464);
  assert.ok(r.steps <= 12, `busca deve convergir rápido (steps=${r.steps})`);
});

test('MTU: túnel de VPN 1400', async () => {
  const path = fakePath(1400);
  const r = await mtu.searchMaxPayload(path.probe);
  assert.strictEqual(r.mtu, 1400);
});

test('MTU: valores incomuns (1454 / 1360 / 576)', async () => {
  for (const target of [1454, 1360, 576]) {
    const path = fakePath(target);
    const r = await mtu.searchMaxPayload(path.probe);
    assert.strictEqual(r.mtu, target, `esperado ${target}, obtido ${r.mtu}`);
  }
});

test('MTU: alvo inalcançável (ICMP bloqueado) retorna inconclusivo', async () => {
  const probe = async (payload) => ({ success: false, reason: 'NO_REPLY', payload });
  const r = await mtu.searchMaxPayload(probe);
  assert.strictEqual(r.mtu, null);
  assert.strictEqual(r.conclusive, false);
  assert.strictEqual(r.error, 'MIN_FAILED');
  assert.ok(r.message.includes('ICMP'));
});

test('MTU: probe que lança exceção não derruba a busca', async () => {
  let n = 0;
  const probe = async (payload) => {
    n += 1;
    if (n === 2) throw new Error('boom');
    return { success: payload <= 1400, payload };
  };
  const r = await mtu.searchMaxPayload(probe);
  assert.ok(r.mtu === null || r.mtu > 0);
  assert.ok(r.trace.length >= 2);
});

test('MTU: detecção de ruído quando a monotonicidade é violada', () => {
  const clean = [
    { payload: 1472, ok: false },
    { payload: 548, ok: true },
    { payload: 1010, ok: true },
    { payload: 1241, ok: true },
    { payload: 1356, ok: true },
  ];
  // Busca binária legítima convergindo (1241 falha -> tenta menor): NÃO é ruído.
  const converging = [
    { payload: 1472, ok: false },
    { payload: 548, ok: true },
    { payload: 1010, ok: true },
    { payload: 1241, ok: false },
    { payload: 1125, ok: true },
  ];
  // Ruído real: um payload MENOR falha depois de um MAIOR ter passado.
  const noisy = [
    { payload: 1472, ok: false },
    { payload: 548, ok: true },
    { payload: 1010, ok: true },
    { payload: 1241, ok: false },
    { payload: 1125, ok: true },
    { payload: 1183, ok: false },
    { payload: 1154, ok: true },
    { payload: 900, ok: false },
  ];
  assert.strictEqual(mtu.hasMonotonicityViolation(clean), false);
  assert.strictEqual(mtu.hasMonotonicityViolation(converging), false, 'convergência normal não é ruído');
  assert.strictEqual(mtu.hasMonotonicityViolation(noisy), true);
});

test('MTU: onStep reporta cada tentativa (progresso na UI)', async () => {
  const path = fakePath(1492);
  const steps = [];
  await mtu.searchMaxPayload(path.probe, { onStep: (s) => steps.push(s) });
  assert.ok(steps.length >= 2);
  assert.ok(steps.every((s) => typeof s.payload === 'number' && typeof s.ok === 'boolean'));
});

test('MTU: limites de payload respeitam RFC 791 e Ethernet', () => {
  assert.strictEqual(mtu.MIN_PAYLOAD + mtu.IP_ICMP_OVERHEAD, 576);
  assert.strictEqual(mtu.MAX_PAYLOAD + mtu.IP_ICMP_OVERHEAD, 1500);
});

test('MTU: isValidMtu aceita faixa segura e rejeita absurdos', () => {
  assert.ok(mtu.isValidMtu(1500));
  assert.ok(mtu.isValidMtu(1492));
  assert.ok(mtu.isValidMtu(576));
  assert.ok(!mtu.isValidMtu(575));
  assert.ok(!mtu.isValidMtu(9001));
  assert.ok(!mtu.isValidMtu('abc'));
  assert.ok(!mtu.isValidMtu(1500.5));
  assert.ok(!mtu.isValidMtu(null));
});

test('MTU: overhead IP+ICMP = 28 (20 IP + 8 ICMP)', () => {
  assert.strictEqual(mtu.IP_ICMP_OVERHEAD, 28);
});

test('MTU: apply fora do Windows falha de forma estruturada', async () => {
  if (process.platform === 'win32') return;
  const res = await mtu.applyMtu(1500, { isAdmin: async () => true });
  assert.strictEqual(res.success, false);
  assert.ok(res.code === 'NO_INTERFACE' || res.code === 'UNSUPPORTED_PLATFORM');
});

test('MTU: apply rejeita valor inválido antes de tocar no sistema', async () => {
  const res = await mtu.applyMtu(99999, { isAdmin: async () => true });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'INVALID_MTU');
});
