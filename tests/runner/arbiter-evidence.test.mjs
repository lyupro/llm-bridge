/** Guards the OW-097 snapshot of the advisor records that an arbitration brief asks to weigh. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { arbiterEvidence } from '../../src/home/lib/runner/arbiter-evidence.mjs';
import { checkOutgoingRefusal } from '../../src/home/lib/order-text-record.mjs';
import { makeTempTree } from '../temp-tree.mjs';

const RUN = '2026-11-18_110000_split';
const META = { agent: 'codex-advisor', phase: 'advise', status: 'OK', finished_at: '2026-11-18T11:01:00Z' };
const RESULT = {
  recommendation: { option_id: 'split', text: 'Isolate the seam café-side.' },
  rejected: [{ option_id: 'keep', cost: 'Keeps two callers coupled.' }],
  strongest_counterargument: 'The changed API adds migration work.',
};

function writeRun(root, run, files = {}) {
  const dir = path.join(root, run);
  fs.mkdirSync(dir);
  for (const [file, contents] of Object.entries({
    'meta.json': JSON.stringify(META), 'result.json': JSON.stringify(RESULT), ...files,
  })) {
    if (contents !== undefined) fs.writeFileSync(path.join(dir, file), contents, 'utf8');
  }
  return dir;
}

function evidence(root, priorRuns, trigger = 'disagreement', option = 'keep') {
  return arbiterEvidence({ projectRunsRoot: root, priorRuns, position: { option }, trigger });
}

function assertRefusal(result, run, detail) {
  assert.equal(result.ok, false);
  assert.ok(result.refusal.includes(JSON.stringify(run)), result.refusal);
  assert.match(result.refusal, detail);
  assert.equal(checkOutgoingRefusal(result.refusal, 'arbiter-evidence-test'), result.refusal);
  assert.equal(Object.hasOwn(result, 'runs'), false);
}

test('freezes only the required facts and hashes the exact result bytes', () => {
  const root = makeTempTree('arbiter-evidence-');
  const bytes = Buffer.from('\uFEFF  ' + JSON.stringify({
    ...RESULT,
    recommendation: { ...RESULT.recommendation, extra: true },
    rejected: [{ ...RESULT.rejected[0], extra: true }],
    confidence: 'high',
  }, null, 2).replaceAll('\n', '\r\n') + '\r\n', 'utf8');
  const dir = writeRun(root, RUN, { 'result.json': bytes });
  const snapshot = evidence(root, [RUN]);
  fs.writeFileSync(path.join(dir, 'result.json'), '{}', 'utf8');
  assert.deepEqual(snapshot, { ok: true, runs: [{
    run: RUN, result_sha256: createHash('sha256').update(bytes).digest('hex'), ...RESULT,
  }] });
  const [run] = snapshot.runs;
  for (const frozen of [snapshot.runs, run, run.recommendation, run.rejected, run.rejected[0]]) {
    assert.ok(Object.isFrozen(frozen));
  }
});

test('refuses names outside the bare run-folder grammar before using them as paths', (t) => {
  const root = makeTempTree('arbiter-names-');
  const lstat = t.mock.method(fs, 'lstatSync');
  for (const run of ['one/two', 'one\\two', '.', '..', '', ' ', 'C:child', 'C:\\child', 'nul\0name', null]) {
    assertRefusal(evidence(root, [run]), run, /bare run-folder name/);
  }
  assert.equal(lstat.mock.callCount(), 0);
  lstat.mock.restore();
});

test('refuses missing folders and files in place of run folders', () => {
  const root = makeTempTree('arbiter-folders-');
  assertRefusal(evidence(root, [RUN]), RUN, /folder does not exist/);
  fs.writeFileSync(path.join(root, RUN), '{}', 'utf8');
  assertRefusal(evidence(root, [RUN]), RUN, /not a directory/);
});

test('refuses a symbolic link or junction even when its target is valid advice', (t) => {
  const root = makeTempTree('arbiter-link-');
  const target = writeRun(root, 'advisor-target');
  const linked = path.join(root, RUN);
  try {
    fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Platform refuses to create the run folder link: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assertRefusal(evidence(root, [RUN]), RUN, /symbolic link or junction/);
});

test('reports inaccessible run directories and artifacts as registered refusals', (t) => {
  const root = makeTempTree('arbiter-unreadable-');
  const dir = writeRun(root, RUN);
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const lstat = t.mock.method(fs, 'lstatSync', () => { throw denied; });
  assertRefusal(evidence(root, [RUN]), RUN, /run folder could not be inspected/);
  lstat.mock.restore();
  const readFileSync = fs.readFileSync;
  for (const file of ['meta.json', 'result.json']) {
    const blocked = path.join(dir, file);
    const read = t.mock.method(fs, 'readFileSync', (filename, ...args) => {
      if (filename === blocked) throw denied;
      return readFileSync(filename, ...args);
    });
    assertRefusal(evidence(root, [RUN]), RUN, new RegExp(`${file} could not be read`));
    read.mock.restore();
  }
});

const metaCases = [
  ['missing metadata', undefined, /meta\.json is missing/],
  ['invalid metadata JSON', '{', /meta\.json must contain a valid JSON object/],
  ['non-object metadata', '[]', /meta\.json must contain a valid JSON object/],
  ['another agent', JSON.stringify({ ...META, agent: 'codex-review' }), /agent "codex-advisor"/],
  ['the scope phase', JSON.stringify({ ...META, phase: 'scope' }), /phase "advise"/],
  ['a failed verdict', JSON.stringify({ ...META, status: 'FAIL' }), /status "OK"/],
  ['missing completion', JSON.stringify({ ...META, finished_at: undefined }), /non-empty finished_at/],
  ['blank completion', JSON.stringify({ ...META, finished_at: ' ' }), /non-empty finished_at/],
  ['non-string completion', JSON.stringify({ ...META, finished_at: 1 }), /non-empty finished_at/],
];

const resultCases = [
  ['missing result', undefined, /result\.json is missing/],
  ['invalid result JSON', '{', /result\.json must contain a valid JSON object/],
  ['non-object result', 'null', /result\.json must contain a valid JSON object/],
  ['missing recommendation', JSON.stringify({ ...RESULT, recommendation: undefined }), /recommendation\.option_id/],
  ['non-string recommendation id', JSON.stringify({ ...RESULT, recommendation: { ...RESULT.recommendation, option_id: 2 } }),
    /recommendation\.option_id/],
  ['non-string recommendation text', JSON.stringify({ ...RESULT, recommendation: { option_id: 'split', text: 2 } }),
    /recommendation\.text/],
  ['non-array rejected options', JSON.stringify({ ...RESULT, rejected: {} }), /rejected array/],
  ['null rejected option', JSON.stringify({ ...RESULT, rejected: [null] }), /option_id and cost/],
  ['non-string rejected option id', JSON.stringify({ ...RESULT, rejected: [{ option_id: 2, cost: 'work' }] }), /option_id and cost/],
  ['missing rejected cost', JSON.stringify({ ...RESULT, rejected: [{ option_id: 'keep' }] }), /option_id and cost/],
  ['non-string counterargument', JSON.stringify({ ...RESULT, strongest_counterargument: 2 }), /strongest_counterargument/],
];

for (const [file, cases] of [['meta.json', metaCases], ['result.json', resultCases]]) {
  for (const [name, contents, detail] of cases) {
    test(`refuses ${name} and names the run`, () => {
      const root = makeTempTree('arbiter-invalid-');
      writeRun(root, RUN, { [file]: contents });
      assertRefusal(evidence(root, [RUN]), RUN, detail);
    });
  }
}

test('disagreement requires a differing recommendation and validates every listed run', () => {
  const root = makeTempTree('arbiter-disagreement-');
  const agreeing = '2026-11-18_120000_keep';
  writeRun(root, RUN);
  writeRun(root, agreeing, { 'result.json': JSON.stringify({
    ...RESULT, recommendation: { option_id: 'keep', text: 'Preserve the integration.' },
  }) });
  assertRefusal(evidence(root, []), [], /must recommend a different option/);
  assertRefusal(evidence(root, [agreeing]), [agreeing], /must recommend a different option/);
  assert.deepEqual(evidence(root, [agreeing, RUN]).runs.map(({ run }) => run), [agreeing, RUN]);
  assertRefusal(evidence(root, [RUN, 'missing']), 'missing', /folder does not exist/);
  assert.deepEqual(evidence(root, [], 'irreversible'), { ok: true, runs: [] });
  assert.equal(evidence(root, [agreeing], 'irreversible').ok, true);
});

test('omitting the trigger fails loudly instead of bypassing disagreement', () => {
  assert.throws(() => arbiterEvidence({ projectRunsRoot: '.', priorRuns: [], position: { option: 'keep' } }), {
    name: 'TypeError', message: /valid trigger/,
  });
});
