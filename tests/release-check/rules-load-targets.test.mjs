/** Guards independent host discovery and safe preflight because Plan_64 D12/D13 and the 2026-10-10 manual run require two protected target roles. */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { preflightTarget, REQUIRED_FLAGS, resolveTargets } from '../../scripts/release-check/rules-load-targets.mjs';

const cliExecutable = path.resolve('fake-cli', 'claude.exe');
const extensionExecutable = path.resolve('fake-vscode', 'extensions', 'anthropic.claude-code-fixture', 'claude.exe');
const target = { role: 'cli', executable: cliExecutable, source: 'path' };
const help = REQUIRED_FLAGS.map((flag) => `  ${flag} <value>`).join('\n');

function resolve(overrides = {}) {
  return resolveTargets({
    env: { CLAUDE_CODE_EXECPATH: extensionExecutable },
    resolveOnPath: () => cliExecutable,
    exists: () => true,
    discover: () => ({ error: 'Provide --vscode-executable or --extensions-dir: no discovery fixture.',
      selection: { source: 'discovery' } }),
    ...overrides,
  });
}

function fakeRun({ version = '2.1.999 (Claude Code)\n', helpText = help } = {}) {
  return (_executable, args) => ({ status: 0, stdout: args[0] === '--version' ? version : helpText });
}

test('resolves CLI from PATH and extension from its session independently', () => {
  const env = { PATH: 'fake-path', CLAUDE_CODE_EXECPATH: extensionExecutable };
  const calls = [];
  const result = resolve({ env, resolveOnPath: (name, passedEnv) => {
    calls.push([name, passedEnv]);
    return cliExecutable;
  } });
  assert.deepEqual(calls, [['claude', env]]);
  assert.deepEqual(result, {
    cli: target,
    vscode: { role: 'vscode', executable: extensionExecutable, source: 'extension-session',
      selection: { source: 'extension-session' } },
  });
});

test('refuses environment executables outside the extension directory, without using them for CLI', () => {
  for (const candidate of [cliExecutable, '/extensions/other-extension/claude', '/extensions/anthropic.claude-code/claude']) {
    const result = resolve({ env: { CLAUDE_CODE_EXECPATH: candidate } });
    assert.deepEqual(result.cli, target);
    assert.equal(result.vscode.role, 'vscode');
    assert.match(result.vscode.error, /--vscode-executable/);
  }
});

test('extension-session path recognition accepts backslashes and mixed case', () => {
  const candidate = extensionExecutable.replaceAll('/', '\\').replace(/extensions/i, 'EXTENSIONS')
    .replace(/anthropic\.claude-code-/i, 'ANTHROPIC.CLAUDE-CODE-');
  assert.equal(resolve({ env: { CLAUDE_CODE_EXECPATH: candidate } }).vscode.source, 'extension-session');
});

test('explicit flag beats the environment even outside an extension directory', () => {
  const result = resolve({ vscodeExecutable: cliExecutable });
  assert.deepEqual(result.vscode, { role: 'vscode', executable: cliExecutable, source: 'flag', selection: { source: 'flag' } });
  assert.notStrictEqual(result.cli, result.vscode);
});

test('empty or missing explicit flag never falls back to the environment', () => {
  assert.match(resolve({ vscodeExecutable: '' }).vscode.error, /--vscode-executable/);
  assert.match(resolve({ vscodeExecutable: cliExecutable, exists: (file) => file !== cliExecutable }).vscode.error,
    /--vscode-executable/);
});

test('unavailable CLI does not suppress the extension role', () => {
  for (const resolveOnPath of [() => null, () => 'relative.exe', () => { throw new Error('PATH denied'); }]) {
    const result = resolve({ resolveOnPath });
    assert.equal(result.cli.role, 'cli');
    assert.equal(typeof result.cli.error, 'string');
    assert.equal(result.vscode.executable, extensionExecutable);
  }
});

test('missing environment target does not suppress CLI', () => {
  const result = resolve({ env: {} });
  assert.deepEqual(result.cli, target);
  assert.match(result.vscode.error, /--vscode-executable/);
});

test('missing files and existence-check exceptions produce per-role errors', () => {
  for (const exists of [() => false, () => { throw new Error('access denied'); }]) {
    const result = resolve({ exists });
    assert.equal(result.cli.role, 'cli');
    assert.equal(result.vscode.role, 'vscode');
    assert.equal(typeof result.cli.error, 'string');
    assert.match(result.vscode.error, /--vscode-executable/);
  }
});

test('explicit and qualifying environment targets never invoke discovery', () => {
  const discover = () => assert.fail('Discovery must not override an explicit or qualifying session target');
  assert.equal(resolve({ vscodeExecutable: cliExecutable, discover }).vscode.source, 'flag');
  assert.equal(resolve({ discover }).vscode.source, 'extension-session');
});

