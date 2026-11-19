import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { publishArbiterReport } from '../../src/home/lib/meta/arbiter-publication.mjs';
import { renderArbiterReport } from '../../src/home/lib/runner/arbiter-report.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const tag = 'ARBITER_PROBE_0123456789abcdef';
const command = `echo ${tag}`;
const output = 'café\n';
const task = {
  trigger: 'review', question: 'Which option?', paths: ['src'],
  options: [{ id: 'A', description: 'Use A' }, { id: 'B', description: 'Use B' }],
  position: { option: 'A', rationale: 'Preserve the current behavior.' },
};
const evidence = [];
const result = {
  recommendation: { option_ids: ['A'], text: 'Use A.', mix_rationale: '' },
  rejected: [{ option_id: 'B', cost: 'Migration' }],
  residual_gaps: [{ option_id: 'A', gap: 'Documentation' }],
  strongest_counterargument: 'B simplifies operations.',
  pre_mortem: [{ scenario: 'A fails.', early_check: 'Read logs.' }],
  prior_advice_review: [],
  checks: [],
  probes: [{ probe_tag: tag, purpose: 'Check capture', finding: 'Output captured.' }],
};
const receipts = [{
  probe_tag: tag, event_index: 0, item_id: 'item_1', command, status: 'completed', exit_code: 0,
  succeeded: true, output_excerpt: output, output_bytes: Buffer.byteLength(output), output_truncated: false,
}];

function fixture(t, { revision = 'a'.repeat(40), inputTask = task } = {}) {
  const runDir = makeTempTree('arbiter-publication-');
  t.after(() => removeTempTree(runDir));
  const write = (name, text) => fs.writeFileSync(path.join(runDir, name), text, 'utf8');
  write('status.json', JSON.stringify({
    source_revision: revision, stdio_drained: true, stop: { receipts: { lines: 1 } },
  }));
  write('arbiter-input.json', JSON.stringify({ version: 1, task: inputTask, evidence }));
  write('events.jsonl', `${JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_1', type: 'command_execution', command, status: 'completed', exit_code: 0, aggregated_output: output },
  })}\n`);
  return {
    runDir,
    file: path.join(runDir, 'report.md'),
    publish: () => publishArbiterReport({ runDir, result }),
    expected: () => Buffer.from(renderArbiterReport({
      run: path.basename(runDir), revision, task, evidence, result, receipts,
    }), 'utf8'),
  };
}

function assertNoTemporary(runDir) {
  assert.equal(fs.readdirSync(runDir).some((name) => name.endsWith('.tmp')), false);
}

test('publishes rendered bytes with bound probe receipts and returns their SHA-256', (t) => {
  const run = fixture(t);
  const expected = run.expected();
  assert.deepEqual(run.publish(), { ok: true, sha256: createHash('sha256').update(expected).digest('hex') });
  assert.deepEqual(fs.readFileSync(run.file), expected);
  assertNoTemporary(run.runDir);
});

test('publishes the report when the source revision is null', (t) => {
  const run = fixture(t, { revision: null });
  assert.equal(run.publish().ok, true);
  assert.deepEqual(fs.readFileSync(run.file), run.expected());
  assert.match(fs.readFileSync(run.file, 'utf8'), /Source revision: not recorded/);
});

test('a malformed task gives a render failure without creating a report or temporary', (t) => {
  const run = fixture(t, { inputTask: 'malformed' });
  assert.deepEqual(run.publish(), {
    ok: false, reason: 'arbiter report render failed: Expected task and result objects and evidence and receipts arrays.',
  });
  assert.equal(fs.existsSync(run.file), false);
  assertNoTemporary(run.runDir);
});

test('a failed rename gives a bounded single-line write reason and removes the temporary', (t) => {
  const run = fixture(t);
  t.mock.method(fs, 'renameSync', () => {
    throw new Error(`replacement failed\r\n${'x'.repeat(250)}`);
  });
  const publication = run.publish();
  assert.equal(publication.ok, false);
  assert.match(publication.reason, /^arbiter report write failed: replacement failed x+\.\.\.$/);
  assert.equal(publication.reason.length, 200);
  assert.equal(fs.existsSync(run.file), false);
  assertNoTemporary(run.runDir);
});

test('a byte mismatch on read-back gives the verification reason without a hash', (t) => {
  const run = fixture(t);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...options) =>
    file === run.file ? Buffer.from('different bytes', 'utf8') : read(file, ...options));
  assert.deepEqual(run.publish(), { ok: false, reason: 'arbiter report verification failed: bytes differ' });
  assertNoTemporary(run.runDir);
});

test('the stale report remains visible until the complete replacement is renamed over it', (t) => {
  const run = fixture(t);
  fs.writeFileSync(run.file, 'stale report', 'utf8');
  const rename = fs.renameSync;
  const replacement = t.mock.method(fs, 'renameSync', (temporary, target) => {
    assert.equal(target, run.file);
    assert.equal(fs.readFileSync(target, 'utf8'), 'stale report');
    assert.deepEqual(fs.readFileSync(temporary), run.expected());
    return rename(temporary, target);
  });
  assert.equal(run.publish().ok, true);
  assert.equal(replacement.mock.callCount(), 1);
  assert.deepEqual(fs.readFileSync(run.file), run.expected());
  assertNoTemporary(run.runDir);
});
