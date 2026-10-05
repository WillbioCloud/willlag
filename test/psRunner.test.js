'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ps = require('../public/services/psRunner');

test('encodePsCommand: base64 UTF-16LE decodifica de volta ao script', () => {
  const script = "Write-Output 'Olá — acentuação: ã ç é'";
  const encoded = ps.encodePsCommand(script);
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.strictEqual(decoded, script);
});

test('psString: escapa apóstrofo e neutraliza injeção', () => {
  assert.strictEqual(ps.psString('Wi-Fi'), "'Wi-Fi'");
  assert.strictEqual(ps.psString("O'Brien"), "'O''Brien'");

  // Tentativas de injeção que a v1.0 permitia (interpolação direta em exec()).
  const attacks = [
    "Wi-Fi'; Remove-Item C:\\ -Recurse -Force; '",
    '$(calc.exe)',
    '`whoami`',
    'Wi-Fi"; Start-Process calc; "',
    'a\nb; c',
  ];

  for (const attack of attacks) {
    const literal = ps.psString(attack);
    assert.ok(literal.startsWith("'") && literal.endsWith("'"), `deve ser literal single-quoted: ${literal}`);

    // Dentro de single-quoted do PowerShell a única sequência especial é '' —
    // nenhum $, ` ou ; isolado consegue sair do literal.
    const inner = literal.slice(1, -1);
    assert.ok(/^(?:[^']|'')*$/.test(inner), `apóstrofos devem vir sempre em pares: ${literal}`);
    assert.strictEqual(inner.replace(/''/g, "'"), attack, 'round-trip fiel ao valor original');
  }
});

test('psNumber: rejeita string não numérica', () => {
  assert.strictEqual(ps.psNumber(12), '12');
  assert.strictEqual(ps.psNumber('12'), '12');
  assert.strictEqual(ps.psNumber('12; rm -rf /', 7), '7');
  assert.strictEqual(ps.psNumber(NaN, 3), '3');
  assert.strictEqual(ps.psNumber(Infinity, 3), '3');
});

test('psStringArray: gera array PowerShell escapado', () => {
  assert.strictEqual(ps.psStringArray(['a', "b'c"]), "@('a', 'b''c')");
  assert.strictEqual(ps.psStringArray('x'), "@('x')");
});

test('isSafeHost: aceita hostname/IP e bloqueia metacaracteres', () => {
  const ok = ['1.1.1.1', '8.8.8.8', 'google.com', 'sa-east-1.amazonaws.com', '::1', '2001:4860:4860::8888', 'host_name'];
  for (const h of ok) assert.ok(ps.isSafeHost(h), `deveria aceitar ${h}`);

  const bad = [
    '8.8.8.8 & calc',
    'host; rm -rf /',
    '$(whoami)',
    'a|b',
    'x`y`',
    '',
    null,
    undefined,
    12345,
    'a'.repeat(300),
  ];
  for (const h of bad) assert.ok(!ps.isSafeHost(h), `deveria rejeitar ${JSON.stringify(h)}`);
});

test('isSafeName: aceita nomes de interface com espaço/acento, bloqueia shell', () => {
  assert.ok(ps.isSafeName('Wi-Fi'));
  assert.ok(ps.isSafeName('Conexão Local'));
  assert.ok(ps.isSafeName('Ethernet 2'));
  assert.ok(!ps.isSafeName('Wi-Fi"; calc; "'));
  assert.ok(!ps.isSafeName('a$b'));
  assert.ok(!ps.isSafeName('a`b'));
  assert.ok(!ps.isSafeName('a;b'));
  assert.ok(!ps.isSafeName(''));
});

test('sanitizeName: remove apenas os caracteres perigosos', () => {
  assert.strictEqual(ps.sanitizeName('Conexão Local'), 'Conexão Local');
  assert.strictEqual(ps.sanitizeName('a";b$c`d'), 'abcd');
});

test('isSafeGuid: valida GUID de interface', () => {
  assert.ok(ps.isSafeGuid('{A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D}'));
  assert.ok(ps.isSafeGuid('A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D'));
  assert.ok(!ps.isSafeGuid('{A1B2C3D4}; Remove-Item C:\\'));
  assert.ok(!ps.isSafeGuid('não-é-guid'));
});

test('buildScript: injeta marcador, função de JSON e captura de erro', () => {
  const script = ps.buildScript('Write-WillLagJson @{ ok = $true }');
  assert.ok(script.includes(ps.JSON_MARKER));
  assert.ok(script.includes('function Write-WillLagJson'));
  assert.ok(script.includes('ConvertTo-Json'));
  assert.ok(script.includes('$ErrorActionPreference = \'Stop\''));
  assert.ok(script.includes('catch'));
  assert.ok(script.includes('exit 1'));

  const lenient = ps.buildScript('x', { strict: false });
  assert.ok(lenient.includes("$ErrorActionPreference = 'Continue'"));
});

test('parseMarkerOutput: isola o JSON mesmo com ruído antes/depois', () => {
  const noisy = `Warning: something\nSome banner text\n${ps.JSON_MARKER}\n{"ok":true,"value":42}\nExtra line\n`;
  const parsed = ps.parseMarkerOutput(noisy);
  assert.strictEqual(parsed.found, true);
  assert.deepStrictEqual(parsed.data, { ok: true, value: 42 });
});

test('parseMarkerOutput: usa o último marcador e aceita array', () => {
  const text = `${ps.JSON_MARKER}\n{"a":1}\n${ps.JSON_MARKER}\n[1,2,3]`;
  assert.deepStrictEqual(ps.parseMarkerOutput(text).data, [1, 2, 3]);
});

test('parseMarkerOutput: reporta erro de parse sem lançar', () => {
  const bad = ps.parseMarkerOutput(`${ps.JSON_MARKER}\n{invalid json`);
  assert.strictEqual(bad.data, null);
  assert.ok(bad.parseError);
});

test('asArray: normaliza objeto único do PowerShell 5.1', () => {
  assert.deepStrictEqual(ps.asArray(null), []);
  assert.deepStrictEqual(ps.asArray(undefined), []);
  assert.deepStrictEqual(ps.asArray({ a: 1 }), [{ a: 1 }]);
  assert.deepStrictEqual(ps.asArray([1, 2]), [1, 2]);
});

test('classifyFailure: mapeia cancelamento de UAC (pt-BR e en-US)', () => {
  assert.strictEqual(ps.classifyFailure('The operation was canceled by the user', {}), 'UAC_DENIED');
  assert.strictEqual(ps.classifyFailure('A operação foi cancelada pelo usuário', {}), 'UAC_DENIED');
  assert.strictEqual(ps.classifyFailure('whatever', { numericExit: 1223 }), 'UAC_DENIED');
  assert.strictEqual(ps.classifyFailure('Access is denied', {}), 'ACCESS_DENIED');
  assert.strictEqual(ps.classifyFailure('Requested registry access is not allowed', {}), 'ACCESS_DENIED');
  assert.strictEqual(ps.classifyFailure('The parameter is incorrect', {}), 'INVALID_PARAMETER');
  assert.strictEqual(ps.classifyFailure('Element not found', {}), 'NOT_FOUND');
  assert.strictEqual(ps.classifyFailure('blah', {}), 'EXEC_FAILED');
});

test('humanizeError: devolve mensagem acionável em pt-BR', () => {
  assert.match(ps.humanizeError('The operation was canceled by the user'), /UAC|cancelada/i);
  assert.match(ps.humanizeError('Access is denied'), /Administrador/);
  assert.match(ps.humanizeError('The parameter is incorrect'), /não suportado/i);
  assert.strictEqual(ps.humanizeError('erro qualquer'), 'erro qualquer');
});

test('runPowerShell fora do Windows: falha estruturada, nunca lança', async () => {
  if (process.platform === 'win32') return;
  const res = await ps.runPowerShell('Write-WillLagJson @{ok=$true}');
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'UNSUPPORTED_PLATFORM');
  assert.ok(res.error);
});

test('runNetsh / runReg / runPowercfg fora do Windows: falha estruturada', async () => {
  if (process.platform === 'win32') return;
  for (const fn of [
    () => ps.runNetsh(['int', 'tcp', 'show', 'global']),
    () => ps.runReg(['query', 'HKLM']),
    () => ps.runPowercfg(['/query']),
  ]) {
    const res = await fn();
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, 'UNSUPPORTED_PLATFORM');
  }
});

test('runPing valida host antes de executar', async () => {
  const res = await ps.runPing('1.1.1.1; calc', { count: 1 });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'INVALID_HOST');
});

test('runPing monta argumentos sem shell (DF + tamanho para MTU)', async () => {
  const res = await ps.runPing('127.0.0.1', { count: 2, timeoutMs: 1000, dontFragment: true, size: 1472 });
  // Em Linux o alvo é alcançável; o importante aqui é a forma dos argumentos.
  assert.ok(Array.isArray(res.args));
  assert.ok(res.args.includes('127.0.0.1'));
  if (process.platform === 'win32') {
    assert.ok(res.args.includes('-f'));
    assert.ok(res.args.includes('-l'));
  } else {
    assert.ok(res.args.includes('-M'));
    assert.ok(res.args.includes('-s'));
  }
  assert.ok(!res.args.some((a) => /[;&|`$]/.test(String(a))), 'nenhum argumento deve conter metacaracter');
});
