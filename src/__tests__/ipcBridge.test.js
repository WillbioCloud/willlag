/**
 * Ponte de IPC do renderer.
 *
 * O contrato que importa aqui:
 *  - em modo demo (navegador / `npm start`) a UI funciona inteira contra o
 *    mockBackend, sem tocar em nada do sistema;
 *  - em modo preload, `invoke`/`send` vão para window.willlag e `on` devolve
 *    uma função de unsubscribe com o PAYLOAD (sem o objeto `event` do Electron)
 *    — os componentes foram migrados para esse formato e um regresso aqui
 *    quebraria Dashboard e NetworkMonitor silenciosamente;
 *  - nenhum canal pode lançar exceção para dentro do componente.
 */

import ipc, { mode, isDemo, isElectron } from '../services/ipc';
import mock from '../services/mockBackend';
import catalog from '../shared/tweakCatalog.json';

describe('detecção de modo', () => {
  test('fora do Electron cai em modo demo', () => {
    expect(mode).toBe('demo');
    expect(isDemo).toBe(true);
    expect(isElectron).toBe(false);
    expect(ipc.mode).toBe('demo');
  });

  test('interface pública completa (mesma forma do preload)', () => {
    for (const fn of ['invoke', 'send', 'on', 'once', 'removeAll']) {
      expect(typeof ipc[fn]).toBe('function');
    }
  });
});

