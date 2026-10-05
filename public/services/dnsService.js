'use strict';

/**
 * DNS: benchmark real (latência + jitter + perda), aplicação e reversão.
 *
 * Honestidade técnica que a UI comunica ao usuário:
 *   DNS NÃO reduz o ping dentro da partida (o jogo conecta por IP depois do
 *   matchmaking). O ganho é em: login, matchmaking, download de patch,
 *   anti-cheat e qualquer resolução durante o jogo — e principalmente em
 *   *evitar timeouts* de resolução, que aparecem como travada de 2-5s.
 *
 * Medição em três camadas, porque cada uma falha de um jeito:
 *   1. TCP/53 handshake  -> latência de rede até o resolvedor (ICMP costuma ser
 *                           despriorizado/bloqueado em 1.1.1.1 e 8.8.8.8).
 *   2. Consulta DNS real -> o que o sistema de fato sofre (c-ares/UDP).
 *   3. ICMP ping          -> comparabilidade com ferramentas externas.
 */

const ps = require('./psRunner');
const netif = require('./netInterfaces');
const probe = require('./latencyProbe');
const stateStore = require('./stateStore');
const logger = require('./logger');

const log = logger.scope('dns');

const PROVIDERS = [
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
    icon: '👨‍👩‍👧',
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

/** Domínios usados na medição de resolução (CDNs e serviços comuns em jogos). */
const TEST_HOSTNAMES = [
  'www.google.com',
  'store.steampowered.com',
  'cloudflare.com',
  'www.roblox.com',
];

const DEFAULT_OPTIONS = {
  rounds: 4,
  timeoutMs: 2000,
  methods: ['tcp', 'dns'],
  hostnames: TEST_HOSTNAMES,
  includeIcmp: false,
};

/* ------------------------------------------------------------------ */
/* Leitura do estado atual                                             */
/* ------------------------------------------------------------------ */

async function getCurrentDns(ifIndex) {
  const snap = await netif.getSnapshot({ force: true });
  if (ifIndex) {
    const entry = snap.dns.find((d) => d.ifIndex === Number(ifIndex));
    return entry ? entry.servers : [];
  }
  if (snap.activeAdapter) {
    const entry = snap.dns.find((d) => d.ifIndex === snap.activeAdapter.ifIndex);
    return entry ? entry.servers : [];
  }
  return [];
}

/** Identifica de onde vêm os DNS atuais (DHCP do roteador vs. manual). */
async function getDnsSource(ifIndex) {
  const snap = await netif.getSnapshot();
  const ipi = snap.ipInterfaces.find((i) => i.ifIndex === Number(ifIndex));
  const dhcp = ipi ? String(ipi.dhcp || '').toLowerCase() : '';
  return dhcp === 'enabled' || dhcp === 'true' ? 'dhcp' : 'static';
}

function findProviderByServers(servers) {
  const set = new Set((servers || []).map((s) => String(s).trim()));
  return PROVIDERS.find((p) => set.has(p.primary) || set.has(p.secondary)) || null;
}

/* ------------------------------------------------------------------ */
/* Benchmark                                                           */
/* ------------------------------------------------------------------ */

/**
 * Executa o benchmark completo.
 * `options.onProgress({ providerId, phase, index, total })` permite mostrar
 * progresso na UI sem travar a tela.
 */
async function benchmark(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Sanidade dos parâmetros: o renderer manda o que o usuário clicou, e um
  // `rounds` alto viraria milhares de probes (UI travada por minutos).
  opts.rounds = Math.max(1, Math.min(10, parseInt(opts.rounds, 10) || DEFAULT_OPTIONS.rounds));
  opts.timeoutMs = Math.max(100, Math.min(5000, parseInt(opts.timeoutMs, 10) || DEFAULT_OPTIONS.timeoutMs));
  opts.methods = Array.isArray(opts.methods) && opts.methods.length ? opts.methods : DEFAULT_OPTIONS.methods;
  const hostnames = Array.isArray(opts.hostnames) && opts.hostnames.length
    ? opts.hostnames.filter((h) => ps.isSafeHost(h)).slice(0, 8)
    : TEST_HOSTNAMES;
  if (hostnames.length === 0) hostnames.push(...TEST_HOSTNAMES);
  opts.hostnames = hostnames;

  const providers = (opts.providers && opts.providers.length ? opts.providers : PROVIDERS).map((p) =>
    typeof p === 'string' ? PROVIDERS.find((x) => x.id === p || x.primary === p) : p
  ).filter(Boolean);

  const results = [];
  const total = providers.length;
  let index = 0;

  for (const provider of providers) {
    index += 1;
    if (opts.onProgress) opts.onProgress({ providerId: provider.id, phase: 'start', index, total });

    // --- 1) Latência de rede via TCP/53 ---
    const tcpSamples = [];
    for (let i = 0; i < opts.rounds; i++) {
      const r = await probe.tcpProbe(provider.primary, 53, opts.timeoutMs);
      tcpSamples.push(r.ms);
      if (opts.onProgress) opts.onProgress({ providerId: provider.id, phase: 'tcp', index, total, round: i + 1 });
      await ps.sleep(40);
    }
    const tcpStats = probe.computeStats(tcpSamples);

    // --- 2) Latência de resolução real ---
    const dnsSamples = [];
    const dnsErrors = [];
    for (const hostname of hostnames) {
      const r = await probe.dnsQueryProbe(provider.primary, hostname, opts.timeoutMs);
      dnsSamples.push(r.ms);
      if (r.error) dnsErrors.push(r.error);
      if (opts.onProgress) opts.onProgress({ providerId: provider.id, phase: 'dns', index, total, hostname });
      await ps.sleep(40);
    }
    const dnsStats = probe.computeStats(dnsSamples);

    // --- 3) ICMP (opcional; comparabilidade com ping/tracert) ---
    let icmpStats = null;
    if (opts.includeIcmp || opts.methods.includes('icmp')) {
      icmpStats = await probe.icmpProbe(provider.primary, { count: Math.min(4, opts.rounds), timeoutMs: opts.timeoutMs });
    }

    const stats = mergeStats(tcpStats, dnsStats, icmpStats, opts);
    const score = probe.scoreLatency(stats);
    const grade = probe.gradeLatency(stats);

    results.push({
      id: provider.id,
      name: provider.name,
      icon: provider.icon,
      description: provider.description,
      tags: provider.tags,
      primary: provider.primary,
      secondary: provider.secondary,
      network: round1(tcpStats),
      resolution: round1(dnsStats),
      icmp: icmpStats ? round1(icmpStats) : null,
      combined: round1(stats),
      score: Number.isFinite(score) ? Math.round(score * 10) / 10 : null,
      grade: grade.grade,
      gradeLabel: grade.label,
      gradeColor: grade.color,
      dnsErrors: [...new Set(dnsErrors)].slice(0, 5),
      reachable: tcpStats.success > 0 || dnsStats.success > 0,
    });
  }

  // Rank: menor score primeiro; inacessíveis por último.
  results.sort((a, b) => {
    const sa = a.score === null ? Infinity : a.score;
    const sb = b.score === null ? Infinity : b.score;
    return sa - sb;
  });

  results.forEach((r, i) => {
    r.rank = i + 1;
  });

  const best = results.find((r) => r.reachable && r.score !== null) || null;
  const current = await getCurrentDns();
  const currentProvider = findProviderByServers(current);

  return {
    ok: true,
    testedAt: Date.now(),
    rounds: opts.rounds,
    hostnames,
    results,
    best,
    current,
    currentProvider: currentProvider ? { id: currentProvider.id, name: currentProvider.name } : null,
    recommendation: best
      ? `${best.name} (${best.primary}) — score ${best.score} | rede ${fmt(best.combined.avg)}ms | jitter ${fmt(best.combined.jitter)}ms | perda ${fmt(best.combined.lossPercent)}%`
      : 'Nenhum resolvedor respondeu. Verifique se a rede bloqueia DNS externo (porta 53).',
  };
}

function fmt(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v * 10) / 10;
}

