'use strict';

/**
 * Sondagem de latência e estatísticas (ping, jitter, perda, p95).
 *
 * Três métodos complementares — porque cada um falha de um jeito diferente:
 *
 *  1. TCP connect na porta 53 (`tcpProbe`)
 *     Não depende de ICMP (que muitos provedores/hostes despriorizam ou
 *     bloqueiam) e não exige privilégios. Mede o RTT real até o resolvedor.
 *
 *  2. DNS query UDP real (`dnsQueryProbe`, via c-ares do Node)
 *     Mede o que o jogo/launcher efetivamente sofre ao resolver nomes:
 *     latência de resolução + taxa de falha do servidor.
 *
 *  3. ICMP (`icmpProbe`, via ping do sistema)
 *     Útil para o gateway/roteador e para path MTU.
 *
 * As estatísticas incluem percentil 95 e jitter RFC3550, que são o que
 * realmente descreve "lag spike" — a média sozinha esconde o problema.
 */

const net = require('net');
const dns = require('dns');
const ps = require('./psRunner');
const logger = require('./logger');

const log = logger.scope('probe');

/* ------------------------------------------------------------------ */
/* Estatísticas (funções puras — testáveis)                            */
/* ------------------------------------------------------------------ */

/**
 * Calcula estatísticas a partir de amostras.
 * `samples`: array de números em ms; `null`/`undefined`/negativo = perda.
 */
function computeStats(samples, options = {}) {
  const all = Array.isArray(samples) ? samples : [];
  const total = all.length;
  const valid = all.filter((s) => typeof s === 'number' && Number.isFinite(s) && s >= 0);
  const lost = total - valid.length;

  if (valid.length === 0) {
    return {
      count: total,
      success: 0,
      lost,
      lossPercent: total > 0 ? 100 : 0,
      min: null,
      max: null,
      avg: null,
      median: null,
      p95: null,
      stddev: null,
      jitter: 0,
      jitterRfc3550: 0,
      spikeCount: 0,
      worstSpikeMs: 0,
      score: Infinity,
    };
  }

  const sorted = [...valid].sort((a, b) => a - b);
  const sum = valid.reduce((a, b) => a + b, 0);
  const avg = sum / valid.length;
  const variance = valid.reduce((a, b) => a + (b - avg) * (b - avg), 0) / valid.length;
  const stddev = Math.sqrt(variance);

  // Jitter como desvio absoluto médio entre amostras consecutivas (mesma
  // definição usada pelo NetworkMonitor existente, para manter coerência na UI).
  let deltaSum = 0;
  for (let i = 1; i < valid.length; i++) {
    deltaSum += Math.abs(valid[i] - valid[i - 1]);
  }
  const jitter = valid.length > 1 ? deltaSum / (valid.length - 1) : 0;

  // Jitter RFC 3550 (EWMA) — mais sensível a spikes isolados.
  let rfc = 0;
  for (let i = 1; i < valid.length; i++) {
    rfc = rfc + (Math.abs(valid[i] - valid[i - 1]) - rfc) / 16;
  }

  const spikeThreshold = options.spikeThresholdMs !== undefined
    ? options.spikeThresholdMs
    : Math.max(avg * 1.8, avg + 25);

  const spikes = valid.filter((v) => v >= spikeThreshold);

  return {
    count: total,
    success: valid.length,
    lost,
    lossPercent: total > 0 ? (lost / total) * 100 : 0,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    stddev,
    jitter,
    jitterRfc3550: rfc,
    spikeCount: spikes.length,
    spikePercent: (spikes.length / valid.length) * 100,
    worstSpikeMs: spikes.length ? Math.max(...spikes) - avg : 0,
    spikeThresholdMs: spikeThreshold,
    samples: valid,
    score: null,
  };
}

function percentile(sortedValues, pct) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (pct / 100) * (sortedValues.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedValues[low];
  return sortedValues[low] + (sortedValues[high] - sortedValues[low]) * (rank - low);
}

/**
 * Pontuação única para ranquear servidores/rotas. MENOR = MELHOR.
 *
 * Ponderação pensada para jogos competitivos:
 *   - média conta, mas o *tail* (p95) conta mais: um servidor com média 20ms
 *     e spikes de 200ms é pior que um estável de 30ms.
 *   - jitter pesa forte (causa rubber-banding / interpolação ruim).
 *   - perda é quase desqualificante (UDP de jogo não recupera pacote perdido).
 */
