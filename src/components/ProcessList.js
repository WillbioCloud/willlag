import React, { useState, useEffect, useCallback } from 'react';
import './ProcessList.css';

const { ipcRenderer } = window.require('electron');

function ProcessList({ isAdmin, showNotification }) {
  const [processes, setProcesses] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [optimizingPid, setOptimizingPid] = useState(null);

  const loadProcesses = useCallback(async () => {
    setLoading(true);
    const procs = await ipcRenderer.invoke('get-processes');
    setProcesses(procs);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadProcesses();
    const interval = setInterval(loadProcesses, 5000);
    return () => clearInterval(interval);
  }, [loadProcesses]);

  const handleOptimize = async (process) => {
    if (!isAdmin) {
      showNotification('Execute o aplicativo como Administrador!', 'error');
      return;
    }

    setOptimizingPid(process.pid);
    const result = await ipcRenderer.invoke('optimize-for-process', process.pid, process.name);

    if (result.success) {
      showNotification(result.message, 'success');
    } else {
      showNotification(result.message, 'error');
    }
    setOptimizingPid(null);
  };

  const handleSetPriority = async (pid, priority) => {
    const result = await ipcRenderer.invoke('set-process-priority', pid, priority);
    if (result.success) {
      showNotification(result.message, 'success');
    } else {
      showNotification(result.message, 'error');
    }
  };

  const handleSetNetworkPriority = async (processName) => {
    if (!isAdmin) {
      showNotification('Execute o aplicativo como Administrador!', 'error');
      return;
    }

    const result = await ipcRenderer.invoke('set-network-priority', processName);
    if (result.success) {
      showNotification(result.message, 'success');
    } else {
      showNotification(result.message, 'error');
    }
  };

  const filteredProcesses = processes.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.title.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const gameKeywords = ['game', 'steam', 'epic', 'riot', 'valorant', 'fortnite', 'league',
    'csgo', 'cs2', 'apex', 'overwatch', 'minecraft', 'roblox', 'gta', 'cod',
    'battlenet', 'origin', 'ubisoft', 'blizzard', 'discord'];

  const isGame = (name) => {
    return gameKeywords.some(kw => name.toLowerCase().includes(kw));
  };

  return (
    <div className="process-list">
      <div className="page-header">
        <h1>🎮 Processos Ativos</h1>
        <p>Otimize a prioridade de rede e CPU para seus jogos</p>
      </div>

      <div className="process-controls">
        <div className="search-box">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Buscar processo..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <button className="btn btn-outline" onClick={loadProcesses} disabled={loading}>
          {loading ? <div className="loading-spinner" /> : '🔄'} Atualizar
        </button>
      </div>

      <div className="process-table-container">
        <table className="process-table">
          <thead>
            <tr>
              <th>Processo</th>
              <th>Janela</th>
              <th>PID</th>
              <th>RAM</th>
              <th>CPU</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {filteredProcesses.map((proc) => (
              <tr key={proc.pid} className={isGame(proc.name) ? 'game-process' : ''}>
                <td>
                  <div className="process-name-cell">
                    <span className="process-icon">{isGame(proc.name) ? '🎮' : '📋'}</span>
                    <span className="process-name">{proc.name}</span>
                    {isGame(proc.name) && <span className="badge badge-info">Game</span>}
                  </div>
                </td>
                <td>
                  <span className="process-title">{proc.title}</span>
                </td>
                <td>
                  <span className="process-pid">{proc.pid}</span>
                </td>
                <td>
                  <span className="process-memory">{proc.memory} MB</span>
                </td>
                <td>
                  <span className="process-cpu">{proc.cpu}s</span>
                </td>
                <td>
                  <div className="process-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleOptimize(proc)}
                      disabled={optimizingPid === proc.pid}
                      title="Otimizar para jogos (prioridade alta + QoS)"
                    >
                      {optimizingPid === proc.pid ? <div className="loading-spinner" /> : '⚡'} Boost
                    </button>
                    <select
                      className="priority-select"
                      onChange={(e) => handleSetPriority(proc.pid, e.target.value)}
                      defaultValue=""
                    >
                      <option value="" disabled>Prioridade</option>
                      <option value="Realtime">Tempo Real</option>
                      <option value="High">Alta</option>
                      <option value="AboveNormal">Acima do Normal</option>
                      <option value="Normal">Normal</option>
                      <option value="BelowNormal">Abaixo do Normal</option>
                      <option value="Low">Baixa</option>
                    </select>
                    <button
                      className="btn btn-success btn-sm"
                      onClick={() => handleSetNetworkPriority(proc.name)}
                      title="Definir prioridade máxima de rede (QoS)"
                    >
                      🌐 Net
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredProcesses.length === 0 && (
          <div className="empty-state">
            {loading ? 'Carregando processos...' : 'Nenhum processo encontrado'}
          </div>
        )}
      </div>
    </div>
  );
}

export default ProcessList;