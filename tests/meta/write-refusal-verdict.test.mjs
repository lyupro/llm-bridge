/** OW-092 D1: a witnessed in-scope refusal explains a failed build without condemning recovery. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readJsonFileSync } from '../../src/home/lib/json-file.mjs';
import { writeRefusalGap } from '../../src/home/lib/meta/write-refusal-verdict.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { collect, exitCodeFor, renderReply } from '../../src/home/lib/write-meta.mjs';
import { buildResult, COMPLETED_COMMAND, makeRun } from './test-fixtures.mjs';

const repo = 'C:\\repo';
const deniedPath = 'C:\\repo\\src\\blocked.mjs';
const refusalLine = `Failed to write file ${deniedPath}`;
const refused = {
  paths: [{ path: 'src/blocked.mjs', inScope: true, failedChange: true }],
  evidence: [refusalLine],
};
const changed = 'U\t10\tsrc/partial.mjs\n';
const changes = [{ file: 'src/partial.mjs', what: 'edit', why: 'task' }];
const thread = { type: 'thread.started', thread_id: 'write-refusal' };
const failedChange = {
  type: 'item.completed',
  item: {
    id: 'item_2',
    type: 'file_change',
    changes: [{ path: deniedPath, kind: 'update' }],
    status: 'failed',
  },
};
const actionRows = (reply) => reply.split('\n').filter((row) => row.startsWith('Action:'));

function buildRun({ status, target = deniedPath, ...overrides } = {}) {
  return makeRun({
    args: ['exec', '--json'],
    status: { repo, ...status },
    events: [thread, failedChange, COMPLETED_COMMAND],
    stderr: [
      '2026-11-15T23:07:14.511119Z ERROR codex_core::tools::router: error=Exit code: 1',
      'Wall time: 1.5 seconds',
      'Output:',
      `Failed to write file ${target}`,
    ].join('\r\n'),
    schema: { required: ['outcome'] },
    scope: 'src/**',
    after: changed,
    result: buildResult(changes),
    ...overrides,
  });
}

test('writeRefusalGap returns null for a successful build with an in-scope refusal', () => {
  const result = buildResult(changes);
  const runDir = buildRun({ result });
  assert.equal(writeRefusalGap(refused, { resultOk: true, exit: 0, result, runDir }), null);
});

test('writeRefusalGap returns the refusal rule when Verify fails with an in-scope refusal', () => {
  const result = buildResult(changes, { verify_passed: false });
  const runDir = buildRun({ result });
  const gap = writeRefusalGap(refused, { resultOk: true, exit: 0, result, runDir });
  assert.equal(gap.key, 'build-scope-write-refused');
  assert.match(gap.reason, /sandbox refused to write .*src\/blocked\.mjs/);
});

test('writeRefusalGap returns null when a failed build has only out-of-scope refusals', () => {
  const result = buildResult(changes, { verify_passed: false });
  const runDir = buildRun({ result });
  const outOfScope = { ...refused, paths: [{ ...refused.paths[0], inScope: false }] };
  assert.equal(writeRefusalGap(outOfScope, { resultOk: true, exit: 0, result, runDir }), null);
});

for (const [name, options, exit, resultOk] of [
  ['no usable result', { result: undefined }, 0, false],
  ['nonzero Codex exit', {}, 9, true],
  ['failed verification', { result: buildResult(changes, { verify_passed: false }) }, 0, true],
  ['declared failure', { result: buildResult(changes, { outcome: 'fail' }) }, 0, true],
]) {
  test(`${name} selects the refusal rule and T01 Action without changing the worktree record`, () => {
    const dir = buildRun(options);
    const { meta, reply } = collect(dir, 'codex-build', exit);
    assert.equal(meta.result_ok, resultOk);
    assert.equal(meta.status, 'FAIL');
    assert.equal(meta.exit, exit);
    assert.equal(exitCodeFor(meta.status), 1);
    assert.equal(meta.reason_rule, 'build-scope-write-refused');
    assert.match(meta.reason, /sandbox refused to write .*src\/blocked\.mjs/);
    assert.deepEqual(meta.write_refusal, refused);
    const recorded = readJsonFileSync(path.join(dir, 'meta.json'));
    assert.equal(recorded.reason_rule, meta.reason_rule);
    assert.deepEqual(recorded.write_refusal, refused);
    assert.deepEqual(actionRows(reply), [
      orderDiagnosticMessage('next-action', { variant: 'fail-build-write-refusal' }),
    ]);
    assert.equal(reply.split('\n')[2], actionRows(reply)[0]);
    assert.match(actionRows(reply)[0], /llm-bridge guidance troubleshooting, case T01/);
    assert.match(reply, /^Worktree: has unfinished changes \(1\): src\/partial\.mjs/m);
    assert.equal(fs.readFileSync(path.join(dir, 'state-after.txt'), 'utf8'), changed);
    const stderrFile = path.join(dir, 'stderr.log');
    fs.writeFileSync(stderrFile, '', 'utf8');
    assert.equal(renderReply(dir, 'codex-build', recorded), reply);
  });
}

for (const [name, target, scope, normalized, failed] of [
  ['outside scope', deniedPath, 'tests/**', 'src/blocked.mjs', true],
  ['outside the repository', 'C:\\repo-other\\src\\blocked.mjs', '**', 'C:/repo-other/src/blocked.mjs', false],
]) {
  test(`a refusal ${name} is recorded but does not select the rule`, () => {
    const { meta, reply } = collect(buildRun({ target, scope }), 'codex-build', 9);
    assert.equal(meta.status, 'FAIL');
    assert.match(meta.reason, /^result exists, but exit=9:/);
    assert.equal(meta.reason_rule, null);
    assert.deepEqual(meta.write_refusal, {
      paths: [{ path: normalized, inScope: false, failedChange: failed }],
      evidence: [`Failed to write file ${target}`],
    });
    assert.deepEqual(actionRows(reply), [orderDiagnosticMessage('next-action', { variant: 'fail-result' })]);
  });
}

test('one in-scope path is enough even without a matching failed file change', () => {
  const outside = 'Failed to write file C:\\outside\\blocked.mjs';
  const { meta } = collect(buildRun({
    result: undefined,
    stderr: [outside, refusalLine].join('\n'),
    events: [thread, COMPLETED_COMMAND],
  }), 'codex-build', 1);
  assert.equal(meta.reason_rule, 'build-scope-write-refused');
  assert.match(meta.reason, /\(src\/blocked\.mjs\)/);
  assert.doesNotMatch(meta.reason, /outside/);
  assert.deepEqual(meta.write_refusal, {
    paths: [
      { path: 'C:/outside/blocked.mjs', inScope: false, failedChange: false },
      { path: 'src/blocked.mjs', inScope: true, failedChange: false },
    ],
    evidence: [outside, refusalLine],
  });
});

test('a build that recovered stays OK and keeps the observed refusal in metadata', () => {
  const { meta, reply } = collect(buildRun(), 'codex-build', 0);
  assert.equal(meta.status, 'OK');
  assert.equal(exitCodeFor(meta.status), 0);
  assert.equal(meta.reason_rule, null);
  assert.deepEqual(meta.write_refusal, refused);
  assert.deepEqual(actionRows(reply), []);
});

test('an archived result without a contracted outcome still follows its ordinary verdict', () => {
  const dir = buildRun({ schema: undefined, result: buildResult(changes, { outcome: 'fail' }) });
  const { meta, reply } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
  assert.equal(meta.reason_rule, null);
  assert.deepEqual(meta.write_refusal, refused);
  assert.deepEqual(actionRows(reply), []);
});

test('the same refusal does not select a build rule for a scout', () => {
  const { meta, reply } = collect(buildRun({ result: undefined }), 'codex-scout', 1);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason_rule, null);
  assert.equal(Object.hasOwn(meta, 'write_refusal'), false);
  assert.deepEqual(actionRows(reply), [orderDiagnosticMessage('next-action', { variant: 'fail-no-result' })]);
});

test('matching patch context failure without a refusal line keeps the Verify reason', () => {
  const { meta } = collect(buildRun({
    stderr: `Failed to find expected lines in ${deniedPath}:`,
    result: buildResult(changes, { verify_passed: false }),
  }), 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /verification .* failed/);
  assert.equal(meta.reason_rule, null);
  assert.equal(meta.write_refusal, null);
});

for (const [name, options, reason] of [
  ['commit', { headBefore: 'old', headAfter: 'new' }, /commit made despite prohibition/],
  ['branch', { branchBefore: 'master', branchAfter: 'other' }, /branch moved despite prohibition/],
  ['deadline', { status: { stopped_on_deadline: true, elapsed_seconds: 60 } }, /deadline/],
  ['transport', {
    events: [thread, failedChange, { type: 'turn.failed', error: { message: 'Transport closed early' } }],
  }, /Transport closed early/],
  ['sandbox witness', {
    status: {
      resumed_from: 'earlier-run',
      stop: { session: { sandbox_witness: { state: 'observed', policy: 'workspace-write' } } },
    },
  }, /read-only/],
]) {
  test(`${name} retains its earlier verdict and Action with refusal evidence present`, () => {
    const { meta, reply } = collect(buildRun({ result: undefined, ...options }), 'codex-build', 1);
    assert.equal(meta.status, 'FAIL');
    assert.match(meta.reason, reason);
    assert.notEqual(meta.reason_rule, 'build-scope-write-refused');
    assert.deepEqual(meta.write_refusal, refused);
    assert.deepEqual(actionRows(reply), [
      orderDiagnosticMessage('next-action', { variant: 'fail-no-result' }),
    ]);
  });
}
