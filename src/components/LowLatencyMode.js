import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ipc from '../services/ipc';
import TweakRow from './TweakRow';
import {
  formatMs,
  formatPercent,
  latencyColor,
  jitterColor,
  lossColor,
  formatDelta,
  formatTime,
} from './utils/networkOptimizer';
import './LowLatencyMode.css';

/** Mapa tweak -> chave de parâmetro aceita pelo processo principal. */
const PARAM_KEY = {
  systemResponsiveness: { key: 'systemResponsiveness', numeric: true },
  autoTuning: { key: 'autoTuning' },
  ecn: { key: 'ecn' },
  rsc: { key: 'rsc' },
  timestamps: { key: 'timestamps' },
  initialRto: { key: 'initialRto' },
  congestionProvider: { key: 'congestionProvider' },
  autoDns: { key: 'dns' },
  mtuOptimize: { key: 'mtu', numeric: true },
  nagle: { key: 'allInterfaces', boolean: true },
};

function buildParams(selectedIds, paramValues) {
  const params = {};
  for (const id of selectedIds) {
    const spec = PARAM_KEY[id];
    const raw = paramValues[id];
    if (!spec || raw === undefined || raw === null || raw === '') continue;
    if (spec.numeric) params[spec.key] = Number(raw);
    else if (spec.boolean) params[spec.key] = raw === true || raw === 'true';
    else params[spec.key] = raw;
  }
  return params;
}

