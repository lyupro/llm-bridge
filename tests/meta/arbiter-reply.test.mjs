/** Guards the OW-097 D4 chat summary and its link to the published arbiter report. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { arbiterFilled, arbiterReply } from '../../src/home/lib/meta/arbiter-reply.mjs';

const validResult = () => ({
  recommendation: { option_ids: ['keep'], mix_rationale: '', text: 'Keep the existing boundary.' },
  rejected: [
    { option_id: 'split', cost: 'Requires migrating callers.' },
    { option_id: 'replace', cost: 'Requires rewriting the adapter.' },
  ],
  residual_gaps: [{ option_id: 'keep', gap: 'Compatibility still needs a live check.' }],
  strongest_counterargument: 'The existing boundary is harder to extend.',
  pre_mortem: [{ scenario: 'A caller breaks.', early_check: 'Run the compatibility tests.' }],
  prior_advice_review: [],
  checks: [
    { claim: 'The adapter has two callers.', verified: true, evidence: [] },
    { claim: 'All callers support the new contract.', verified: false, evidence: [] },
  ],
  probes: [],
});

const runDir = path.join('runs', 'arbiter-run');
const reply = (result) => arbiterReply({
  result,
  runDir,
  resultPath: path.join(runDir, 'result.json'),
  file: (name) => path.join(runDir, name),
});

test('single-option arbitration renders five ordered rows and links the published report', () => {
  assert.deepEqual(reply(validResult()), [
    'OK — recommend keep: Keep the existing boundary.',
    'Rejected: split (Requires migrating callers.); replace (Requires rewriting the adapter.)',
    'Counter: The existing boundary is harder to extend.',
    'Gaps: 1 · pre-mortem 1 · probes 0 · checks 2',
    `Report: ${path.join(runDir, 'report.md')} · Log: llm-bridge read ${runDir}`,
  ]);
});

test('a two-option mix preserves recommendation order and can reject no options', () => {
  const result = validResult();
  result.recommendation.option_ids = ['keep', 'split'];
  result.recommendation.mix_rationale = 'Keep the public adapter and split its internals.';
  result.recommendation.text = 'Keep the adapter and split its internals.';
  result.rejected = [];
  result.probes = [{
    probe_tag: 'ARBITER_PROBE_0123456789abcdef',
    purpose: 'Locate callers.',
    finding: 'Two callers use the adapter.',
  }];
  const rows = reply(result);
  assert.equal(rows[0], 'OK — recommend keep + split: Keep the adapter and split its internals.');
  assert.equal(rows[1], 'Rejected: none');
  assert.equal(rows[3], 'Gaps: 1 · pre-mortem 1 · probes 1 · checks 2');
});

test('a long multiline recommendation stays within 200 characters on one row', () => {
  const result = validResult();
  result.recommendation.text = `Keep the boundary.\n${'Preserve existing callers. '.repeat(30)}`;
  const [row] = reply(result);
  assert.match(row, /^OK — recommend keep: Keep the boundary\. Preserve existing callers\./u);
  assert.doesNotMatch(row, /[\r\n\u2028\u2029]/u);
  assert.ok(row.length <= 200);
  assert.ok(row.endsWith('...'));
});

test('a filled result requires a non-blank first id in an array', () => {
  assert.equal(arbiterFilled(validResult()), true);
  assert.equal(arbiterFilled({}), false);
  assert.equal(arbiterFilled({ recommendation: { option_ids: [] } }), false);
  assert.equal(arbiterFilled({ recommendation: { option_ids: [' \t', 'keep'] } }), false);
  assert.equal(arbiterFilled({ recommendation: { option_ids: 'keep' } }), false);
});
