import React from 'react';
import './Sidebar.css';

const menuItems = [
  { id: 'dashboard', icon: '📊', label: 'Dashboard' },
  { id: 'processes', icon: '🎮', label: 'Processos' },
  { id: 'monitor', icon: '📡', label: 'Monitor de Rede' },
  { id: 'optimizer', icon: '⚡', label: 'Otimizador' },
  { id: 'dns', icon: '🌐', label: 'DNS' },
];

function Sidebar({ currentPage, onPageChange }) {
  return (
    <nav className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon">⚡</div>
        <div className="logo-text">
          <span className="logo-name">NetOpt</span>
          <span className="logo-version">v1.0</span>
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
            {currentPage === item.id && <div className="sidebar-indicator" />}
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-status">
          <div className="status-dot" />
          <span>Sistema Ativo</span>
        </div>
      </div>
    </nav>
  );
}

export default Sidebar;