describe('invoke em modo demo (mockBackend)', () => {
  beforeEach(() => {
    mock.__setAdmin(false);
  });

  test('get-system-context devolve um Windows 11 simulado com adaptador USB', async () => {
    const ctx = await ipc.invoke('get-system-context');
    expect(ctx).toBeTruthy();
    expect(ctx.platform.isWindows).toBe(true);
    expect(ctx.platform.windowsBuild).toBeGreaterThanOrEqual(9200);
    expect(ctx.elevation.isAdmin).toBe(false);
    expect(ctx.activeAdapter.isUsb).toBe(true);
    expect(ctx.activeAdapter.isWifi).toBe(true);
    expect(ctx.features.ctcp).toBe(true);
    expect(ctx.catalogValid).toBe(true);
    expect(ctx.wifiAdapters.length).toBeGreaterThan(0);
  });

  test('get-elevation-status explica o que falta quando não é admin', async () => {
    const st = await ipc.invoke('get-elevation-status');
    expect(st.isAdmin).toBe(false);
    expect(st.canApplyTweaks).toBe(true); // demo deixa tentar para mostrar o erro
    expect(typeof st.message).toBe('string');
    expect(st.message.length).toBeGreaterThan(10);
    expect(st.recommendation).toBe('relaunch-or-prompt');
    expect(typeof st.hint).toBe('string');
  });

  test('negar o UAC devolve erro acionável, não exceção (requisito de elevação)', async () => {
    const res = await ipc.invoke('apply-tweak', 'networkThrottling', {});
    expect(res.success).toBe(false);
    expect(res.code).toBe('UAC_DENIED');
    expect(res.applied).toBe(false);
    expect(res.message).toMatch(/UAC|Administrador/);

    // Nada foi aplicado.
    const detected = await ipc.invoke('detect-tweak', 'networkThrottling');
    expect(detected.recordedApplied).toBe(false);
  });

  test('relaunch-as-admin simula a elevação e libera os ajustes', async () => {
    const elevated = await ipc.invoke('relaunch-as-admin');
    expect(elevated.success).toBe(true);

    const st = await ipc.invoke('get-elevation-status');
    expect(st.isAdmin).toBe(true);
    expect(st.recommendation).toBe('ready');
  });

  test('get-tweaks-detailed devolve os 20 tweaks do catálogo com estado', async () => {
    const res = await ipc.invoke('get-tweaks-detailed');
    expect(res.ok !== false).toBe(true);
    const tweaks = res.tweaks || res;
    expect(tweaks.length).toBe(catalog.tweaks.length);

    const ids = tweaks.map((t) => t.id);
    for (const expected of ['nagle', 'wlanAutoconfig', 'autoDns', 'mtuOptimize']) {
      expect(ids).toContain(expected);
    }
    for (const t of tweaks) {
      expect(typeof t.label).toBe('string');
      expect(['low', 'medium', 'high']).toContain(t.risk);
      expect(['persistent', 'session']).toContain(t.scope);
    }
  });

  test('apply-tweak / revert-tweak mantêm o estado coerente', async () => {
    mock.__setAdmin(true);
    const apply = await ipc.invoke('apply-tweak', 'networkThrottling', {});
    expect(apply.success).toBe(true);

    const detected = await ipc.invoke('detect-tweak', 'networkThrottling');
    expect(detected.applied).toBe(true);

    const revert = await ipc.invoke('revert-tweak', 'networkThrottling');
    expect(revert.success).toBe(true);

    const after = await ipc.invoke('detect-tweak', 'networkThrottling');
    expect(after.applied).toBe(false);
  });

  test('gamemode-start ativa o modo e gamemode-stop devolve tudo', async () => {
    mock.__setAdmin(true);
    const started = await ipc.invoke('gamemode-start', { preset: 'ultra' });
    expect(started.success).toBe(true);
    expect(started.baseline).toBeTruthy();
    expect(started.after).toBeTruthy();
    expect(started.improvement).toBeTruthy();

    let status = await ipc.invoke('gamemode-status');
    expect(status.active).toBe(true);
    expect(status.appliedIds.length).toBeGreaterThan(0);

    const stopped = await ipc.invoke('gamemode-stop', {});
    expect(stopped.success).toBe(true);

    status = await ipc.invoke('gamemode-status');
    expect(status.active).toBe(false);
    expect(status.appliedIds.length).toBe(0);
  }, 40000);

  test('mtu-get / mtu-discover respondem com forma esperada pela MtuPanel', async () => {
    const current = await ipc.invoke('mtu-get');
    expect(current.ok).toBe(true);
    expect(current.mtu).toBeGreaterThanOrEqual(576);
    expect(current.adapter.name).toBeTruthy();

    const found = await ipc.invoke('mtu-discover');
    expect(found.ok !== undefined || found.success !== undefined).toBe(true);
  });

  test('dns-current e dns-benchmark alimentam a tela de DNS', async () => {
    const current = await ipc.invoke('dns-current');
    expect(Array.isArray(current.servers || current.dns || [])).toBe(true);

    const bench = await ipc.invoke('dns-benchmark', { providers: ['cloudflare', 'google'] });
    expect(bench.ok !== false).toBe(true);
    expect(Array.isArray(bench.results)).toBe(true);
    if (bench.results.length > 0) {
      const first = bench.results[0];
      expect(first.rank).toBe(1);
      expect(typeof first.id).toBe('string');
      expect(typeof first.primary).toBe('string');
    }
  });

  test('canal inexistente devolve null em vez de lançar', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(ipc.invoke('canal-que-nao-existe')).resolves.toBeNull();
    spy.mockRestore();
  });

  test('legacy: get-processes continua com a forma da v1.0', async () => {
    const list = await ipc.invoke('get-processes');
    expect(Array.isArray(list)).toBe(true);
    if (list.length > 0) {
      const p = list[0];
      expect(typeof p.pid).toBe('number');
      expect(typeof p.name).toBe('string');
      expect(p).toHaveProperty('memory');
      expect(p).toHaveProperty('priority');
    }
  });
});

describe('eventos (on/once/removeAll)', () => {
  beforeEach(() => {
    mock.__setAdmin(true);
  });

  afterEach(async () => {
    await ipc.invoke('gamemode-stop', {});
  });

  test('on devolve função de unsubscribe e entrega o payload', async () => {
    const received = [];
    const off = ipc.on('gamemode-progress', (payload) => received.push(payload));
    expect(typeof off).toBe('function');

    await ipc.invoke('gamemode-start', { tweakIds: ['nagle'] });
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]).toHaveProperty('phase');
    expect(typeof received[0].message).toBe('string');

    off();
    const antes = received.length;
    await ipc.invoke('gamemode-stop', {});
    expect(received.length).toBe(antes);
  }, 30000);

  test('vários listeners no mesmo canal, e um quebrado não derruba o outro', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ok = [];

    const offBad = ipc.on('tweak-updated', () => { throw new Error('listener quebrado'); });
    const offGood = ipc.on('tweak-updated', (payload) => ok.push(payload));

    await ipc.invoke('apply-tweaks', ['nagle', 'networkThrottling']);

    expect(ok.length).toBe(2);
    expect(ok[0]).toHaveProperty('id');
    expect(spy).toHaveBeenCalled(); // o listener quebrado foi isolado e logado

    offBad();
    offGood();
    spy.mockRestore();
  });

  test('once resolve com o primeiro evento', async () => {
    const promise = ipc.once('gamemode-state');
    await ipc.invoke('gamemode-start', { tweakIds: ['nagle'] });
    const payload = await promise;
    expect(payload).toBeTruthy();
    expect(payload.status).toBeTruthy();
    await ipc.invoke('gamemode-stop', {});
  }, 30000);

  test('removeAll limpa todos os listeners do canal', async () => {
    const hits = [];
    ipc.on('ping-result', (p) => hits.push(p));
    ipc.removeAll('ping-result');

    ipc.send('start-ping-monitor', '1.1.1.1');
    await new Promise((r) => setTimeout(r, 60));
    ipc.send('stop-ping-monitor');

    expect(hits.length).toBe(0);
  });
});

