/**
 * Testes de componente (jsdom + backend simulado).
 *
 * O que eles garantem, na prática:
 *  - a UI monta sem quebrar contra o MESMO contrato de IPC do app real
 *    (mockBackend responde com as mesmas formas que public/services/ipc.js);
 *  - o botão principal do Modo Ultra Low-Latency ativa/desativa e reflete o
 *    estado do backend;
 *  - negar o UAC mostra aviso na tela (requisito explícito de elevação);
 *  - telas de DNS/MTU/Otimizador renderizam dados e não texto vazio.
 */

import React from 'react';
import { mount, flush, waitFor } from '../services/testUtils';
import mock from '../services/mockBackend';
import ipc from '../services/ipc';

const ipcOn = (channel, cb) => ipc.on(channel, cb);

import ToggleSwitch from '../components/ToggleSwitch';
import TweakRow from '../components/TweakRow';
import Sidebar from '../components/Sidebar';
import LowLatencyMode from '../components/LowLatencyMode';
import MtuPanel from '../components/MtuPanel';
import DNSChanger from '../components/DNSChanger';
import Optimizer from '../components/Optimizer';
import App from '../App';

const noop = () => {};

afterEach(() => {
  mock.__setAdmin(false);
});

/* ================================================================== */
/* ToggleSwitch — componente base de TODA a seleção de tweaks          */
/* ================================================================== */

describe('ToggleSwitch', () => {
  test('expõe role=switch e aria-checked (acessível sem mouse)', () => {
    const view = mount(<ToggleSwitch checked onChange={noop} label="Incluir Nagle" />);
    const el = view.query('[role="switch"]');
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-checked')).toBe('true');
    expect(el.getAttribute('aria-label')).toBe('Incluir Nagle');
    expect(el.className).toContain('is-on');
    view.unmount();
  });

  test('clique alterna o valor', () => {
    const calls = [];
    const view = mount(<ToggleSwitch checked={false} onChange={(v) => calls.push(v)} label="x" />);
    view.click(view.query('[role="switch"]'));
    expect(calls).toEqual([true]);
    view.rerender(<ToggleSwitch checked onChange={(v) => calls.push(v)} label="x" />);
    view.click(view.query('[role="switch"]'));
    expect(calls).toEqual([true, false]);
    view.unmount();
  });

  test('teclado (Enter e Espaço) também alterna', () => {
    const calls = [];
    const view = mount(<ToggleSwitch checked={false} onChange={(v) => calls.push(v)} label="x" />);
    const el = view.query('[role="switch"]');
    view.key(el, 'Enter');
    view.key(el, ' ');
    view.key(el, 'a'); // tecla irrelevante não alterna
    expect(calls).toEqual([true, true]);
    view.unmount();
  });

  test('desabilitado ou ocupado não emite mudança', () => {
    const calls = [];
    const view = mount(<ToggleSwitch checked={false} disabled onChange={(v) => calls.push(v)} label="x" />);
    view.click(view.query('[role="switch"]'));
    expect(calls).toEqual([]);
    expect(view.query('[role="switch"]').className).toContain('is-disabled');

    view.rerender(<ToggleSwitch checked={false} busy onChange={(v) => calls.push(v)} label="x" />);
    view.click(view.query('[role="switch"]'));
    view.key(view.query('[role="switch"]'), 'Enter');
    expect(calls).toEqual([]);
    view.unmount();
  });

  test('tamanho e tom viram classes (estilo vem do CSS, não de inline)', () => {
    const view = mount(<ToggleSwitch checked size="sm" tone="success" onChange={noop} label="x" />);
    const el = view.query('[role="switch"]');
    expect(el.className).toContain('toggle-sm');
    expect(el.className).toContain('toggle-tone-success');
    view.unmount();
  });
});

/* ================================================================== */
/* TweakRow — seleção vs. estado real do sistema                       */
/* ================================================================== */

const NAGLE = {
  id: 'nagle',
  group: 'tcpip',
  groupLabel: 'Pilha TCP/IP e Registro',
  label: "Desativar Nagle's Algorithm (TCP_NODELAY)",
  description: 'Envia cada pacote imediatamente.',
  why: 'Nagle segura pacotes pequenos até receber ACK (40-200ms).',
  risk: 'low',
  riskLabel: 'Baixo risco',
  riskColor: 'success',
  requiresAdmin: true,
  scope: 'persistent',
  defaultInPreset: true,
  options: null,
  state: { id: 'nagle', ok: true, supported: true, applied: false },
};