function round1(stats) {
  if (!stats) return null;
  const out = {};
  for (const [k, v] of Object.entries(stats)) {
    if (k === 'samples') {
      out.samples = v.map((s) => (s === null ? null : Math.round(s * 10) / 10));
    } else if (typeof v === 'number') {
      out[k] = Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Combina as camadas em um único conjunto de estatísticas.
 * A resolução DNS é o que o sistema realmente paga, então ela entra com peso
 * maior; a rede (TCP/53) dá o piso físico; ICMP entra apenas se disponível.
 */
function mergeStats(tcpStats, dnsStats, icmpStats, opts = {}) {
  const wTcp = opts.weightNetwork !== undefined ? opts.weightNetwork : 0.35;
  const wDns = opts.weightResolution !== undefined ? opts.weightResolution : 0.55;
  const wIcmp = opts.weightIcmp !== undefined ? opts.weightIcmp : 0.1;

  const parts = [
    { s: tcpStats, w: wTcp },
    { s: dnsStats, w: wDns },
    { s: icmpStats, w: wIcmp },
  ].filter((p) => p.s && p.s.count > 0);

  const totalW = parts.reduce((a, p) => a + p.w, 0) || 1;

  const wavg = (field) => {
    let sum = 0;
    let wsum = 0;
    for (const { s, w } of parts) {
      const v = s[field];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v * w;
        wsum += w;
      }
    }
    return wsum > 0 ? sum / wsum : null;
  };

  const totalSamples = parts.reduce((a, p) => a + p.s.count, 0);
  const totalSuccess = parts.reduce((a, p) => a + p.s.success, 0);

  const merged = {
    count: totalSamples,
    success: totalSuccess,
    lost: totalSamples - totalSuccess,
    lossPercent: totalSamples ? ((totalSamples - totalSuccess) / totalSamples) * 100 : 100,
    min: Math.min(...parts.map((p) => p.s.min).filter((v) => v !== null)),
    max: Math.max(...parts.map((p) => p.s.max).filter((v) => v !== null)),
    avg: wavg('avg'),
    median: wavg('median'),
    p95: wavg('p95'),
    stddev: wavg('stddev'),
    jitter: wavg('jitter'),
    jitterRfc3550: wavg('jitterRfc3550'),
    spikeCount: parts.reduce((a, p) => a + (p.s.spikeCount || 0), 0),
    method: parts.map((p) => (p.s === tcpStats ? 'tcp' : p.s === dnsStats ? 'dns' : 'icmp')).join('+'),
  };

  if (!Number.isFinite(merged.min)) merged.min = null;
  if (!Number.isFinite(merged.max)) merged.max = null;

  return merged;
}

/* ------------------------------------------------------------------ */
/* Aplicação / reversão                                                */
/* ------------------------------------------------------------------ */

async function resolveTargetInterface(ctx) {
  const wanted = ctx && ctx.params && ctx.params.ifIndex;
  const snap = await netif.getSnapshot({ force: true });

  if (wanted) {
    const found = snap.adapters.find((a) => a.ifIndex === Number(wanted));
    if (found) return found;
  }
  return snap.activeAdapter;
}

/**
 * Valida IPv4/IPv6 antes de mandar para o Set-DnsClientServerAddress.
 * Um IP fora de faixa (999.1.1.1) não é "inofensivo": o cmdlet falha com uma
 * mensagem genérica e o usuário acha que o app quebrou.
 */
function isValidIp(value) {
  const v = String(value === null || value === undefined ? '' : value).trim();
  if (!v || v.length > 45) return false;

  if (v.includes(':')) return /^[0-9a-fA-F:]{2,45}$/.test(v) && !/:::/.test(v);

  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((part) => {
    if (part.length > 1 && part[0] === '0') return false; // 010 != 10 (ambiguidade octal)
    return Number(part) <= 255;
  });
}

async function applyDns(servers, ctx, options = {}) {
  const context = ctx || {}; // chamadas vindas do IPC sempre trazem ctx, mas não confiamos nisso
  const list = (Array.isArray(servers) ? servers : [servers])
    .map((s) => String(s || '').trim())
    .filter(isValidIp)
    .slice(0, 4);

  if (list.length === 0) {
    return { success: false, code: 'INVALID_DNS', error: 'Nenhum endereço DNS válido informado.' };
  }

  const adapter = await resolveTargetInterface(context);
  if (!adapter) {
    return { success: false, code: 'NO_INTERFACE', error: 'Nenhuma interface de rede ativa encontrada.' };
  }

  // Backup do estado atual (inclui se era DHCP, para restaurar corretamente).
  const previous = await getCurrentDns(adapter.ifIndex);
  const source = await getDnsSource(adapter.ifIndex);

  stateStore.pushBackup(
    options.tweakId || 'dns',
    [
      {
        kind: 'dns',
        ifIndex: adapter.ifIndex,
        alias: adapter.name,
        servers: previous,
        wasDhcp: source === 'dhcp' && previous.length === 0,
      },
    ],
    { adapter: adapter.name, source, previous }
  );

  const body = `
$ifIndex = ${ps.psNumber(adapter.ifIndex)}
$servers = ConvertFrom-Json -InputObject '${JSON.stringify(list)}'
Set-DnsClientServerAddress -InterfaceIndex $ifIndex -ServerAddresses @($servers) -ErrorAction Stop
try { Clear-DnsClientCache -ErrorAction SilentlyContinue } catch {}
$check = @(Get-DnsClientServerAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses }) | ForEach-Object { "$_" }
Write-WillLagJson @{ ok = $true; applied = @($servers); effective = @($check) }
`;

  const res = await ps.ensureElevated(body, {
    label: 'dns:apply',
    isAdmin: context.isAdmin,
    allowPrompt: context.allowPrompt,
    timeout: 45000,
  });

  if (!res.success) {
    stateStore.consumeBackup(options.tweakId || 'dns');
    return {
      success: false,
      code: res.code,
      applied: false,
      error: res.error,
      message: res.error || 'Falha ao definir o DNS.',
    };
  }

  await flushCache();
  netif.invalidate();
  stateStore.markApplied(options.tweakId || 'dns', {
    scope: 'persistent',
    params: { servers: list, ifIndex: adapter.ifIndex },
  });
  stateStore.updateSettings({ dnsProvider: options.providerId || null, dnsServers: list });

  return {
    success: true,
    code: 'OK',
    applied: true,
    interface: adapter.name,
    ifIndex: adapter.ifIndex,
    servers: list,
    previous,
    message: `DNS definido como ${list.join(' / ')} em "${adapter.name}". Cache limpo.`,
  };
}

async function restoreDns(ctx, options = {}) {
  const context = ctx || {};
  const layer = stateStore.peekBackup(options.tweakId || 'dns');
  if (!layer || !layer.entries || layer.entries.length === 0) {
    return { success: true, code: 'NO_BACKUP', applied: false, message: 'Nenhum backup de DNS encontrado.' };
  }

  const res = await require('./restoreEngine').restoreEntries(layer.entries, {
    isAdmin: context.isAdmin,
    allowPrompt: context.allowPrompt,
  });

  if (res.success || res.code === 'PARTIAL') {
    stateStore.consumeBackup(options.tweakId || 'dns');
    stateStore.markReverted(options.tweakId || 'dns');
    await flushCache();
    netif.invalidate();
  }
  return { ...res, applied: false };
}

async function flushCache() {
  if (!ps.isWindows()) {
    return { success: false, code: 'UNSUPPORTED_PLATFORM', message: 'Somente Windows.' };
  }

  const res = await ps.runPowerShell(
    `
$out = & ipconfig /flushdns 2>&1 | Out-String
try { Clear-DnsClientCache -ErrorAction SilentlyContinue } catch {}
$stats = Get-DnsClientCache -ErrorAction SilentlyContinue | Measure-Object
Write-WillLagJson @{ ok = $true; output = $out.Trim(); remainingEntries = $stats.Count }
`,
    { label: 'dns:flush', timeout: 25000 }
  );

  if (!res.success) {
    return { success: false, code: res.code, message: res.error || 'Falha ao limpar o cache DNS.' };
  }

  return {
    success: true,
    code: 'OK',
    message: 'Cache DNS do sistema limpo com sucesso.',
    remainingEntries: res.data ? res.data.remainingEntries : null,
    output: res.data ? res.data.output : '',
  };
}

/** Pré-visualização do cache DNS (útil para depurar resolução de servidores de jogo). */
async function readCache(limit = 60) {
  if (!ps.isWindows()) return { ok: false, entries: [], error: 'Somente Windows.' };

  const res = await ps.runPowerShell(
    `
$entries = @(Get-DnsClientCache -ErrorAction SilentlyContinue | Select-Object -First ${ps.psNumber(limit, 60)} | ForEach-Object {
  [pscustomobject]@{
    entry   = "$($_.Entry)"
    name    = "$($_.Name)"
    data    = "$($_.Data)"
    type    = "$($_.Type)"
    ttl     = $_.TimeToLive
    section = "$($_.Section)"
  }
})
Write-WillLagJson @{ ok = $true; entries = @($entries) }
`,
    { label: 'dns:cache', timeout: 30000 }
  );

  if (!res.success) return { ok: false, entries: [], error: res.error };
  return { ok: true, entries: ps.asArray(res.data && res.data.entries) };
}

/* ------------------------------------------------------------------ */
/* Tweak "auto" para o catálogo                                        */
/* ------------------------------------------------------------------ */

const autoDnsTweak = {
  id: 'autoDns',
  group: 'dns',
  label: 'DNS automático de menor latência e jitter',
  description: 'Mede os resolvedores públicos e aplica o de melhor score (média + p95 + jitter + perda).',
  why:
    'Um resolvedor lento não aumenta o ping da partida, mas causa travadas de 2-5s em login, ' +
    'matchmaking, loja e download de patch — e timeouts de resolução derrubam clientes anti-cheat. ' +
    'O score prioriza *estabilidade* (jitter/p95), não só média: de nada adianta resolver em 5ms ' +
    'se 1 em cada 20 consultas leva 900ms.',
  risk: 'low',
  requiresAdmin: true,
  scope: 'persistent',
  defaultInPreset: true,
  options: PROVIDERS.map((p) => ({ value: p.id, label: `${p.name} (${p.primary})` })).concat([
    { value: 'auto', label: 'auto — medir e escolher o melhor' },
    { value: 'dhcp', label: 'dhcp — voltar para o DNS do roteador' },
  ]),

  async detect(ctx) {
    if (!ps.isWindows()) return { ok: false, supported: false, error: 'Somente Windows.' };
    const adapter = await resolveTargetInterface(ctx);
    if (!adapter) return { ok: true, supported: false, applied: false, reason: 'Sem interface ativa.' };

    const current = await getCurrentDns(adapter.ifIndex);
    const provider = findProviderByServers(current);
    const source = await getDnsSource(adapter.ifIndex);
    const stored = stateStore.getSetting('dnsServers', null);

    return {
      ok: true,
      supported: true,
      applied: Boolean(stored && stored.length && arraysEqual(stored, current)),
      interface: adapter.name,
      current: current.length ? current.join(', ') : source === 'dhcp' ? 'DHCP (automático)' : 'nenhum',
      currentProvider: provider ? provider.name : null,
      source,
      target: 'o resolvedor de melhor score medido',
    };
  },

  async apply(ctx) {
    const choice = (ctx.params && ctx.params.dns) || 'auto';

    if (choice === 'dhcp') {
      const res = await restoreDns(ctx, { tweakId: 'autoDns' });
      return { ...res, message: res.message || 'DNS devolvido para automático (DHCP).' };
    }

    let servers = null;
    let label = null;
    let measurement = null;

    if (choice === 'auto') {
      const bench = await benchmark({
        rounds: ctx.params?.rounds || 3,
        timeoutMs: 1500,
        onProgress: ctx.onProgress,
      });
      if (!bench.best) {
        return {
          success: false,
          code: 'NO_REACHABLE_DNS',
          applied: false,
          message:
            'Nenhum resolvedor público respondeu. Sua rede pode bloquear DNS externo (porta 53). ' +
            'Mantive sua configuração atual intacta.',
          benchmark: bench.results.map((r) => ({ name: r.name, score: r.score, reachable: r.reachable })),
        };
      }
      servers = [bench.best.primary, bench.best.secondary];
      label = bench.best.name;
      measurement = { score: bench.best.score, avg: bench.best.combined.avg, jitter: bench.best.combined.jitter };
    } else {
      const provider = PROVIDERS.find((p) => p.id === choice || p.primary === choice);
      if (!provider) return { success: false, code: 'UNKNOWN_PROVIDER', applied: false, message: `Provedor desconhecido: ${choice}` };
      servers = [provider.primary, provider.secondary];
      label = provider.name;
    }

    const res = await applyDns(servers, ctx, { tweakId: 'autoDns', providerId: label });
    if (!res.success) return res;

    return {
      ...res,
      provider: label,
      measurement,
      message: `DNS otimizado: ${label} (${servers.join(' / ')}) em "${res.interface}".` +
        (measurement ? ` Score ${measurement.score} — ${measurement.avg}ms médio, jitter ${measurement.jitter}ms.` : ''),
    };
  },

  async revert(ctx) {
    return restoreDns(ctx, { tweakId: 'autoDns' });
  },
};

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => String(v) === String(b[i]));
}

module.exports = {
  PROVIDERS,
  TEST_HOSTNAMES,
  tweaks: [autoDnsTweak],
  benchmark,
  mergeStats,
  applyDns,
  restoreDns,
  flushCache,
  readCache,
  getCurrentDns,
  getDnsSource,
  findProviderByServers,
  arraysEqual,
  isValidIp,
};
