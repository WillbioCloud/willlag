import React, { useState, useEffect, useRef } from 'react';
import './NetworkMonitor.css';

const { ipcRenderer } = window.require('electron');

function NetworkMonitor({ showNotification }) {
  const [pingHistory, setPingHistory] = useState([]);
  const [host, setHost] = useState('8.8.8.8');
  const [monitoring, setMonitoring] = useState(false);
  const [connections, setConnections] = useState([]);
  const [stats, setStats] = useState({ min: 0, max: 0, avg: 0, jitter: 0, loss: 0 });
  const maxHistory = 60;
  const canvasRef = useRef(null);

  useEffect(() => {
    loadConnections();
    const connInterval = setInterval(loadConnections, 10000);
    return () => clearInterval(connInterval);
  }, []);

  useEffect(() => {
    const handler = (event, data) => {
      setPingHistory(prev => {
        const newHistory = [...prev, data].slice(-maxHistory);
        calculateStats(newHistory);
        return newHistory;
      });
    };

    ipcRenderer.on('ping-result', handler);

    return () => {
      ipcRenderer.removeListener('ping-result', handler);
    };
  }, []);

  useEffect(() => {
    drawGraph();
  }, [pingHistory]);

  const loadConnections = async () => {
    const conns = await ipcRenderer.invoke('get-network-connections');
    setConnections(conns);
  };

  const calculateStats = (history) => {
    const validPings = history.filter(p => p.ms >= 0).map(p => p.ms);
    if (validPings.length === 0) return;

    const min = Math.min(...validPings);
    const max = Math.max(...validPings);
    const avg = Math.round(validPings.reduce((a, b) => a + b, 0) / validPings.length);

    // Calcular jitter (variação média)
    let jitterSum = 0;
    for (let i = 1; i < validPings.length; i++) {
      jitterSum += Math.abs(validPings[i] - validPings[i - 1]);
    }
    const jitter = validPings.length > 1 ? Math.round(jitterSum / (validPings.length - 1)) : 0;

    // Calcular perda de pacotes
    const totalPings = history.length;
    const lostPings = history.filter(p => p.ms < 0).length;
    const loss = totalPings > 0 ? Math.round((lostPings / totalPings) * 100) : 0;

    setStats({ min, max, avg, jitter, loss });
  };

  const drawGraph = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 20, right: 20, bottom: 30, left: 50 };

    // Limpar canvas
    ctx.clearRect(0, 0, width, height);

    if (pingHistory.length < 2) {
      ctx.fillStyle = '#555577';
      ctx.font = '13px Inter';
      ctx.textAlign = 'center';
      ctx.fillText('Aguardando dados...', width / 2, height / 2);
      return;
    }

    const validPings = pingHistory.map(p => p.ms >= 0 ? p.ms : null);
    const maxPing = Math.max(...validPings.filter(p => p !== null), 100);

    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;

    // Grid lines
    ctx.strokeStyle = 'rgba(30, 30, 74, 0.8)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (graphHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      // Labels
      const value = Math.round(maxPing - (maxPing / 4) * i);
      ctx.fillStyle = '#555577';
      ctx.font = '10px JetBrains Mono';
      ctx.textAlign = 'right';
      ctx.fillText(`${value}ms`, padding.left - 8, y + 4);
    }

    // Desenhar linha do gráfico
    const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
    gradient.addColorStop(0, 'rgba(108, 92, 231, 0.8)');
    gradient.addColorStop(1, 'rgba(108, 92, 231, 0.1)');

    // Área preenchida
    ctx.beginPath();
    let firstValid = true;
    for (let i = 0; i < validPings.length; i++) {
      if (validPings[i] === null) continue;
      const x = padding.left + (i / (maxHistory - 1)) * graphWidth;
      const y = padding.top + graphHeight - (validPings[i] / maxPing) * graphHeight;

      if (firstValid) {
        ctx.moveTo(x, height - padding.bottom);
        ctx.lineTo(x, y);
        firstValid = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    // Fechar o path para preencher
    for (let i = validPings.length - 1; i >= 0; i--) {
      if (validPings[i] !== null) {
        const x = padding.left + (i / (maxHistory - 1)) * graphWidth;
        ctx.lineTo(x, height - padding.bottom);
        break;
      }
    }
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Linha principal
    ctx.beginPath();
    firstValid = true;
    for (let i = 0; i < validPings.length; i++) {
      if (validPings[i] === null) {
        firstValid = true;
        continue;
      }
      const x = padding.left + (i / (maxHistory - 1)) * graphWidth;
      const y = padding.top + graphHeight - (validPings[i] / maxPing) * graphHeight;

      if (firstValid) {
        ctx.moveTo(x, y);
        firstValid = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = '#6c5ce7';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Pontos
    for (let i = 0; i < validPings.length; i++) {
      if (validPings[i] === null) continue;
      const x = padding.left + (i / (maxHistory - 1)) * graphWidth;
      const y = padding.top + graphHeight - (validPings[i] / maxPing) * graphHeight;

      // Cor baseada no valor
      let color = '#00d68f';
      if (validPings[i] > 100) color = '#ff4757';
      else if (validPings[i] > 60) color = '#ffaa00';

      if (i === validPings.length - 1) {
        // Último ponto maior
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Pontos de perda de pacote (X vermelho)
    for (let i = 0; i < pingHistory.length; i++) {
      if (pingHistory[i].ms < 0) {
        const x = padding.left + (i / (maxHistory - 1)) * graphWidth;
        const y = padding.top + 10;

        ctx.strokeStyle = '#ff4757';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x + 4, y + 4);
        ctx.moveTo(x + 4, y - 4);
        ctx.lineTo(x - 4, y + 4);
        ctx.stroke();
      }
    }
  };

  const startMonitoring = () => {
    setPingHistory([]);
    setMonitoring(true);
    ipcRenderer.send('start-ping-monitor', host);
    showNotification(`Monitorando ${host}...`, 'info');
  };

  const stopMonitoring = () => {
    setMonitoring(false);
    ipcRenderer.send('stop-ping-monitor');
    showNotification('Monitoramento parado', 'info');
  };

  return (
    <div className="network-monitor">
      <div className="page-header">
        <h1>📡 Monitor de Rede</h1>
        <p>Monitore a latência em tempo real e conexões ativas</p>
      </div>

      {/* Controles */}
      <div className="monitor-controls card">
        <div className="monitor-input-group">
          <label>Host / IP para monitorar:</label>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="Ex: 8.8.8.8 ou google.com"
            disabled={monitoring}
          />
        </div>
        <div className="monitor-presets">
          {[
            { label: 'Google DNS', value: '8.8.8.8' },
            { label: 'Cloudflare', value: '1.1.1.1' },
            { label: 'Riot Games', value: '104.160.131.3' },
            { label: 'Valve/Steam', value: '155.133.248.34' },
          ].map(preset => (
            <button
              key={preset.value}
              className={`btn btn-outline btn-sm ${host === preset.value ? 'active-preset' : ''}`}
              onClick={() => setHost(preset.value)}
              disabled={monitoring}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="monitor-actions">
          {!monitoring ? (
            <button className="btn btn-success" onClick={startMonitoring}>
              ▶ Iniciar Monitoramento
            </button>
          ) : (
            <button className="btn btn-danger" onClick={stopMonitoring}>
              ⏹ Parar
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="monitor-stats">
        <div className="stat-item">
          <span className="stat-label">Mínimo</span>
          <span className="stat-value" style={{ color: 'var(--success)' }}>{stats.min}ms</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Máximo</span>
          <span className="stat-value" style={{ color: 'var(--danger)' }}>{stats.max}ms</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Média</span>
          <span className="stat-value" style={{ color: 'var(--accent-secondary)' }}>{stats.avg}ms</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Jitter</span>
          <span className="stat-value" style={{ color: 'var(--warning)' }}>{stats.jitter}ms</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Perda</span>
          <span className="stat-value" style={{ color: stats.loss > 0 ? 'var(--danger)' : 'var(--success)' }}>
            {stats.loss}%
          </span>
        </div>
      </div>

      {/* Gráfico */}
      <div className="card graph-card">
        <div className="card-header">
          <h3>📈 Latência em Tempo Real</h3>
          <span className="graph-host">{host}</span>
        </div>
        <div className="graph-container">
          <canvas ref={canvasRef} className="ping-canvas" />
        </div>
      </div>

      {/* Conexões ativas */}
      <div className="card" style={{ marginTop: '20px' }}>
        <div className="card-header">
          <h3>🔗 Conexões Ativas ({connections.length})</h3>
          <button className="btn btn-outline btn-sm" onClick={loadConnections}>
            🔄 Atualizar
          </button>
        </div>
        <div className="connections-list">
          {connections.slice(0, 15).map((conn, index) => (
            <div key={index} className="connection-item">
              <span className="conn-pid">PID: {conn.pid}</span>
              <span className="conn-local">:{conn.localPort}</span>
              <span className="conn-arrow">→</span>
              <span className="conn-remote">{conn.remoteAddress}:{conn.remotePort}</span>
              <span className="badge badge-success">{conn.state}</span>
            </div>
          ))}
          {connections.length === 0 && (
            <div className="empty-state">Nenhuma conexão ativa encontrada</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default NetworkMonitor;