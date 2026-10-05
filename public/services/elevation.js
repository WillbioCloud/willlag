'use strict';

/**
 * Elevação de privilégios (UAC).
 *
 * Decisão de arquitetura: o willLag NÃO exige ser iniciado como administrador.
 * Ele roda como usuário normal (monitoramento, benchmark, diagnóstico funcionam
 * perfeitamente sem elevação) e eleva sob demanda:
 *
 *   a) `ensureElevated()` — abre UM prompt UAC por operação, executando o
 *      script num processo filho elevado e devolvendo o resultado por arquivo.
 *      Se o usuário negar, devolvemos { code: 'UAC_DENIED' } com mensagem clara
 *      e nenhuma alteração é feita.
 *
 *   b) `relaunchAsAdmin()` — reinicia o app inteiro elevado, para quem prefere
 *      não ver prompts (comportamento estilo ExitLag).
 *
 * Nenhum dos dois caminhos lança exceção para o renderer: tudo vira resultado
 * estruturado, para a UI poder explicar o que aconteceu.
 */

const ps = require('./psRunner');
const logger = require('./logger');

const log = logger.scope('elevation');

const cache = { isAdmin: null, at: 0 };
const NEGATIVE_TTL = 5000;

/** Verifica se o processo atual tem token elevado. */
async function isAdmin() {
  if (!ps.isWindows()) return false;
  if (cache.isAdmin === true) return true;
  if (cache.isAdmin === false && Date.now() - cache.at < NEGATIVE_TTL) return false;

  const res = await ps.runPowerShell(
    `
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($id)
$elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
Write-WillLagJson @{
  ok       = $true
  elevated = [bool]$elevated
  user     = $id.Name
  sid      = $id.User.Value
}
`,
    { label: 'elevation:check', timeout: 20000 }
  );

  if (!res.success) {
    // Fallback clássico: `net session` só funciona elevado.
    const fallback = await ps.execFileAsync('net', ['session'], { timeout: 8000 });
    cache.isAdmin = !fallback.error;
    cache.at = Date.now();
    return cache.isAdmin;
  }

  cache.isAdmin = Boolean(res.data && res.data.elevated);
  cache.at = Date.now();
  return cache.isAdmin;
}

function invalidate() {
  cache.isAdmin = null;
  cache.at = 0;
}

/** Status completo para a UI (com recomendação do que fazer). */
async function getStatus() {
  const elevated = await isAdmin();
  const isWin = ps.isWindows();

  if (!isWin) {
    return {
      isAdmin: false,
      isWindows: false,
      canApplyTweaks: false,
      message: 'willLag roda os ajustes de sistema apenas no Windows.',
      recommendation: 'use-demo',
    };
  }

  if (elevated) {
    return {
      isAdmin: true,
      isWindows: true,
      canApplyTweaks: true,
      message: 'Executando com privilégios de Administrador. Todos os ajustes podem ser aplicados diretamente.',
      recommendation: 'ready',
    };
  }

  return {
    isAdmin: false,
    isWindows: true,
    canApplyTweaks: true,
    message:
      'Executando sem privilégios de Administrador. Leitura e testes funcionam; ao aplicar um ajuste ' +
      'o Windows vai pedir permissão (UAC) uma vez por operação.',
    recommendation: 'relaunch-or-prompt',
    hint: 'Para não ver prompts a cada ajuste, use "Reiniciar como Administrador".',
  };
}

/**
 * Reinicia o aplicativo elevado.
 * `electronApp` é injetado para manter este módulo testável fora do Electron.
 */
async function relaunchAsAdmin(electronApp, options = {}) {
  if (!ps.isWindows()) {
    return { success: false, code: 'UNSUPPORTED_PLATFORM', message: 'Reinício elevado só existe no Windows.' };
  }

  if (await isAdmin()) {
    return { success: true, code: 'ALREADY_ADMIN', message: 'O aplicativo já está elevado.' };
  }

  let exePath = process.execPath;
  let args = [];

  try {
    const packaged = electronApp && typeof electronApp.isPackaged === 'boolean' ? electronApp.isPackaged : false;
    if (packaged) {
      exePath = process.execPath;
      args = process.argv.slice(1).filter((a) => !a.startsWith('--type='));
    } else {
      // Em desenvolvimento, process.execPath é o electron e o primeiro argumento é o app.
      exePath = process.execPath;
      args = process.argv.slice(1).filter((a) => !a.startsWith('--type='));
      if (electronApp && electronApp.getAppPath) {
        const appPath = electronApp.getAppPath();
        if (appPath && !args.some((a) => a === appPath)) args = [appPath, ...args];
      }
    }
  } catch (err) {
    log.warn('Falha ao montar argumentos do relaunch', { err: err.message });
  }

  const argList = args.map((a) => ps.psString(a)).join(', ');

  const body = `
$exe = ${ps.psString(exePath)}
$argList = @(${argList})
try {
  if ($argList.Count -gt 0) {
    Start-Process -FilePath $exe -ArgumentList $argList -Verb RunAs -ErrorAction Stop
  } else {
    Start-Process -FilePath $exe -Verb RunAs -ErrorAction Stop
  }
  Write-WillLagJson @{ ok = $true; relaunched = $true }
} catch {
  Write-WillLagJson @{ ok = $false; error = $_.Exception.Message; hresult = ('{0:X}' -f $_.Exception.HResult) }
  exit 1
}
`;

  const res = await ps.runPowerShell(body, { label: 'elevation:relaunch', timeout: options.timeout || 120000 });

  if (!res.success) {
    const code = ps.classifyFailure(res.rawError || res.error, res);
    if (code === 'UAC_DENIED') {
      return {
        success: false,
        code: 'UAC_DENIED',
        message:
          'Você negou o prompt de Administrador. O aplicativo continua aberto sem privilégios — ' +
          'ajustes ainda podem ser aplicados individualmente (cada um pedirá permissão).',
      };
    }
    return {
      success: false,
      code,
      message: res.error || 'Não foi possível reiniciar como Administrador.',
    };
  }

  // Dá tempo de o novo processo subir antes de encerrar este.
  if (electronApp && typeof electronApp.quit === 'function') {
    setTimeout(() => {
      try {
        if (typeof options.beforeQuit === 'function') options.beforeQuit();
        electronApp.exit(0);
      } catch (err) {
        log.error('Falha ao encerrar após relaunch', { err: err.message });
      }
    }, options.delayMs || 1200);
  }

  return {
    success: true,
    code: 'OK',
    message: 'Reiniciando como Administrador...',
  };
}

/**
 * Guard usado pelos handlers IPC: devolve um erro padronizado quando a ação
 * exige admin e não podemos (ou não devemos) pedir UAC.
 */
function adminRequiredResult(message) {
  return {
    success: false,
    code: 'ELEVATION_REQUIRED',
    applied: false,
    message:
      message ||
      'Esta ação exige privilégios de Administrador. Clique em "Reiniciar como Administrador" ou aceite o prompt UAC.',
  };
}

module.exports = {
  isAdmin,
  invalidate,
  getStatus,
  relaunchAsAdmin,
  adminRequiredResult,
};