const WLAN = {
  id: 'wlanAutoconfig',
  group: 'wifi',
  groupLabel: 'Wi-Fi e energia USB',
  label: 'Pausar varredura de redes Wi-Fi durante o jogo',
  description: 'netsh wlan set autoconfig enabled=no.',
  why: 'O Windows sai do canal a cada 30-60s para procurar redes.',
  risk: 'medium',
  riskLabel: 'Risco médio',
  riskColor: 'warning',
  requiresAdmin: true,
  scope: 'session',
  sessionCritical: true,
  options: null,
  state: { id: 'wlanAutoconfig', ok: true, supported: true, applied: false },
};

describe('TweakRow', () => {
  test('mostra rótulo, risco e o chip de estado real', () => {
    const view = mount(<TweakRow tweak={NAGLE} selected={false} onSelect={noop} isAdmin={false} />);
    const text = view.text();
    expect(text).toContain("Desativar Nagle's Algorithm");
    expect(text).toContain('Baixo risco');
    expect(text).toContain('Padrão do Windows'); // state.applied === false
    view.unmount();
  });

  test('toggle de seleção chama onSelect com (id, novoValor)', () => {
    const calls = [];
    const view = mount(<TweakRow tweak={NAGLE} selected={false} onSelect={(id, v) => calls.push([id, v])} isAdmin />);
    view.click(view.query('[role="switch"]'));
    expect(calls).toEqual([['nagle', true]]);
    view.unmount();
  });

  test('aplicado no sistema -> chip "Ativo"', () => {
    const applied = { ...NAGLE, state: { ...NAGLE.state, applied: true } };
    const view = mount(<TweakRow tweak={applied} selected onSelect={noop} isAdmin />);
    expect(view.text()).toContain('Ativo');
    expect(view.query('.tweak-row').className).toContain('is-applied');
    view.unmount();
  });

  test('não suportado desabilita a seleção e explica (chimney em Win11)', () => {
    const unsupported = { ...NAGLE, state: { ...NAGLE.state, supported: false, reason: 'Removido no Windows 8+' } };
    const view = mount(<TweakRow tweak={unsupported} selected={false} onSelect={noop} isAdmin />);
    expect(view.text()).toContain('Não suportado');
    expect(view.query('[role="switch"]').disabled).toBe(true);
    expect(view.query('.tweak-row').className).toContain('is-unsupported');
    view.unmount();
  });

  test('tweak de sessão mostra o badge "Só durante o modo"', () => {
    const view = mount(<TweakRow tweak={WLAN} selected onSelect={noop} isAdmin />);
    expect(view.text()).toContain('Só durante o modo');
    view.unmount();
  });

  test('"Por que isso reduz latência?" expande a explicação técnica', () => {
    const view = mount(<TweakRow tweak={WLAN} selected onSelect={noop} isAdmin />);
    expect(view.text()).not.toContain('30-60s');

    const why = view.byText('Por que isso reduz latência?', 'button');
    expect(why).toBeTruthy();
    view.click(why);
    expect(view.text()).toContain('30-60s');
    view.unmount();
  });

  test('sem estado (detectando) mostra "Verificando…"', () => {
    const view = mount(<TweakRow tweak={{ ...NAGLE, state: null }} selected={false} onSelect={noop} isAdmin />);
    expect(view.text()).toContain('Verificando');
    view.unmount();
  });

  test('exige admin: o botão avisa que vai pedir UAC (e na demo não promete isso)', () => {
    const view = mount(<TweakRow tweak={NAGLE} selected={false} onSelect={noop} isAdmin={false} demoMode={false} />);
    const apply = Array.from(view.queryAll('button')).find((b) => /Aplicar/.test(b.textContent));
    expect(apply).toBeTruthy();
    expect(apply.getAttribute('title')).toMatch(/Administrador|UAC/);
    // O botão continua habilitado: quem decide é o prompt do UAC, não a UI.
    expect(apply.disabled).toBe(false);
    view.unmount();

    const demo = mount(<TweakRow tweak={NAGLE} selected={false} onSelect={noop} isAdmin={false} demoMode />);
    const applyDemo = Array.from(demo.queryAll('button')).find((b) => /Aplicar/.test(b.textContent));
    expect(applyDemo.getAttribute('title')).not.toMatch(/UAC/);
    demo.unmount();
  });

  test('tweak com opções renderiza select de parâmetro quando selecionado', () => {
    const withOptions = {
      ...NAGLE,
      id: 'systemResponsiveness',
      options: [
        { value: '0', label: '0 — máxima prioridade para o jogo' },
        { value: '10', label: '10 — padrão do Windows' },
      ],
    };
    const changes = [];
    const view = mount(
      <TweakRow tweak={withOptions} selected onSelect={noop} onParamChange={(id, v) => changes.push([id, v])} paramValue="0" isAdmin />
    );
    const select = view.query('select');
    expect(select).toBeTruthy();
    expect(select.value).toBe('0');
    expect(select.options.length).toBe(3); // inclui "(usar recomendado)"
    view.change(select, '10');
    expect(changes).toEqual([['systemResponsiveness', '10']]);
    view.unmount();
  });
});