function scoreLatency(stats, weights = {}) {
  if (!stats || stats.success === 0) return Infinity;

  const w = {
    avg: weights.avg !== undefined ? weights.avg : 1.0,
    p95: weights.p95 !== undefined ? weights.p95 : 1.25,
    jitter: weights.jitter !== undefined ? weights.jitter : 2.0,
    loss: weights.loss !== undefined ? weights.loss : 40.0,
    stddev: weights.stddev !== undefined ? weights.stddev : 0.35,
  };

  const lossFraction = (stats.lossPercent || 0) / 100;

  return (
    w.avg * (stats.avg || 0) +
    w.p95 * (stats.p95 || stats.avg || 0) +
    w.jitter * (stats.jitter || 0) +
    w.stddev * (stats.stddev || 0) +
    w.loss * lossFraction * 100
  );
}

/** Classificação legível para a UI. */
function gradeLatency(stats) {
  if (!stats || stats.success === 0) return { grade: 'sem-dados', label: 'Sem resposta', color: 'muted' };
  const score = scoreLatency(stats);
  const loss = stats.lossPercent || 0;

  if (loss > 5) return { grade: 'critico', label: 'Crítico (perda de pacotes)', color: 'danger', score };
  if (score < 60) return { grade: 'excelente', label: 'Excelente', color: 'success', score };
  if (score < 110) return { grade: 'otimo', label: 'Ótimo', color: 'success', score };
  if (score < 200) return { grade: 'bom', label: 'Bom', color: 'info', score };
  if (score < 350) return { grade: 'regular', label: 'Regular', color: 'warning', score };
  return { grade: 'ruim', label: 'Ruim', color: 'danger', score };
}

/* ------------------------------------------------------------------ */
/* Probes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Mede o tempo de handshake TCP até host:port.
 * Retorna null em falha/timeout (contabilizado como perda).
 */
function tcpProbe(host, port = 53, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!ps.isSafeHost(host)) return resolve({ ms: null, error: 'INVALID_HOST' });

    const socket = new net.Socket();
    let done = false;
    const started = process.hrtime.bigint();

    const finish = (ms, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ms, error: error || null });
    };

    const timer = setTimeout(() => finish(null, 'TIMEOUT'), timeoutMs);

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(null, 'TIMEOUT'));
    socket.once('error', (err) => finish(null, err.code || 'ERROR'));
    socket.once('connect', () => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      finish(elapsed);
    });

    try {
      socket.connect(Number(port) || 53, String(host).trim());
    } catch (err) {
      finish(null, 'CONNECT_THROW');
    }
  });
}

/**
 * Mede a latência de uma consulta DNS real contra um servidor específico.
 * Usa uma instância própria de Resolver — nunca altera o DNS global do processo.
 */
function dnsQueryProbe(server, hostname = 'www.google.com', timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!ps.isSafeHost(server)) return resolve({ ms: null, error: 'INVALID_HOST' });

    let resolver;
    try {
      resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
      resolver.setServers([{ address: String(server).trim(), port: 53 }]);
    } catch (err) {
      return resolve({ ms: null, error: `SET_SERVERS: ${err.message}` });
    }

    const started = process.hrtime.bigint();
    const timer = setTimeout(() => resolve({ ms: null, error: 'TIMEOUT' }), timeoutMs + 500);

    resolver.resolve4(String(hostname), (err, addresses) => {
      clearTimeout(timer);
      if (err) {
        return resolve({ ms: null, error: err.code || err.message || 'DNS_ERROR' });
      }
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ ms: elapsed, addresses, error: null });
    });
  });
}

/** Extrai RTTs individuais da saída do `ping` do sistema. */
function parsePingRtts(output) {
  const text = String(output || '');
  const rtts = [];

  // Uma única passada cobre todos os idiomas, com \b para não casar "t" dentro
  // de palavras ("Zeit", "octets") e a alternativa curta por último para que
  // "tiempo"/"time" sejam consumidos inteiros (sem contagem dupla).
  //   en:    "Reply from 1.1.1.1: bytes=32 time=12ms TTL=58"
  //   pt-BR: "Resposta de 8.8.8.8: bytes=32 tempo=12ms TTL=58"
  //   de/es/fr: "Zeit=14ms", "tiempo=17ms", "délai=13ms"
  //   sub-milissegundo: "time<1ms" / "tempo<1ms" -> 0
  const re = /\b(?:time|tempo|zeit|tiempo|d[eé]lai|delay|t)\s*([=<])\s*(\d+(?:[.,]\d+)?)\s*ms/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(String(m[2]).replace(',', '.'));
    if (Number.isFinite(v)) rtts.push(m[1] === '<' ? 0 : v);
  }

  return rtts;
}

