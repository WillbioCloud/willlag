/**
 * Helpers compartilhados de rede/latência.
 *
 * O ponto destes testes é garantir que "30ms = verde" signifique a MESMA coisa
 * em Dashboard, NetworkMonitor, DNSChanger e LowLatencyMode — a v1.0 tinha
 * escalas de cor duplicadas e divergentes.
 */

import {
  formatMs,
  formatNumber,
  formatPercent,
  latencyColor,
  latencyLabel,
  jitterColor,
  jitterLabel,
  lossColor,
  computeStats,
  formatDelta,
  tweakStatus,
  barWidth,
  formatTime,
  formatDateTime,
  RISK_TONE,
  SCOPE_LABEL,
  DNS_PROVIDERS_FALLBACK,
  MONITOR_PRESETS,
} from '../components/utils/networkOptimizer';

import catalog from '../shared/tweakCatalog.json';

describe('formatMs', () => {
  test('valores ausentes viram travessão (nunca "NaNms")', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(undefined)).toBe('—');
    expect(formatMs(NaN)).toBe('—');
    expect(formatMs('abc')).toBe('—');
  });

  test('arredonda por padrão e respeita casas decimais', () => {
    expect(formatMs(12.4)).toBe('12ms');
    expect(formatMs(12.6)).toBe('13ms');
    expect(formatMs(12.34, 1)).toBe('12.3ms');
    expect(formatMs(0)).toBe('0ms');
    expect(formatMs('42', 0)).toBe('42ms');
  });
});

describe('formatNumber / formatPercent', () => {
  test('percentual sempre com símbolo', () => {
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(12.345)).toBe('12.3%');
    expect(formatPercent(null)).toBe('—');
  });

  test('número com casas configuráveis', () => {
    expect(formatNumber(1.2345, 2)).toBe('1.23');
    expect(formatNumber(undefined)).toBe('—');
  });
});

describe('escalas de cor (latência, jitter e perda)', () => {
  test('latência: verde até 30ms, âmbar até 100ms, vermelho acima', () => {
    expect(latencyColor(10)).toBe('var(--success)');
    expect(latencyColor(30)).toBe('var(--success)');
    expect(latencyColor(45)).toBe('#00d68f');
    expect(latencyColor(80)).toBe('var(--warning)');
    expect(latencyColor(150)).toBe('var(--danger)');
    expect(latencyColor(null)).toBe('var(--text-muted)');
    expect(latencyColor(-1)).toBe('var(--text-muted)');
  });

  test('latência: rótulos legíveis para o usuário', () => {
    expect(latencyLabel(15)).toBe('Excelente');
    expect(latencyLabel(40)).toBe('Bom');
    expect(latencyLabel(90)).toBe('Regular');
    expect(latencyLabel(200)).toBe('Ruim');
    expect(latencyLabel(null)).toBe('Sem resposta');
  });

  test('jitter usa escala mais apertada que a latência', () => {
    expect(jitterLabel(1)).toBe('Estável');
    expect(jitterLabel(5)).toBe('Aceitável');
    expect(jitterLabel(15)).toBe('Instável');
    expect(jitterLabel(40)).toBe('Crítico');
    expect(jitterColor(2)).toBe('var(--success)');
    expect(jitterColor(50)).toBe('var(--danger)');
    expect(jitterColor(null)).toBe('var(--text-muted)');
  });

  test('perda: qualquer valor alto é vermelho (jogo online não tolera loss)', () => {
    expect(lossColor(0)).toBe('var(--success)');
    expect(lossColor(0.5)).toBe('#00d68f');
    expect(lossColor(3)).toBe('var(--warning)');
    expect(lossColor(12)).toBe('var(--danger)');
    expect(lossColor(null)).toBe('var(--text-muted)');
  });
});

describe('computeStats (mesma definição do main process)', () => {
  test('série estável', () => {
    const s = computeStats([10, 12, 11, 13, 10]);
    expect(s.count).toBe(5);
    expect(s.success).toBe(5);
    expect(s.lost).toBe(0);
    expect(s.lossPercent).toBe(0);
    expect(s.min).toBe(10);
    expect(s.max).toBe(13);
    expect(s.avg).toBeCloseTo(11.2);
    expect(s.jitter).toBe(2); // (2+1+2+3)/4
    expect(s.spikeCount).toBe(0);
  });

  test('amostras nulas contam como perda', () => {
    const s = computeStats([10, null, 12, undefined, -1]);
    expect(s.count).toBe(5);
    expect(s.success).toBe(2);
    expect(s.lost).toBe(3);
    expect(s.lossPercent).toBe(60);
  });

  test('série totalmente perdida não divide por zero', () => {
    const s = computeStats([null, null]);
    expect(s.lossPercent).toBe(100);
    expect(s.avg).toBeNull();
    expect(s.jitter).toBe(0);
    expect(s.min).toBeNull();
  });

  test('lista vazia / não-array', () => {
    expect(computeStats([]).lossPercent).toBe(0);
    expect(computeStats(null).count).toBe(0);
  });

  test('detecta spike isolado (o sintoma de lag spike que o usuário relata)', () => {
    const s = computeStats([20, 21, 20, 19, 240, 20]);
    expect(s.spikeCount).toBe(1);
    expect(s.max).toBe(240);
  });

  test('p95 e mediana não estouram o índice', () => {
    const s = computeStats([5]);
    expect(s.p95).toBe(5);
    expect(s.median).toBe(5);
  });
});