/* ================================================================== */
/* Sidebar                                                             */
/* ================================================================== */

describe('Sidebar', () => {
  test('lista as 6 páginas e marca a atual', () => {
    const view = mount(<Sidebar currentPage="dns" onPageChange={noop} gameModeActive={false} />);
    const items = view.queryAll('.sidebar-item');
    expect(items.length).toBe(6);
    expect(view.text()).toContain('Ultra Low-Latency');
    expect(view.text()).toContain('DNS & MTU');
    expect(items.find((i) => i.className.includes('active')).textContent).toContain('DNS & MTU');
    view.unmount();
  });

  test('clique navega', () => {
    const calls = [];
    const view = mount(<Sidebar currentPage="lowlatency" onPageChange={(id) => calls.push(id)} gameModeActive={false} />);
    view.click(view.queryAll('.sidebar-item')[4]); // Otimizador
    expect(calls).toEqual(['optimizer']);
    view.unmount();
  });

  test('indica quando o modo jogo está ativo (o usuário precisa ver isso sempre)', () => {
    const off = mount(<Sidebar currentPage="dashboard" onPageChange={noop} gameModeActive={false} />);
    const on = mount(<Sidebar currentPage="dashboard" onPageChange={noop} gameModeActive />);

    expect(off.query('.sidebar-mode-badge')).toBeNull();
    expect(off.text()).toContain('Sistema Ativo');

    expect(on.query('.sidebar-mode-badge')).toBeTruthy();
    expect(on.text()).toContain('Modo Jogo ativo');
    expect(on.text()).toContain('Reverte ao fechar o app');
    expect(on.text()).toContain('Latência otimizada');
    expect(on.query('.status-dot').className).toContain('dot-boost');

    off.unmount();
    on.unmount();
  });

  test('mostra a versão v2 no logo', () => {
    const view = mount(<Sidebar currentPage="dashboard" onPageChange={noop} gameModeActive={false} />);
    expect(view.text()).toContain('willLag');
    expect(view.text()).toMatch(/v2/);
    view.unmount();
  });
});

/* ================================================================== */
/* LowLatencyMode — fluxo principal (integração com o backend demo)    */
/* ================================================================== */