test('invalid flags stay terminal even when discovery could succeed', () => {
  let calls = 0;
  const discover = () => { calls += 1; return { executable: extensionExecutable, selection: { source: 'discovery' } }; };
  for (const vscodeExecutable of ['', null, 123, cliExecutable]) {
    const result = resolve({ vscodeExecutable, discover, exists: () => false });
    assert.match(result.vscode.error, /--vscode-executable/);
    assert.deepEqual(result.vscode.selection, { source: 'flag' });
  }
  assert.equal(calls, 0);
});

test('a missing qualifying environment executable does not fall back to discovery', () => {
  const result = resolve({ exists: () => false, discover: () => assert.fail('Session source stays terminal') });
  assert.match(result.vscode.error, /does not exist/);
  assert.deepEqual(result.vscode.selection, { source: 'extension-session' });
});

test('discovery is the third source and receives the original environment and extensionsDir', () => {
  for (const env of [{}, { CLAUDE_CODE_EXECPATH: cliExecutable }]) {
    const selection = { source: 'discovery', reason: 'one candidate' };
    const calls = [];
    const result = resolve({ env, extensionsDir: 'custom-extensions', discover: (input) => {
      calls.push(input);
      return { executable: extensionExecutable, selection };
    } });
    assert.deepEqual(calls, [{ env, extensionsDir: 'custom-extensions' }]);
    assert.strictEqual(calls[0].env, env);
    assert.deepEqual(result.cli, target);
    assert.deepEqual(result.vscode, { role: 'vscode', source: 'discovery', executable: extensionExecutable, selection });
  }
});

test('discovery errors and selection survive target resolution for an inconclusive preflight', () => {
  const selection = { source: 'discovery', candidates: ['one', 'two'] };
  const error = 'Ambiguous discovery: one; two. Use --vscode-executable or --extensions-dir.';
  const result = resolve({ env: {}, discover: () => ({ error, selection }) });
  assert.deepEqual(result.vscode, { role: 'vscode', source: 'discovery', error, selection });
  assert.deepEqual(preflightTarget({ target: result.vscode, run: () => assert.fail('Must not start a binary') }),
    { ok: false, reason: error });
});

test('discovery exceptions stay confined to the VS Code role', () => {
  const result = resolve({ env: {}, discover: () => { throw new Error('Discovery denied'); } });
  assert.deepEqual(result.cli, target);
  assert.match(result.vscode.error, /Discovery denied/);
  assert.deepEqual(result.vscode.selection, { source: 'discovery' });
});

test('preflight runs only version and help with bounded shell-free options', () => {
  const calls = [];
  const run = (executable, args, options) => {
    calls.push({ executable, args, options });
    return fakeRun()(executable, args);
  };
  assert.deepEqual(preflightTarget({ target, run }), { ok: true, version: '2.1.999' });
  assert.deepEqual(calls.map((call) => call.args), [['--version'], ['--help']]);
  for (const call of calls) {
    assert.equal(call.executable, cliExecutable);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.encoding, 'utf8');
    assert.ok(Number.isFinite(call.options.timeout) && call.options.timeout > 0);
  }
});

test('each required flag must be present as a whole option', () => {
  assert.deepEqual(REQUIRED_FLAGS, ['--setting-sources', '--strict-mcp-config', '--tools']);
  for (const flag of REQUIRED_FLAGS) {
    for (const replacement of ['', `${flag}-other`, `prefix${flag}`]) {
      const result = preflightTarget({ target, run: fakeRun({ helpText: help.replace(flag, replacement) }) });
      assert.equal(result.ok, false);
      assert.ok(result.reason.includes(flag));
    }
  }
});

test('unreadable version is unsuccessful without invoking help', () => {
  for (const version of ['', 'unknown', 'v2.1.999', undefined]) {
    let calls = 0;
    const result = preflightTarget({ target, run: () => { calls += 1; return { status: 0, stdout: version }; } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /version.*unreadable/i);
    assert.equal(calls, 1);
  }
});

test('spawn errors, unsuccessful exits, timeouts and thrown errors never escape preflight', () => {
  for (const failingStep of ['--version', '--help']) {
    for (const failure of [undefined, { status: 1 }, { status: null, signal: 'SIGTERM' },
      { status: 0, error: new Error('spawn denied') }]) {
      const result = preflightTarget({ target, run: (executable, args) => args[0] === failingStep
        ? failure : fakeRun()(executable, args) });
      assert.equal(result.ok, false);
      assert.ok(result.reason.includes(failingStep));
    }
    const result = preflightTarget({ target, run: (executable, args) => {
      if (args[0] === failingStep) throw new Error('spawn threw');
      return fakeRun()(executable, args);
    } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /spawn threw/);
  }
});

test('target resolution errors and missing executables do not start a process', () => {
  const run = () => assert.fail('No process should be started');
  assert.deepEqual(preflightTarget({ target: { role: 'vscode', error: 'missing flag' }, run }),
    { ok: false, reason: 'missing flag' });
  assert.equal(preflightTarget({ target: { role: 'cli' }, run }).ok, false);
});

test('non-text help cannot satisfy required flags', () => {
  assert.equal(preflightTarget({ target, run: (_executable, args) => ({
    status: 0, stdout: args[0] === '--version' ? '2.1.999' : undefined,
  }) }).ok, false);
});
