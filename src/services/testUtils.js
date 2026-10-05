/**
 * Utilidades de teste do renderer (NÃO fazem parte do bundle do app: só os
 * arquivos *.test.js importam daqui).
 *
 * Por que um helper próprio em vez de @testing-library/react?
 *  - O repositório não tem essa dependência e instalar aqui não é possível
 *    (o sandbox não baixa pacotes do Electron/registry com confiança).
 *  - Precisamos de controle explícito sobre `act()` para os useEffect que
 *    chamam `ipc.invoke` (assíncronos) sem encher o log de warnings.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { act as legacyAct } from 'react-dom/test-utils';

/** React 18.3 expõe act() em 'react'; 18.0-18.2 só em react-dom/test-utils. */
export const act = React.act || legacyAct;

/**
 * Monta um componente em um container real do jsdom.
 * @param {React.ReactElement} element
 * @returns {{container: HTMLDivElement, text: () => string, query: Function,
 *            queryAll: Function, byText: Function, click: Function,
 *            rerender: Function, unmount: Function}}
 */
export function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  let root;
  act(() => {
    root = createRoot(container);
    root.render(element);
  });

  const api = {
    container,
    root,

    /** Texto inteiro renderizado (útil para assertivas de conteúdo). */
    text: () => container.textContent || '',

    query: (selector) => container.querySelector(selector),
    queryAll: (selector) => Array.from(container.querySelectorAll(selector)),

    /** Primeiro elemento cujo texto contém `needle`. */
    byText: (needle, selector = '*') => {
      const nodes = Array.from(container.querySelectorAll(selector));
      return nodes.find((n) => (n.textContent || '').includes(needle)) || null;
    },

    /** Clique envolvendo act() — dispara efeitos colaterais de forma síncrona. */
    click: (el) => {
      if (!el) throw new Error('click(): elemento não encontrado');
      act(() => {
        el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
    },

    /** Tecla em um elemento (para testar acessibilidade de botões/switches). */
    key: (el, key) => {
      if (!el) throw new Error('key(): elemento não encontrado');
      act(() => {
        el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    },

    /**
     * Muda um campo controlado do React.
     * React 18 escuta `input` para <input type=text|number> e `change` para
     * <select>/<input type=checkbox>; além disso é preciso usar o setter
     * NATIVO do prototype para o tracker interno do React perceber a mudança.
     */
    change: (el, value) => {
      if (!el) throw new Error('change(): elemento não encontrado');
      const tag = el.tagName;

      act(() => {
        if (tag === 'SELECT') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(el, String(value));
          el.dispatchEvent(new window.Event('change', { bubbles: true }));
          return;
        }

        if (tag === 'INPUT' && el.type === 'checkbox') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
          setter.call(el, Boolean(value));
          el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
          return;
        }

        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, String(value));
          el.dispatchEvent(new window.Event('input', { bubbles: true }));
          return;
        }

        throw new Error(`change(): tag não suportada (${tag})`);
      });
    },

    rerender: (next) => act(() => { root.render(next); }),
    unmount: () => {
      act(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };

  return api;
}

/**
 * Deixa os microtasks/timers dos useEffect assíncronos assentarem.
 * Componentes carregam dados via ipc.invoke() em useEffect — sem isso, as
 * assertivas rodam antes do estado existir.
 */
export async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Espera até `predicate()` ser verdade (ou estoura o timeout). */
export async function waitFor(predicate, { timeout = 3000, interval = 20 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    // eslint-disable-next-line no-await-in-loop
    await flush(1);
    last = predicate();
    if (last) return last;
  }
  throw new Error(`waitFor: condição não satisfeita em ${timeout}ms (último valor: ${JSON.stringify(last)})`);
}

export { React };