function Sparkline({ samples, width = 620, height = 68 }) {
  if (!samples || samples.length < 2) {
    return (
      <div className="spark-empty" style={{ width: '100%', height }}>
        Coletando amostras do watchdog…
      </div>
    );
  }

  const values = samples.map((s) => (s.avg === null || s.avg === undefined ? 0 : s.avg));
  const max = Math.max(...values, 10) * 1.15;
  const step = width / Math.max(1, samples.length - 1);

  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`).join(' ');
  const areaPoints = `0,${height} ${points} ${((samples.length - 1) * step).toFixed(1)},${height}`;

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width="100%" height={height}>
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(108,92,231,0.55)" />
          <stop offset="100%" stopColor="rgba(108,92,231,0.03)" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill="url(#sparkGrad)" />
      <polyline points={points} fill="none" stroke="#a29bfe" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      {samples.map((s, i) =>
        s.gateway === false || s.internet === false ? (
          <circle key={i} cx={i * step} cy={height - (values[i] / max) * height} r="3" fill="#ff4757" />
        ) : null
      )}
    </svg>
  );
}

function MetricBox({ label, value, unit, color, delta }) {
  const d = delta ? formatDelta(delta.delta, unit === '%' ? '%' : 'ms') : null;
  return (
    <div className="metric-box">
      <span className="metric-label">{label}</span>
      <span className="metric-value" style={{ color }}>
        {value}
        {value !== '—' && unit && <small>{unit}</small>}
      </span>
      {d && d.tone !== 'neutral' && (
        <span className={`metric-delta delta-${d.tone}`} title="Variação em relação à medição anterior (baseline)">
          {d.text}
        </span>
      )}
    </div>
  );
}

function LowLatencyMode({ isAdmin, showNotification, demoMode }) {
  const [catalog, setCatalog] = useState(null);
  const [states, setStates] = useState({});
  const [selected, setSelected] = useState([]);
  const [params, setParams] = useState({});
  const [gamemode, setGamemode] = useState({ active: false, busy: false, watchdog: { samples: [] } });
  const [elevation, setElevation] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [globalBusy, setGlobalBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [history, setHistory] = useState([]);
  const [detecting, setDetecting] = useState(true);
  const [preset, setPreset] = useState('ultra');
  const [activeGroup, setActiveGroup] = useState('all');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pushHistory = useCallback((entry) => {
    if (!mounted.current) return;
    setHistory((prev) => [{ ts: Date.now(), ...entry }, ...prev].slice(0, 40));
  }, []);

  const pushAlert = useCallback((alert) => {
    if (!mounted.current) return;
    setAlerts((prev) => [{ id: `${Date.now()}-${Math.random()}`, ...alert }, ...prev].slice(0, 5));
  }, []);

  /* ---------------- carga inicial ---------------- */
  const loadAll = useCallback(async (force = false) => {
    setDetecting(true);
    try {
      const [cat, detailed, elev, gm] = await Promise.all([
        ipc.invoke('get-tweaks'),
        ipc.invoke('get-tweaks-detailed', { force, concurrency: 3 }),
        ipc.invoke('get-elevation-status'),
        ipc.invoke('gamemode-status'),
      ]);

      if (!mounted.current) return;

      setCatalog(cat);
      setStates(detailed.detection || {});
      setElevation(elev);
      setGamemode(gm || { active: false, busy: false, watchdog: { samples: [] } });

      // Seleção: usa a salva; senão, o preset padrão do catálogo.
      const saved = cat.settings && Array.isArray(cat.settings.selectedTweaks) ? cat.settings.selectedTweaks : null;
      const defaultPreset = (cat.presets || []).find((p) => p.id === (cat.settings && cat.settings.ultraPreset) || 'ultra');
      setSelected(saved && saved.length ? saved : defaultPreset ? defaultPreset.tweakIds : []);

      // Parâmetros salvos (ex.: SystemResponsiveness=10).
      if (cat.settings) {
        const restored = {};
        if (cat.settings.systemResponsiveness !== undefined && cat.settings.systemResponsiveness !== null) {
          restored.systemResponsiveness = String(cat.settings.systemResponsiveness);
        }
        if (cat.settings.congestionProvider) restored.congestionProvider = cat.settings.congestionProvider;
        if (cat.settings.autoTuning) restored.autoTuning = cat.settings.autoTuning;
        if (cat.settings.ecn) restored.ecn = cat.settings.ecn;
        if (cat.settings.dnsProvider) restored.autoDns = cat.settings.dnsProvider;
        if (cat.settings.mtu) restored.mtuOptimize = String(cat.settings.mtu);
        setParams(restored);
      }
    } catch (err) {
      showNotification(`Erro ao carregar os ajustes: ${err.message}`, 'error');
    } finally {
      if (mounted.current) setDetecting(false);
    }
  }, [showNotification]);

  useEffect(() => {
    loadAll(false);
  }, [loadAll]);

  /* ---------------- eventos do backend ---------------- */
  useEffect(() => {
    const offs = [
      ipc.on('gamemode-state', (payload) => {
        if (!mounted.current || !payload) return;
        if (payload.status) setGamemode(payload.status);
        setGlobalBusy(false);
        setProgress(null);
        if (payload.result) {
          pushHistory({
            kind: payload.result.active ? 'gamemode-on' : payload.result.success ? 'gamemode-off' : 'gamemode-error',
            message: payload.result.message,
            success: Boolean(payload.result.success),
          });
          if (payload.result.code === 'UAC_DENIED') {
            pushAlert({ severity: 'warn', title: 'Permissão negada (UAC)', detail: payload.result.message });
          }
          if (payload.result.code === 'CONNECTIVITY_GUARD_FAILED') {
            pushAlert({ severity: 'danger', title: 'Guarda de conectividade reverteu tudo', detail: payload.result.message });
          }
          if (payload.result.improvement) {
            const imp = payload.result.improvement;
            showNotification(
              `Modo ativo — latência ${imp.avg.before}→${imp.avg.after}ms, jitter ${imp.jitter.before}→${imp.jitter.after}ms`,
              'success'
            );
          } else if (payload.result.message) {
            showNotification(payload.result.message, payload.result.success ? 'success' : 'error');
          }
          // Re-lê o estado real dos tweaks após a operação.
          loadAll(true);
        }
      }),

      ipc.on('gamemode-progress', (payload) => {
        if (!mounted.current || !payload) return;
        setGlobalBusy(true);
        setProgress(payload);
      }),

      ipc.on('gamemode-metrics', (payload) => {
        if (!mounted.current || !payload || !payload.status) return;
        setGamemode(payload.status);
      }),

      ipc.on('gamemode-alert', (payload) => {
        if (!mounted.current || !payload || !payload.alert) return;
        const a = payload.alert;
        pushAlert({
          severity: a.type === 'connectivity-lost' ? 'danger' : 'warn',
          title: a.type === 'connectivity-lost' ? 'Conectividade perdida' : 'Conectividade instável',
          detail: a.message,
        });
        showNotification(a.message, a.type === 'connectivity-lost' ? 'error' : 'info');
        if (payload.status) setGamemode(payload.status);
      }),

      ipc.on('tweak-updated', (payload) => {
        if (!mounted.current || !payload || !payload.id) return;
        ipc.invoke('detect-tweak', payload.id, { force: true }).then((st) => {
          if (mounted.current && st) setStates((prev) => ({ ...prev, [payload.id]: st }));
        });
      }),

      ipc.on('recovery-notice', (payload) => {
        if (!mounted.current || !payload) return;
        pushAlert({ severity: 'warn', title: 'Recuperação automática', detail: payload.message });
      }),
    ];

    return () => offs.forEach((off) => typeof off === 'function' && off());
  }, [loadAll, pushAlert, pushHistory, showNotification]);

  /* ---------------- ações ---------------- */
  const persistSelection = useCallback(
    (ids) => {
      setSelected(ids);
      ipc.invoke('set-settings', { selectedTweaks: ids }).catch(() => {});
    },
    []
  );

  const handleSelect = useCallback(
    (id, value) => {
      setSelected((prev) => {
        const next = value ? [...new Set([...prev, id])] : prev.filter((x) => x !== id);
        ipc.invoke('set-settings', { selectedTweaks: next }).catch(() => {});
        return next;
      });
    },
    []
  );

  const handleParam = useCallback((id, value) => {
    setParams((prev) => ({ ...prev, [id]: value }));
    const spec = PARAM_KEY[id];
    if (!spec) return;
    const patch = {};
    if (id === 'systemResponsiveness') patch.systemResponsiveness = value === '' ? null : Number(value);
    if (id === 'congestionProvider') patch.congestionProvider = value || null;
    if (id === 'autoTuning') patch.autoTuning = value || null;
    if (id === 'ecn') patch.ecn = value || null;
    if (id === 'autoDns') patch.dnsProvider = value || null;
    if (id === 'mtuOptimize') patch.mtu = value ? Number(value) : null;
    if (Object.keys(patch).length) ipc.invoke('set-settings', patch).catch(() => {});
  }, []);

  const handleApplyOne = useCallback(
    async (id) => {
      const tweak = (catalog && catalog.tweaks.find((t) => t.id === id)) || null;
      setBusyId(id);
      pushHistory({ kind: 'apply', message: `Aplicando: ${tweak ? tweak.label : id}`, success: true, pending: true });

      const res = await ipc.invoke('apply-tweak', id, buildParams([id], params));

      if (!mounted.current) return;
      setBusyId(null);
      pushHistory({ kind: 'apply', message: res.message || `${id}`, success: Boolean(res.success), id });

      if (res.success) showNotification(res.message, 'success');
      else if (res.code === 'UAC_DENIED') {
        showNotification('Permissão de Administrador negada — nada foi alterado.', 'error');
        pushAlert({ severity: 'warn', title: 'Permissão negada (UAC)', detail: res.message });
      } else showNotification(res.message || 'Falha ao aplicar o ajuste.', 'error');

      const st = await ipc.invoke('detect-tweak', id, { force: true });
      if (mounted.current && st) setStates((prev) => ({ ...prev, [id]: st }));
    },
    [catalog, params, pushHistory, showNotification, pushAlert]
  );

  const handleRevertOne = useCallback(
    async (id) => {
      const tweak = (catalog && catalog.tweaks.find((t) => t.id === id)) || null;
      setBusyId(id);
      const res = await ipc.invoke('revert-tweak', id);
      if (!mounted.current) return;
      setBusyId(null);
      pushHistory({ kind: 'revert', message: res.message || `${id}`, success: Boolean(res.success), id });
      showNotification(res.message, res.success ? 'success' : 'error');

      const st = await ipc.invoke('detect-tweak', id, { force: true });
      if (mounted.current && st) setStates((prev) => ({ ...prev, [id]: st }));
      if (tweak && tweak.scope === 'session' && !res.success) {
        pushAlert({ severity: 'danger', title: 'Reversão pendente', detail: res.message });
      }
    },
    [catalog, pushHistory, showNotification, pushAlert]
  );

  const handleToggleMode = useCallback(async () => {
    if (globalBusy) return;

    if (gamemode.active) {
      setGlobalBusy(true);
      setProgress({ phase: 'revert', message: 'Desativando e restaurando o sistema…' });
      const res = await ipc.invoke('gamemode-stop', { reason: 'user' });
      if (!mounted.current) return;
      setGlobalBusy(false);
      setProgress(null);
      showNotification(res.message, res.success ? 'success' : 'error');
      loadAll(true);
      return;
    }

    if (!selected.length) {
      showNotification('Selecione ao menos um ajuste para ativar o modo.', 'info');
      return;
    }

    setGlobalBusy(true);
    setProgress({ phase: 'baseline', message: 'Medindo latência atual (baseline)…' });
    setAlerts([]);

    const res = await ipc.invoke('gamemode-start', {
      preset,
      tweakIds: selected,
      allowPrompt: true,
    });

    if (!mounted.current) return;
    setGlobalBusy(false);
    setProgress(null);

    if (!res.success && res.code === 'UAC_DENIED') {
      showNotification('Permissão de Administrador negada. Nenhum ajuste foi aplicado.', 'error');
      pushAlert({ severity: 'warn', title: 'Permissão negada (UAC)', detail: res.message });
    }
    // Mensagens de sucesso/erro já chegam via evento gamemode-state.
    if (res.status) setGamemode(res.status);
  }, [gamemode.active, globalBusy, selected, preset, showNotification, loadAll, pushAlert]);

  const handleApplySelected = useCallback(async () => {
    if (!selected.length) return showNotification('Nenhum ajuste selecionado.', 'info');
    setGlobalBusy(true);
    const res = await ipc.invoke('apply-tweaks', selected, buildParams(selected, params));
    if (!mounted.current) return;
    setGlobalBusy(false);
    showNotification(res.message, res.success ? 'success' : 'error');
    pushHistory({ kind: 'apply-many', message: res.message, success: Boolean(res.success) });
    loadAll(true);
  }, [selected, params, showNotification, pushHistory, loadAll]);

  const handleRevertSelected = useCallback(async () => {
    if (!selected.length) return showNotification('Nenhum ajuste selecionado.', 'info');
    setGlobalBusy(true);
    const res = await ipc.invoke('revert-tweaks', selected);
    if (!mounted.current) return;
    setGlobalBusy(false);
    showNotification(res.message, res.success ? 'success' : 'error');
    loadAll(true);
  }, [selected, showNotification, loadAll]);

  const handleRevertAll = useCallback(async () => {
    if (!window.confirm('Reverter TODOS os ajustes para o estado anterior (a partir dos backups)?')) return;
    setGlobalBusy(true);
    const res = await ipc.invoke('revert-all');
    if (!mounted.current) return;
    setGlobalBusy(false);
    showNotification(res.message, res.success ? 'success' : 'error');
    pushHistory({ kind: 'revert-all', message: res.message, success: Boolean(res.success) });
    loadAll(true);
  }, [showNotification, pushHistory, loadAll]);

  const handleExportBackup = useCallback(async () => {
    const res = await ipc.invoke('export-backup-reg');
    if (!mounted.current) return;
    showNotification(res.message || (res.success ? 'Backup exportado.' : 'Falha ao exportar backup.'), res.success ? 'success' : 'error');
    if (res.files && res.files.length) pushHistory({ kind: 'backup', message: `Backup exportado: ${res.files.length} arquivo(s)`, success: true });
  }, [showNotification, pushHistory]);

  const handleRelaunch = useCallback(async () => {
    const res = await ipc.invoke('relaunch-as-admin');
    if (!mounted.current) return;
    showNotification(res.message, res.success ? 'success' : 'error');
    if (res.success) {
      const elev = await ipc.invoke('get-elevation-status');
      if (mounted.current) setElevation(elev);
    }
  }, [showNotification]);

  const applyPreset = useCallback(
    (presetId) => {
      setPreset(presetId);
      const p = (catalog && catalog.presets.find((x) => x.id === presetId)) || null;
      if (p) persistSelection(p.tweakIds);
      ipc.invoke('set-settings', { ultraPreset: presetId }).catch(() => {});
    },
    [catalog, persistSelection]
  );

  /* ---------------- derivação ---------------- */
  const tweaks = useMemo(() => (catalog ? catalog.tweaks : []), [catalog]);

  const grouped = useMemo(() => {
    if (!catalog) return [];
    return catalog.groups
      .map((g) => ({ ...g, items: tweaks.filter((t) => t.group === g.id) }))
      .filter((g) => (activeGroup === 'all' ? true : g.id === activeGroup))
      .filter((g) => g.items.length > 0);
  }, [catalog, tweaks, activeGroup]);

  const counts = useMemo(() => {
    const applied = tweaks.filter((t) => states[t.id] && states[t.id].applied).length;
    const unsupported = tweaks.filter((t) => states[t.id] && states[t.id].supported === false).length;
    return { total: tweaks.length, applied, unsupported, selected: selected.length };
  }, [tweaks, states, selected]);

  const imp = gamemode.improvement || null;
  const live = (gamemode.watchdog && gamemode.watchdog.samples) || [];
  const lastSample = live.length ? live[live.length - 1] : null;
  const combined = gamemode.after ? gamemode.after.combined : gamemode.baseline ? gamemode.baseline.combined : null;

  const shownAvg = lastSample ? lastSample.avg : combined ? combined.avg : null;
  const shownJitter = lastSample ? lastSample.jitter : combined ? combined.jitter : null;
  const shownLoss = lastSample ? lastSample.loss : combined ? combined.lossPercent : null;
  const shownP95 = combined ? combined.p95 : null;

  if (!catalog) {
    return (
      <div className="low-latency">
        <div className="page-header">
          <h1>🚀 Ultra Low-Latency</h1>
          <p>Carregando catálogo de ajustes…</p>
        </div>
        <div className="empty-state card">
          {detecting ? <><div className="loading-spinner" /> Lendo o estado real do sistema…</> : 'Não foi possível carregar os ajustes.'}
        </div>
      </div>
    );
  }

  return (
    <div className="low-latency">
      <div className="page-header">
        <h1>🚀 Modo Ultra Low-Latency</h1>
        <p>
          Ative tudo de uma vez ou controle cada ajuste individualmente. Toda alteração gera backup
          e pode ser revertida com um clique.
        </p>
      </div>

      {demoMode && (
        <div className="banner banner-info">
          <span>🧪</span>
          <div>
            <strong>Modo demonstração</strong>
            <p>
              Rodando no navegador, sem Electron/Windows: nada é alterado no sistema. Os textos, riscos
              e ordem dos ajustes são os reais (exportados do processo principal).
            </p>
          </div>
        </div>
      )}

      {elevation && !elevation.isAdmin && (
        <div className="banner banner-warning">
          <span>🔐</span>
          <div>
            <strong>Sem privilégios de Administrador</strong>
            <p>{elevation.message}</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleRelaunch}>
            🔁 Reiniciar como Administrador
          </button>
        </div>
      )}

      {alerts.map((a) => (
        <div key={a.id} className={`banner banner-${a.severity === 'danger' ? 'danger' : 'warning'}`}>
          <span>{a.severity === 'danger' ? '🛑' : '⚠️'}</span>
          <div>
            <strong>{a.title}</strong>
            <p>{a.detail}</p>
          </div>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setAlerts((prev) => prev.filter((x) => x.id !== a.id))}>
            Fechar
          </button>
        </div>
      ))}

      {/* ================= PAINEL PRINCIPAL ================= */}
      <div className={`master-panel card ${gamemode.active ? 'is-active' : ''}`}>
        <div className="master-left">
          <button
            type="button"
            className={`master-button ${gamemode.active ? 'active' : ''} ${globalBusy ? 'busy' : ''}`}
            onClick={handleToggleMode}
            disabled={globalBusy}
            aria-pressed={gamemode.active}
          >
            <span className="master-button-glow" />
            <span className="master-button-icon">{globalBusy ? '⏳' : gamemode.active ? '⏻' : '⚡'}</span>
            <span className="master-button-text">
              {globalBusy
                ? progress
                  ? progress.message
                  : 'Processando…'
                : gamemode.active
                  ? 'Modo ATIVO — clique para desativar'
                  : 'Ativar Modo Ultra Low-Latency'}
            </span>
            <span className="master-button-sub">
              {globalBusy
                ? `${progress && progress.progress ? `${progress.progress.index}/${progress.progress.total}` : 'aguarde'}`
                : gamemode.active
                  ? `desde ${formatTime(gamemode.startedAt)} · ${gamemode.appliedIds.length} ajustes`
                  : `${counts.selected} ajuste(s) selecionado(s)`}
            </span>
          </button>

          {globalBusy && progress && (
            <div className="master-progress">
              <div className="master-progress-bar">
                <div className="master-progress-fill" />
              </div>
              <span>{progress.message}</span>
            </div>
          )}
        </div>

        <div className="master-right">
          <div className="master-metrics">
            <MetricBox
              label="Latência média"
              value={shownAvg === null || shownAvg === undefined ? '—' : Math.round(shownAvg)}
              unit="ms"
              color={latencyColor(shownAvg)}
              delta={imp ? imp.avg : null}
            />
            <MetricBox
              label="p95 (tail)"
              value={shownP95 === null || shownP95 === undefined ? '—' : Math.round(shownP95)}
              unit="ms"
              color={latencyColor(shownP95)}
              delta={imp ? imp.p95 : null}
            />
            <MetricBox
              label="Jitter"
              value={shownJitter === null || shownJitter === undefined ? '—' : Math.round(shownJitter * 10) / 10}
              unit="ms"
              color={jitterColor(shownJitter)}
              delta={imp ? imp.jitter : null}
            />
            <MetricBox
              label="Perda"
              value={shownLoss === null || shownLoss === undefined ? '—' : Math.round(shownLoss * 10) / 10}
              unit="%"
              color={lossColor(shownLoss)}
              delta={imp ? imp.loss : null}
            />
          </div>

          <div className="master-status-line">
            <span className={`status-pill ${gamemode.active ? 'pill-on' : 'pill-off'}`}>
              <span className="pill-dot" />
              {gamemode.active ? 'MODO JOGO ATIVO' : 'MODO JOGO INATIVO'}
            </span>
            <span className="status-counts">
              {counts.applied}/{counts.total} ativos
              {counts.unsupported > 0 && ` · ${counts.unsupported} não suportados`}
            </span>
            {gamemode.active && (
              <span className="status-watchdog" title="Watchdog verifica a conectividade periodicamente e reverte tudo se a rede cair">
                🛡️ watchdog {gamemode.watchdog && gamemode.watchdog.running ? 'ativo' : 'parado'}
              </span>
            )}
          </div>

          {gamemode.active && live.length > 1 && (
            <div className="master-spark">
              <Sparkline samples={live.slice(-60)} />
            </div>
          )}

          {imp && (
            <div className="master-improvement">
              <span className="imp-title">Ganho medido (baseline → ativo):</span>
              <span className={formatDelta(imp.avg.delta).tone === 'good' ? 'imp-good' : 'imp-bad'}>
                {imp.avg.before}→{imp.avg.after}ms
              </span>
              <span className="imp-sep">·</span>
              <span>jitter {imp.jitter.before}→{imp.jitter.after}ms</span>
              <span className="imp-sep">·</span>
              <span>perda {formatPercent(imp.loss.before)}→{formatPercent(imp.loss.after)}</span>
            </div>
          )}
        </div>
      </div>

      {/* ================= TOOLBAR ================= */}
      <div className="toolbar card">
        <div className="toolbar-presets">
          <span className="toolbar-label">Preset:</span>
          {catalog.presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`preset-chip ${preset === p.id ? 'active' : ''}`}
              onClick={() => applyPreset(p.id)}
              title={p.description}
            >
              {p.label}
              <small>{p.tweakIds.length}</small>
            </button>
          ))}
        </div>

        <div className="toolbar-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => loadAll(true)} disabled={detecting}>
            {detecting ? <span className="loading-spinner" /> : '🔍'} Re-detectar
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleApplySelected} disabled={globalBusy || !selected.length}>
            ⚡ Aplicar selecionados
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={handleRevertSelected} disabled={globalBusy || !selected.length}>
            ↩ Reverter selecionados
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={handleRevertAll} disabled={globalBusy}>
            🧯 Reverter tudo
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={handleExportBackup} disabled={globalBusy} title="Exporta .reg + JSON com o estado original">
            💾 Exportar backup
          </button>
        </div>
      </div>

      {/* ================= FILTRO DE GRUPOS ================= */}
      <div className="group-tabs">
        <button
          type="button"
          className={`group-tab ${activeGroup === 'all' ? 'active' : ''}`}
          onClick={() => setActiveGroup('all')}
        >
          Todos <small>{counts.total}</small>
        </button>
        {catalog.groups.map((g) => {
          const n = tweaks.filter((t) => t.group === g.id).length;
          return (
            <button
              key={g.id}
              type="button"
              className={`group-tab ${activeGroup === g.id ? 'active' : ''}`}
              onClick={() => setActiveGroup(g.id)}
            >
              {g.icon} {g.label} <small>{n}</small>
            </button>
          );
        })}
      </div>

      {/* ================= GRUPOS / TWEAKS ================= */}
      {grouped.map((group) => (
        <section key={group.id} className="tweak-group">
          <div className="tweak-group-header">
            <h3>
              <span className="group-icon">{group.icon}</span>
              {group.label}
            </h3>
            <p>{group.description}</p>
          </div>

          <div className="tweak-list">
            {group.items.map((tweak) => (
              <TweakRow
                key={tweak.id}
                tweak={{ ...tweak, state: states[tweak.id] || null }}
                selected={selected.includes(tweak.id)}
                onSelect={handleSelect}
                onApply={handleApplyOne}
                onRevert={handleRevertOne}
                busy={busyId === tweak.id}
                isAdmin={isAdmin}
                demoMode={demoMode}
                onParamChange={handleParam}
                paramValue={params[tweak.id]}
              />
            ))}
          </div>
        </section>
      ))}

      {/* ================= HISTÓRICO ================= */}
      {history.length > 0 && (
        <div className="card history-card">
          <div className="card-header">
            <h3>📋 Histórico da sessão</h3>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setHistory([])}>Limpar</button>
          </div>
          <div className="history-list">
            {history.map((h, i) => (
              <div key={i} className={`history-item ${h.success ? 'ok' : 'fail'}`}>
                <span className="history-time">{formatTime(h.ts)}</span>
                <span className="history-icon">{h.success ? '✅' : '❌'}</span>
                <span className="history-msg">{h.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card safety-card">
        <h3>🛡️ Como o willLag protege seu sistema</h3>
        <ul>
          <li><strong>Backup antes de escrever.</strong> Cada alteração guarda o valor anterior (inclusive "não existia"), permitindo reversão exata — não apenas "voltar ao padrão".</li>
          <li><strong>Guarda de conectividade.</strong> Ao ativar o modo, o gateway e a internet são testados. Se a rede cair, tudo é revertido automaticamente.</li>
          <li><strong>Watchdog contínuo.</strong> Enquanto o modo está ativo, a conectividade é revalidada a cada 15s. Três falhas seguidas disparam rollback e aviso.</li>
          <li><strong>Recuperação após crash.</strong> Um lock de sessão em disco permite restaurar os ajustes temporários mesmo se o app for morto ou faltar energia.</li>
          <li><strong>Ajustes de sessão nunca ficam pendurados.</strong> A pausa da varredura Wi-Fi é revertida ao desativar o modo e ao fechar o app; se não for possível, o app mostra o comando exato para você rodar.</li>
          <li><strong>UAC tratado.</strong> Negar o prompt nunca quebra nada: o erro é capturado, explicado e nada é alterado.</li>
        </ul>
      </div>
    </div>
  );
}

export default LowLatencyMode;