describe('LowLatencyMode', () => {
  test('carrega o catálogo e renderiza os 20 ajustes', async () => {
    const view = mount(<LowLatencyMode isAdmin={false} showNotification={noop} demoMode />);
    await waitFor(() => view.queryAll('.tweak-row').length >= 20, { timeout: 8000 });

    const text = view.text();
    expect(text).toContain('Modo Ultra Low-Latency');
    expect(text).toContain('Modo demonstração');
    expect(text).toContain("Desativar Nagle's Algorithm");
    expect(text).toContain('Pausar varredura de redes em segundo plano');
    expect(text).toContain('autoconfig enabled=no');
    expect(text).toContain('DNS automático');
    expect(view.query('.master-button')).toBeTruthy();
    view.unmount();
  }, 20000);

  test('sem admin mostra o aviso de elevação com ação de reiniciar', async () => {
    mock.__setAdmin(false);
    const view = mount(<LowLatencyMode isAdmin={false} showNotification={noop} demoMode={false} />);
    await waitFor(() => view.text().includes('Sem privilégios de Administrador'), { timeout: 8000 });
    expect(view.byText('Reiniciar como Administrador', 'button')).toBeTruthy();
    view.unmount();
  }, 20000);

  test('seleção inicial vem do preset ultra (13 ajustes)', async () => {
    const view = mount(<LowLatencyMode isAdmin showNotification={noop} demoMode />);
    await waitFor(() => view.text().includes('ajuste(s) selecionado(s)'), { timeout: 8000 });
    expect(view.text()).toMatch(/13 ajuste\(s\) selecionado\(s\)/);
    view.unmount();
  }, 20000);

  test('negar o UAC ao aplicar um tweak mostra banner de permissão (não silêncio)', async () => {
    mock.__setAdmin(false);
    const notes = [];
    const view = mount(<LowLatencyMode isAdmin={false} showNotification={(m, t) => notes.push([m, t])} demoMode />);
    await waitFor(() => view.queryAll('.tweak-row').length >= 20, { timeout: 8000 });

    const row = view.queryAll('.tweak-row').find((r) => r.textContent.includes('Network Throttling'));
    expect(row).toBeTruthy();

    const applyBtn = Array.from(row.querySelectorAll('button')).find((b) => /aplicar/i.test(b.textContent));
    expect(applyBtn).toBeTruthy();
    view.click(applyBtn);

    await waitFor(() => view.text().includes('Permissão negada (UAC)'), { timeout: 8000 });
    expect(notes.some(([msg, type]) => type === 'error' && /Administrador|UAC/i.test(msg))).toBe(true);
    view.unmount();
  }, 30000);

  test('alternar a seleção persiste em set-settings', async () => {
    const view = mount(<LowLatencyMode isAdmin showNotification={noop} demoMode />);
    // Espera a seleção inicial (preset ultra) aparecer na UI.
    await waitFor(() => /13 ajuste\(s\) selecionado\(s\)/.test(view.text()), { timeout: 8000 });

    const row = view.queryAll('.tweak-row')[0];
    expect(row.textContent).toContain('Nagle');
    expect(row.querySelector('[role="switch"]').getAttribute('aria-checked')).toBe('true');

    view.click(row.querySelector('[role="switch"]'));
    await waitFor(() => /12 ajuste\(s\) selecionado\(s\)/.test(view.text()), { timeout: 8000 });

    const persisted = mock.__getState().settings.selectedTweaks || [];
    expect(persisted.length).toBe(12);
    expect(persisted).not.toContain('nagle');

    // E volta a selecionar (o toggle é reversível também).
    view.click(row.querySelector('[role="switch"]'));
    await waitFor(() => /13 ajuste\(s\) selecionado\(s\)/.test(view.text()), { timeout: 8000 });
    expect((mock.__getState().settings.selectedTweaks || [])).toContain('nagle');
    view.unmount();
  }, 30000);

  test('botão principal ativa o modo e depois restaura tudo', async () => {
    mock.__setAdmin(true);
    const notes = [];
    const view = mount(<LowLatencyMode isAdmin showNotification={(m, t) => notes.push([m, t])} demoMode />);

    await waitFor(() => view.query('.master-button') && view.text().includes('ajuste(s) selecionado(s)'), { timeout: 8000 });
    expect(view.query('.master-button').getAttribute('aria-pressed')).toBe('false');
    expect(view.text()).toContain('Ativar Modo Ultra Low-Latency');

    view.click(view.query('.master-button'));

    await waitFor(() => view.text().includes('Modo ATIVO'), { timeout: 40000 });
    expect(view.query('.master-button').getAttribute('aria-pressed')).toBe('true');
    expect(view.query('.master-panel').className).toContain('is-active');
    expect(notes.length).toBeGreaterThan(0);

    // E desfaz — o requisito de reversibilidade.
    view.click(view.query('.master-button'));
    await waitFor(() => view.text().includes('Ativar Modo Ultra Low-Latency'), { timeout: 40000 });
    expect(mock.__getState().gamemode.active).toBe(false);
    expect(Object.keys(mock.__getState().applied).length).toBe(0);
    view.unmount();
  }, 120000);

  test('desmontar não deixa listeners ativos (sem setState em componente morto)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const view = mount(<LowLatencyMode isAdmin showNotification={noop} demoMode />);
    await waitFor(() => view.queryAll('.tweak-row').length >= 20, { timeout: 8000 });
    view.unmount();

    await mock.invoke('apply-tweak', 'nagle', {});
    await flush(2);

    const leak = spy.mock.calls.some((c) => /unmounted|not wrapped in act/i.test(String(c[0])));
    expect(leak).toBe(false);
    spy.mockRestore();
  }, 30000);
});

