import React, { useState, useEffect } from 'react';
import ipc from '../services/ipc';
import './Optimizer.css';


function Optimizer({ isAdmin, showNotification, onNavigate }) {
  const [optimizing, setOptimizing] = useState({});
  const [results, setResults] = useState([]);
  const [backupInfo, setBackupInfo] = useState(null);
  const [systemCtx, setSystemCtx] = useState(null);
  const [busyAll, setBusyAll] = useState(false);

  useEffect(() => {
    let alive = true;
    ipc.invoke('get-backups').then((r) => { if (alive && r) setBackupInfo(r); }).catch(() => {});
    ipc.invoke('get-system-context').then((r) => { if (alive && r) setSystemCtx(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const handleRevertAll = async () => {
    if (!window.confirm('Reverter TODOS os ajustes para o estado anterior (a partir dos backups)?')) return;
    setBusyAll(true);
    try {
      const res = await ipc.invoke('revert-all');
      showNotification(res.message, res.success ? 'success' : 'error');
      const info = await ipc.invoke('get-backups');
      setBackupInfo(info);
    } finally {
      setBusyAll(false);
    }
  };

  const handleExport = async () => {
    const res = await ipc.invoke('export-backup-reg');
    showNotification(res.message || (res.success ? 'Backup exportado.' : 'Falha ao exportar.'), res.success ? 'success' : 'error');
  };

  const optimizations = [
    {
      id: 'tcp',
      title: 'Otimizar TCP/IP',
      description: 'Configura parâmetros TCP para menor latência: desabilita auto-tuning, timestamps, ECN e habilita TCP Fast Open.',
      icon: '🔧',
      color: '#6c5ce7',
      handler: 'optimize-tcp',
      adminRequired: true,
    },
    {
      id: 'nagle',
      title: 'Desabilitar Nagle Algorithm',
      description: 'Remove o atraso no envio de pequenos pacotes TCP. Essencial para jogos online que enviam dados frequentes.',
      icon: '⚡',
      color: '#00d68f',
      handler: 'disable-nagle',
      adminRequired: true,
    },
    {
      id: 'flush',
      title: 'Limpar Cache DNS',
      description: 'Limpa o cache DNS do sistema, forçando resolução nova de todos os endereços. Pode resolver problemas de conexão.',
      icon: '🧹',
      color: '#0095ff',
      handler: 'flush-dns',
      adminRequired: false,
    },
    {
      id: 'reset',
      title: 'Resetar Configurações',
      description: 'Restaura todas as configurações de rede ao padrão do Windows. Use se algo der errado.',
      icon: '↩️',
      color: '#ff4757',
      handler: 'reset-optimizations',
      adminRequired: true,
    },
  ];

  const handleOptimize = async (opt) => {
    if (opt.adminRequired && !isAdmin) {
      showNotification('Execute o aplicativo como Administrador!', 'error');
      return;
    }

    setOptimizing(prev => ({ ...prev, [opt.id]: true }));

    try {
      const result = await ipc.invoke(opt.handler);

      if (result.success) {
        showNotification(result.message, 'success');
        setResults(prev => [
          { id: opt.id, title: opt.title, message: result.message, success: true, time: new Date().toLocaleTimeString(), details: result.details },
          ...prev
        ]);
      } else {
        showNotification(result.message, 'error');
        setResults(prev => [
          { id: opt.id, title: opt.title, message: result.message, success: false, time: new Date().toLocaleTimeString() },
          ...prev
        ]);
      }
    } catch (e) {
      showNotification(`Erro: ${e.message}`, 'error');
    }

    setOptimizing(prev => ({ ...prev, [opt.id]: false }));
  };

  return (
    <div className="optimizer">
      <div className="page-header">
        <h1>⚡ Otimizador de Rede</h1>
        <p>Aplique otimizações no Windows para reduzir latência em jogos</p>
      </div>

      {!isAdmin && (
        <div className="admin-notice card">
          <span className="admin-notice-icon">⚠️</span>
          <div>
            <strong>Privilégios de Administrador necessários</strong>
            <p>Feche o aplicativo e execute novamente como Administrador para usar as otimizações.</p>
          </div>
        </div>
      )}

      {/* Atalho para o modo completo */}
      <div className="card optimizer-hero">
        <div className="optimizer-hero-text">
          <h3>🚀 Quer tudo de uma vez, com backup e rollback automático?</h3>
          <p>
            A aba <strong>Ultra Low-Latency</strong> tem o botão principal do Modo Jogo, toggles
            individuais para cada ajuste (TCP/IP, Wi-Fi, energia USB, DNS e MTU),
            medição de ganho real (antes/depois) e guarda de conectividade que reverte tudo se a rede cair.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => onNavigate && onNavigate('lowlatency')}>
          Abrir Ultra Low-Latency →
        </button>
      </div>

      {/* Contexto do sistema */}
      {systemCtx && (
        <div className="card system-context-card">
          <div className="ctx-item">
            <span className="ctx-label">Sistema</span>
            <span className="ctx-value">
              {systemCtx.platform ? `${systemCtx.platform.windowsVersion} (build ${systemCtx.platform.windowsBuild})` : '—'}
            </span>
          </div>
          <div className="ctx-item">
            <span className="ctx-label">Privilégios</span>
            <span className="ctx-value" style={{ color: isAdmin ? 'var(--success)' : 'var(--warning)' }}>
              {isAdmin ? 'Administrador' : 'Usuário padrão'}
            </span>
          </div>
          <div className="ctx-item">
            <span className="ctx-label">Interface ativa</span>
            <span className="ctx-value">
              {systemCtx.activeAdapter
                ? `${systemCtx.activeAdapter.name}${systemCtx.activeAdapter.isWifi ? ' (Wi-Fi)' : ''}${systemCtx.activeAdapter.isUsb ? ' · USB' : ''}`
                : '—'}
            </span>
          </div>
          <div className="ctx-item">
            <span className="ctx-label">Backups salvos</span>
            <span className="ctx-value mono">
              {backupInfo ? Object.keys(backupInfo.backups || {}).length : '—'}
            </span>
          </div>
        </div>
      )}

      {/* Backup e restauração */}
      <div className="card backup-card">
        <div className="card-header">
          <h3>💾 Backup e restauração</h3>
          <div className="backup-actions">
            <button className="btn btn-outline btn-sm" onClick={handleExport}>
              💾 Exportar (.reg + .json)
            </button>
            <button className="btn btn-danger btn-sm" onClick={handleRevertAll} disabled={busyAll}>
              {busyAll ? <span className="loading-spinner" /> : '🧯'} Reverter tudo
            </button>
          </div>
        </div>
        <p className="backup-desc">
          Antes de cada alteração o willLag grava o valor anterior (inclusive quando o valor não
          existia). "Reverter tudo" restaura exatamente o estado original — não apenas "o padrão do
          Windows". O arquivo <code>.reg</code> exportado pode ser aplicado com dois cliques, mesmo
          sem o willLag instalado.
        </p>
        {backupInfo && backupInfo.history && backupInfo.history.length > 0 && (
          <div className="backup-history">
            {backupInfo.history.slice(0, 6).map((h, i) => (
              <div key={i} className="backup-history-item">
                <span className={`bh-dot ${h.success === false ? 'fail' : 'ok'}`} />
                <span className="bh-action">{h.action === 'apply' ? 'Aplicado' : 'Revertido'}</span>
                <span className="bh-id">{h.tweakId}</span>
                <span className="bh-time">{new Date(h.ts).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cards de otimização */}
      <div className="optimization-grid">
        {optimizations.map(opt => (
          <div key={opt.id} className="optimization-card card">
            <div className="opt-header">
              <div className="opt-icon" style={{ background: `${opt.color}20`, color: opt.color }}>
                {opt.icon}
              </div>
              <div className="opt-info">
                <h3>{opt.title}</h3>
                <p>{opt.description}</p>
              </div>
            </div>
            <div className="opt-footer">
              {opt.adminRequired && (
                <span className="badge badge-warning">Admin</span>
              )}
              <button
                className={`btn ${opt.id === 'reset' ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => handleOptimize(opt)}
                disabled={optimizing[opt.id] || (opt.adminRequired && !isAdmin)}
              >
                {optimizing[opt.id] ? (
                  <><div className="loading-spinner" /> Aplicando...</>
                ) : (
                  <>{opt.icon} Aplicar</>
                )}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Dicas adicionais */}
      <div className="card tips-card">
        <h3>💡 Dicas Adicionais para Reduzir MS</h3>
        <div className="tips-grid">
          <div className="tip-item">
            <span className="tip-icon">📶</span>
            <div>
              <strong>Use cabo Ethernet</strong>
              <p>Wi-Fi adiciona 2-10ms de latência e é menos estável.</p>
            </div>
          </div>
          <div className="tip-item">
            <span className="tip-icon">🔌</span>
            <div>
              <strong>Feche programas em segundo plano</strong>
              <p>Downloads, atualizações e streams consomem banda.</p>
            </div>
          </div>
          <div className="tip-item">
            <span className="tip-icon">🌐</span>
            <div>
              <strong>Use DNS otimizado</strong>
              <p>Configure na aba DNS um servidor mais próximo de você.</p>
            </div>
          </div>
          <div className="tip-item">
            <span className="tip-icon">🖥️</span>
            <div>
              <strong>Desative VPN durante jogos</strong>
              <p>VPNs adicionam uma camada extra de latência.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Resultados */}
      {results.length > 0 && (
        <div className="card results-card">
          <div className="card-header">
            <h3>📋 Histórico de Otimizações</h3>
            <button className="btn btn-outline btn-sm" onClick={() => setResults([])}>
              Limpar
            </button>
          </div>
          <div className="results-list">
            {results.map((result, index) => (
              <div key={index} className={`result-item ${result.success ? 'result-success' : 'result-error'}`}>
                <div className="result-header">
                  <span className="result-status">{result.success ? '✅' : '❌'}</span>
                  <span className="result-title">{result.title}</span>
                  <span className="result-time">{result.time}</span>
                </div>
                <p className="result-message">{result.message}</p>
                {result.details && (
                  <div className="result-details">
                    {result.details.map((detail, i) => (
                      <div key={i} className="detail-line">
                        {typeof detail === 'string' ? detail : `${detail.success ? '✅' : '❌'} ${detail.cmd}`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Optimizer;