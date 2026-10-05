import React, { useState, useEffect, useCallback } from 'react';
import ipc from '../services/ipc';
import './MtuPanel.css';

/**
 * Utilitário de MTU.
 *
 * Mostra o MTU atual, descobre o MTU real do caminho (busca binária com ping
 * "Don't Fragment") e aplica o valor correto — eliminando fragmentação de
 * pacotes UDP, que é a causa silenciosa de perda "aleatória" em jogos.
 */
function MtuPanel({ isAdmin, showNotification }) {
  const [current, setCurrent] = useState(null);
  const [discovery, setDiscovery] = useState(null);
  const [discovering, setDiscovering] = useState(false);
  const [applying, setApplying] = useState(false);
  const [steps, setSteps] = useState([]);
  const [manual, setManual] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ipc.invoke('mtu-get');
      if (res && res.ok) setCurrent(res);
    } catch (err) {
      // backend indisponível
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const off = ipc.on('mtu-progress', (payload) => {
      if (!payload) return;
      setSteps((prev) => [...prev.slice(-24), payload]);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [load]);

  const handleDiscover = async () => {
    setDiscovering(true);
    setSteps([]);
    setDiscovery(null);
    try {
      const res = await ipc.invoke('mtu-discover', {});
      setDiscovery(res);
      if (!res || !res.ok) {
        showNotification(res && res.error ? res.error : 'Não foi possível medir o MTU.', 'error');
      } else if (res.recommendation && res.recommendation.mtu) {
        showNotification(
          `MTU do caminho: ${res.recommendation.mtu} (atual: ${res.recommendation.current ?? '—'})`,
          res.recommendation.action === 'ok' ? 'info' : 'success'
        );
      }
    } catch (err) {
      showNotification(`Erro na detecção: ${err.message}`, 'error');
    } finally {
      setDiscovering(false);
    }
  };

  const handleApply = async (value) => {
    const mtu = Number(value);
    if (!Number.isInteger(mtu) || mtu < 576 || mtu > 9000) {
      showNotification('MTU inválido. Use um valor entre 576 e 9000.', 'error');
      return;
    }
    setApplying(true);
    try {
      const res = await ipc.invoke('mtu-apply', mtu);
      showNotification(res.message, res.success ? 'success' : 'error');
      if (res.success) {
        await load();
        setManual('');
      }
    } catch (err) {
      showNotification(`Erro ao aplicar MTU: ${err.message}`, 'error');
    } finally {
      setApplying(false);
    }
  };

  const handleRestore = async () => {
    setApplying(true);
    try {
      const res = await ipc.invoke('mtu-restore');
      showNotification(res.message, res.success ? 'success' : 'error');
      await load();
    } finally {
      setApplying(false);
    }
  };

  const rec = discovery && discovery.recommendation ? discovery.recommendation : null;
  const tone = rec
    ? rec.action === 'ok'
      ? 'ok'
      : rec.action === 'reduce'
        ? 'warn'
        : rec.action === 'inconclusive'
          ? 'muted'
          : 'info'
    : null;

  return (
    <div className="card mtu-panel">
      <div className="card-header">
        <h3>📏 MTU da interface ativa</h3>
        <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading}>
          {loading ? <span className="loading-spinner" /> : '🔄'} Atualizar
        </button>
      </div>

      <p className="mtu-intro">
        Pacote UDP maior que o MTU do caminho é <strong>fragmentado</strong>. Se um único fragmento
        se perde, o jogo descarta a mensagem inteira — perda de pacote "aleatória" mesmo com enlace
        saudável. Aqui você mede o MTU real e corrige.
      </p>

      <div className="mtu-current">
        <div className="mtu-current-item">
          <span className="mtu-label">Interface</span>
          <span className="mtu-value">{current && current.alias ? current.alias : '—'}</span>
        </div>
        <div className="mtu-current-item">
          <span className="mtu-label">MTU atual</span>
          <span className="mtu-value mono">{current && current.mtu ? `${current.mtu} bytes` : '—'}</span>
        </div>
        <div className="mtu-current-item">
          <span className="mtu-label">DHCP</span>
          <span className="mtu-value">{current && current.dhcp ? current.dhcp : '—'}</span>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleDiscover} disabled={discovering}>
          {discovering ? <><span className="loading-spinner" /> Medindo…</> : '🔎 Detectar MTU ideal'}
        </button>
      </div>

      {discovering && steps.length > 0 && (
        <div className="mtu-steps">
          <span className="mtu-steps-title">Busca binária (ping com bit DF):</span>
          <div className="mtu-steps-list">
            {steps.map((s, i) => (
              <span key={i} className={`mtu-step ${s.ok ? 'ok' : 'fail'}`}>
                {s.payload + 28}
                <small>{s.ok ? '✓' : '✗'}</small>
              </span>
            ))}
          </div>
        </div>
      )}

      {discovery && discovery.ok && (
        <div className="mtu-results">
          <div className="mtu-result-row">
            <span className="mtu-target">🏠 Gateway {discovery.gateway ? `(${discovery.gateway.target})` : ''}</span>
            <span className="mtu-result-value">
              {discovery.gateway && discovery.gateway.mtu ? `${discovery.gateway.mtu} bytes` : discovery.gateway && discovery.gateway.error === 'MIN_FAILED' ? 'ICMP bloqueado' : '—'}
            </span>
            <span className="mtu-result-note">MTU do enlace local (Wi-Fi/cabo até o roteador)</span>
          </div>

          {(discovery.internet || []).map((t, i) => (
            <div className="mtu-result-row" key={i}>
              <span className="mtu-target">🌐 Internet ({t.target})</span>
              <span className="mtu-result-value">
                {t.mtu ? `${t.mtu} bytes` : t.error === 'MIN_FAILED' ? 'ICMP bloqueado' : '—'}
              </span>
              <span className="mtu-result-note">
                Path MTU (inclui PPPoE, VPN, CGNAT)
                {t.noisy ? ' · ⚠ medição ruidosa' : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {rec && (
        <div className={`mtu-recommendation tone-${tone}`}>
          <div className="mtu-rec-head">
            <span className="mtu-rec-badge">
              {rec.action === 'ok' && '✅ Já está ideal'}
              {rec.action === 'reduce' && `⬇️ Reduzir para ${rec.mtu}`}
              {rec.action === 'raise' && `⬆️ Caminho suporta ${rec.mtu}`}
              {rec.action === 'inconclusive' && '❔ Inconclusivo'}
              {rec.action === 'unknown' && '❔ MTU atual desconhecido'}
            </span>
            {rec.isPppoe && <span className="badge badge-info">PPPoE (1492)</span>}
            {rec.isVpnLike && <span className="badge badge-warning">Túnel/VPN</span>}
          </div>
          <p>{rec.message}</p>
          {rec.note && <p className="mtu-rec-note">💡 {rec.note}</p>}

          <div className="mtu-rec-actions">
            {rec.action === 'reduce' && (
              <button
                type="button"
                className="btn btn-success btn-sm"
                onClick={() => handleApply(rec.mtu)}
                disabled={applying}
              >
                {applying ? <span className="loading-spinner" /> : '✔'} Aplicar MTU {rec.mtu}
              </button>
            )}
            <button type="button" className="btn btn-outline btn-sm" onClick={handleRestore} disabled={applying}>
              ↩ Restaurar MTU anterior
            </button>
          </div>
        </div>
      )}

      <div className="mtu-manual">
        <label htmlFor="mtu-manual-input">Definir manualmente:</label>
        <input
          id="mtu-manual-input"
          type="number"
          min="576"
          max="9000"
          step="1"
          placeholder="Ex.: 1492"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => handleApply(manual)}
          disabled={applying || !manual || !isAdmin}
          title={!isAdmin ? 'Requer privilégios de Administrador' : 'Aplicar MTU manualmente'}
        >
          Aplicar
        </button>
        <span className="mtu-hint">
          Valores comuns: <code>1500</code> Ethernet · <code>1492</code> PPPoE · <code>1400-1460</code> VPN/hotspot
        </span>
      </div>
    </div>
  );
}

export default MtuPanel;
