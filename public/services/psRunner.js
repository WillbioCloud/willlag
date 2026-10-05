'use strict';

/**
 * Camada de execução segura de comandos (PowerShell / netsh / reg / ping).
 *
 * Regras seguidas aqui — e o motivo de cada uma:
 *
 *  1. NUNCA interpolamos texto do usuário dentro de uma string de shell.
 *     O código antigo fazia `exec("powershell -Command \"... '${interfaceName}' ...\"")`,
 *     o que permite injeção de comando (um nome de adaptador como
 *     `Wi-Fi'; Remove-Item C:\ #` executaria código arbitrário COMO ADMIN).
 *     Aqui usamos `execFile` (sem shell) + `-EncodedCommand` (base64 UTF-16LE)
 *     e `psString()` para literais.
 *
 *  2. Saída estruturada e confiável: todo script emite um marcador
 *     `@@WILLLAG_JSON@@` seguido de JSON compacto. Assim warnings, banners de
 *     perfil ou texto de cmdlets não corrompem o parse.
 *
 *  3. Timeouts e maxBuffer explícitos — nenhum tweak pode travar o app.
 *
 *  4. Elevação sob demanda (UAC) com tratamento de "usuário negou"
 *     (HRESULT 0x800704C7 / ERROR_CANCELLED), sem nunca derrubar o processo.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const log = logger.scope('exec');

const JSON_MARKER = '@@WILLLAG_JSON@@';
const POWERSHELL_BIN = 'powershell.exe';
const NETSH_BIN = 'netsh.exe';
const REG_BIN = 'reg.exe';
const POWERCFG_BIN = 'powercfg.exe';

// CreateProcess limita a linha de comando a ~32767 caracteres. Acima disso,
// gravamos o script em arquivo temporário e usamos -File.
const MAX_ENCODED_LEN = 28000;

let tmpDir = null;

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function isWindows() {
  return process.platform === 'win32';
}

function configure(options = {}) {
  if (options.tmpDir) {
    tmpDir = options.tmpDir;
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch (err) {
      log.warn('Não foi possível criar diretório temporário', { err: err.message });
      tmpDir = null;
    }
  }
}

function getTmpDir() {
  if (tmpDir) return tmpDir;
  return os.tmpdir();
}

/** Codifica um script PowerShell como base64 UTF-16LE (formato de -EncodedCommand). */
function encodePsCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * Converte um valor JS em um literal de string PowerShell seguro.
 * Strings single-quoted no PowerShell não interpretam variáveis nem backticks;
 * a única sequência especial é o apóstrofo, que é duplicado.
 */
function psString(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Converte um valor JS em literal numérico PowerShell (bloqueia injeção via número). */
function psNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(fallback);
  return String(n);
}

/** Converte um array JS em literal de array PowerShell de strings seguras. */
function psStringArray(values) {
  const list = Array.isArray(values) ? values : [values];
  return '@(' + list.map(psString).join(', ') + ')';
}

/**
 * Valida host/IP antes de usar em `ping` ou sockets.
 * Aceita IPv4, IPv6 simples e hostnames FQDN. Rejeita qualquer caractere de shell.
 */
function isSafeHost(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 253) return false;
  return /^[A-Za-z0-9._:\-[\]]+$/.test(v) && !/\s/.test(v);
}

/** Valida nome de interface/alias — permite espaços e acentos, bloqueia metacaracteres. */
function isSafeName(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 200) return false;
  // Bloqueia: aspas, crase, $, ;, |, &, <, >, newline — vetores de injeção.
  return !/["'`$;|&<>\r\n]/.test(v);
}

/** Valida GUID de interface de rede. */
function isSafeGuid(value) {
  return typeof value === 'string' && /^\{?[0-9a-fA-F-]{36}\}?$/.test(value.trim());
}