/* ================================================================== */
/* MtuPanel                                                            */
/* ================================================================== */

describe('MtuPanel', () => {
  test('mostra o MTU atual da interface ativa', async () => {
    const view = mount(<MtuPanel isAdmin showNotification={noop} />);
    await waitFor(() => view.text().includes('1500 bytes'), { timeout: 8000 });
    expect(view.text()).toContain('MTU da interface ativa');
    expect(view.text()).toContain('Wi-Fi');
    view.unmount();
  }, 20000);

  test('detecção mede o caminho e mostra resultado por alvo + recomendação', async () => {
    const view = mount(<MtuPanel isAdmin showNotification={noop} />);
    await waitFor(() => view.text().includes('1500 bytes'), { timeout: 8000 });

    const discover = Array.from(view.queryAll('button')).find((b) => /detectar mtu/i.test(b.textContent));
    expect(discover).toBeTruthy();
    view.click(discover);

    await waitFor(() => view.query('.mtu-recommendation') !== null, { timeout: 20000 });

    // Resultado por alvo (gateway local + internet/path MTU).
    expect(view.queryAll('.mtu-result-row').length).toBeGreaterThanOrEqual(2);
    expect(view.text()).toContain('Gateway');
    expect(view.text()).toMatch(/Internet/);
    expect(view.text()).toMatch(/Path MTU/);

    // Recomendação acionável + caminho de reversão sempre visível.
    const rec = view.query('.mtu-recommendation');
    expect(rec.textContent).toMatch(/Já está ideal|Reduzir para|Caminho suporta|Inconclusivo/);
    expect(view.byText('Restaurar MTU anterior', 'button')).toBeTruthy();
    view.unmount();
  }, 40000);

  test('etapas da busca binária aparecem enquanto mede (progresso ao vivo)', async () => {
    const view = mount(<MtuPanel isAdmin showNotification={noop} />);
    await waitFor(() => view.text().includes('1500 bytes'), { timeout: 8000 });

    const stepsVistos = [];
    const off = ipcOn('mtu-progress', () => stepsVistos.push(1));

    const discover = Array.from(view.queryAll('button')).find((b) => /detectar mtu/i.test(b.textContent));
    view.click(discover);
    await waitFor(() => view.query('.mtu-recommendation') !== null, { timeout: 20000 });

    off();
    expect(stepsVistos.length).toBeGreaterThan(0);
    view.unmount();
  }, 40000);

  test('MTU manual fora da faixa é bloqueado na UI (576..9000)', async () => {
    const notes = [];
    const view = mount(<MtuPanel isAdmin showNotification={(m, t) => notes.push([m, t])} />);
    await waitFor(() => view.query('input[type="number"]'), { timeout: 8000 });

    const input = view.query('input[type="number"]');
    expect(Number(input.min)).toBe(576);
    expect(Number(input.max)).toBe(9000);

    view.change(input, '100');
    const apply = view.query('.mtu-manual button');
    expect(apply).toBeTruthy();
    expect(apply.textContent).toMatch(/Aplicar/);
    view.click(apply);
    await flush(3);

    expect(notes.some(([msg, type]) => type === 'error' && /576/.test(msg))).toBe(true);
    view.unmount();
  }, 30000);
});

/* ================================================================== */
/* DNSChanger                                                          */
/* ================================================================== */

