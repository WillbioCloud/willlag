import React from 'react';
import './Sidebar.css';

const menuItems = [
  { id: 'lowlatency', icon: '🚀', label: 'Ultra Low-Latency', badge: 'novo' },
  { id: 'dashboard', icon: '📊', label: 'Dashboard' },
  { id: 'processes', icon: '🎮', label: 'Processos' },
  { id: 'monitor', icon: '📡', label: 'Monitor de Rede' },
  { id: 'optimizer', icon: '⚡', label: 'Otimizador' },
  { id: 'dns', icon: '🌐', label: 'DNS & MTU' },
];

function Sidebar({ currentPage, onPageChange, gameModeActive }) {
  return (
    <nav className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon">⚡</div>
        <div className="logo-text">
          <span className="logo-name">willLag</span>
          <span className="logo-version">v2.0 · low-latency</span>
        </div>
      </div>

      <div className="sidebar-menu">
        {menuItems.map(item => (
          <button
            key={item.id}
            className={`sidebar-item ${currentPage === item.id ? 'active' : ''}`}
            onClick={() => onPageChange(item.id)}
          >
            <span className="sidebar-item-icon">{item.icon}</span>
            <span className="sidebar-item-label">{item.label}</span>
            {item.badge && currentPage !== item.id && (
              <span className="sidebar-item-badge">{item.badge}</span>
            )}
            {currentPage === item.id && <div className="sidebar-indicator" />}
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        {gameModeActive && (
          <div className="sidebar-mode-badge">
            <span className="mode-dot" />
            <div>
              <strong>Modo Jogo ativo</strong>
              <small>Reverte ao fechar o app</small>
            </div>
          </div>
        )}
        <div className="sidebar-status">
          <div className={`status-dot ${gameModeActive ? 'dot-boost' : ''}`} />
          <span>{gameModeActive ? 'Latência otimizada' : 'Sistema Ativo'}</span>
        </div>
      </div>
    </nav>
  );
}

export default Sidebar;
