import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import ProcessList from './components/ProcessList';
import NetworkMonitor from './components/NetworkMonitor';
import Optimizer from './components/Optimizer';
import DNSChanger from './components/DNSChanger';
import LowLatencyMode from './components/LowLatencyMode';
import ipc from './services/ipc';
import './App.css';

function App() {
  const [currentPage, setCurrentPage] = useState('lowlatency');
  const [isAdmin, setIsAdmin] = useState(false);
  const [notification, setNotification] = useState(null);
  const [gameModeActive, setGameModeActive] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState(null);

  const showNotification = useCallback((message, type = 'info', duration = 4000) => {
    setNotification({ message, type, id: Date.now() });
    setTimeout(() => setNotification((prev) => (prev && prev.message === message ? null : prev)), duration);
  }, []);

  useEffect(() => {
    let alive = true;

    ipc.invoke('check-admin')
      .then((v) => { if (alive) setIsAdmin(Boolean(v)); })
      .catch(() => {});

    ipc.invoke('gamemode-status')
      .then((s) => { if (alive && s) setGameModeActive(Boolean(s.active)); })
      .catch(() => {});

    const offState = ipc.on('gamemode-state', (payload) => {
      if (payload && payload.status) setGameModeActive(Boolean(payload.status.active));
    });

    const offRecovery = ipc.on('recovery-notice', (payload) => {
      if (payload && payload.message) setRecoveryNotice(payload.message);
    });

    // Reavalia privilégios periodicamente: o usuário pode elevar/reelevar o app.
    const adminTimer = setInterval(() => {
      ipc.invoke('check-admin')
        .then((v) => setIsAdmin(Boolean(v)))
        .catch(() => {});
    }, 20000);

    return () => {
      alive = false;
      if (typeof offState === 'function') offState();
      if (typeof offRecovery === 'function') offRecovery();
      clearInterval(adminTimer);
    };
  }, []);

  const renderPage = () => {
    const common = { isAdmin, showNotification, demoMode: ipc.isDemo };

    switch (currentPage) {
      case 'lowlatency':
        return <LowLatencyMode {...common} />;
      case 'dashboard':
        return <Dashboard {...common} />;
      case 'processes':
        return <ProcessList {...common} />;
      case 'monitor':
        return <NetworkMonitor {...common} />;
      case 'optimizer':
        return <Optimizer {...common} onNavigate={setCurrentPage} />;
      case 'dns':
        return <DNSChanger {...common} />;
      default:
        return <LowLatencyMode {...common} />;
    }
  };

  return (
    <div className="app">
      {/* Title Bar customizada */}
      <div className="title-bar">
        <div className="title-bar-drag">
          <div className="title-bar-icon">⚡</div>
          <span className="title-bar-text">willLag</span>

          {gameModeActive && (
            <span className="title-pill title-pill-on" title="Modo Ultra Low-Latency ativo — ajustes de sessão serão revertidos ao fechar o app">
              <span className="title-pill-dot" />
              MODO JOGO
            </span>
          )}

          {ipc.isDemo && (
            <span className="title-pill title-pill-demo" title="Rodando no navegador: nada é alterado no sistema">
              DEMO
            </span>
          )}

          {!isAdmin && !ipc.isDemo && (
            <span className="admin-warning">⚠ Sem privilégios de Admin</span>
          )}
        </div>
        <div className="title-bar-buttons">
          <button className="tb-btn minimize" onClick={() => ipc.send('minimize-window')} aria-label="Minimizar">
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button className="tb-btn maximize" onClick={() => ipc.send('maximize-window')} aria-label="Maximizar">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
          </button>
          <button className="tb-btn close" onClick={() => ipc.send('close-window')} aria-label="Fechar">
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
        </div>
      </div>

      <div className="app-body">
        <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} gameModeActive={gameModeActive} />
        <main className="main-content">
          {renderPage()}
        </main>
      </div>

      {/* Aviso de recuperação pós-crash (persistente até o usuário fechar) */}
      {recoveryNotice && (
        <div className="recovery-banner">
          <span>🛡️</span>
          <div>
            <strong>Restauração automática executada</strong>
            <p>{recoveryNotice}</p>
          </div>
          <button className="tb-btn" onClick={() => setRecoveryNotice(null)} aria-label="Fechar aviso">✕</button>
        </div>
      )}

      {/* Notificações */}
      {notification && (
        <div key={notification.id} className={`notification notification-${notification.type}`}>
          <span>{notification.type === 'success' ? '✅' : notification.type === 'error' ? '❌' : 'ℹ️'}</span>
          <span>{notification.message}</span>
        </div>
      )}
    </div>
  );
}

export default App;