describe('formatDelta', () => {
  test('negativo é melhora quando menor é melhor', () => {
    expect(formatDelta(-8.4)).toEqual({ text: '-8.4ms', tone: 'good' });
    expect(formatDelta(8.4)).toEqual({ text: '+8.4ms', tone: 'bad' });
  });

  test('inversão para métricas "maior é melhor"', () => {
    expect(formatDelta(5, ' Mbps', false).tone).toBe('good');
    expect(formatDelta(-5, ' Mbps', false).tone).toBe('bad');
  });

  test('delta nulo / desprezível', () => {
    expect(formatDelta(null)).toEqual({ text: '—', tone: 'neutral' });
    expect(formatDelta(0.001).tone).toBe('neutral');
  });
});

describe('tweakStatus (chip de estado na lista de tweaks)', () => {
  test('sem estado ainda -> "Verificando…"', () => {
    expect(tweakStatus(null, false)).toEqual({ key: 'unknown', label: 'Verificando…', tone: 'neutral' });
  });

  test('erro de leitura fica vermelho (não pode parecer "ok")', () => {
    expect(tweakStatus({ error: 'acesso negado' }, false).key).toBe('error');
    expect(tweakStatus({ exception: true }, false).key).toBe('error');
  });

  test('não suportado é neutro/apagado', () => {
    expect(tweakStatus({ supported: false }, false)).toEqual({ key: 'unsupported', label: 'Não suportado', tone: 'muted' });
  });

  test('aplicado e confirmado pelo sistema', () => {
    expect(tweakStatus({ supported: true, applied: true }, true)).toEqual({ key: 'applied', label: 'Ativo', tone: 'success' });
  });

  test('aplicado no estado mas não confirmado -> aviso amarelo', () => {
    const s = tweakStatus({ supported: true, applied: false }, true);
    expect(s.key).toBe('partial');
    expect(s.tone).toBe('warning');
  });

  test('padrão do Windows', () => {
    expect(tweakStatus({ supported: true, applied: false }, false).key).toBe('idle');
  });
});

describe('mapas de rótulo e risco', () => {
  test('RISK_TONE cobre os três níveis usados no catálogo', () => {
    expect(RISK_TONE.low).toBe('success');
    expect(RISK_TONE.medium).toBe('warning');
    expect(RISK_TONE.high).toBe('danger');
    for (const t of catalog.tweaks) {
      expect(RISK_TONE[t.risk]).toBeDefined();
    }
  });

  test('SCOPE_LABEL diferencia persistente de sessão (o usuário precisa saber)', () => {
    expect(SCOPE_LABEL.persistent).toBe('Persistente');
    expect(SCOPE_LABEL.session).toBe('Só durante o modo');
  });
});

describe('barWidth', () => {
  test('normaliza e limita entre 2% e 100%', () => {
    expect(barWidth(100, 200)).toBe(50);
    expect(barWidth(0, 200)).toBe(2);
    expect(barWidth(9999, 200)).toBe(100);
    expect(barWidth(null)).toBe(100);
    expect(barWidth(-5)).toBe(100);
  });
});

describe('formatTime / formatDateTime', () => {
  test('timestamp inválido não quebra a lista de histórico', () => {
    expect(formatTime(null)).toBe('—');
    expect(formatTime(0)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(typeof formatTime(Date.now())).toBe('string');
    expect(typeof formatDateTime(Date.now())).toBe('string');
  });
});

describe('dados estáticos compartilhados com o backend', () => {
  test('DNS_PROVIDERS_FALLBACK tem a mesma forma do resultado de dns-benchmark', () => {
    expect(DNS_PROVIDERS_FALLBACK.length).toBeGreaterThanOrEqual(4);
    for (const p of DNS_PROVIDERS_FALLBACK) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(p.primary).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(p.secondary).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(typeof p.icon).toBe('string');
      expect(typeof p.description).toBe('string');
    }
  });

  test('os dois provedores exigidos no requisito estão no fallback', () => {
    const ids = DNS_PROVIDERS_FALLBACK.map((p) => p.id);
    expect(ids).toContain('cloudflare');
    expect(ids).toContain('google');
    expect(DNS_PROVIDERS_FALLBACK.find((p) => p.id === 'cloudflare').primary).toBe('1.1.1.1');
    expect(DNS_PROVIDERS_FALLBACK.find((p) => p.id === 'google').primary).toBe('8.8.8.8');
  });

  test('fallback cobre todos os provedores oferecidos pelo tweak autoDns', () => {
    const autoDns = catalog.tweaks.find((t) => t.id === 'autoDns');
    expect(autoDns).toBeDefined();

    const fallbackIds = new Set(DNS_PROVIDERS_FALLBACK.map((p) => p.id));
    const especiais = new Set(['auto', 'dhcp']);
    const providers = (autoDns.options || []).map((o) => o.value).filter((v) => !especiais.has(v));

    expect(providers.length).toBeGreaterThanOrEqual(5);
    for (const id of providers) {
      expect(fallbackIds.has(id)).toBe(true);
    }
    // O inverso também: nada de provedor na UI que o backend não conheça.
    for (const id of fallbackIds) {
      expect(providers).toContain(id);
    }
  });

  test('MONITOR_PRESETS usa hosts válidos (nada de string que quebre o ping)', () => {
    expect(MONITOR_PRESETS.length).toBeGreaterThanOrEqual(3);
    for (const preset of MONITOR_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(2);
      expect(preset.value).toMatch(/^[A-Za-z0-9._:-]+$/);
      expect(/[;&|`$\s]/.test(preset.value)).toBe(false);
    }
  });
});
