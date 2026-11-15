/** Holds the sandbox flags and shell environment policy required by every delegated run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { codexArgs, resumeArgs } from '../../src/home/lib/runner/codex-args.mjs';
import { codexSpawnSpec, unsafeForCmd } from '../../src/home/lib/runner/codex-cmd.mjs';
import { platformSandboxArgs, runSandboxArgs, UTF8_SHELL_POLICY, WINDOWS_SANDBOX } from '../../src/home/lib/runner/sandbox-flags.mjs';
import { loadRunEnv } from '../../src/home/lib/runner/run-env.mjs';

const AGENTS = ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor'];

const argsFor = (agent) => codexArgs(
  { agent, effort: 'medium', repo: process.cwd(), models: {} },
  path.join(os.tmpdir(), 'codex-run'),
  true,
);

test('Windows gets the elevated sandbox key and other platforms get nothing', () => {
  assert.deepEqual(platformSandboxArgs('win32'), ['-c', 'windows.sandbox=elevated']);
  assert.deepEqual(platformSandboxArgs('linux'), []);
  assert.deepEqual(platformSandboxArgs('darwin'), []);
});

test('the frozen UTF-8 pair follows platform flags in a fresh argument array', () => {
  assert.deepEqual(UTF8_SHELL_POLICY, ['-c', "shell_environment_policy.set.PYTHONUTF8='1'"]);
  assert.equal(Object.isFrozen(UTF8_SHELL_POLICY), true);
  for (const platform of ['win32', 'linux', 'darwin']) {
    const expected = [...platformSandboxArgs(platform), ...UTF8_SHELL_POLICY];
    const args = runSandboxArgs(platform);
    assert.deepEqual(args, expected, platform);
    args.push('local-only');
    assert.deepEqual(runSandboxArgs(platform), expected, platform);
  }
});

// OW-089 D3: spawn's PYTHONUTF8 was lost inside the elevated sandbox; readers, writers and
// continuations must all carry the shell policy on every platform.
test('every fresh role and resume form carries the UTF-8 pair exactly once on both platforms', () => {
  loadRunEnv();
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const runDir = path.join(os.tmpdir(), 'codex-run');
  const roles = AGENTS.flatMap((agent) => agent === 'codex-advisor'
    ? [{ agent, phase: 'scope' }, { agent, phase: 'advise' }] : [{ agent }]);
  try {
    for (const platform of ['win32', 'linux']) {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
      const check = (args, label) => {
        const policyAt = args.indexOf(UTF8_SHELL_POLICY[1]);
        assert.equal(args.filter((arg) => arg === UTF8_SHELL_POLICY[1]).length, 1, label);
        assert.deepEqual(args.slice(policyAt - 1, policyAt + 1), UTF8_SHELL_POLICY, label);
        assert.equal(args.filter((arg) => arg === WINDOWS_SANDBOX[1]).length,
          platform === 'win32' ? 1 : 0, label);
        const start = args.indexOf('agents.enabled=false') + 1;
        const expected = [...(platform === 'win32' ? WINDOWS_SANDBOX : []), ...UTF8_SHELL_POLICY];
        assert.deepEqual(args.slice(start, start + expected.length), expected, label);
      };
      for (const role of roles) {
        for (const hasModel of [false, true]) {
          for (const hasSpeed of [false, true]) {
            const profile = { effort: 'high', ...(hasModel ? { model: 'configured-model' } : {}),
              ...(hasSpeed ? { speed: 'configured-tier' } : {}) };
            const label = `${platform} ${role.agent} ${role.phase || ''} model=${hasModel} speed=${hasSpeed}`;
            for (const isGitRepo of [false, true]) {
              check(codexArgs({ ...role, repo: '/repo', models: { [role.agent.slice(6)]: profile } },
                runDir, isGitRepo), `${label} fresh git=${isGitRepo}`);
            }
            if (role.agent === 'codex-build') continue;
            for (const isolationFlags of [[], ['--disable', 'plugins']]) {
              check(resumeArgs({ ...role, profile, runDir, isolationFlags,
                threadId: '01234567-89ab-cdef-0123-456789abcdef' }), `${label} resume ${isolationFlags}`);
            }
          }
        }
      }
    }
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
});

test('the UTF-8 pair survives cmd.exe transport unchanged without argument wrapper quotes or refusal', () => {
  assert.equal(UTF8_SHELL_POLICY.some((arg) => /["%\s]/.test(arg)), false);
  assert.equal(unsafeForCmd(UTF8_SHELL_POLICY), undefined);
  const args = ['exec', ...UTF8_SHELL_POLICY, '-'];
  assert.deepEqual(codexSpawnSpec(args, 'win32'), {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', '"codex exec -c shell_environment_policy.set.PYTHONUTF8=\'1\' -"'],
    options: { windowsVerbatimArguments: true, windowsHide: true },
  });
  assert.deepEqual(args, ['exec', '-c', "shell_environment_policy.set.PYTHONUTF8='1'", '-']);
});

// The unelevated token refuses CreateProcess for every command, so a run that omits this key
// reads nothing and still spends its quota (2026-08-23). All three agents need it, including
// codex-build: it survived that day only by inheriting the key from the operator's own config.
test('every agent carries the platform sandbox flags of the host it runs on', () => {
  loadRunEnv();
  for (const agent of AGENTS) {
    const args = argsFor(agent);
    const expected = platformSandboxArgs();
    if (!expected.length) continue;
    const at = args.indexOf(expected[1]);
    assert.notEqual(at, -1, `${agent} is missing ${expected[1]}`);
    assert.equal(args[at - 1], '-c', `${agent} must pass the key as a -c override`);
  }
});

// The whole command line goes through cmd.exe, and unsafeForCmd() refuses any argument holding a
// double quote. A quoted TOML value here would refuse every Windows run instead of fixing it.
test('the sandbox key survives the cmd.exe argument check', () => {
  assert.equal(WINDOWS_SANDBOX.some((arg) => arg.includes('"') || arg.includes('%')), false);
  loadRunEnv();
  for (const agent of AGENTS) assert.equal(unsafeForCmd(argsFor(agent)), undefined, agent);
});
