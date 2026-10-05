import React, { useState } from 'react';
import './DNSChanger.css';

const { ipcRenderer } = window.require('electron');

function DNSChanger({ isAdmin, showNotification }) {
  const [customPrimary, setCustomPrimary] = useState('');
  const [customSecondary, setCustomSecondary] = useState('');
  const [testing, setTesting] = useState({});
  const [testResults, setTestResults] = useState({});

  const dnsProviders = [
    {
      name: 'Cloudflare',
      primary: '1.1.1.1',
      secondary: '1.0.0.1',
      description: 'Mais rápido do mundo, foco em privacidade',
      icon: '🟠',
      recommended: true,
    },
    {
      name: 'Google DNS',
      primary: '8.8.8.8',
      secondary: '8.8.4.4',
      description: 'Confiável e estável, infraestrutura global',
      icon: '🔵',
    },
    {
      name: 'Cloudflare Gaming',
      primary: '1.1.1.2',
      secondary: '1.0.0.2',
      description: 'Cloudflare com filtro de malware (proteção extra)',
      icon: '🎮',
      recommended: true,
    },
    {
      name: 'OpenDNS',
      primary: '208.67.222.222',
      secondary: '208.67.220.220',
      description: 'Filtro de conteúdo, bom para segurança',
      icon: '🟢',
    },
    {
      name: 'Quad9',
      primary: '9.9.9.9',
      secondary: '149.112.112.112',
      description: 'Bloqueio de domínios maliciosos',
      icon: '🟣',
    },
    {
      name: 'AdGuard DNS',
      primary: '94.140.14.14',
      secondary: '94.140.15.15',
      description: 'Bloqueia ads e trackers automaticamente',
      icon: '🛡️',
    },
  ];

  const handleChangeDNS = async (primary, secondary, name) => {
    if (!isAdmin) {
      showNotification('Execute como Administrador!', 'error');
      return;
    }

    const result = await ipcRenderer.invoke('change-dns', primary, secondary);
    if (result.success) {
      showNotification(`DNS alterado para ${name}: ${primary} / ${secondary}`, 'success');
    } else {
      showNotification(result.message, 'error');
    }
  };

  const handleFlushDNS = async () => {
    const result = await ipcRenderer.invoke('flush-dns');
    if (result.success) {
      showNotification(result.message, 'success');
    } else {
      showNotification(result.message, 'error');
    }
  };

  const testDNS = async (provider) => {
    setTesting(prev => ({ ...prev, [provider.name]: true }));

    const result = await ipcRenderer.invoke('ping-host', provider.primary);

    setTestResults(prev => ({
      ...prev,
      [provider.name]: result.ms
    }));

    setTesting(prev => ({ ...prev, [provider.name]: false }));
  };

  const testAllDNS = async () => {
    for (const provider of dnsProviders) {
      await testDNS(provider);
    }
    showNotification('Testes concluídos!', 'success');
  };

  const getPingColor = (ms) => {
    if (!ms || ms < 0) return 'var(--text-muted)';
    if (ms <= 20) return 'var(--success)';
    if (ms <= 50) return '#00d68f';
    if (ms <= 100) return 'var(--warning)';
    return 'var(--danger)';
  };

  return (
    <div className="dns-changer">
      <div className="page-header">
        <h1>🌐 Configuração de DNS</h1>
        <p>Escolha o melhor servidor DNS para sua localização</p>
      </div>

      <div className="dns-actions-bar">
        <button className="btn btn-primary" onClick={testAllDNS}>
          🏓 Testar Todos os DNS
        </button>
        <button className="btn btn-outline" onClick={handleFlushDNS}>
          🧹 Limpar Cache DNS
        </button>
      </div>

      {/* DNS Providers Grid */}
      <div className="dns-grid">
        {dnsProviders.map(provider => (
          <div key={provider.name} className={`dns-card card ${provider.recommended ? 'dns-recommended' : ''}`}>
            {provider.recommended && (
              <div className="dns-recommended-badge">⭐ Recomendado</div>
            )}
            <div className="dns-card-header">
              <span className="dns-icon">{provider.icon}</span>
              <div>
                <h3>{provider.name}</h3>
                <p>{provider.description}</p>
              </div>
            </div>

            <div className="dns-addresses">
              <div className="dns-address">
                <span className="dns-label">Primário</span>
                <span className="dns-value">{provider.primary}</span>
              </div>
              <div className="dns-address">
                <span className="dns-label">Secundário</span>
                <span className="dns-value">{provider.secondary}</span>
              </div>
            </div>

            {testResults[provider.name] !== undefined && (
              <div className="dns-test-result">
                <span className="dns-test-label">Latência:</span>
                <span className="dns-test-value" style={{ color: getPingColor(testResults[provider.name]) }}>
                  {testResults[provider.name] >= 0 ? `${testResults[provider.name]}ms` : 'Timeout'}
                </span>
              </div>
            )}

            <div className="dns-card-actions">
              <button
                className="btn btn-outline btn-sm"
                onClick={() => testDNS(provider)}
                disabled={testing[provider.name]}
              >
                {testing[provider.name] ? <div className="loading-spinner" /> : '🏓'} Testar
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => handleChangeDNS(provider.primary, provider.secondary, provider.name)}
                disabled={!isAdmin}
              >
                ✅ Usar este DNS
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* DNS Customizado */}
      <div className="card custom-dns-card">
        <h3>🔧 DNS Personalizado</h3>
        <p className="custom-dns-desc">Configure um servidor DNS personalizado</p>
        <div className="custom-dns-inputs">
          <div className="custom-dns-field">
            <label>DNS Primário</label>
            <input
              type="text"
              placeholder="Ex: 1.1.1.1"
              value={customPrimary}
              onChange={(e) => setCustomPrimary(e.target.value)}
            />
          </div>
          <div className="custom-dns-field">
            <label>DNS Secundário</label>
            <input
              type="text"
              placeholder="Ex: 1.0.0.1"
              value={customSecondary}
              onChange={(e) => setCustomSecondary(e.target.value)}
            />
          </div>
          <button
            className="btn btn-success"
            onClick={() => handleChangeDNS(customPrimary, customSecondary, 'Personalizado')}
            disabled={!isAdmin || !customPrimary || !customSecondary}
          >
            🌐 Aplicar DNS Personalizado
          </button>
        </div>
      </div>
    </div>
  );
}

export default DNSChanger;