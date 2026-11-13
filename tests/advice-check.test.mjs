/** Guards Plan_68 D4/D10's shared advice contract so callers cannot drift or mistake I/O failures for absence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkAdvice, adviceCheckExitCode } from '../src/home/lib/advice-check.mjs';
import { taskPreflight } from '../src/home/lib/runner/preflight.mjs';
import { retiredPathRefusal } from '../src/home/lib/runner/runs-root.mjs';
import { orderRuleMessage } from '../src/home/lib/order-rules.mjs';
import { orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import { cleanupRetention } from '../src/home/lib/retention.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

const VALID = { agent: 'codex-advisor', phase: 'advise', status: 'OK' };
const FIELDS = ['schema_version', 'ok', 'kind', 'reason', 'run', 'project', 'phase', 'verdict'];

function fixture(t) {
  const root = makeTempTree('advice-check-');
  t.after(() => removeTempTree(root));
  const project = 'folder-project';
  const run = path.join(root, project, '2000-01-01_090000_advice');
  fs.mkdirSync(run, { recursive: true });
  return { root, run, project, resolution: { retired: [], homeRoot: path.join(root, 'runs') } };
}

function writeMeta(tree, meta) {
  fs.writeFileSync(path.join(tree.run, 'meta.json'), JSON.stringify(meta));
}

function expectResult(result, expected) {
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(Object.keys(result).sort(), [...FIELDS].sort());
  assert.deepEqual(result, {
    schema_version: 1, ok: null, kind: null, reason: 'invalid-call',
    run: null, project: null, phase: null, verdict: null, ...expected,
  });
  assert.equal(adviceCheckExitCode(result), expected.ok === true ? 0 : expected.ok === false ? 1 : 2);
}

function expectRun(tree, reason, extra = {}) {
  expectResult(checkAdvice(tree.run, { resolution: tree.resolution }), {
    ok: false, kind: 'run', reason, run: tree.run, project: tree.project, ...extra,
  });
}

for (const value of [undefined, null, '', 0, true, {}, [], new String('mechanical')]) {
  test(`invalid-call for ${String(value)} (${typeof value})`, () => {
    expectResult(checkAdvice(value), {});
  });
}

for (const value of ['mechanical', 'revert', 'docs-only', 'test-only']) {
  test(`bridge-label accepts exactly ${value} without filesystem access`, (t) => {
    for (const method of ['statSync', 'readFileSync', 'existsSync']) {
      t.mock.method(fs, method, () => assert.fail('labels must not read the filesystem'));
    }
    expectResult(checkAdvice(value), { ok: true, kind: 'label', reason: 'bridge-label' });
  });
}

for (const value of ['operator-preference', 'run-name', 'runs/project/run', ' mechanical', 'mechanical ', ' ', '\n']) {
  test(`not-bridge-value preserves raw ${JSON.stringify(value)}`, (t) => {
    for (const method of ['statSync', 'readFileSync', 'existsSync']) {
      t.mock.method(fs, method, () => assert.fail('relative values must not trigger lookup'));
    }
    expectResult(checkAdvice(value), { ok: false, kind: 'unknown', reason: 'not-bridge-value' });
  });
}

for (const existing of [false, true]) {
  test(`retired-root precedes all run filesystem access (${existing ? 'present' : 'absent'})`, (t) => {
    const tree = fixture(t);
    if (existing) writeMeta(tree, VALID);
    else tree.run = path.join(tree.root, tree.project, 'absent');
    tree.resolution.retired = [{ root: tree.root, movedAt: '2026-10-08T12:30:00.000Z' }];
    for (const method of ['statSync', 'readFileSync', 'existsSync']) {
      t.mock.method(fs, method, () => assert.fail('retired paths must not be opened'));
    }
    expectRun(tree, 'retired-root');
    assert.equal(taskPreflight({ agent: 'codex-build', header: { advice: tree.run },
      resolution: tree.resolution }).refusal,
    `${retiredPathRefusal(tree.run, tree.resolution)}\n${orderDiagnosticMessage('run-not-created')}`);
  });
}

test('not-found reports an absent folder without guessing whether it was pruned', (t) => {
  const tree = fixture(t);
  tree.run = path.join(tree.root, tree.project, 'absent');
  expectRun(tree, 'not-found');
});

test('not-directory precedes the metadata lookup', (t) => {
  const tree = fixture(t);
  tree.run = path.join(tree.root, tree.project, 'file');
  fs.writeFileSync(tree.run, '{}');
  t.mock.method(fs, 'readFileSync', () => assert.fail('files are not run folders'));
  expectRun(tree, 'not-directory');
});

test('meta-missing reports a real folder without meta.json', (t) => {
  expectRun(fixture(t), 'meta-missing');
});

for (const raw of ['{broken', 'null', '[]', '"text"', '12', 'true']) {
  test(`meta-invalid requires a JSON object (${raw})`, (t) => {
    const tree = fixture(t);
    fs.writeFileSync(path.join(tree.run, 'meta.json'), raw);
    expectRun(tree, 'meta-invalid');
  });
}

for (const [reason, meta] of [
  ['wrong-agent', { agent: 'codex-build', phase: 'scope', status: 'FAIL' }],
  ['wrong-agent', {}],
  ['wrong-phase', { ...VALID, phase: 'scope', status: 'FAIL' }],
  ['wrong-phase', { agent: 'codex-advisor', status: 'OK' }],
  ['wrong-verdict', { ...VALID, status: 'FAIL' }],
  ['wrong-verdict', { agent: 'codex-advisor', phase: 'advise' }],
]) {
  test(`${reason} follows agent, phase, verdict order for ${JSON.stringify(meta)}`, (t) => {
    const tree = fixture(t);
    writeMeta(tree, meta);
    expectRun(tree, reason, { phase: meta.phase ?? null, verdict: meta.status ?? null });
  });
}

test('valid-run uses the parent folder project and permits runs outside the current root', (t) => {
  const tree = fixture(t);
  writeMeta(tree, { ...VALID, project: 'not-the-folder-project' });
  expectRun(tree, 'valid-run', { ok: true, phase: 'advise', verdict: 'OK' });
  expectResult(checkAdvice(tree.run), {
    ok: true, kind: 'run', reason: 'valid-run', run: tree.run,
    project: tree.project, phase: 'advise', verdict: 'OK',
  });
});

test('valid-run preserves the existing BOM-readable metadata contract', (t) => {
  const tree = fixture(t);
  fs.writeFileSync(path.join(tree.run, 'meta.json'), `\ufeff${JSON.stringify(VALID)}`);
  expectRun(tree, 'valid-run', { ok: true, phase: 'advise', verdict: 'OK' });
});

for (const method of ['statSync', 'readFileSync']) {
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR']) {
    test(`unreadable preserves ${method} ${code} as an environment error and preflight fails closed`, (t) => {
      const tree = fixture(t);
      writeMeta(tree, VALID);
      // Windows ACLs and elevated POSIX users make chmod-based permission fixtures unreliable.
      t.mock.method(fs, method, () => { throw Object.assign(new Error('filesystem failure'), { code }); });
      expectRun(tree, 'unreadable', { ok: null });
      assert.equal(taskPreflight({ agent: 'codex-build', header: { advice: tree.run },
        resolution: tree.resolution }).refusal,
      `${orderRuleMessage('build-advice-required')}\n${orderDiagnosticMessage('run-not-created')}`);
    });
  }
}

test('unreadable also covers failure to read the runs-root environment', (t) => {
  const tree = fixture(t);
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('I/O failure'), { code: 'EIO' }); });
  expectResult(checkAdvice(tree.run), {
    ok: null, kind: 'run', reason: 'unreadable', run: tree.run, project: tree.project,
  });
});

test('D4 retention cleanup leaves an old advice valid when transport files disappear', (t) => {
  const tree = fixture(t);
  writeMeta(tree, VALID);
  fs.writeFileSync(path.join(tree.run, 'events.jsonl'), 'old transport');
  expectRun(tree, 'valid-run', { ok: true, phase: 'advise', verdict: 'OK' });
  const cleaned = cleanupRetention(path.dirname(tree.run), { enabled: true, days: 30 },
    { now: Date.parse('2026-11-13T12:00:00Z') });
  assert.equal(cleaned.runs, 1);
  assert.equal(fs.existsSync(path.join(tree.run, 'events.jsonl')), false);
  expectRun(tree, 'valid-run', { ok: true, phase: 'advise', verdict: 'OK' });
});

function snapshot(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? { name: entry.name, files: snapshot(file) }
        : { name: entry.name, bytes: fs.readFileSync(file), mtime: fs.statSync(file, { bigint: true }).mtimeNs };
    });
}

test('checking changes no file bytes, mtimes or directory entries in the run folder', (t) => {
  const tree = fixture(t);
  writeMeta(tree, VALID);
  fs.writeFileSync(path.join(tree.run, 'events.jsonl'), 'transport\n');
  fs.writeFileSync(path.join(tree.run, 'status.json'), '{"state":"done"}\n');
  fs.mkdirSync(path.join(tree.run, 'nested'));
  fs.writeFileSync(path.join(tree.run, 'nested', 'evidence.bin'), Buffer.from([0, 255, 1]));
  const before = snapshot(tree.run);
  expectRun(tree, 'valid-run', { ok: true, phase: 'advise', verdict: 'OK' });
  assert.deepEqual(snapshot(tree.run), before);
  writeMeta(tree, { ...VALID, status: 'FAIL' });
  const failedBefore = snapshot(tree.run);
  expectRun(tree, 'wrong-verdict', { phase: 'advise', verdict: 'FAIL' });
  assert.deepEqual(snapshot(tree.run), failedBefore);
});

test('exit-code mapping distinguishes valid, invalid and errored results', () => {
  assert.equal(adviceCheckExitCode({ ok: true }), 0);
  assert.equal(adviceCheckExitCode({ ok: false }), 1);
  assert.equal(adviceCheckExitCode({ ok: null }), 2);
});