/** Extrai a média resumida (Average/Média/Moyenne/Durchschnitt). */
function parsePingAverage(output) {
  const text = String(output || '');
  const m = text.match(/(?:Average|Média|Media|Moyenne|Durchschnittszeit|Gemiddelde)\s*=\s*(\d+)\s*ms/i);
  if (m) return parseInt(m[1], 10);

  const m2 = text.match(/=\s*(\d+)\s*ms\s*$/m);
  return m2 ? parseInt(m2[1], 10) : null;
}

function parsePingLossPercent(output) {
  const text = String(output || '');
  const m = text.match(/\((\d+)%\s*(?:loss|perda|perte|verlust)\)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Ping ICMP com estatísticas completas.
 * `host` é validado antes de chegar ao binário (sem shell, sem injeção).
 */
async function icmpProbe(host, options = {}) {
  const count = options.count || 4;
  const res = await ps.runPing(host, {
    count,
    timeoutMs: options.timeoutMs || 2000,
    dontFragment: options.dontFragment,
    size: options.size,
  });

  if (res.code === 'INVALID_HOST') {
    return { ...computeStats([]), host, error: res.error, method: 'icmp', raw: '' };
  }

  let rtts = parsePingRtts(res.output);

  // Se o regex não pegou nada mas houve resposta, tenta a média do resumo.
  if (rtts.length === 0 && !res.needsFragmentation) {
    const avg = parsePingAverage(res.output);
    if (avg !== null) rtts = [avg];
  }

  // Contabiliza perdas: se ping enviou N e só temos M respostas, completa com null.
  const samples = [];
  for (let i = 0; i < count; i++) samples.push(i < rtts.length ? rtts[i] : null);

  const stats = computeStats(samples);
  const reportedLoss = parsePingLossPercent(res.output);

  return {
    ...stats,
    host,
    method: 'icmp',
    needsFragmentation: Boolean(res.needsFragmentation),
    reportedLossPercent: reportedLoss,
    error: rtts.length === 0 ? (res.needsFragmentation ? 'DF_FRAGMENTATION' : 'NO_REPLY') : null,
    raw: res.output,
  };
}

/**
 * Sonda combinada: usa TCP-53 como fonte primária de latência de rede
 * (mais confiável que ICMP para resolvedores públicos) e ICMP como fallback.
 */
async function probeHost(host, options = {}) {
  const rounds = options.rounds || 5;
  const port = options.port || 53;
  const method = options.method || 'auto';

  let samples = [];
  let used = method;

  if (method === 'tcp' || method === 'auto') {
    for (let i = 0; i < rounds; i++) {
      const r = await tcpProbe(host, port, options.timeoutMs || 2500);
      samples.push(r.ms);
      if (options.onSample) options.onSample(r.ms, i, 'tcp');
      if (options.delayMs) await ps.sleep(options.delayMs);
    }
    used = 'tcp';
  }

  const tcpSuccess = samples.filter((s) => s !== null).length;

  if ((method === 'icmp' || method === 'auto') && (method === 'icmp' || tcpSuccess === 0)) {
    const icmp = await icmpProbe(host, { count: rounds, timeoutMs: options.timeoutMs || 2000 });
    if (icmp.success > 0) {
      samples = icmp.samples || [];
      used = 'icmp';
    } else if (method === 'icmp') {
      samples = icmp.samples || samples;
      used = 'icmp';
    }
  }

  const stats = computeStats(samples);
  return { ...stats, host, method: used, score: scoreLatency(stats) };
}

module.exports = {
  computeStats,
  percentile,
  scoreLatency,
  gradeLatency,
  tcpProbe,
  dnsQueryProbe,
  icmpProbe,
  probeHost,
  parsePingRtts,
  parsePingAverage,
  parsePingLossPercent,
};