describe('send (canais fire-and-forget)', () => {
  test('minimize/maximize/close não lançam', () => {
    expect(() => ipc.send('minimize-window')).not.toThrow();
    expect(() => ipc.send('maximize-window')).not.toThrow();
    expect(() => ipc.send('close-window')).not.toThrow();
  });
});

describe('modo preload (window.willlag)', () => {
  const originalWilllag = window.willlag;

  afterEach(() => {
    if (originalWilllag === undefined) delete window.willlag;
    else window.willlag = originalWilllag;
    jest.resetModules();
  });

  function loadIpcWithPreload(api) {
    window.willlag = api;
    jest.resetModules();
    // eslint-disable-next-line global-require
    return require('../services/ipc');
  }

  test('com window.willlag presente, mode vira "preload" e invoke delega', async () => {
    const calls = [];
    const mod = loadIpcWithPreload({
      version: 2,
      invoke: async (channel, ...args) => { calls.push([channel, ...args]); return { ok: true, channel }; },
      send: (channel, ...args) => { calls.push(['send', channel, ...args]); },
      on: () => () => {},
      once: () => Promise.resolve(null),
      removeAll: () => {},
    });

    expect(mod.default.mode).toBe('preload');
    expect(mod.default.isElectron).toBe(true);
    expect(mod.default.isDemo).toBe(false);

    const res = await mod.default.invoke('apply-tweak', 'nagle', { allInterfaces: true });
    expect(res).toEqual({ ok: true, channel: 'apply-tweak' });
    expect(calls[0]).toEqual(['apply-tweak', 'nagle', { allInterfaces: true }]);

    mod.default.send('minimize-window');
    expect(calls[1]).toEqual(['send', 'minimize-window']);
  });

  test('on() assina no preload e o unsubscribe cancela; handler recebe só o payload', () => {
    let registered = null;
    let removed = 0;
    const mod = loadIpcWithPreload({
      version: 2,
      invoke: async () => null,
      send: () => {},
      on: (channel, handler) => { registered = { channel, handler }; return () => { removed += 1; }; },
      once: () => Promise.resolve(null),
      removeAll: () => {},
    });

    const seen = [];
    const off = mod.default.on('gamemode-state', (payload) => seen.push(payload));

    expect(registered.channel).toBe('gamemode-state');
    // O preload entrega apenas o payload (o `event` do Electron fica no main).
    registered.handler({ status: { active: true } });
    expect(seen).toEqual([{ status: { active: true } }]);

    off();
    expect(removed).toBe(1);
  });

  test('modo legacy: window.require("electron") ainda é suportado', async () => {
    const invoked = [];
    window.require = () => ({
      ipcRenderer: {
        invoke: async (channel, ...args) => { invoked.push([channel, ...args]); return { legacy: true }; },
        send: () => {},
        on: () => {},
        removeAllListeners: () => {},
      },
    });
    jest.resetModules();
    // eslint-disable-next-line global-require
    const mod = require('../services/ipc');
    expect(mod.default.mode).toBe('legacy');
    expect(await mod.default.invoke('check-admin')).toEqual({ legacy: true });
    expect(invoked[0][0]).toBe('check-admin');
    delete window.require;
  });
});
