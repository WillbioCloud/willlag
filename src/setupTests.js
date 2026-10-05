/**
 * Configuração global dos testes do renderer (jest + jsdom via react-scripts).
 *
 * React 18 exige que updates disparados fora do React (eventos, timers,
 * promises resolvidas em useEffect) aconteçam dentro de `act()`, e isso só é
 * permitido com IS_REACT_ACT_ENVIRONMENT ligado — sem a flag, cada teste
 * estamparia "The current testing environment is not configured to support act".
 */

global.IS_REACT_ACT_ENVIRONMENT = true;

// O NetworkMonitor usa recharts (ResponsiveContainer), que depende de
// ResizeObserver — inexistente no jsdom.
if (typeof global.ResizeObserver === 'undefined') {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Alguns componentes medem viewport; jsdom implementa matchMedia, mas versões
// antigas não — o stub evita falha por ambiente, não por código.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
}

// O app é um desktop app: nada de scroll suave animado nos testes.
if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
}