function sanitizeName(value) {
  return String(value || '').replace(/["'`$;|&<>\r\n]/g, '').trim();
}

function unsupported(operation, detail) {
  return {
    success: false,
    code: 'UNSUPPORTED_PLATFORM',
    error: `Operação "${operation}" disponível apenas no Windows (plataforma atual: ${process.platform}).`,
    detail: detail || null,
  };
}

/* ------------------------------------------------------------------ */
/* execFile promisificado (captura stdout mesmo com exit code != 0)    */
/* ------------------------------------------------------------------ */

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    const opts = {
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
      windowsHide: true,
      cwd: options.cwd,
      env: options.env,
      shell: false, // sempre sem shell: elimina injeção via metacaracteres
    };

    const started = Date.now();
    let settled = false;

    execFile(file, args, opts, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      resolve({
        error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        exitCode: error && typeof error.code === 'number' ? error.code : error ? error.code : 0,
        numericExit: error && typeof error.status === 'number' ? error.status : 0,
        timedOut: Boolean(error && error.killed),
        durationMs: Date.now() - started,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Parsing da saída                                                    */
/* ------------------------------------------------------------------ */

/**
 * Extrai o JSON emitido após o marcador. Se não houver marcador, tenta fazer o
 * parse do stdout inteiro (compatível com scripts que só imprimem JSON).
 */
function parseMarkerOutput(stdout) {
  const text = String(stdout || '');
  const idx = text.lastIndexOf(JSON_MARKER);

  let payload = null;
  if (idx >= 0) {
    payload = text.slice(idx + JSON_MARKER.length).trim();
  } else {
    payload = text.trim();
  }

  if (!payload) return { found: idx >= 0, data: null, parseError: 'Saída vazia' };

  // Alguns cmdlets imprimem linhas extras antes/depois; isolamos do primeiro
  // '{' ou '[' até o último '}' ou ']'.
  const firstObj = payload.search(/[[{]/);
  const lastObj = Math.max(payload.lastIndexOf('}'), payload.lastIndexOf(']'));
  if (firstObj >= 0 && lastObj > firstObj) {
    payload = payload.slice(firstObj, lastObj + 1);
  }

  try {
    return { found: idx >= 0, data: JSON.parse(payload), parseError: null };
  } catch (err) {
    return { found: idx >= 0, data: null, parseError: err.message };
  }
}

/** Normaliza saída do PowerShell 5.1: objeto único -> array quando esperamos lista. */
function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/* ------------------------------------------------------------------ */
/* PowerShell                                                          */
/* ------------------------------------------------------------------ */

/**
 * Pré-ambulo injetado em todo script:
 *  - função Write-WillLagJson (marcador + JSON compacto)
 *  - ErrorActionPreference estrito dentro do try
 *  - saída de erro estruturada no catch
 */
function buildScript(body, { strict = true } = {}) {
  return `
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Write-WillLagJson {
  param($Object)
  Write-Output '${JSON_MARKER}'
  if ($null -eq $Object) {
    Write-Output 'null'
  } else {
    try {
      Write-Output (ConvertTo-Json -InputObject $Object -Depth 10 -Compress)
    } catch {
      Write-Output (ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Depth 4 -Compress)
    }
  }
}

$ErrorActionPreference = '${strict ? 'Stop' : 'Continue'}'
try {
${body}
} catch {
  $ErrorActionPreference = 'Continue'
  Write-WillLagJson @{
    ok    = $false
    error = $_.Exception.Message
    type  = $_.Exception.GetType().FullName
    line  = $_.InvocationInfo.ScriptLineNumber
  }
  exit 1
}
`;
}

/**
 * Executa um script PowerShell e devolve { success, data, stdout, stderr, code }.
 *
 * `success` = processo terminou sem erro E o JSON tinha `ok !== false`
 * (quando o script informa `ok`, respeitamos; caso contrário, basta ter dados).
 */
async function runPowerShell(body, options = {}) {
  const label = options.label || 'powershell';

  if (!isWindows()) {
    return unsupported(label, 'PowerShell não disponível nesta plataforma.');
  }

  const script = options.raw ? String(body) : buildScript(body, { strict: options.strict !== false });
  const encoded = encodePsCommand(script);

  let args;
  let tempScript = null;

  if (encoded.length > MAX_ENCODED_LEN) {
    tempScript = path.join(getTmpDir(), `willlag-${crypto.randomBytes(6).toString('hex')}.ps1`);
    try {
      // UTF-8 com BOM garante que o PowerShell 5.1 leia acentos corretamente.
      fs.writeFileSync(tempScript, '\ufeff' + script, { encoding: 'utf8' });
    } catch (err) {
      return {
        success: false,
        code: 'TEMP_WRITE_FAILED',
        error: `Falha ao gravar script temporário: ${err.message}`,
        stdout: '',
        stderr: '',
      };
    }
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempScript];
  } else {
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  }

  const started = Date.now();
  const res = await execFileAsync(POWERSHELL_BIN, args, {
    timeout: options.timeout || 45000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
  });

  if (tempScript) {
    try { fs.unlinkSync(tempScript); } catch (err) { /* melhor esforço */ }
  }

  const parsed = parseMarkerOutput(res.stdout);
  const durationMs = Date.now() - started;

  if (res.timedOut) {
    log.warn(`${label}: timeout`, { durationMs });
    return {
      success: false,
      code: 'TIMEOUT',
      error: `Tempo esgotado ao executar "${label}" (${Math.round((options.timeout || 45000) / 1000)}s).`,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs,
      data: parsed.data,
    };
  }

  const data = parsed.data;
  const dataOk = data && typeof data === 'object' ? data.ok !== false : true;
  const success = !res.error && dataOk && !parsed.parseError;

  if (!success) {
    const stderrClean = (res.stderr || '').trim();
    const message =
      (data && data.error) ||
      parsed.parseError ||
      stderrClean ||
      (res.error ? res.error.message : 'Falha desconhecida');

    log.debug(`${label}: falha`, { code: res.error ? res.error.code : 'data-error', message: String(message).slice(0, 300) });

    return {
      success: false,
      code: classifyFailure(String(message), res),
      error: humanizeError(String(message)),
      rawError: String(message),
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.numericExit || res.exitCode,
      durationMs,
      data: data || null,
    };
  }

  return {
    success: true,
    code: 'OK',
    data,
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.numericExit || 0,
    durationMs,
  };
}

/** Classifica falhas conhecidas em códigos estáveis para a UI. */
function classifyFailure(message, res) {
  const m = String(message || '').toLowerCase();
  const exit = res && (res.numericExit || 0);

  if (m.includes('canceled by the user') || m.includes('cancelada pelo usuário') ||
      m.includes('cancelado pelo usuário') || m.includes('0x800704c7') || exit === 1223) {
    return 'UAC_DENIED';
  }
  if (m.includes('access is denied') || m.includes('acesso negado') || m.includes('unauthorizedaccess') ||
      m.includes('requested registry access is not allowed') || exit === 5) {
    return 'ACCESS_DENIED';
  }
  if (m.includes('elevated') || m.includes('administrator') || m.includes('administrador')) {
    return 'ELEVATION_REQUIRED';
  }
  if (m.includes('not recognized') || m.includes('não é reconhecido') || m.includes('cmdletnotfound')) {
    return 'UNSUPPORTED';
  }
  if (m.includes('the parameter is incorrect') || m.includes('parâmetro está incorreto') ||
      m.includes('invalid parameter') || m.includes('invalidargument')) {
    return 'INVALID_PARAMETER';
  }
  if (m.includes('cannot find path') || m.includes('não foi possível encontrar') || m.includes('itemnotfound')) {
    return 'NOT_FOUND';
  }
  if (m.includes('element not found') || m.includes('não foi possível encontrar o elemento')) {
    return 'NOT_FOUND';
  }
  return 'EXEC_FAILED';
}

/** Traduz erros técnicos do Windows em mensagens acionáveis, em pt-BR. */
function humanizeError(message) {
  const m = String(message || '');
  const lower = m.toLowerCase();

  if (lower.includes('canceled by the user') || lower.includes('cancelada pelo usuário') ||
      lower.includes('cancelado pelo usuário')) {
    return 'A solicitação de administrador (UAC) foi cancelada. Nenhuma alteração foi feita.';
  }
  if (lower.includes('access is denied') || lower.includes('acesso negado')) {
    return 'Acesso negado pelo Windows. Execute o willLag como Administrador.';
  }
  if (lower.includes('requested registry access is not allowed')) {
    return 'Sem permissão de escrita no Registro. Execute como Administrador.';
  }
  if (lower.includes('the parameter is incorrect') || lower.includes('parâmetro está incorreto')) {
    return 'Parâmetro não suportado por esta versão/driver do Windows.';
  }
  if (lower.includes('element not found') || lower.includes('não foi possível encontrar o elemento')) {
    return 'Configuração não existe neste sistema (provavelmente já está no padrão).';
  }
  if (lower.includes('cannot find path') || lower.includes('não foi possível encontrar o caminho')) {
    return 'Caminho/registro não encontrado neste sistema.';
  }
  if (lower.includes('the system cannot find the file specified')) {
    return 'Componente do Windows não encontrado.';
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* PowerShell elevado (UAC sob demanda)                                */
/* ------------------------------------------------------------------ */

/**
 * Executa um script PowerShell em um processo elevado, mesmo com o app
 * rodando sem privilégios.
 *
 * Fluxo:
 *   1. grava o script em arquivo temporário (o processo filho precisa ler do disco,
 *      pois -EncodedCommand ficaria enorme na linha de comando do Start-Process);
 *   2. o script elevado escreve o resultado em `<id>.out.json`;
 *   3. disparamos `Start-Process -Verb RunAs -Wait`;
 *   4. lemos o arquivo de resultado (com polling e timeout).
 *
 * Se o usuário negar o UAC, o Start-Process lança erro 1223 / "operação cancelada"
 * e devolvemos { code: 'UAC_DENIED' } — sem exceção propagada.
 */
async function runPowerShellElevated(body, options = {}) {
  const label = options.label || 'elevated';

  if (!isWindows()) {
    return unsupported(label, 'Elevação UAC só existe no Windows.');
  }

  const id = crypto.randomBytes(8).toString('hex');
  const dir = getTmpDir();
  const scriptPath = path.join(dir, `willlag-${id}.ps1`);
  const outPath = path.join(dir, `willlag-${id}.out.json`);

  // O script filho precisa: (a) executar o corpo, (b) salvar o JSON no arquivo.
  const childScript = buildScript(`
$___body = {
${body}
}
$___result = & $___body
if ($null -eq $___result) { $___result = @{ ok = $true } }
try {
  $___json = ConvertTo-Json -InputObject $___result -Depth 10 -Compress
} catch {
  $___json = ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Depth 4 -Compress
}
Set-Content -LiteralPath ${psString(outPath)} -Value $___json -Encoding UTF8 -Force
Write-WillLagJson $___result
`);

  try {
    fs.writeFileSync(scriptPath, '\ufeff' + childScript, { encoding: 'utf8' });
  } catch (err) {
    return {
      success: false,
      code: 'TEMP_WRITE_FAILED',
      error: `Falha ao gravar script temporário: ${err.message}`,
    };
  }

  const launcherBody = `
$ErrorActionPreference = 'Stop'
try {
  $proc = Start-Process -FilePath ${psString(POWERSHELL_BIN)} \`
    -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psString(scriptPath)}) \`
    -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  Write-WillLagJson @{ ok = $true; exitCode = $proc.ExitCode }
} catch {
  Write-WillLagJson @{ ok = $false; error = $_.Exception.Message; hresult = ('{0:X}' -f $_.Exception.HResult) }
  exit 1
}
`;

  const launch = await runPowerShell(launcherBody, {
    raw: true,
    label: `${label}:uac`,
    timeout: options.uacTimeout || 120000,
  });

  // Interpreta cancelamento de UAC.
  if (!launch.success) {
    const code = classifyFailure(launch.rawError || launch.error, launch);
    cleanupTemp(scriptPath, outPath);
    if (code === 'UAC_DENIED') {
      return {
        success: false,
        code: 'UAC_DENIED',
        error: 'Você negou a permissão de Administrador (UAC). Nenhuma alteração foi aplicada.',
        hint: 'Clique novamente e escolha "Sim" na janela de Controle de Conta de Usuário.',
      };
    }
    return {
      success: false,
      code,
      error: launch.error || 'Falha ao iniciar o processo elevado.',
      rawError: launch.rawError,
    };
  }

  // Aguarda o arquivo de resultado (o -Wait normalmente já garante).
  const deadline = Date.now() + (options.timeout || 45000);
  let raw = null;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(outPath)) {
        raw = fs.readFileSync(outPath, 'utf8').replace(/^\ufeff/, '');
        break;
      }
    } catch (err) {
      raw = null;
    }
    await sleep(150);
  }

  cleanupTemp(scriptPath, outPath);

  if (!raw) {
    return {
      success: false,
      code: 'NO_RESULT',
      error: 'O processo elevado terminou mas não retornou resultado (possível negação silenciosa do UAC).',
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return {
      success: false,
      code: 'BAD_RESULT',
      error: `Resultado do processo elevado inválido: ${err.message}`,
      stdout: raw,
    };
  }

  const ok = data && data.ok !== false;
  return {
    success: ok,
    code: ok ? 'OK' : classifyFailure(data.error, null),
    data,
    error: ok ? null : humanizeError(data.error || 'Falha no processo elevado.'),
    rawError: ok ? null : data.error,
  };
}

function cleanupTemp(...files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (err) { /* melhor esforço */ }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executa o corpo em contexto elevado se necessário.
 * `isAdminFn` é injetado para evitar dependência circular com elevation.js.
 */
async function ensureElevated(body, options = {}) {
  const elevatedAlready = typeof options.isAdmin === 'function' ? await options.isAdmin() : false;
  if (elevatedAlready) {
    return runPowerShell(body, options);
  }
  if (options.allowPrompt === false) {
    return {
      success: false,
      code: 'ELEVATION_REQUIRED',
      error: 'Esta ação exige privilégios de Administrador e o prompt UAC está desativado.',
    };
  }
  return runPowerShellElevated(body, options);
}

/* ------------------------------------------------------------------ */
/* netsh / reg / powercfg (sem shell)                                  */
/* ------------------------------------------------------------------ */

async function runNetsh(args, options = {}) {
  if (!isWindows()) return unsupported('netsh ' + args.join(' '));
  const res = await execFileAsync(NETSH_BIN, args, { timeout: options.timeout || 30000 });
  const out = (res.stdout || '') + (res.stderr || '');
  const success = !res.error && !isNetshFailure(out);
  return {
    success,
    code: success ? 'OK' : classifyFailure(out, res),
    output: out.trim(),
    stdout: res.stdout,
    stderr: res.stderr,
    error: success ? null : humanizeError(firstMeaningfulLine(out) || 'netsh falhou.'),
    args,
  };
}

function isNetshFailure(output) {
  const o = String(output || '').toLowerCase();
  return (
    o.includes('the parameter is incorrect') ||
    o.includes('parâmetro está incorreto') ||
    o.includes('parametro esta incorreto') ||
    o.includes('is not recognized as an internal or external command') ||
    o.includes('não é reconhecido como um comando') ||
    o.includes('access is denied') ||
    o.includes('acesso negado') ||
    o.includes('failed to') ||
    o.includes('falha ao') ||
    o.includes('the system cannot find the file specified') ||
    o.includes('requested operation requires elevation') ||
    o.includes('requires elevation (run as administrator)') ||
    o.includes('element not found') ||
    o.includes('não foi possível encontrar o elemento')
  );
}

function firstMeaningfulLine(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.find((l) => !/^(ok\.|\.|---)/i.test(l)) || lines[0] || null;
}

async function runReg(args, options = {}) {
  if (!isWindows()) return unsupported('reg ' + args.join(' '));
  const res = await execFileAsync(REG_BIN, args, { timeout: options.timeout || 30000 });
  const out = (res.stdout || '') + (res.stderr || '');
  const success = !res.error && /the operation completed successfully|operação foi concluída com êxito/i.test(out);
  return {
    success,
    code: success ? 'OK' : classifyFailure(out, res),
    output: out.trim(),
    error: success ? null : humanizeError(firstMeaningfulLine(out) || 'reg.exe falhou.'),
    args,
  };
}

async function runPowercfg(args, options = {}) {
  if (!isWindows()) return unsupported('powercfg ' + args.join(' '));
  const res = await execFileAsync(POWERCFG_BIN, args, { timeout: options.timeout || 30000 });
  const out = (res.stdout || '') + (res.stderr || '');
  const success = !res.error;
  return {
    success,
    code: success ? 'OK' : classifyFailure(out, res),
    output: out.trim(),
    error: success ? null : humanizeError(firstMeaningfulLine(out) || 'powercfg falhou.'),
    args,
  };
}

/**
 * Ping ICMP multiplataforma, sem shell.
 * Windows: ping -n <count> -w <ms> [-f] [-l <size>] <host>
 * Linux/mac: ping -c <count> -W <sec> [-M do -s <size>] <host>
 */
async function runPing(host, options = {}) {
  if (!isSafeHost(host)) {
    return { success: false, code: 'INVALID_HOST', error: `Host inválido: "${host}"` };
  }

  const count = Math.max(1, Math.min(50, parseInt(options.count, 10) || 1));
  const timeoutMs = Math.max(200, Math.min(10000, parseInt(options.timeoutMs, 10) || 2000));

  let args;
  if (isWindows()) {
    args = ['-n', String(count), '-w', String(timeoutMs)];
    if (options.dontFragment) args.push('-f');
    if (options.size !== undefined && options.size !== null) {
      args.push('-l', String(Math.max(0, Math.min(65500, parseInt(options.size, 10) || 0))));
    }
    args.push(String(host).trim());
  } else {
    args = ['-c', String(count), '-W', String(Math.max(1, Math.round(timeoutMs / 1000)))];
    if (options.dontFragment) args.push('-M', 'do');
    if (options.size !== undefined && options.size !== null) {
      args.push('-s', String(Math.max(0, parseInt(options.size, 10) || 0)));
    }
    args.push(String(host).trim());
  }

  const res = await execFileAsync('ping', args, { timeout: timeoutMs * count + 5000 });
  const out = (res.stdout || '') + (res.stderr || '');
  return {
    success: !res.error,
    output: out,
    stdout: res.stdout,
    stderr: res.stderr,
    args,
    needsFragmentation: /needs to be fragmented|precisa ser fragmentado|fragmentation needed|Message too long/i.test(out),
  };
}

module.exports = {
  JSON_MARKER,
  configure,
  isWindows,
  encodePsCommand,
  buildScript,
  psString,
  psNumber,
  psStringArray,
  isSafeHost,
  isSafeName,
  isSafeGuid,
  sanitizeName,
  asArray,
  parseMarkerOutput,
  runPowerShell,
  runPowerShellElevated,
  ensureElevated,
  runNetsh,
  runReg,
  runPowercfg,
  runPing,
  execFileAsync,
  classifyFailure,
  humanizeError,
  sleep,
};
