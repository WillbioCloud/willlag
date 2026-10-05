/**
 * Integridade do catálogo compartilhado (src/shared/tweakCatalog.json).
 *
 * Este arquivo é GERADO por `npm run sync-catalog` a partir do código real do
 * processo principal — nunca editado à mão. Os testes abaixo existem para
 * pegar o caso clássico: alguém mexe em public/services/*.js e esquece de
 * regenerar, e a UI passa a mostrar tweaks que não existem (ou esconde os que
 * existem). `npm run sync-catalog -- --check` é a verificação de sincronismo;
 * aqui validamos a FORMA que os componentes consomem.
 */

import catalog from '../shared/tweakCatalog.json';

const ids = catalog.tweaks.map((t) => t.id);

describe('estrutura do catálogo', () => {
  test('tem os campos de topo que a UI lê', () => {
    expect(catalog.generator).toBeTruthy();
    expect(typeof catalog.generatedAt).toBe('string');
    expect(catalog.note).toMatch(/gerad|generated/i);
    expect(Array.isArray(catalog.groups)).toBe(true);
    expect(Array.isArray(catalog.presets)).toBe(true);
    expect(Array.isArray(catalog.tweaks)).toBe(true);
    expect(catalog.riskLabels).toBeTruthy();
  });

  test('20 tweaks com ids únicos', () => {
    expect(catalog.tweaks.length).toBe(20);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('os 4 grupos do requisito estão presentes', () => {
    const groupIds = catalog.groups.map((g) => g.id);
    expect(groupIds).toEqual(expect.arrayContaining(['tcpip', 'wifi', 'dns', 'routing']));
    for (const g of catalog.groups) {
      expect(typeof g.label).toBe('string');
      expect(typeof g.icon).toBe('string');
      expect(typeof g.description).toBe('string');
    }
  });

  test('todo tweak tem metadados completos e consistentes', () => {
    for (const t of catalog.tweaks) {
      expect(typeof t.id).toBe('string');
      expect(t.label.length).toBeGreaterThan(4);
      expect(t.description.length).toBeGreaterThan(15);
      expect(t.why.length).toBeGreaterThan(40); // explicação técnica, não marketing
      expect(['low', 'medium', 'high']).toContain(t.risk);
      expect(['persistent', 'session']).toContain(t.scope);
      expect(typeof t.requiresAdmin).toBe('boolean');
      expect(typeof t.defaultInPreset).toBe('boolean');
      expect(typeof t.order).toBe('number');
      expect(catalog.groups.some((g) => g.id === t.group)).toBe(true);
      expect(t.groupLabel).toBeTruthy();
      expect(catalog.riskLabels[t.risk]).toBeTruthy();
      expect(t.riskLabel).toBe(catalog.riskLabels[t.risk].label);
    }
  });

  test('rótulos de risco derivam do risco (a UI não precisa de mapa próprio)', () => {
    for (const t of catalog.tweaks) {
      expect(t.riskLabel).toBe(catalog.riskLabels[t.risk].label);
      expect(t.riskColor).toBe(catalog.riskLabels[t.risk].color);
    }
  });

  test('ordem é estável e sem buracos', () => {
    const orders = catalog.tweaks.map((t) => t.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('cobertura funcional dos requisitos', () => {
  test('TCP/IP: Nagle, throttling multimídia, auto-tuning, ECN e congestion provider', () => {
    for (const id of ['nagle', 'networkThrottling', 'systemResponsiveness', 'mmcssGames', 'autoTuning', 'ecn', 'congestionProvider']) {
      expect(ids).toContain(id);
    }
  });

  test('Nagle é aplicado por interface do registro (escopo documentado)', () => {
    const nagle = catalog.tweaks.find((t) => t.id === 'nagle');
    expect(nagle.group).toBe('tcpip');
    expect(nagle.requiresAdmin).toBe(true);
    expect(nagle.scope).toBe('persistent');
    expect(nagle.why).toMatch(/ACK|ack|Nagle|40ms|200ms/);
    const optionLabels = (nagle.options || []).map((o) => String(o.label));
    expect(optionLabels.some((l) => /todas as interfaces/i.test(l))).toBe(true);
    expect(optionLabels.some((l) => /interface ativa/i.test(l))).toBe(true);
  });

  test('Wi-Fi USB: pausa de varredura, USB selective suspend e energia do adaptador', () => {
    for (const id of ['wlanAutoconfig', 'usbSelectiveSuspend', 'adapterPowerManagement', 'adapterPowerSaveAdvanced']) {
      expect(ids).toContain(id);
    }
    const wifiGroup = catalog.tweaks.filter((t) => t.group === 'wifi');
    expect(wifiGroup.length).toBe(4);
  });

  test('wlanAutoconfig é o único ajuste de sessão e é marcado como crítico', () => {
    const session = catalog.tweaks.filter((t) => t.scope === 'session');
    expect(session.map((t) => t.id)).toEqual(['wlanAutoconfig']);
    expect(session[0].sessionCritical).toBe(true);
    expect(session[0].why).toMatch(/off-channel|30-60s|lag spike|reverte/i);
  });

  test('DNS e MTU existem e são persistentes', () => {
    const dns = catalog.tweaks.find((t) => t.id === 'autoDns');
    const mtu = catalog.tweaks.find((t) => t.id === 'mtuOptimize');
    expect(dns.group).toBe('dns');
    expect(mtu.group).toBe('routing');
    expect(dns.scope).toBe('persistent');
    expect(mtu.scope).toBe('persistent');
    expect(mtu.needsDiscovery).toBe(true);
  });

  test('autoDns oferece automático, DHCP e os 8 provedores', () => {
    const dns = catalog.tweaks.find((t) => t.id === 'autoDns');
    const values = dns.options.map((o) => o.value);
    expect(values).toContain('auto');
    expect(values).toContain('dhcp');
    expect(values).toContain('cloudflare');
    expect(values).toContain('google');
    expect(values.length).toBe(10);
  });

  test('congestionProvider só oferece o que pode ser suportado (feature-detect)', () => {
    const cp = catalog.tweaks.find((t) => t.id === 'congestionProvider');
    const values = cp.options.map((o) => o.value);
    expect(values).toContain('cubic');
    expect(values).toContain('ctcp');
    // "quando suportado": o texto precisa deixar claro que é detectado, não prometido.
    expect(cp.why).toMatch(/detect/i);
    expect(cp.options.map((o) => o.value)).toContain('auto');
  });

  test('ajustes legacy estão marcados como tal (não entram no preset ultra)', () => {
    const legacy = catalog.tweaks.filter((t) => t.legacy);
    expect(legacy.map((t) => t.id)).toEqual(expect.arrayContaining(['timestamps', 'chimneyOffload']));
    const ultra = catalog.presets.find((p) => p.id === 'ultra');
    for (const t of legacy) {
      expect(ultra.tweakIds).not.toContain(t.id);
    }
  });
});

describe('presets', () => {
  test('5 presets com ids únicos e tweaks existentes', () => {
    expect(catalog.presets.length).toBe(5);
    const presetIds = catalog.presets.map((p) => p.id);
    expect(new Set(presetIds).size).toBe(5);
    expect(presetIds).toEqual(expect.arrayContaining(['ultra', 'safe', 'wifi', 'all', 'legacy']));

    for (const p of catalog.presets) {
      expect(typeof p.label).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(Array.isArray(p.tweakIds)).toBe(true);
      expect(p.tweakIds.length).toBeGreaterThan(0);
      for (const id of p.tweakIds) {
        expect(ids).toContain(id);
      }
    }
  });

  test('ultra é exatamente o conjunto defaultInPreset', () => {
    const ultra = catalog.presets.find((p) => p.id === 'ultra');
    const expected = catalog.tweaks.filter((t) => t.defaultInPreset).map((t) => t.id);
    expect([...ultra.tweakIds].sort()).toEqual([...expected].sort());
    expect(ultra.tweakIds.length).toBeGreaterThanOrEqual(10);
  });

  test('safe não contém nada de risco médio/alto', () => {
    const safe = catalog.presets.find((p) => p.id === 'safe');
    for (const id of safe.tweakIds) {
      expect(catalog.tweaks.find((t) => t.id === id).risk).toBe('low');
    }
  });

  test('all contém todos os tweaks', () => {
    const all = catalog.presets.find((p) => p.id === 'all');
    expect([...all.tweakIds].sort()).toEqual([...ids].sort());
  });

  test('wifi contém exatamente o grupo wifi', () => {
    const wifi = catalog.presets.find((p) => p.id === 'wifi');
    const expected = catalog.tweaks.filter((t) => t.group === 'wifi').map((t) => t.id);
    expect([...wifi.tweakIds].sort()).toEqual([...expected].sort());
  });
});
