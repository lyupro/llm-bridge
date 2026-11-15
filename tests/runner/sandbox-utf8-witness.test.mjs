/** OW-089 D3: observe the sandbox policy without starting a real Codex or forcing Python's mode. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTempTree } from '../temp-tree.mjs';
import { codexSpawnSpec, unsafeForCmd } from '../../src/home/lib/runner/codex-cmd.mjs';
import { UTF8_SHELL_POLICY } from '../../src/home/lib/runner/sandbox-flags.mjs';
import { witnessSandboxUtf8 } from '../../src/home/lib/runner/sandbox-utf8-witness.mjs';
import { probeSandbox, SANDBOX_PROBE_MARKER } from '../../src/home/lib/runner/sandbox-probe.mjs';

const repo = 'C:\\repository with spaces & punctuation';
const marker = 'llm-bridge-sandbox-pythonutf8=';
const interpreter = 'C:\\Python\\python.exe';
const output = (pythonutf8 = '1', mode = '1') => `${marker}${pythonutf8}\r\n${mode}\r\n${interpreter}\r\n`;
const success = { status: 0, stdout: output(), stderr: '', signal: null };

function observe(response, options = {}) {
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    if (response instanceof Error) throw response;
    return Promise.resolve(response);
  };
  return witnessSandboxUtf8({ agent: 'codex-scout', repo, platform: 'win32', ...options, run })
    .then((result) => ({ result, calls }));
}

function assertObservation(result) {
  assert.deepEqual(Object.keys(result).sort(),
    ['interpreter', 'ms', 'pythonutf8', 'status', 'stderrTail', 'utf8_mode']);
  assert.ok(Number.isInteger(result.ms) && result.ms >= 0);
  assert.equal(typeof result.stderrTail, 'string');
  assert.ok(result.stderrTail.length <= 300);
}

for (const [agent, mode] of [
  ['codex-build', 'workspace-write'], ['codex-scout', 'read-only'],
  ['codex-review', 'read-only'], ['codex-advisor', 'read-only'],
]) {
  test(`Windows witness uses ${agent}'s sandbox and the UTF-8 policy exactly once`, async () => {
    const { result, calls } = await observe(success, { agent });
    assert.equal(result.status, 'observed');
    assert.equal(calls.length, 1);
    const [command, args, options] = calls[0];
    assert.equal(command, process.env.ComSpec || 'cmd.exe');
    assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
    // Inspect arguments before cmd.exe quoting: transport quotes themselves are not shell inputs.
    const raw = [...args[3].slice(1, -1).matchAll(/"([^"]*)"|(\S+)/g)]
      .map((match) => match[1] ?? match[2]);
    assert.equal(raw.shift(), 'codex');
    const script = raw.at(-1);
    assert.deepEqual(raw, ['sandbox', '-c', 'windows.sandbox=elevated', ...UTF8_SHELL_POLICY,
      '-c', `sandbox_mode=${mode}`, '--', 'powershell.exe', '-NoProfile', '-Command', script]);
    assert.equal(raw.filter((arg, index) => arg === UTF8_SHELL_POLICY[0]
      && raw[index + 1] === UTF8_SHELL_POLICY[1]).length, 1);
    assert.equal(unsafeForCmd(raw), undefined);
    assert.deepEqual({ command, args }, {
      command: codexSpawnSpec(raw, 'win32').command, args: codexSpawnSpec(raw, 'win32').args,
    });
    assert.match(script, /\$env:PYTHONUTF8/);
    assert.doesNotMatch(script, /\$env:PYTHONUTF8\s*=/i);
    assert.match(script, /python -c 'import sys; print\(sys.flags.utf8_mode\); print\(sys.executable\)'/);
    assert.doesNotMatch(raw.join(' '), /python3|-X\s+utf8/i);
    assert.deepEqual(options, { windowsVerbatimArguments: true, windowsHide: true,
      cwd: repo, encoding: 'utf8', timeout: 15_000 });
    assert.equal(Object.hasOwn(options, 'shell'), false);
  });
}

test('the witness uses its explicitly supplied bounded timeout', async () => {
  const { calls } = await observe(success, { timeoutMs: 1234 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].timeout, 1234);
});

for (const [name, response, status, pythonutf8, mode, executable] of [
  ['matching policy', success, 'observed', '1', 1, interpreter],
  ['mode zero', { ...success, stdout: output('1', '0') }, 'mismatch', '1', 0, interpreter],
  ['empty variable with mode one', { ...success, stdout: output('', '1') }, 'mismatch', '', 1, interpreter],
  ['wrong variable with mode one', { ...success, stdout: output('0', '1') }, 'mismatch', '0', 1, interpreter],
  ['marker without Python output', { ...success, stdout: `${marker}1\n` }, 'no-python', '1', null, null],
  ['shell reports Python missing', { status: 1, stdout: `${marker}1\nllm-bridge-sandbox-no-python\n`,
    stderr: 'python was not found' }, 'no-python', '1', null, null],
  ['timeout result', { ...success, error: { code: 'ETIMEDOUT' } }, 'timeout', null, null, null],
  ['missing marker', { ...success, stdout: `1\n${interpreter}\n` }, 'malformed', null, null, null],
  ['two markers', { ...success, stdout: output() + output() }, 'malformed', null, null, null],
  ['non-numeric mode', { ...success, stdout: output('1', 'unknown') }, 'malformed', '1', null, null],
  ['stderr-only observation', { ...success, stdout: '', stderr: output() }, 'malformed', null, null, null],
  ['spawn error result', { error: { code: 'ENOENT' } }, 'malformed', null, null, null],
  ['thrown spawn error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }),
    'malformed', null, null, null],
  ['thrown timeout', Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' }),
    'timeout', null, null, null],
]) {
  test(`witness classifies ${name} from injected results`, async () => {
    const { result, calls } = await observe(response);
    assert.equal(calls.length, 1);
    assertObservation(result);
    assert.equal(result.status, status);
    assert.equal(result.pythonutf8, pythonutf8);
    assert.equal(result.utf8_mode, mode);
    assert.equal(result.interpreter, executable);
    assert.equal(result.stderrTail, String(response.stderr ?? '').slice(-300));
  });
}

test('stderr is bounded evidence and cannot override a matching stdout observation', async () => {
  const stderr = 'discarded prefix\n' + 'x'.repeat(299) + '!';
  const { result } = await observe({ ...success, stderr });
  assertObservation(result);
  assert.equal(result.status, 'observed');
  assert.equal(result.stderrTail.length, 300);
  assert.equal(result.stderrTail, stderr.slice(-300));
});

test('a thrown spawn error keeps only the last 300 stderr characters', async () => {
  const stderr = 'discarded prefix\n' + 'y'.repeat(299) + '!';
  const { result } = await observe(Object.assign(new Error('spawn failed'), { stderr }));
  assertObservation(result);
  assert.equal(result.status, 'malformed');
  assert.equal(result.stderrTail.length, 300);
  assert.equal(result.stderrTail, stderr.slice(-300));
});

test('Linux skips without invoking run or validating an unused agent', async () => {
  const { result, calls } = await observe(success, { platform: 'linux', agent: 'codex-unknown' });
  assert.deepEqual(result, { status: 'skipped' });
  assert.equal(calls.length, 0);
});

const alive = { status: 0, stdout: `${SANDBOX_PROBE_MARKER}\n` };

test('an alive probe awaits liveness before calling the witness with the same run', async () => {
  await withTempTree('sandbox-witness-order-', async (codexHome) => {
    const events = [];
    const answer = { status: 'observed', pythonutf8: '1', utf8_mode: 1 };
    const run = async () => {
      events.push('liveness started');
      await Promise.resolve();
      events.push('liveness finished');
      return alive;
    };
    const result = await probeSandbox({ agent: 'codex-scout', repo, platform: 'win32', codexHome, run,
      witness: async (options) => {
        assert.deepEqual(events, ['liveness started', 'liveness finished']);
        assert.deepEqual(options, { agent: 'codex-scout', repo, platform: 'win32', run });
        events.push('witness');
        await Promise.resolve();
        return answer;
      } });
    assert.deepEqual(events, ['liveness started', 'liveness finished', 'witness']);
    assert.equal(result.witness, answer);
    assert.deepEqual(Object.keys(result).sort(), ['attempts', 'outcome', 'reason', 'witness']);
    assert.equal(result.outcome, 'alive');
    assert.equal(result.reason, 'The Codex sandbox started a process.');
    assert.equal(result.attempts.length, 1);
    assert.deepEqual(result.attempts[0], { form: 'flagged', status: 0, marker: true,
      ms: result.attempts[0].ms, stderrTail: '' });
    assert.ok(Number.isInteger(result.attempts[0].ms) && result.attempts[0].ms >= 0);
  });
});

for (const status of ['observed', 'mismatch', 'no-python', 'timeout', 'malformed', 'skipped', 'throws']) {
  test(`witness ${status} leaves the alive outcome, reason and attempts unchanged`, async () => {
    await withTempTree('sandbox-witness-evidence-', async (codexHome) => {
      let witnessCalls = 0;
      let runCalls = 0;
      const run = async () => { runCalls += 1; return alive; };
      const base = { agent: 'codex-build', repo, platform: 'win32', codexHome, run };
      const baseline = await probeSandbox({ ...base, witness: async () => ({ status: 'skipped' }) });
      const answer = { status, reason: 'evidence only', attempts: [], outcome: 'dead' };
      const result = await probeSandbox({ ...base, witness: async () => {
        witnessCalls += 1;
        if (status === 'throws') throw new Error('witness failed');
        return answer;
      } });
      assert.equal(witnessCalls, 1);
      assert.equal(runCalls, 2);
      if (status === 'throws') assert.deepEqual(result.witness, { status: 'malformed' });
      else assert.equal(result.witness, answer);
      const { witness: baselineWitness, ...baselineLiveness } = baseline;
      const { witness: resultWitness, ...liveness } = result;
      assert.deepEqual(Object.keys(liveness).sort(), ['attempts', 'outcome', 'reason']);
      assert.equal(liveness.outcome, 'alive');
      assert.equal(liveness.attempts.length, 1);
      for (const attempt of [...liveness.attempts, ...baselineLiveness.attempts]) {
        assert.ok(Number.isInteger(attempt.ms) && attempt.ms >= 0);
      }
      assert.deepEqual({ ...liveness, attempts: liveness.attempts.map((a) => ({ ...a, ms: 0 })) },
        { ...baselineLiveness, attempts: baselineLiveness.attempts.map((a) => ({ ...a, ms: 0 })) });
    });
  });
}

for (const [name, platform, responses, outcome, forms] of [
  ['argument rejection', 'win32', [{ status: 2 }], 'inconclusive', ['flagged']],
  ['interrupted marker', 'win32', [{ ...alive, error: { code: 'ETIMEDOUT' } }], 'inconclusive', ['flagged']],
  ['nonzero marker', 'win32', [{ ...alive, status: 1 }], 'inconclusive', ['flagged']],
  ['control-only liveness', 'win32', [{ status: 1 }, alive], 'inconclusive', ['flagged', 'control']],
  ['dead sandbox', 'win32', [{ status: 1 }, { status: 1 }, { status: 0 }],
    'dead', ['flagged', 'control', 'version']],
  ['unsupported platform', 'darwin', [], 'skipped', []],
]) {
  test(`${name} never invokes or attaches a witness`, async () => {
    await withTempTree('sandbox-witness-gate-', async (codexHome) => {
      let runCalls = 0;
      let witnessCalls = 0;
      const result = await probeSandbox({ agent: 'codex-scout', repo, platform, codexHome,
        run: async () => {
          assert.ok(runCalls < responses.length, 'unexpected sandbox invocation');
          return responses[runCalls++];
        },
        witness: async () => { witnessCalls += 1; return { status: 'observed' }; } });
      assert.equal(result.outcome, outcome);
      assert.equal(witnessCalls, 0);
      assert.equal(Object.hasOwn(result, 'witness'), false);
      assert.equal(runCalls, responses.length);
      if (outcome === 'skipped') assert.deepEqual(result, { outcome: 'skipped' });
      else assert.deepEqual(result.attempts.map(({ form }) => form), forms);
    });
  });
}
