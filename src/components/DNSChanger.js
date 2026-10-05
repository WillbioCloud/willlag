import React, { useState, useEffect, useCallback } from 'react';
import ipc from '../services/ipc';
import MtuPanel from './MtuPanel';
import {
  formatMs,
  formatPercent,
  latencyColor,
  jitterColor,
  lossColor,
  DNS_PROVIDERS_FALLBACK,
} from './utils/networkOptimizer';
import './DNSChanger.css';

/**
 * DNS & MTU.
 *
 * Diferença para a v1.0: o teste não mede só "ping ICMP". Ele mede três coisas
 * e combina num score: latência de rede (TCP/53), latência de resolução real
 * (consulta DNS de verdade) e ICMP. O ranking prioriza ESTABILIDADE (jitter e
 * p95), não só a média — que é o que realmente atrapalha em jogo.
 */
function DNSChanger({ isAdmin, showNotification }) {
  const [customPrimary, setCustomPrimary] = useState('');
  const [customSecondary, setCustomSecondary] = useState('');
  const [testing, setTesting] = useState({});
  const [benchmark, setBenchmark] = useState(null);
  const [progress, setProgress] = useState(null);
  const [current, setCurrent] = useState(null);
  const [applying, setApplying] = useState(null);
  const [includeIcmp, setIncludeIcmp] = useState(false);

  const loadCurrent = useCallback(async () => {
    try {
      const res = await ipc.invoke('dns-current');
      if (res && res.ok) setCurrent(res);
    } catch (err) {
      /* backend indisponível */
    }
  }, []);

  useEffect(() => {
    loadCurrent();
    const off = ipc.on('dns-benchmark-progress', (payload) => {
      if (payload) setProgress(payload);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [loadCurrent]);

  /** Lista exibida: resultado do benchmark quando existe; senão, fallback estático. */
  const rows = benchmark && benchmark.results && benchmark.results.length
    ? benchmark.results
    : DNS_PROVIDERS_FALLBACK.map((p) => ({ ...p, combined: null, score: null, rank: null }));

  const runBenchmark = async (provider) => {
    const id = provider ? provider.id || provider.primary : null;
    setProgress(null);

    if (id) setTesting((prev) => ({ ...prev, [id]: true }));
    else setTesting((prev) => ({ ...prev, __all: true }));

    try {
      const res = await ipc.invoke('dns-benchmark', {
        rounds: 4,
        timeoutMs: 2000,
        includeIcmp,
        providers: id ? [id] : undefined,
      });

      if (!res || !res.ok) {
        showNotification('Não foi possível concluir o teste de DNS.', 'error');
        return;
      }

      if (id) {
        // Teste individual: mescla no resultado existente (ou cria um novo).
        setBenchmark((prev) => {
          if (!prev) return res;
          const merged = [...prev.results.filter((r) => r.id !== id), ...res.results];
          merged.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity));
          merged.forEach((r, i) => { r.rank = i + 1; });
          return { ...prev, results: merged, best: merged[0], testedAt: Date.now() };
        });
      } else {
        setBenchmark(res);
        showNotification(
          res.recommendation || 'Testes concluídos.',
          'success'
        );
      }
    } catch (err) {
      showNotification(`Erro no teste: ${err.message}`, 'error');
    } finally {
      setProgress(null);
      setTesting({});
    }
  };

  const handleChangeDNS = async (primary, secondary, name) => {
    setApplying(name);
    try {
      const res = await ipc.invoke('dns-apply', [primary, secondary].filter(Boolean));
      if (res.success) {
        showNotification(res.message || `DNS alterado para ${name}: ${primary} / ${secondary}`, 'success');
        await loadCurrent();
      } else {
        showNotification(res.message || res.error || 'Falha ao alterar o DNS.', 'error');
      }
    } finally {
      setApplying(null);
    }
  };

  const handleApplyBest = async () => {
    if (!benchmark || !benchmark.best) {
      showNotification('Rode o teste completo antes de aplicar o melhor DNS.', 'info');
      return;
    }
    await handleChangeDNS(benchmark.best.primary, benchmark.best.secondary, benchmark.best.name);
  };

  const handleAutoTune = async () => {
    setApplying('auto');
    try {
      const res = await ipc.invoke('apply-tweak', 'autoDns', { dns: 'auto', rounds: 3 });
      showNotification(res.message, res.success ? 'success' : 'error');
      await loadCurrent();
    } finally {
      setApplying(null);
    }
  };

  const handleRestoreDhcp = async () => {
    setApplying('dhcp');
    try {
      const res = await ipc.invoke('dns-restore');
      showNotification(res.message, res.success ? 'success' : 'error');
      await loadCurrent();
    } finally {
      setApplying(null);
    }
  };

  const handleFlushDNS = async () => {
    const result = await ipc.invoke('flush-dns');
    showNotification(result.message, result.success ? 'success' : 'error');
  };

  const isBusy = Boolean(progress) || Boolean(testing.__all);

  return (
    <div className="dns-changer">
      <div className="page-header">
        <h1>🌐 DNS & MTU</h1>
        <p>Escolha o resolvedor mais estável e corrija a fragmentação de pacotes UDP</p>
      </div>

      {/* Estado atual */}
      <div className="card dns-current-card">
        <div className="dns-current">
          <div className="dns-current-item">
            <span className="dns-current-label">Interface</span>
            <span className="dns-current-value">{current && current.interface ? current.interface : '—'}</span>
          </div>
          <div className="dns-current-item">
            <span className="dns-current-label">DNS em uso</span>
            <span className="dns-current-value mono">
              {current && current.servers && current.servers.length ? current.servers.join(', ') : '—'}
            </span>
          </div>
          <div className="dns-current-item">
            <span className="dns-current-label">Origem</span>
            <span className="dns-current-value">
              {current && current.provider ? current.provider.name : current && current.source === 'dhcp' ? 'DHCP (roteador)' : '—'}
            </span>
          </div>
        </div>
        <div className="dns-current-actions">
          <button className="btn btn-outline btn-sm" onClick={handleFlushDNS}>🧹 Limpar cache DNS</button>
          <button className="btn btn-outline btn-sm" onClick={handleRestoreDhcp} disabled={applying === 'dhcp' || !isAdmin}>
            ↩ Voltar para o DNS do roteador
          </button>
        </div>
      </div>

      <div className="dns-actions-bar">
        <button className="btn btn-primary" onClick={() => runBenchmark(null)} disabled={isBusy}>
          {isBusy ? (
            <>
              <span className="loading-spinner" />
              {progress ? `Testando ${progress.providerId} (${progress.index}/${progress.total})…` : 'Testando…'}
            </>
          ) : (
            '🏓 Testar todos (latência + jitter + resolução)'
          )}
        </button>
        <button className="btn btn-success" onClick={handleAutoTune} disabled={applying === 'auto' || !isAdmin}>
          {applying === 'auto' ? <span className="loading-spinner" /> : '🎯'} Medir e aplicar o melhor
        </button>
        <button className="btn btn-outline" onClick={handleApplyBest} disabled={!benchmark || !benchmark.best || !isAdmin}>
          ✅ Aplicar melhor medido
        </button>
        <label className="dns-icmp-toggle" title="Inclui ping ICMP na medição (alguns resolvedores bloqueiam ICMP)">
          <input type="checkbox" checked={includeIcmp} onChange={(e) => setIncludeIcmp(e.target.checked)} />
          incluir ICMP
        </label>
      </div>

      {benchmark && benchmark.recommendation && (
        <div className="dns-recommendation">
          <span>🏆</span>
          <div>
            <strong>Recomendação</strong>
            <p>{benchmark.recommendation}</p>
          </div>
        </div>
      )}

      <div className="dns-honesty">
        ℹ️ <strong>DNS não reduz o ping dentro da partida</strong> — o jogo conecta por IP depois do
        matchmaking. O ganho real é em login, loja, download de patch e anti-cheat: um resolvedor
        instável causa travadas de 2-5 segundos e timeouts de resolução.
      </div>

      {/* DNS Providers Grid */}
      <div className="dns-grid">
        {rows.map((provider) => {
          const key = provider.id || provider.name;
          const combined = provider.combined || null;
          const isBest = benchmark && benchmark.best && benchmark.best.id === key;

          return (
            <div key={key} className={`dns-card card ${isBest ? 'dns-recommended' : ''}`}>
              {isBest && <div className="dns-recommended-badge">🏆 Melhor medido</div>}
              {provider.rank && !isBest && <div className="dns-rank-badge">#{provider.rank}</div>}

              <div className="dns-card-header">
                <span className="dns-icon">{provider.icon || '🌐'}</span>
                <div>
                  <h3>{provider.name}</h3>
                  <p>{provider.description}</p>
                </div>
              </div>

              <div className="dns-addresses">
                <div className="dns-address">
                  <span className="dns-label">Primário</span>
                  <span className="dns-value">{provider.primary}</span>
                </div>
                <div className="dns-address">
                  <span className="dns-label">Secundário</span>
                  <span className="dns-value">{provider.secondary}</span>
                </div>
              </div>

              {combined ? (
                <div className="dns-metrics">
                  <div className="dns-metric">
                    <span className="dns-metric-label">Rede</span>
                    <span className="dns-metric-value" style={{ color: latencyColor(combined.avg) }}>
                      {formatMs(combined.avg)}
                    </span>
                  </div>
                  <div className="dns-metric">
                    <span className="dns-metric-label">p95</span>
                    <span className="dns-metric-value" style={{ color: latencyColor(combined.p95) }}>
                      {formatMs(combined.p95)}
                    </span>
                  </div>
                  <div className="dns-metric">
                    <span className="dns-metric-label">Jitter</span>
                    <span className="dns-metric-value" style={{ color: jitterColor(combined.jitter) }}>
                      {formatMs(combined.jitter, 1)}
                    </span>
                  </div>
                  <div className="dns-metric">
                    <span className="dns-metric-label">Perda</span>
                    <span className="dns-metric-value" style={{ color: lossColor(combined.lossPercent) }}>
                      {formatPercent(combined.lossPercent, 0)}
                    </span>
                  </div>
                  <div className="dns-metric dns-metric-score">
                    <span className="dns-metric-label">Score</span>
                    <span className="dns-metric-value">{provider.score ?? '—'}</span>
                  </div>
                </div>
              ) : (
                <div className="dns-metrics-empty">Sem medição ainda</div>
              )}

              {provider.gradeLabel && (
                <div className={`dns-grade grade-${provider.gradeColor || 'neutral'}`}>{provider.gradeLabel}</div>
              )}

              <div className="dns-card-actions">
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => runBenchmark(provider)}
                  disabled={Boolean(testing[key]) || isBusy}
                >
                  {testing[key] ? <span className="loading-spinner" /> : '🏓'} Testar
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => handleChangeDNS(provider.primary, provider.secondary, provider.name)}
                  disabled={!isAdmin || applying === provider.name}
                >
                  {applying === provider.name ? <span className="loading-spinner" /> : '✅'} Usar este DNS
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* DNS Customizado */}
      <div className="card custom-dns-card">
        <h3>🔧 DNS Personalizado</h3>
        <p className="custom-dns-desc">Configure um servidor DNS personalizado (IPv4)</p>
        <div className="custom-dns-inputs">
          <div className="custom-dns-field">
            <label>DNS Primário</label>
            <input
              type="text"
              placeholder="Ex: 1.1.1.1"
              value={customPrimary}
              onChange={(e) => setCustomPrimary(e.target.value)}
            />
          </div>
          <div className="custom-dns-field">
            <label>DNS Secundário</label>
            <input
              type="text"
              placeholder="Ex: 1.0.0.1"
              value={customSecondary}
              onChange={(e) => setCustomSecondary(e.target.value)}
            />
          </div>
          <button
            className="btn btn-success"
            onClick={() => handleChangeDNS(customPrimary, customSecondary, 'Personalizado')}
            disabled={!isAdmin || !customPrimary}
          >
            🌐 Aplicar DNS Personalizado
          </button>
        </div>
      </div>

      {/* MTU */}
      <MtuPanel isAdmin={isAdmin} showNotification={showNotification} />
    </div>
  );
}

export default DNSChanger;
