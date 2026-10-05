/**
 * Helpers de gerenciamento de processos para jogos.
 *
 * (Arquivo existia vazio no repositório. Agora concentra a heurística de
 * detecção de jogos/launchers e as opções de prioridade, que estavam
 * hardcoded dentro de ProcessList.js — assim Dashboard e a aba de processos
 * usam o mesmo critério.)
 */

/** Palavras-chave da v1.0 + launchers e anti-cheats comuns. */
export const GAME_KEYWORDS = [
  'game', 'steam', 'epic', 'riot', 'valorant', 'fortnite', 'league',
  'csgo', 'cs2', 'apex', 'overwatch', 'minecraft', 'roblox', 'gta', 'cod',
  'battlenet', 'origin', 'ubisoft', 'blizzard', 'discord',
  // lançadores/clients adicionais
  'gog', 'ea app', 'ealauncher', 'bethesda', 'xbox', 'warframe', 'pathofexile',
  'dota', 'deadlock', 'rocketleague', 'rainbow6', 'siege', 'pubg', 'warzone',
  'destiny', 'diablo', 'wow', 'ffxiv', 'genshin', 'honkai', 'wuthering',
  // anti-cheat / runtime de jogo (importante: merecem prioridade também)
  'vgc', 'vanguard', 'easyanticheat', 'eac', 'battleye', 'faceit', 'ace-base',
  'sguard', 'tenprotect', 'unity', 'unreal', 'launcher',
];

/** Processos que consomem banda/CPU e costumam causar jitter em partida. */
export const BANDWIDTH_HOGS = [
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'onedrive', 'dropbox',
  'googledrive', 'backup', 'spotify', 'obs64', 'obs32', 'discord', 'teams',
  'zoom', 'skype', 'steam', 'epicgameslauncher', 'battlenet', 'utorrent',
  'qbittorrent', 'transmission', 'windowsupdate', 'wuauserv', 'antimalware',
  'msmpeng', 'searchindexer', 'onedrivesetup',
];

/** Anti-cheat: nunca mexer na prioridade (pode ser interpretado como tampering). */
export const PROTECTED_PROCESSES = [
  'vgc', 'vgk', 'valorant-watcher', 'faceitclient', 'faceitservice',
  'easyanticheat', 'easyanticheat_eos', 'beservice', 'battleyeservice',
  'sguard64', 'sguardsvc', 'tenio', 'tenprotect', 'ace-base', 'xigncode',
  'nprotect', 'gameguard', 'eracleservice', 'riotclientcrashhandler',
];

export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .trim();
}

export function isGame(name) {
  const n = normalizeName(name);
  if (!n) return false;
  return GAME_KEYWORDS.some((kw) => n.includes(kw));
}

export function isBandwidthHog(name) {
  const n = normalizeName(name);
  if (!n) return false;
  return BANDWIDTH_HOGS.some((kw) => n.includes(kw));
}

/**
 * Processos protegidos por anti-cheat.
 * Alterar prioridade/afinidade deles pode disparar detecção ou impedir o jogo
 * de iniciar. A UI deve desabilitar as ações e explicar o motivo.
 */
export function isProtected(name) {
  const n = normalizeName(name);
  if (!n) return false;
  return PROTECTED_PROCESSES.some((kw) => n === kw || n.includes(kw));
}

export const PRIORITY_OPTIONS = [
  { value: 'Realtime', label: 'Tempo Real', tone: 'danger', warning: 'Pode travar o sistema se o jogo usar 100% de CPU. Use só em último caso.' },
  { value: 'High', label: 'Alta', tone: 'warning', warning: null },
  { value: 'AboveNormal', label: 'Acima do Normal', tone: 'info', warning: null },
  { value: 'Normal', label: 'Normal', tone: 'neutral', warning: null },
  { value: 'BelowNormal', label: 'Abaixo do Normal', tone: 'neutral', warning: null },
  { value: 'Idle', label: 'Baixa (Idle)', tone: 'neutral', warning: null },
];

/** Compatibilidade com a v1.0, que usava 'Low' no select. */
export const PRIORITY_ALIAS = { Low: 'Idle', Idle: 'Idle' };

export function normalizePriority(value) {
  const v = String(value || '');
  return PRIORITY_ALIAS[v] || v;
}

export function priorityInfo(value) {
  return PRIORITY_OPTIONS.find((p) => p.value === value) || null;
}

/**
 * Recomendação de ação por processo: o que vale a pena otimizar e o que não.
 * Retorna { canBoost, canPriority, canQos, reason }
 */
export function recommendFor(process) {
  const name = normalizeName(process && process.name);

  if (isProtected(name)) {
    return {
      canBoost: false,
      canPriority: false,
      canQos: false,
      tone: 'danger',
      reason:
        'Processo protegido por anti-cheat. Alterar prioridade ou afinidade pode ser interpretado ' +
        'como adulteração e impedir o jogo de iniciar.',
    };
  }

  if (isGame(name)) {
    return {
      canBoost: true,
      canPriority: true,
      canQos: true,
      tone: 'success',
      reason: 'Jogo/launcher detectado: prioridade alta + QoS DSCP 46 são seguros e recomendados.',
    };
  }

  if (isBandwidthHog(name)) {
    return {
      canBoost: false,
      canPriority: true,
      canQos: false,
      tone: 'warning',
      reason:
        'Este processo costuma competir por banda/CPU durante a partida. Em vez de priorizá-lo, ' +
        'considere reduzi-lo para "Abaixo do Normal" ou fechá-lo.',
    };
  }

  return {
    canBoost: true,
    canPriority: true,
    canQos: true,
    tone: 'neutral',
    reason: null,
  };
}

export function filterProcesses(processes, searchTerm) {
  const term = String(searchTerm || '').toLowerCase().trim();
  if (!term) return processes;
  return processes.filter(
    (p) =>
      String(p.name || '').toLowerCase().includes(term) ||
      String(p.title || '').toLowerCase().includes(term) ||
      String(p.pid || '').includes(term)
  );
}

export function sortProcesses(processes, mode = 'memory') {
  const arr = [...(processes || [])];
  switch (mode) {
    case 'cpu':
      return arr.sort((a, b) => parseFloat(b.cpu) - parseFloat(a.cpu));
    case 'name':
      return arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    case 'pid':
      return arr.sort((a, b) => Number(a.pid) - Number(b.pid));
    case 'memory':
    default:
      return arr.sort((a, b) => Number(b.memory) - Number(a.memory));
  }
}

export default {
  GAME_KEYWORDS,
  BANDWIDTH_HOGS,
  PROTECTED_PROCESSES,
  normalizeName,
  isGame,
  isBandwidthHog,
  isProtected,
  PRIORITY_OPTIONS,
  normalizePriority,
  priorityInfo,
  recommendFor,
  filterProcesses,
  sortProcesses,
};
