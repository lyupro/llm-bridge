/** OW-089 D1: proof blocks ordinary and carried OK; suspicions remain visible without accusation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { encodingGap, readEncodingEvidence } from '../../src/home/lib/meta/encoding-verdict.mjs';
import { failActionVariant } from '../../src/home/lib/meta/reply.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { buildResult, COMPLETED_COMMAND, makeChainRoot, makeRun } from './test-fixtures.mjs';

const changed = 'U\t10\tsrc/a.mjs\n';
const result = () => buildResult([{ file: 'src/a.mjs', what: 'repair', why: 'task' }]);
const provenEntry = (line = 7) => ({ path: 'src/a.mjs', line, text: '// \u00e2\u20ac\u201d' });
const suspectedEntry = (line = 9, kind = 'candidate') => ({
  path: 'src/a.mjs', line, kind, index: 3, text: '\u00c3\u00a9', repaired: '\u00e9',
});
function evidence(proven = [], suspected = []) {
  return {
    version: 1, proven, suspected, counts: { proven: proven.length, suspected: suspected.length },
    truncated: false, coverage: { complete: true, gaps: [] },
  };
}
const writeEvidence = (dir, report) => fs.writeFileSync(path.join(dir, 'encoding.json'), JSON.stringify(report));
const greenBuild = (overrides = {}) => makeRun({
  args: ['exec', '--json'], events: [{ type: 'thread.started', thread_id: 'encoding' }, COMPLETED_COMMAND],
  result: result(), before: '', after: changed, scope: 'src/**', ...overrides,
});
const encodingRows = (reply) => reply.split('\n').filter((row) => row.startsWith('Encoding:'));

test('green build with tier A fails with its rule and exactly one repair Action; artifacts stay intact', () => {
  const dir = greenBuild();
  writeEvidence(dir, evidence([provenEntry()]));
  const artifact = fs.readFileSync(path.join(dir, 'encoding.json'), 'utf8');
  const { meta, reply } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason_rule, 'build-encoding-corrupted');
  assert.match(meta.reason, /1 proven mojibake replacements at src\/a\.mjs:7/);
  assert.match(meta.reason, /edits were kept in the worktree/);
  assert.equal(failActionVariant(meta), 'fail-build-encoding');
  assert.deepEqual(reply.split('\n').filter((row) => row.startsWith('Action:')), [
    orderDiagnosticMessage('next-action', { variant: 'fail-build-encoding' }),
  ]);
  assert.match(reply, /Worktree: has unfinished changes \(1\): src\/a\.mjs/);
  assert.equal(fs.readFileSync(path.join(dir, 'encoding.json'), 'utf8'), artifact);
  assert.equal(fs.readFileSync(path.join(dir, 'state-after.txt'), 'utf8'), changed);
});

test('tier A blocks carried OK before the earlier-pass success return', () => {
  const root = makeChainRoot([
    { name: 'first', at: '2026-11-15T00:00:00Z', before: '', after: changed, result: result() },
    { name: 'second', at: '2026-11-15T01:00:00Z', before: changed, after: changed, result: result() },
  ]);
  const dir = path.join(root, 'second');
  const baseline = collect(dir, 'codex-build', 0);
  assert.equal(baseline.meta.status, 'OK');
  assert.equal(baseline.meta.carried_from_earlier_run, true);
  writeEvidence(dir, evidence([provenEntry()]));
  const { meta, reply } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason_rule, 'build-encoding-corrupted');
  assert.equal(meta.carried_from_earlier_run, false);
  assert.match(reply, /^Action: .*do not repeat the order unchanged/m);
});

test('proven reason uses the true count and only the first three locations', () => {
  const dir = greenBuild();
  const report = evidence([1, 2, 3, 4].map(provenEntry));
  report.counts.proven = 60;
  report.truncated = true;
  writeEvidence(dir, report);
  const gap = encodingGap(dir);
  assert.equal(gap.key, 'build-encoding-corrupted');
  assert.match(gap.reason, /^60 proven/);
  assert.match(gap.reason, /src\/a\.mjs:1, src\/a\.mjs:2, src\/a\.mjs:3;/);
  assert.doesNotMatch(gap.reason, /src\/a\.mjs:4/);
});

test('suspected entries stay OK, print text and repair after both Flags rows, and use true totals', () => {
  const dir = greenBuild();
  const report = evidence([], [1, 2, 3, 4].map((n) => suspectedEntry(n)));
  report.counts.suspected = 55;
  report.truncated = true;
  report.coverage = { complete: false, gaps: ['b.mjs: start content unavailable'] };
  writeEvidence(dir, report);
  fs.writeFileSync(path.join(dir, 'flags.txt'), 'src/a.mjs:1 TODO\n');
  fs.writeFileSync(path.join(dir, 'flags-coverage.txt'), report.coverage.gaps.join('\n'));
  const { meta, reply } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
  assert.equal(meta.reason_rule, null);
  const rows = reply.split('\n');
  const flags = rows.findIndex((row) => row.startsWith('Flags:'));
  assert.match(rows[flags + 1], /^Flags coverage:/);
  assert.equal(rows[flags + 2], 'Encoding: 55 suspected \u2014 '
    + [1, 2, 3].map((n) => `src/a.mjs:${n} \u00c3\u00a9\u2192\u00e9`).join(' | ')
    + '; check before accepting');
  assert.doesNotMatch(rows[flags + 2], /src\/a\.mjs:4|coverage|unavailable/);
  assert.deepEqual(encodingRows(reply), [rows[flags + 2]]);
  assert.equal(encodingGap(dir), null);
  assert.equal(readEncodingEvidence(dir).suspected.length, 3);
});

test('suspected row is capped like Flags and keeps the acceptance hint with long multiline text', () => {
  const dir = greenBuild();
  writeEvidence(dir, evidence([], [{ ...suspectedEntry(), text: 'long text\n'.repeat(40) }]));
  const { reply } = collect(dir, 'codex-build', 0);
  const [row] = encodingRows(reply);
  const prefix = 'Encoding: 1 suspected \u2014 ';
  const hint = '; check before accepting';
  assert.ok(row.startsWith(prefix));
  assert.ok(row.endsWith(hint));
  assert.ok(row.slice(prefix.length, -hint.length).length <= 140);
  assert.match(row, /\.\.\.; check before accepting$/);
  assert.doesNotMatch(row, /[\r\n]/);
});

for (const kind of ['inherited', 'replacement-char', 'malformed-utf8']) {
  test(`tier B ${kind} remains visible without inventing a repair or line`, () => {
    const dir = greenBuild();
    const entry = kind === 'malformed-utf8'
      ? { path: 'src/a.mjs', kind, byteOffset: 5 }
      : kind === 'replacement-char' ? { path: 'src/a.mjs', line: 9, kind, index: 3 }
      : suspectedEntry(9, kind);
    writeEvidence(dir, evidence([], [entry]));
    const { meta, reply } = collect(dir, 'codex-build', 0);
    assert.equal(meta.status, 'OK');
    const [row] = encodingRows(reply);
    assert.ok(row);
    if (kind === 'inherited') assert.ok(row.includes('src/a.mjs:9 \u00c3\u00a9\u2192\u00e9'));
    if (kind === 'replacement-char') assert.match(row, /src\/a\.mjs:9 U\+FFFD/);
    if (kind === 'malformed-utf8') assert.match(row, /src\/a\.mjs:byte 5 malformed UTF-8/);
  });
}

for (const [name, artifact] of [
  ['absent', undefined], ['malformed JSON', '{'], ['unreadable directory', null],
  ['unsupported version', { ...evidence([provenEntry()], [suspectedEntry()]), version: 2 }],
  ['string version', { ...evidence([provenEntry()]), version: '1' }],
  ['null artifact', 'null'], ['empty object', {}],
  ['invalid counts', { ...evidence([provenEntry()]), counts: { proven: '1', suspected: 0 } }],
  ['invalid proven list', { ...evidence([provenEntry()]), proven: null }],
  ['invalid proven location', evidence([{ ...provenEntry(), line: 0 }])],
  ['invalid suspected entry', evidence([], [null])],
  ['empty evidence', evidence()],
  ['coverage only', { ...evidence(), coverage: { complete: false, gaps: ['unreadable start'] } }],
]) {
  test(`${name} never accuses a green build or adds an Encoding row`, () => {
    const dir = greenBuild();
    const file = path.join(dir, 'encoding.json');
    if (artifact === null) fs.mkdirSync(file);
    else if (typeof artifact === 'string') fs.writeFileSync(file, artifact);
    else if (artifact !== undefined) writeEvidence(dir, artifact);
    assert.equal(encodingGap(dir), null);
    const { meta, reply } = collect(dir, 'codex-build', 0);
    assert.equal(meta.status, 'OK');
    assert.equal(meta.reason_rule, null);
    assert.equal(meta.reason, null);
    assert.deepEqual(encodingRows(reply), []);
  });
}

for (const [name, options, exit] of [
  ['red verification', { result: buildResult(result().changes, { verify_passed: false }) }, 0],
  ['out-of-scope file', { after: `${changed}U\t10\tother/b.mjs\n` }, 0],
  ['commit', { headBefore: 'old', headAfter: 'new' }, 0],
  ['branch', { branchBefore: 'master', branchAfter: 'other' }, 0],
  ['deadline', { status: { stopped_on_deadline: true, elapsed_seconds: 60 } }, 0],
  ['nonzero exit', {}, 1],
  ['declared failure', { schema: { required: ['outcome'] },
    result: buildResult(result().changes, { outcome: 'fail', summary: 'work incomplete' }) }, 0],
]) {
  test(`${name} keeps its earlier FAIL reason ahead of tier A`, () => {
    const dir = greenBuild(options);
    const earlier = collect(dir, 'codex-build', exit).meta;
    assert.equal(earlier.status, 'FAIL');
    writeEvidence(dir, evidence([provenEntry()]));
    const { meta } = collect(dir, 'codex-build', exit);
    assert.equal(meta.status, 'FAIL');
    assert.equal(meta.reason, earlier.reason);
    assert.equal(meta.reason_rule, earlier.reason_rule);
    assert.notEqual(meta.reason_rule, 'build-encoding-corrupted');
    assert.equal(failActionVariant(meta), 'fail-result');
  });
}

test('tier A takes precedence over report mismatch', () => {
  const dir = greenBuild({ result: buildResult([{ file: 'src/other.mjs', what: 'change', why: 'task' }]) });
  const before = collect(dir, 'codex-build', 0).meta;
  assert.equal(before.status, 'FAIL');
  assert.notEqual(before.reason_rule, 'build-encoding-corrupted');
  writeEvidence(dir, evidence([provenEntry()]));
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.reason_rule, 'build-encoding-corrupted');
});

test('scout run ignores encoding evidence for both verdict and reply', () => {
  const dir = makeRun({
    events: [{ type: 'thread.started', thread_id: 'encoding-scout' }, COMPLETED_COMMAND],
    args: ['exec', '--json'],
    result: { answer: 'The scout inspected the repository and explained the existing implementation. '.repeat(5),
      findings: [], unknowns: [], report_markdown: '# report' },
  });
  const baseline = collect(dir, 'codex-scout', 0);
  assert.equal(baseline.meta.status, 'OK');
  writeEvidence(dir, evidence([provenEntry()], [suspectedEntry()]));
  const { meta, reply } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'OK');
  assert.equal(meta.reason_rule, null);
  assert.equal(reply, baseline.reply);
  assert.deepEqual(encodingRows(reply), []);
});
