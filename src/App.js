import React, { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import ProcessList from './components/ProcessList';
import NetworkMonitor from './components/NetworkMonitor';
import Optimizer from './components/Optimizer';
import DNSChanger from './components/DNSChanger';
import './App.css';

const { ipcRenderer } = window.require('electron');

function App() {
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [isAdmin, setIsAdmin] = useState(false);
  const [notification, setNotification] = useState(null);

  useEffect(() => {
    ipcRenderer.invoke('check-admin').then(setIsAdmin);
  }, []);

  const showNotification = (message, type = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard':
        return <Dashboard isAdmin={isAdmin} showNotification={showNotification} />;
      case 'processes':
        return <ProcessList isAdmin={isAdmin} showNotification={showNotification} />;
      case 'monitor':
        return <NetworkMonitor showNotification={showNotification} />;
      case 'optimizer':
        return <Optimizer isAdmin={isAdmin} showNotification={showNotification} />;
      case 'dns':
        return <DNSChanger isAdmin={isAdmin} showNotification={showNotification} />;
      default:
        return <Dashboard isAdmin={isAdmin} showNotification={showNotification} />;
    }
  };

  return (
    <div className="app">
      {/* Title Bar customizada */}
      <div className="title-bar">
        <div className="title-bar-drag">
          <div className="title-bar-icon">⚡</div>
          <span className="title-bar-text">Net Optimizer</span>
          {!isAdmin && <span className="admin-warning">⚠ Sem privilégios de Admin</span>}
        </div>
        <div className="title-bar-buttons">
          <button className="tb-btn minimize" onClick={() => ipcRenderer.send('minimize-window')}>
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button className="tb-btn maximize" onClick={() => ipcRenderer.send('maximize-window')}>
            <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
          </button>
          <button className="tb-btn close" onClick={() => ipcRenderer.send('close-window')}>
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
        </div>
      </div>

      <div className="app-body">
        <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} />
        <main className="main-content">
          {renderPage()}
        </main>
      </div>

      {/* Notificações */}
      {notification && (
        <div className={`notification notification-${notification.type}`}>
          <span>{notification.type === 'success' ? '✅' : notification.type === 'error' ? '❌' : 'ℹ️'}</span>
          <span>{notification.message}</span>
        </div>
      )}
    </div>
  );
}

export default App;