describe('DNSChanger', () => {
  test('mostra o DNS em uso na interface ativa e as ações de cache/DHCP', async () => {
    const view = mount(<DNSChanger isAdmin showNotification={noop} />);
    await waitFor(() => view.query('.dns-current-card') !== null, { timeout: 10000 });

    const text = view.text();
    expect(text).toContain('DNS & MTU');
    expect(text).toContain('Interface');
    expect(text).toContain('DNS em uso');
    expect(text).toContain('Limpar cache DNS');
    expect(text).toContain('Voltar para o DNS do roteador');
    view.unmount();
  }, 30000);

  test('renderiza a grade de provedores (fallback quando o backend não lista)', async () => {
    const view = mount(<DNSChanger isAdmin showNotification={noop} />);
    await waitFor(() => view.queryAll('.dns-card').length >= 5, { timeout: 10000 });

    const text = view.text();
    expect(text).toContain('Cloudflare');
    expect(text).toContain('Google');
    expect(text).toContain('1.1.1.1');
    expect(text).toContain('8.8.8.8');
    // Sem medição ainda: a UI é honesta em vez de mostrar zero.
    expect(text).toContain('Sem medição ainda');
    view.unmount();
  }, 30000);

  test('inclui a nota de honestidade: DNS não reduz o ping da partida', async () => {
    const view = mount(<DNSChanger isAdmin showNotification={noop} />);
    await waitFor(() => view.query('.dns-honesty') !== null, { timeout: 10000 });
    expect(view.text()).toMatch(/não reduz o ping/i);
    expect(view.text()).toMatch(/matchmaking|anti-cheat|patch/i);
    view.unmount();
  }, 30000);

  test('benchmark preenche métricas, score, ranking e recomendação', async () => {
    const view = mount(<DNSChanger isAdmin showNotification={noop} />);
    await waitFor(() => view.queryAll('.dns-card').length >= 5, { timeout: 10000 });

    const bench = Array.from(view.queryAll('button')).find((b) => /Testar todos/i.test(b.textContent));
    expect(bench).toBeTruthy();
    view.click(bench);

    await waitFor(() => view.queryAll('.dns-metric').length > 0, { timeout: 25000 });
    expect(view.query('.dns-recommendation')).toBeTruthy();
    expect(view.query('.dns-rank-badge, .dns-recommended-badge')).toBeTruthy();

    const text = view.text();
    expect(text).toMatch(/Score/);
    expect(text).toMatch(/Jitter/);
    expect(text).toMatch(/Perda/);
    expect(text).toMatch(/Recomendação/);
    expect(text).not.toContain('Sem medição ainda');

    // O melhor medido fica destacado e habilita o atalho de aplicar.
    const applyBest = Array.from(view.queryAll('button')).find((b) => /Aplicar melhor medido/i.test(b.textContent));
    expect(applyBest.disabled).toBe(false);
    view.unmount();
  }, 60000);

  test('o painel de MTU faz parte da mesma tela', async () => {
    const view = mount(<DNSChanger isAdmin showNotification={noop} />);
    await waitFor(() => view.text().includes('MTU da interface ativa'), { timeout: 10000 });
    expect(view.text()).toMatch(/1500 bytes|1492 bytes/);
    view.unmount();
  }, 30000);

  test('aplicar DNS sem admin: botão bloqueado com explicação', async () => {
    mock.__setAdmin(false);
    const notes = [];
    const view = mount(<DNSChanger isAdmin={false} showNotification={(m, t) => notes.push([m, t])} />);
    await waitFor(() => view.queryAll('.dns-card').length >= 5, { timeout: 10000 });

    const useBtn = Array.from(view.queryAll('.dns-card button')).find((b) => /Usar este DNS/i.test(b.textContent));
    expect(useBtn).toBeTruthy();
    expect(useBtn.disabled).toBe(true); // sem admin não aplica

    // Mas o flush de cache (que não exige escrita de configuração) continua disponível.
    const flush = Array.from(view.queryAll('button')).find((b) => /Limpar cache DNS/i.test(b.textContent));
    expect(flush.disabled).toBe(false);
    view.click(flush);
    await waitFor(() => notes.length > 0, { timeout: 6000 });
    expect(notes[0][1]).toBe('success');
    expect(/cache/i.test(notes[0][0])).toBe(true);
    view.unmount();
  }, 30000);

  test('DNS personalizado aplica primário/secundário válidos', async () => {
    mock.__setAdmin(true);
    const notes = [];
    const view = mount(<DNSChanger isAdmin showNotification={(m, t) => notes.push([m, t])} />);
    await waitFor(() => view.query('.custom-dns-card') !== null, { timeout: 10000 });

    const inputs = view.queryAll('.custom-dns-card input');
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    view.change(inputs[0], '1.1.1.1');
    view.change(inputs[1], '1.0.0.1');

    const apply = Array.from(view.queryAll('.custom-dns-card button')).find((b) => /aplicar/i.test(b.textContent));
    expect(apply).toBeTruthy();
    view.click(apply);
    await waitFor(() => notes.length > 0, { timeout: 8000 });

    expect(notes.some(([msg, type]) => type === 'success' && /DNS/i.test(msg))).toBe(true);
    expect(mock.__getState().applied.autoDns).toBeTruthy();
    expect(mock.__getState().backups.autoDns).toBeTruthy(); // reversível

    // A tela relê o DNS em uso e passa a mostrar o servidor aplicado.
    await waitFor(() => view.text().includes('1.1.1.1'), { timeout: 6000 });
    expect(view.query('.dns-current-card').textContent).toContain('1.1.1.1');
    view.unmount();
  }, 40000);
});

