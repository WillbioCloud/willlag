import React, { useState } from 'react';
import ToggleSwitch from './ToggleSwitch';
import { tweakStatus, SCOPE_LABEL } from './utils/networkOptimizer';

/**
 * Linha de um tweak individual.
 *
 * Dois estados distintos, deliberadamente separados na UI para evitar confusão:
 *   - toggle  = "este tweak entra no Modo Ultra Low-Latency?"  (seleção)
 *   - chip    = "ele está aplicado no sistema agora?"          (estado real)
 *
 * Isso importa porque um tweak pode estar selecionado e ainda não aplicado
 * (o modo está desligado), ou aplicado individualmente sem estar no modo.
 */
function TweakRow({
  tweak,
  selected,
  onSelect,
  onApply,
  onRevert,
  busy,
  isAdmin,
  demoMode,
  onParamChange,
  paramValue,
}) {
  const [expanded, setExpanded] = useState(false);

  const state = tweak.state || null;
  const status = tweakStatus(state, tweak.appliedRecorded);
  const isApplied = Boolean(state && state.applied);
  const unsupported = Boolean(state && state.supported === false);
  const needsAdmin = Boolean(tweak.requiresAdmin) && !isAdmin;

  const canAct = !unsupported && !busy;
  const tone = unsupported ? 'muted' : isApplied ? 'success' : status.key === 'partial' ? 'warning' : 'neutral';

  return (
    <div className={`tweak-row tone-${tone} ${unsupported ? 'is-unsupported' : ''} ${isApplied ? 'is-applied' : ''}`}>
      <div className="tweak-row-main">
        <div className="tweak-select">
          <ToggleSwitch
            checked={Boolean(selected)}
            onChange={(v) => onSelect && onSelect(tweak.id, v)}
            disabled={unsupported}
            size="md"
            tone={tweak.risk === 'low' ? 'success' : 'accent'}
            label={`Incluir ${tweak.label} no Modo Ultra Low-Latency`}
          />
        </div>

        <div className="tweak-body">
          <div className="tweak-title-line">
            <h4 className="tweak-title">{tweak.label}</h4>
            <div className="tweak-badges">
              <span className={`chip chip-${status.tone}`}>{status.label}</span>
              <span className={`badge badge-${tweak.riskColor === 'success' ? 'success' : tweak.riskColor === 'danger' ? 'danger' : 'warning'}`}>
                {tweak.riskLabel}
              </span>
              {tweak.scope === 'session' && (
                <span className="badge badge-info" title="Revertido automaticamente ao desativar o modo ou fechar o app">
                  {SCOPE_LABEL.session}
                </span>
              )}
              {tweak.requiresAdmin && (
                <span className={`badge ${isAdmin ? 'badge-success' : 'badge-warning'}`}>Admin</span>
              )}
              {tweak.legacy && <span className="badge badge-neutral">Legado</span>}
            </div>
          </div>

          <p className="tweak-desc">{tweak.description}</p>

          {state && state.current !== null && state.current !== undefined && (
            <div className="tweak-values">
              <span className="tweak-value-label">Atual</span>
              <code className="tweak-value current">{String(state.current)}</code>
              <span className="tweak-arrow">→</span>
              <span className="tweak-value-label">Alvo</span>
              <code className="tweak-value target">{String(state.target || '—')}</code>
            </div>
          )}

          {unsupported && state && state.reason && (
            <div className="tweak-notice notice-muted">
              <span>ℹ️</span>
              <span>{state.reason}</span>
            </div>
          )}

          {state && state.error && (
            <div className="tweak-notice notice-danger">
              <span>⚠️</span>
              <span>{state.error}</span>
            </div>
          )}

          {tweak.options && tweak.options.length > 0 && selected && (
            <div className="tweak-params">
              <label htmlFor={`param-${tweak.id}`}>Valor:</label>
              <select
                id={`param-${tweak.id}`}
                value={paramValue !== undefined && paramValue !== null ? paramValue : ''}
                onChange={(e) => onParamChange && onParamChange(tweak.id, e.target.value)}
              >
                <option value="">(usar recomendado)</option>
                {tweak.options.map((opt) => (
                  <option key={String(opt.value)} value={String(opt.value)}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {tweak.why && (
            <button type="button" className="tweak-why-toggle" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '▾' : '▸'} Por que isso reduz latência?
            </button>
          )}

          {expanded && tweak.why && (
            <div className="tweak-why">
              <p>{tweak.why}</p>
              {tweak.id === 'wlanAutoconfig' && (
                <p className="why-note">
                  ⚠️ Com a varredura pausada o Windows não reconecta sozinho se o Wi-Fi cair.
                  O willLag reverte automaticamente ao desativar o modo, ao fechar o app e
                  imediatamente se o watchdog detectar perda de conectividade.
                </p>
              )}
              {tweak.id === 'congestionProvider' && (
                <p className="why-note">
                  ℹ️ BBR não existe na pilha TCP/IP nativa do Windows. O willLag detecta o que o
                  sistema oferece (CTCP/CUBIC) e nunca promete ativar algo inexistente.
                </p>
              )}
              {tweak.id === 'systemResponsiveness' && (
                <p className="why-note">
                  ℹ️ Se você faz stream ou mantém downloads ativos durante a partida, use 10 em vez de 0.
                </p>
              )}
              {tweak.id === 'mtuOptimize' && (
                <p className="why-note">
                  ℹ️ A detecção leva alguns segundos (busca binária com ping DF). Ela nunca aumenta o MTU
                  sozinha — só reduz quando o caminho exige.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="tweak-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onApply(tweak.id)}
          disabled={!canAct || busy}
          title={needsAdmin && !demoMode ? 'Vai solicitar permissão de Administrador (UAC)' : 'Aplicar agora'}
        >
          {busy ? <span className="loading-spinner" /> : '⚡'} Aplicar
        </button>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => onRevert(tweak.id)}
          disabled={!canAct || (!isApplied && !tweak.hasBackup && !tweak.appliedRecorded)}
          title="Restaurar o valor anterior (backup)"
        >
          ↩ Reverter
        </button>
      </div>
    </div>
  );
}

export default TweakRow;
