import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { encodeSnapshot } from '../../src/home/lib/meta/snapshot-format.mjs';
import { readRunSnapshots } from '../../src/home/lib/meta/run-snapshots.mjs';
import { reportVersusWork, resolveStatus } from '../../src/home/lib/meta/verdict.mjs';
import {
  buildResult, CHAIN_REPO, CHAIN_SLUG, makeChainRoot, makeRun,
} from './test-fixtures.mjs';

const letter = 'letters/incoming.md';
const hashed = `U\t12:${'a'.repeat(64)}`;
const empty = encodeSnapshot([]);
const letterRow = { path: letter, state: hashed };
const workRow = { path: 'src/work.mjs', state: '1\t2' };
const changedWorkRow = { ...workRow, state: '2\t3' };
const resolve = (runDir, result) => resolveStatus({
  resultOk: true, exit: 0, agent: 'codex-build', result, runDir,
});

test('a build with a new letter as its only stray passes the scope check', () => {
  const result = buildResult([{ file: workRow.path }]);
  const before = encodeSnapshot([workRow]);
  const after = encodeSnapshot([changedWorkRow, letterRow]);
  const runDir = makeRun({
    before, after, result, scope: 'src/**', envNewFilePaths: ['letters/**'],
  });
  assert.deepEqual(readRunSnapshots(runDir), { before, after });
  assert.deepEqual(resolve(runDir, result), { status: 'OK', reason: null });
});

test('a build with only a new environmental letter agrees with an empty report', () => {
  const result = buildResult([]);
  const runDir = makeRun({
    before: empty, after: encodeSnapshot([letterRow]), result,
    scope: 'src/**', envNewFilePaths: ['letters/**'],
  });
  assert.deepEqual(resolve(runDir, result), { status: 'OK', reason: null });
});

test('editing an existing letter outside scope still fails as out-of-scope', () => {
  const result = buildResult([{ file: workRow.path }]);
  const runDir = makeRun({
    before: encodeSnapshot([workRow, letterRow]),
    after: encodeSnapshot([changedWorkRow, { path: letter, state: `U\t12:${'b'.repeat(64)}` }]),
    result, scope: 'src/**', envNewFilePaths: ['letters/**'],
  });
  const verdict = resolve(runDir, result);
  assert.equal(verdict.status, 'FAIL');
  assert.match(verdict.reason, /out-of-scope/);
  assert.ok(verdict.reason.includes(letter));
});

test('a scoped new letter named as the only report change remains work', () => {
  const result = buildResult([{ file: letter }]);
  const runDir = makeRun({
    before: empty, after: encodeSnapshot([letterRow]), result,
    scope: letter, envNewFilePaths: ['letters/**'],
  });
  assert.deepEqual(reportVersusWork(runDir, result), { ok: true, carried: false, reason: null });
  assert.deepEqual(resolve(runDir, result), { status: 'OK', reason: null });
});

test('a chain excuses a letter from an earlier pass using the accumulated comparison pair', () => {
  const after = encodeSnapshot([letterRow, workRow]);
  const root = makeChainRoot([
    { name: 'first', at: '2026-11-01T10:00:00Z', before: empty, after },
    {
      name: 'second', at: '2026-11-01T11:00:00Z', before: after, after,
      envNewFilePaths: ['letters/**'],
    },
  ]);
  const runDir = path.join(root, 'second');
  const ctx = { runsRoot: root, repo: CHAIN_REPO, slug: CHAIN_SLUG };
  assert.deepEqual(reportVersusWork(runDir, buildResult([{ file: workRow.path }]), ctx), {
    ok: true, carried: true, reason: null,
  });
  // The letter is present in this pass's before, but absent from the chain baseline.
  // Claiming only that environmental arrival must not establish carried agreement.
  assert.equal(reportVersusWork(runDir, buildResult([{ file: letter }]), ctx).ok, false);
});

test('a scoped letter from an earlier pass still establishes carried agreement', () => {
  const after = encodeSnapshot([letterRow]);
  const root = makeChainRoot([
    { name: 'first', at: '2026-11-01T10:00:00Z', before: empty, after },
  ]);
  const runDir = makeRun({
    before: after, after, scope: 'letters/**', envNewFilePaths: ['letters/**'],
  });
  assert.deepEqual(reportVersusWork(runDir, buildResult([{ file: letter }]), {
    runsRoot: root, repo: CHAIN_REPO, slug: CHAIN_SLUG,
  }), { ok: true, carried: true, reason: null });
});