/* ================================================================== */
/* Optimizer (tela da v1.0 preservada + novos cartões)                 */
/* ================================================================== */

describe('Optimizer', () => {
  test('mantém as otimizações clássicas da v1.0', async () => {
    const view = mount(<Optimizer isAdmin showNotification={noop} onNavigate={noop} />);
    await waitFor(() => view.text().includes('Otimizador de Rede'), { timeout: 8000 });

    const text = view.text();
    expect(text).toMatch(/TCP|Otimizar/i);
    expect(text).toMatch(/Nagle/i);
    expect(text).toMatch(/DNS/i);
    expect(text).toMatch(/Dicas/i);
    view.unmount();
  }, 20000);

  test('cartão de contexto do sistema lê get-system-context', async () => {
    const view = mount(<Optimizer isAdmin showNotification={noop} onNavigate={noop} />);
    await waitFor(() => view.query('.system-context-card') !== null, { timeout: 8000 });
    await waitFor(() => /Windows/.test(view.text()), { timeout: 8000 });
    view.unmount();
  }, 20000);

  test('cartão de backup oferece exportar e reverter tudo', async () => {
    const view = mount(<Optimizer isAdmin showNotification={noop} onNavigate={noop} />);
    await waitFor(() => view.query('.backup-card') !== null, { timeout: 8000 });

    const buttons = Array.from(view.queryAll('.backup-card button')).map((b) => b.textContent);
    expect(buttons.some((t) => /exportar/i.test(t))).toBe(true);
    expect(buttons.some((t) => /reverter|restaurar/i.test(t))).toBe(true);
    view.unmount();
  }, 20000);

  test('herói navega para o Modo Ultra Low-Latency', async () => {
    const navigations = [];
    const view = mount(<Optimizer isAdmin showNotification={noop} onNavigate={(page) => navigations.push(page)} />);
    await waitFor(() => view.byText('Ultra Low-Latency', 'button') !== null, { timeout: 8000 });

    view.click(view.byText('Ultra Low-Latency', 'button'));
    expect(navigations).toEqual(['lowlatency']);
    view.unmount();
  }, 20000);

  test('"Reverter tudo" pede confirmação antes de mexer no sistema', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => false);
    const view = mount(<Optimizer isAdmin showNotification={noop} onNavigate={noop} />);
    await waitFor(() => view.query('.backup-card') !== null, { timeout: 8000 });

    const revert = Array.from(view.queryAll('.backup-card button')).find((b) => /reverter|restaurar/i.test(b.textContent));
    view.click(revert);
    await flush(2);

    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
    view.unmount();
  }, 20000);
});

/* ================================================================== */
/* App — casca completa                                                */
/* ================================================================== */

describe('App', () => {
  test('abre no Modo Ultra Low-Latency com sidebar e banner demo', async () => {
    const view = mount(<App />);
    await waitFor(() => view.query('.sidebar') !== null, { timeout: 10000 });

    expect(view.query('.sidebar-item.active').textContent).toContain('Ultra Low-Latency');
    await waitFor(() => view.text().includes('Modo Ultra Low-Latency'), { timeout: 10000 });
    expect(view.text()).toContain('Modo demonstração');
    view.unmount();
  }, 40000);

  test('navegar para DNS & MTU troca a página', async () => {
    const view = mount(<App />);
    await waitFor(() => view.queryAll('.sidebar-item').length === 6, { timeout: 10000 });

    const dnsItem = view.queryAll('.sidebar-item').find((i) => i.textContent.includes('DNS & MTU'));
    view.click(dnsItem);

    await waitFor(() => view.queryAll('.dns-card').length > 0, { timeout: 15000 });
    expect(view.text()).toContain('DNS em uso');
    expect(view.query('.sidebar-item.active').textContent).toContain('DNS & MTU');
    view.unmount();
  }, 40000);

  test('controles de janela da v1.0 continuam presentes (frame:false)', async () => {
    const view = mount(<App />);
    await waitFor(() => view.query('.sidebar') !== null, { timeout: 10000 });
    const titlebar = view.query('.title-pill, .window-controls, .titlebar');
    expect(titlebar).toBeTruthy();
    view.unmount();
  }, 40000);
});
