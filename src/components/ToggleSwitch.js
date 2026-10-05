import React from 'react';
import './ToggleSwitch.css';

/**
 * Switch acessível reutilizável.
 * `role="switch"` + `aria-checked` para leitores de tela, e suporte a teclado
 * (Enter/Espaço) — o app inteiro é navegável sem mouse.
 */
function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  label,
  size = 'md',
  tone = 'accent',
  busy = false,
  id,
}) {
  const handleClick = () => {
    if (disabled || busy) return;
    onChange(!checked);
  };

  const handleKey = (event) => {
    if (disabled || busy) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onChange(!checked);
    }
  };

  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
      className={`toggle-switch toggle-${size} toggle-tone-${tone} ${checked ? 'is-on' : 'is-off'} ${disabled ? 'is-disabled' : ''} ${busy ? 'is-busy' : ''}`}
      onClick={handleClick}
      onKeyDown={handleKey}
      disabled={disabled}
      title={disabled ? 'Indisponível' : checked ? 'Clique para desativar' : 'Clique para ativar'}
    >
      <span className="toggle-track">
        <span className="toggle-thumb">
          {busy && <span className="toggle-spinner" />}
        </span>
      </span>
    </button>
  );
}

export default ToggleSwitch;
