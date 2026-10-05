/**
 * Helpers compartilhados de rede/latência para o renderer.
 *
 * (Este arquivo existia vazio no repositório; agora centraliza a lógica de
 * formatação e classificação que antes estava duplicada em Dashboard,
 * NetworkMonitor e DNSChanger — garantindo que "30ms = verde" signifique a
 * mesma coisa em todas as telas.)
 */

/** Formata milissegundos de forma estável (null/NaN -> "—"). */
export function formatMs(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return digits > 0 ? `${n.toFixed(digits)}ms` : `${Math.round(n)}ms`;
}

export function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

export function formatPercent(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(digits)}%`;
}

/** Cor por latência absoluta (mesma escala usada desde a v1.0). */
export function latencyColor(ms) {
  if (ms === null || ms === undefined || ms < 0) return 'var(--text-muted)';
  if (ms <= 30) return 'var(--success)';
  if (ms <= 60) return '#00d68f';
  if (ms <= 100) return 'var(--warning)';
  return 'var(--danger)';
}

export function latencyLabel(ms) {
  if (ms === null || ms === undefined || ms < 0) return 'Sem resposta';
  if (ms <= 20) return 'Excelente';
  if (ms <= 50) return 'Bom';
  if (ms <= 100) return 'Regular';
  return 'Ruim';
}

/** Jitter é o que causa rubber-banding; escala mais apertada que a de latência. */
export function jitterColor(ms) {
  if (ms === null || ms === undefined) return 'var(--text-muted)';
  if (ms <= 3) return 'var(--success)';
  if (ms <= 8) return '#00d68f';
  if (ms <= 20) return 'var(--warning)';
  return 'var(--danger)';
}

export function jitterLabel(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms <= 3) return 'Estável';
  if (ms <= 8) return 'Aceitável';
  if (ms <= 20) return 'Instável';
  return 'Crítico';
}

export function lossColor(pct) {
  if (pct === null || pct === undefined) return 'var(--text-muted)';
  if (pct <= 0) return 'var(--success)';
  if (pct <= 1) return '#00d68f';
  if (pct <= 5) return 'var(--warning)';
  return 'var(--danger)';
}

/**
 * Estatísticas de uma série de pings (mesma definição do main process, para que
 * números calculados na UI batam com os do backend).
 */
export function computeStats(samples) {
  const all = Array.isArray(samples) ? samples : [];
  const valid = all.filter((s) => typeof s === 'number' && Number.isFinite(s) && s >= 0);
  const total = all.length;
  const lost = total - valid.length;

  if (valid.length === 0) {
    return { count: total, success: 0, lost, lossPercent: total ? 100 : 0, min: null, max: null, avg: null, jitter: 0, p95: null, spikeCount: 0 };
  }

  const sorted = [...valid].sort((a, b) => a - b);
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;

  let delta = 0;
  for (let i = 1; i < valid.length; i++) delta += Math.abs(valid[i] - valid[i - 1]);

  const spikeThreshold = Math.max(avg * 1.8, avg + 25);

  return {
    count: total,
    success: valid.length,
    lost,
    lossPercent: total ? (lost / total) * 100 : 0,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    jitter: valid.length > 1 ? delta / (valid.length - 1) : 0,
    spikeCount: valid.filter((v) => v >= spikeThreshold).length,
    spikeThreshold,
  };
}

/** Formata um delta com sinal e cor (negativo = melhora para latência/jitter). */
export function formatDelta(delta, unit = 'ms', lowerIsBetter = true) {
  if (delta === null || delta === undefined || Number.isNaN(Number(delta))) {
    return { text: '—', tone: 'neutral' };
  }
  const n = Number(delta);
  const rounded = Math.round(n * 10) / 10;
  const improved = lowerIsBetter ? rounded < 0 : rounded > 0;
  const worsened = lowerIsBetter ? rounded > 0 : rounded < 0;

  if (Math.abs(rounded) < 0.05) return { text: `0${unit}`, tone: 'neutral' };

  return {
    text: `${rounded > 0 ? '+' : ''}${rounded}${unit}`,
    tone: improved ? 'good' : worsened ? 'bad' : 'neutral',
  };
}

/** Chip de status de um tweak, derivado do estado detectado + registrado. */
export function tweakStatus(state, appliedRecorded) {
  if (!state) {
    return { key: 'unknown', label: 'Verificando…', tone: 'neutral' };
  }
  if (state.exception || state.error) {
    return { key: 'error', label: 'Erro na leitura', tone: 'danger' };
  }
  if (state.supported === false) {
    return { key: 'unsupported', label: 'Não suportado', tone: 'muted' };
  }
  if (state.applied) {
    return { key: 'applied', label: 'Ativo', tone: 'success' };
  }
  if (appliedRecorded || state.hasBackup) {
    return { key: 'partial', label: 'Aplicado (não confirmado)', tone: 'warning' };
  }
  return { key: 'idle', label: 'Padrão do Windows', tone: 'neutral' };
}

export const RISK_TONE = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

export const SCOPE_LABEL = {
  persistent: 'Persistente',
  session: 'Só durante o modo',
};

/** Barreira de largura do gráfico normalizada (0..100). */
export function barWidth(value, max = 200) {
  if (value === null || value === undefined || value < 0) return 100;
  return Math.max(2, Math.min(100, (value / max) * 100));
}

/** Formata data/hora curta para históricos. */
export function formatTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch (err) {
    return '—';
  }
}

export function formatDateTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch (err) {
    return '—';
  }
}

/** Lista estática de provedores DNS (fallback se o backend não responder). */
export const DNS_PROVIDERS_FALLBACK = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    primary: '1.1.1.1',
    secondary: '1.0.0.1',
    icon: '🟠',
    description: 'Menor latência global na maioria das medições; foco em privacidade.',
    tags: ['velocidade', 'privacidade'],
  },
  {
    id: 'cloudflare-malware',
    name: 'Cloudflare (anti-malware)',
    primary: '1.1.1.2',
    secondary: '1.0.0.2',
    icon: '🎮',
    description: 'Mesma rede do 1.1.1.1 com bloqueio de domínios maliciosos.',
    tags: ['velocidade', 'segurança'],
  },
  {
    id: 'cloudflare-family',
    name: 'Cloudflare (família)',
    primary: '1.1.1.3',
    secondary: '1.0.0.3',
    icon: '👨\u200d👩\u200d👧',
    description: 'Bloqueia malware e conteúdo adulto.',
    tags: ['segurança'],
  },
  {
    id: 'google',
    name: 'Google Public DNS',
    primary: '8.8.8.8',
    secondary: '8.8.4.4',
    icon: '🔵',
    description: 'Infraestrutura enorme e muito estável; excelente anycast no Brasil.',
    tags: ['estabilidade'],
  },
  {
    id: 'quad9',
    name: 'Quad9',
    primary: '9.9.9.9',
    secondary: '149.112.112.112',
    icon: '🟣',
    description: 'Bloqueio de domínios maliciosos, operado por fundação suíça.',
    tags: ['segurança'],
  },
  {
    id: 'opendns',
    name: 'OpenDNS (Cisco)',
    primary: '208.67.222.222',
    secondary: '208.67.220.220',
    icon: '🟢',
    description: 'Anycast maduro, bom para filtragem.',
    tags: ['segurança'],
  },
  {
    id: 'adguard',
    name: 'AdGuard DNS',
    primary: '94.140.14.14',
    secondary: '94.140.15.15',
    icon: '🛡️',
    description: 'Bloqueia anúncios e rastreadores em nível de DNS.',
    tags: ['privacidade', 'ads'],
  },
  {
    id: 'level3',
    name: 'Level3 / CenturyLink',
    primary: '4.2.2.2',
    secondary: '4.2.2.1',
    icon: '⚪',
    description: 'Resolvedor antigo e muito disseminado; bom em algumas rotas BR.',
    tags: ['alternativo'],
  },
];

/** Presets de host para o monitor (mantidos da v1.0 + servidores de jogo). */
export const MONITOR_PRESETS = [
  { label: 'Cloudflare', value: '1.1.1.1' },
  { label: 'Google DNS', value: '8.8.8.8' },
  { label: 'Riot Games', value: '104.160.131.3' },
  { label: 'Valve/Steam', value: '155.133.248.34' },
];

export default {
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
};
