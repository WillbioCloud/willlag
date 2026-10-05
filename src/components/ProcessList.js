import React, { useState, useEffect, useCallback } from 'react';
import ipc from '../services/ipc';
import {
  isGame,
  isBandwidthHog,
  isProtected,
  recommendFor,
  filterProcesses,
  PRIORITY_OPTIONS,
} from './utils/processManager';
import './ProcessList.css';


function ProcessList({ isAdmin, showNotification }) {
  const [processes, setProcesses] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [optimizingPid, setOptimizingPid] = useState(null);

  const loadProcesses = useCallback(async () => {
    setLoading(true);
    const procs = await ipc.invoke('get-processes');
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
    const result = await ipc.invoke('optimize-for-process', process.pid, process.name);

    if (result.success) {
      showNotification(result.message, 'success');
    } else {
      showNotification(result.message, 'error');
    }
    setOptimizingPid(null);
  };

  const handleSetPriority = async (pid, priority) => {
    const result = await ipc.invoke('set-process-priority', pid, priority);
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

    const result = await ipc.invoke('set-network-priority', processName);
    if (result.success) {
      showNotification(result.message, 'success');
    } else {
      showNotification(result.message, 'error');
    }
  };

  const filteredProcesses = filterProcesses(processes, searchTerm);

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
            {filteredProcesses.map((proc) => {
              const rec = recommendFor(proc);
              const game = isGame(proc.name);
              const hog = isBandwidthHog(proc.name);
              const locked = isProtected(proc.name);

              return (
              <tr key={proc.pid} className={`${game ? 'game-process' : ''} ${locked ? 'protected-process' : ''} ${hog && !game ? 'hog-process' : ''}`.trim()}>
                <td>
                  <div className="process-name-cell">
                    <span className="process-icon">{locked ? '🛡️' : game ? '🎮' : hog ? '📥' : '📋'}</span>
                    <span className="process-name">{proc.name}</span>
                    {game && <span className="badge badge-info">Game</span>}
                    {locked && <span className="badge badge-danger" title={rec.reason}>Anti-cheat</span>}
                    {!locked && hog && !game && (
                      <span className="badge badge-warning" title={rec.reason}>Consome banda</span>
                    )}
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
                      disabled={optimizingPid === proc.pid || !rec.canBoost}
                      title={rec.reason || 'Otimizar para jogos (prioridade alta + QoS)'}
                    >
                      {optimizingPid === proc.pid ? <div className="loading-spinner" /> : '⚡'} Boost
                    </button>
                    <select
                      className="priority-select"
                      onChange={(e) => handleSetPriority(proc.pid, e.target.value)}
                      defaultValue={proc.priority || ''}
                      disabled={!rec.canPriority}
                      title={rec.reason || 'Prioridade de CPU'}
                    >
                      <option value="" disabled>Prioridade</option>
                      {PRIORITY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <button
                      className="btn btn-success btn-sm"
                      onClick={() => handleSetNetworkPriority(proc.name)}
                      disabled={!rec.canQos}
                      title={rec.reason || 'Definir prioridade máxima de rede (QoS DSCP 46)'}
                    >
                      🌐 Net
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
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