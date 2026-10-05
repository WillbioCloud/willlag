import React, { useState, useEffect } from 'react';
import ipc from '../services/ipc';
import './Dashboard.css';


function Dashboard({ isAdmin, showNotification }) {
  const [pingResults, setPingResults] = useState([]);
  const [networkInfo, setNetworkInfo] = useState([]);
  const [loading, setLoading] = useState(false);
  const [currentPing, setCurrentPing] = useState(null);

  useEffect(() => {
    loadNetworkInfo();
    runQuickPing();

    const handler = (data) => setCurrentPing(data);

    const off = ipc.on('ping-result', handler);
    ipc.send('start-ping-monitor', '8.8.8.8');

    return () => {
      off();
      ipc.send('stop-ping-monitor');
    };
  }, []);

  const loadNetworkInfo = async () => {
    const info = await ipc.invoke('get-network-info');
    setNetworkInfo(info);
  };

  const runQuickPing = async () => {
    setLoading(true);
    const results = await ipc.invoke('speed-test');
    setPingResults(results);
    setLoading(false);
  };

  const getPingColor = (ms) => {
    if (ms < 0) return 'var(--danger)';
    if (ms <= 30) return 'var(--success)';
    if (ms <= 60) return '#00d68f';
    if (ms <= 100) return 'var(--warning)';
    return 'var(--danger)';
  };

  const getPingLabel = (ms) => {
    if (ms < 0) return 'Timeout';
    if (ms <= 20) return 'Excelente';
    if (ms <= 50) return 'Bom';
    if (ms <= 100) return 'Regular';
    return 'Ruim';
  };

  return (
    <div className="dashboard">
      <div className="page-header">
        <h1>⚡ Dashboard</h1>
        <p>Visão geral da sua conexão de rede</p>
      </div>

      {/* Status Cards */}
      <div className="status-cards">
        <div className="status-card">
          <div className="status-card-icon" style={{ background: 'rgba(108, 92, 231, 0.15)' }}>📡</div>
          <div className="status-card-info">
            <span className="status-card-label">Ping Atual</span>
            <span className="status-card-value" style={{ color: currentPing ? getPingColor(currentPing.ms) : 'var(--text-secondary)' }}>
              {currentPing ? (currentPing.ms >= 0 ? `${currentPing.ms}ms` : 'Timeout') : '---'}
            </span>
          </div>
        </div>

        <div className="status-card">
          <div className="status-card-icon" style={{ background: 'rgba(0, 214, 143, 0.15)' }}>🌐</div>
          <div className="status-card-info">
            <span className="status-card-label">Status</span>
            <span className="status-card-value" style={{ color: 'var(--success)' }}>
              {currentPing && currentPing.ms >= 0 ? 'Conectado' : 'Verificando...'}
            </span>
          </div>
        </div>

        <div className="status-card">
          <div className="status-card-icon" style={{ background: 'rgba(255, 170, 0, 0.15)' }}>🔑</div>
          <div className="status-card-info">
            <span className="status-card-label">Privilégios</span>
            <span className="status-card-value" style={{ color: isAdmin ? 'var(--success)' : 'var(--warning)' }}>
              {isAdmin ? 'Administrador' : 'Usuário'}
            </span>
          </div>
        </div>

        <div className="status-card">
          <div className="status-card-icon" style={{ background: 'rgba(0, 149, 255, 0.15)' }}>💻</div>
          <div className="status-card-info">
            <span className="status-card-label">Qualidade</span>
            <span className="status-card-value" style={{ color: currentPing ? getPingColor(currentPing.ms) : 'var(--text-secondary)' }}>
              {currentPing ? getPingLabel(currentPing.ms) : '---'}
            </span>
          </div>
        </div>
      </div>

      {/* Network Info */}
      <div className="dashboard-grid">
        <div className="card">
          <div className="card-header">
            <h3>🖧 Interfaces de Rede</h3>
          </div>
          <div className="network-interfaces">
            {networkInfo.map((iface, index) => (
              <div key={index} className="interface-item">
                <div className="interface-name">{iface.name}</div>
                <div className="interface-details">
                  <span className="interface-ip">{iface.address}</span>
                  <span className="interface-mac">{iface.mac}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>🏓 Teste de Latência</h3>
            <button className="btn btn-primary btn-sm" onClick={runQuickPing} disabled={loading}>
              {loading ? <><div className="loading-spinner" /> Testando...</> : '🔄 Testar'}
            </button>
          </div>
          <div className="ping-results">
            {pingResults.map((result, index) => (
              <div key={index} className="ping-item">
                <div className="ping-info">
                  <span className="ping-name">{result.name}</span>
                  <span className="ping-host">{result.host}</span>
                </div>
                <div className="ping-value" style={{ color: getPingColor(result.avgMs) }}>
                  {result.avgMs >= 0 ? `${result.avgMs}ms` : 'Timeout'}
                </div>
                <div className="ping-bar-container">
                  <div
                    className="ping-bar"
                    style={{
                      width: result.avgMs >= 0 ? `${Math.min(100, (result.avgMs / 200) * 100)}%` : '100%',
                      background: getPingColor(result.avgMs)
                    }}
                  />
                </div>
              </div>
            ))}
            {pingResults.length === 0 && !loading && (
              <div className="empty-state">Clique em "Testar" para verificar a latência</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Dashboard;