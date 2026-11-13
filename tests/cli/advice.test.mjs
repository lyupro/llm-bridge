/** Guards Plan_68 D4/D10's public presentation contract and installed-home authority. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'llm-bridge.mjs');
const FIELDS = ['schema_version', 'ok', 'kind', 'reason', 'run', 'project', 'phase', 'verdict'];
const VALID = { agent: 'codex-advisor', phase: 'advise', status: 'OK' };

function fixture(t, installed = true) {
  const root = makeTempTree('cli-advice-');
  t.after(() => removeTempTree(root));
  const home = path.join(root, 'brand home');
  if (installed) {
    fs.cpSync(path.join(ROOT, 'src', 'home', 'lib'), path.join(home, 'lib'), { recursive: true });
    // The installed image includes its manifest; transitive write-meta imports read its version.
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(home, 'package.json'));
  }
  const run = path.join(root, 'project', '2000-01-01_090000_advice');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify(VALID));
  return { root, home, run };
}

function invoke(tree, args) {
  const result = spawnSync(process.execPath, [BIN, 'advice', ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, HOME: tree.root, USERPROFILE: tree.root,
      LLM_BRIDGE_HOME: tree.home, LLM_BRIDGE_RUNS_ROOT: path.join(tree.home, 'runs') },
  });
  assert.ifError(result.error);
  return result;
}

function jsonResult(command, status, expected) {
  assert.equal(command.status, status, command.stderr);
  assert.equal(command.stdout.trim().split(/\r?\n/).length, 1, command.stdout);
  const result = JSON.parse(command.stdout);
  assert.deepEqual(Object.keys(result).sort(), [...FIELDS].sort());
  assert.deepEqual(result, {
    schema_version: 1, ok: null, kind: null, reason: 'invalid-call',
    run: null, project: null, phase: null, verdict: null, ...expected,
  });
  return result;
}

function snapshot(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? { name: entry.name, files: snapshot(file) }
        : { name: entry.name, bytes: fs.readFileSync(file), mtime: fs.statSync(file, { bigint: true }).mtimeNs };
    });
}

test('valid advise uses metadata alone, keeps all eight fields, and changes no home or run files', (t) => {
  const tree = fixture(t);
  const before = snapshot(tree.root);
  const command = invoke(tree, ['check', tree.run, '--json']);
  jsonResult(command, 0, { ok: true, kind: 'run', reason: 'valid-run',
    run: tree.run, project: 'project', phase: 'advise', verdict: 'OK' });
  assert.equal(command.stderr, '');
  // D4: an old run with no transport remains valid; reading must not recreate transport or state.
  assert.deepEqual(snapshot(tree.root), before);
});

for (const label of ['mechanical', 'revert', 'docs-only', 'test-only']) {
  test(`label ${label} is checked by the installed shared module`, (t) => {
    const tree = fixture(t);
    const command = invoke(tree, ['check', label, '--json']);
    jsonResult(command, 0, { ok: true, kind: 'label', reason: 'bridge-label' });
    assert.equal(command.stderr, '');
  });
}

test('--json is also accepted before the value after check', (t) => {
  jsonResult(invoke(fixture(t), ['check', '--json', 'mechanical']), 0,
    { ok: true, kind: 'label', reason: 'bridge-label' });
});

for (const value of ['operator-preference', ' mechanical', 'mechanical ', 'relative/run']) {
  test(`raw value ${JSON.stringify(value)} is not reinterpreted as a label or CLI error`, (t) => {
    jsonResult(invoke(fixture(t), ['check', value, '--json']), 1,
      { ok: false, kind: 'unknown', reason: 'not-bridge-value' });
  });
}

for (const [reason, meta] of [
  ['wrong-agent', { ...VALID, agent: 'codex-build' }],
  ['wrong-phase', { ...VALID, phase: 'scope' }],
  ['wrong-verdict', { ...VALID, status: 'FAIL' }],
]) {
  test(`installed metadata check returns ${reason}`, (t) => {
    const tree = fixture(t);
    fs.writeFileSync(path.join(tree.run, 'meta.json'), JSON.stringify(meta));
    const before = snapshot(tree.run);
    jsonResult(invoke(tree, ['check', tree.run, '--json']), 1,
      { ok: false, kind: 'run', reason, run: tree.run, project: 'project',
        phase: meta.phase, verdict: meta.status });
    assert.deepEqual(snapshot(tree.run), before);
  });
}

for (const reason of ['not-found', 'not-directory', 'meta-missing', 'meta-invalid', 'unreadable']) {
  test(`installed filesystem check returns ${reason}`, (t) => {
    const tree = fixture(t);
    let value = path.join(tree.root, 'project', 'other');
    if (reason === 'not-directory') fs.writeFileSync(value, 'file');
    if (['meta-missing', 'meta-invalid', 'unreadable'].includes(reason)) fs.mkdirSync(value);
    if (reason === 'meta-invalid') fs.writeFileSync(path.join(value, 'meta.json'), '{broken');
    // A directory where metadata should be avoids unreliable permission fixtures on Windows.
    if (reason === 'unreadable') fs.mkdirSync(path.join(value, 'meta.json'));
    const before = snapshot(tree.root);
    jsonResult(invoke(tree, ['check', value, '--json']), reason === 'unreadable' ? 2 : 1,
      { ok: reason === 'unreadable' ? null : false, kind: 'run', reason,
        run: value, project: 'project' });
    assert.deepEqual(snapshot(tree.root), before);
  });
}

test('retired-root remains the installed check decision', (t) => {
  const tree = fixture(t);
  fs.mkdirSync(path.join(tree.home, 'state'));
  fs.writeFileSync(path.join(tree.home, 'state', 'runs-root.json'), JSON.stringify({
    version: 1, retired: [{ root: path.dirname(tree.run), movedAt: '2026-11-13T12:00:00Z' }],
  }));
  jsonResult(invoke(tree, ['check', tree.run, '--json']), 1,
    { ok: false, kind: 'run', reason: 'retired-root', run: tree.run, project: 'project' });
});

test('missing installation returns JSON environment-error even for a known label without creating the home', (t) => {
  const tree = fixture(t, false);
  for (const value of ['mechanical', tree.run]) {
    const command = invoke(tree, ['check', value, '--json']);
    jsonResult(command, 2, { reason: 'environment-error' });
    assert.match(command.stderr, /environment-error/);
  }
  assert.equal(fs.existsSync(tree.home), false);
});

for (const [name, source] of [
  ['syntax failure', 'export function ('],
  ['missing dependency', "import './not-installed.mjs';"],
  ['module evaluation failure', "throw new Error('load failure');"],
  ['incompatible exports', 'export const incompatible = true;'],
  ['synchronous check exception', "export function checkAdvice() { throw new Error('check failure'); }"],
  ['asynchronous check exception', "export async function checkAdvice() { throw new Error('check failure'); }"],
  ['exit mapper exception', "export function checkAdvice() { return {}; } export function adviceCheckExitCode() { throw new Error('mapping failure'); }"],
]) {
  test(`${name} returns the complete environment-error object`, (t) => {
    const tree = fixture(t);
    fs.writeFileSync(path.join(tree.home, 'lib', 'advice-check.mjs'), source);
    jsonResult(invoke(tree, ['check', 'mechanical', '--json']), 2, { reason: 'environment-error' });
  });
}

test('installed implementation owns the raw value, result and exit-code mapping', (t) => {
  const tree = fixture(t);
  // Plan_62 D17: a different installed policy must be observable, including its exit mapper.
  fs.writeFileSync(path.join(tree.home, 'lib', 'advice-check.mjs'), `
    export function checkAdvice(value) {
      return { schema_version: 1, ok: true, kind: 'label', reason: value,
        run: null, project: null, phase: null, verdict: null };
    }
    export function adviceCheckExitCode() { return 17; }
  `);
  jsonResult(invoke(tree, ['check', ' operator-preference ', '--json']), 17,
    { ok: true, kind: 'label', reason: ' operator-preference ' });
});

for (const args of [
  [], ['unknown'], ['check'], ['check', ''], ['unknown', 'mechanical'],
  ['check', 'mechanical', 'revert'], ['check', '--unknown'],
  ['check', 'mechanical', '--unknown'], ['--json', 'check', 'mechanical'],
  ['check', 'mechanical', '--json', '--json'], ['check', 'mechanical', '-x'],
]) {
  test(`invalid call ${JSON.stringify(args)} prints one JSON object and a one-line usage error`, (t) => {
    // Syntax errors take precedence over installation errors, even on an uninstalled host.
    const tree = fixture(t, false);
    const command = invoke(tree, args.includes('--json') ? args : [...args, '--json']);
    jsonResult(command, 2, {});
    assert.equal(command.stderr.trim().split(/\r?\n/).length, 1, command.stderr);
    assert.match(command.stderr, /invalid-call; usage: llm-bridge advice check <value> \[--json\]/);
  });
}

test('human output names validity, reason and the run folder when known', (t) => {
  const tree = fixture(t);
  for (const [value, status, expected] of [
    [tree.run, 0, `VALID: valid-run (${tree.run})`],
    ['mechanical', 0, 'VALID: bridge-label'],
    ['operator-preference', 1, 'INVALID: not-bridge-value'],
  ]) {
    const command = invoke(tree, ['check', value]);
    assert.equal(command.status, status, command.stderr);
    assert.equal(command.stdout.trim(), expected);
    assert.equal(command.stderr, '');
  }
  const invalid = invoke(tree, ['check']);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout.trim(), 'ERROR: invalid-call');
  const missing = invoke({ ...tree, home: path.join(tree.root, 'absent') }, ['check', 'mechanical']);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout.trim(), 'ERROR: environment-error');
});

test('public and action help keep the usage line unique', (t) => {
  const tree = fixture(t, false);
  const usage = 'llm-bridge advice check <value> [--json]';
  for (const args of [['advice', '-h'], ['advice', 'check', '-h'], ['--help']]) {
    const command = spawnSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, LLM_BRIDGE_HOME: tree.home },
    });
    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stdout.split(usage).length - 1, 1, command.stdout);
    assert.equal(command.stderr, '');
  }
});
