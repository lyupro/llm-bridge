/** Guards verdicts for the OW-097 arbitration design chosen by the advise run named in `advice:`. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { answerRuleMessage } from '../../src/home/lib/answer-rules.mjs';
import { parseArbiterTask } from '../../src/home/lib/meta/arbiter-task.mjs';
import { judgeArbitration } from '../../src/home/lib/meta/arbiter-verdict.mjs';
import { arbiterEvidence } from '../../src/home/lib/runner/arbiter-evidence.mjs';
import { makeTempTree } from '../temp-tree.mjs';

const brief = `## Question
How should we detect a missing order id?
## Options
- gate: Refuse at the gate.
- audit: Check at audit time.
- log: Record the error and continue.
## Trigger
disagreement
## Position
gate: The caller can still repair the order.
## Prior runs
- advisor-one
- advisor-two
## Paths
- src/gate.mjs
`;
const task = parseArbiterTask(brief);
const repoRoot = makeTempTree('arbiter-verdict-');
fs.mkdirSync(path.join(repoRoot, 'src'));
fs.writeFileSync(path.join(repoRoot, 'src', 'gate.mjs'), 'read();\nvalidate();\n', 'utf8');
fs.writeFileSync(path.join(repoRoot, 'src', 'audit.mjs'), 'audit();\n', 'utf8');

const projectRunsRoot = path.join(repoRoot, 'runs');
for (const [run, option_id] of [['advisor-one', 'audit'], ['advisor-two', 'gate']]) {
  const dir = path.join(projectRunsRoot, run);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    agent: 'codex-advisor', phase: 'advise', status: 'OK', finished_at: '2026-11-01T10:00:00Z',
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    recommendation: { option_id, text: 'Detect the missing id.' }, rejected: [],
    strongest_counterargument: 'Old orders are still in flight.',
  }), 'utf8');
}
const snapshot = arbiterEvidence({ projectRunsRoot, ...task });
assert.equal(snapshot.ok, true, snapshot.refusal);
const evidence = snapshot.runs;

function validResult() {
  return {
    recommendation: { option_ids: ['gate'], mix_rationale: '', text: 'Refuse at src/gate.mjs:2.' },
    rejected: [{ option_id: 'audit', cost: 'Late failure.' }, { option_id: 'log', cost: 'No enforcement.' }],
    residual_gaps: [
      { option_id: 'gate', gap: 'Direct invocations bypass the gate.' },
      { option_id: 'audit', gap: 'An order can run before the audit.' },
      { option_id: 'log', gap: 'A log can go unread.' },
    ],
    strongest_counterargument: 'Old orders are still in flight.',
    pre_mortem: [{ scenario: 'A caller bypasses the gate.', early_check: 'Inspect src/gate.mjs:1-2.' }],
    prior_advice_review: [
      { run: 'advisor-two', stance: 'agrees', note: 'Earlier rejection lets the caller repair the order.' },
      { run: 'advisor-one', stance: 'disagrees', note: 'The audit cannot prevent the first run.' },
    ],
    checks: [
      { claim: 'The gate calls validation.', verified: true, evidence: [{ file: 'src/gate.mjs', line_start: 2, line_end: 2 }] },
      { claim: 'Every caller uses the gate.', verified: false, evidence: [] },
    ],
    probes: [{ command: 'rg -n validate src/gate.mjs', purpose: 'Locate validation.', finding: 'Found at src/gate.mjs:2.' }],
  };
}

const judge = (result) => judgeArbitration({ result, task, evidence, repoRoot });
const pass = { ok: true, reasons: [] };

function mix(result) {
  result.recommendation.option_ids.push('audit');
  result.rejected.shift();
  return result;
}

test('accepts a single recommendation, scoped citations, frozen run names and an unverified claim', () => {
  assert.deepEqual(judge(validResult()), pass);
});

test('accepts a mix with rationale and no rejections when all options are recommended', () => {
  const result = mix(validResult());
  result.recommendation.mix_rationale = 'Reject new orders at the gate and audit direct calls.';
  assert.deepEqual(judge(result), pass);
  result.recommendation.option_ids.push('log');
  result.recommendation.mix_rationale += ' Log each direct call for the audit.';
  result.rejected.pop();
  assert.deepEqual(judge(result), pass);
});

test('accepts five scenarios and an empty review for an irreversible brief without prior runs', () => {
  const irreversible = parseArbiterTask(brief.replace('disagreement', 'irreversible')
    .replace('## Prior runs\n- advisor-one\n- advisor-two\n', ''));
  const result = validResult();
  result.pre_mortem = Array.from({ length: 5 }, () => ({ ...result.pre_mortem[0] }));
  result.prior_advice_review = [];
  assert.deepEqual(judgeArbitration({ result, task: irreversible, evidence: [], repoRoot }), pass);
});

const cases = [
  ['empty recommendation', (r) => {
    r.recommendation.option_ids = [];
    r.rejected.push({ option_id: 'gate', cost: 'Blocks existing callers.' });
  }, 'arbiter-recommendation-required'],
  ['unknown recommendation', (r) => {
    r.recommendation.option_ids.push('invented');
    r.recommendation.mix_rationale = 'Added to the gate.';
  }, 'arbiter-recommendation-option-id', { id: 'invented' }],
  ['duplicate recommendation', (r) => {
    r.recommendation.option_ids.push('gate');
    r.recommendation.mix_rationale = 'Repeated the gate.';
  }, 'arbiter-recommendation-duplicate', { id: 'gate' }],
  ['mix without rationale', mix, 'arbiter-mix-rationale'],
  ['mix with whitespace rationale', (r) => { mix(r).recommendation.mix_rationale = ' \n '; }, 'arbiter-mix-rationale'],
  ['missing rejection', (r) => r.rejected.pop(), 'arbiter-coverage-missing', { field: 'rejected', id: 'log' }],
  ['duplicate rejection', (r) => r.rejected.push(r.rejected[0]), 'arbiter-coverage-duplicate', { field: 'rejected', id: 'audit' }],
  ['rejection of the recommended option', (r) => r.rejected.push({ option_id: 'gate', cost: 'Late.' }),
    'arbiter-coverage-unexpected', { field: 'rejected', id: 'gate' }],
  ['missing gap for the recommended option', (r) => r.residual_gaps.shift(), 'arbiter-coverage-missing',
    { field: 'residual_gaps', id: 'gate' }],
  ['duplicate gap', (r) => r.residual_gaps.push(r.residual_gaps[0]), 'arbiter-coverage-duplicate',
    { field: 'residual_gaps', id: 'gate' }],
  ['unknown gap', (r) => r.residual_gaps.push({ option_id: 'invented', gap: 'Unknown.' }), 'arbiter-coverage-unexpected',
    { field: 'residual_gaps', id: 'invented' }],
  ['no pre-mortem scenarios', (r) => { r.pre_mortem = []; }, 'arbiter-pre-mortem-count'],
  ['six pre-mortem scenarios', (r) => { r.pre_mortem = Array(6).fill(r.pre_mortem[0]); }, 'arbiter-pre-mortem-count'],
  ['pre-mortem supplied as text', (r) => { r.pre_mortem = 'one'; }, 'arbiter-pre-mortem-count'],
  ['missing review', (r) => r.prior_advice_review.pop(), 'arbiter-coverage-missing',
    { field: 'prior_advice_review', id: 'advisor-one' }],
  ['duplicate review', (r) => r.prior_advice_review.push(r.prior_advice_review[0]), 'arbiter-coverage-duplicate',
    { field: 'prior_advice_review', id: 'advisor-two' }],
  ['review of an unknown run', (r) => {
    r.prior_advice_review.push({ run: 'advisor-three', stance: 'partial', note: 'Covered the gate.' });
  }, 'arbiter-coverage-unexpected', { field: 'prior_advice_review', id: 'advisor-three' }],
  ['review run field holds a file address', (r) => {
    r.prior_advice_review.push({ run: 'src/audit.mjs:1', stance: 'partial', note: 'Covered the gate.' });
  }, 'arbiter-coverage-unexpected', { field: 'prior_advice_review', id: 'src/audit.mjs:1' }],
  ['out-of-scope citation in a probe finding', (r) => { r.probes[0].finding = 'See src/audit.mjs:1.'; },
    'arbiter-citation-allowed-path', { field: 'probes[0].finding', label: 'src/audit.mjs:1' }],
  ['out-of-scope citation in a review note', (r) => { r.prior_advice_review[0].note = 'See src/audit.mjs:1.'; },
    'arbiter-citation-allowed-path', { field: 'prior_advice_review[0].note', label: 'src/audit.mjs:1' }],
  ['missing file in an early check', (r) => { r.pre_mortem[0].early_check = 'Inspect src/missing.mjs:1.'; },
    'arbiter-citation-existing-file', { field: 'pre_mortem[0].early_check', label: 'src/missing.mjs:1' }],
  ['out-of-scope structured evidence', (r) => {
    r.checks[1].evidence = [{ file: 'src/audit.mjs', line_start: 1, line_end: 1 }];
  }, 'arbiter-citation-allowed-path', { field: 'checks[1].evidence[0]', label: 'src/audit.mjs:1' }],
  ['structured evidence past the end', (r) => { r.checks[0].evidence[0].line_end = 3; }, 'arbiter-citation-line-range',
    { field: 'checks[0].evidence[0]', label: 'src/gate.mjs:2-3', count: 2 }],
  ['empty structured evidence path', (r) => { r.checks[0].evidence[0].file = ''; }, 'arbiter-citation-path',
    { field: 'checks[0].evidence[0]', label: ':2' }],
  ['control character', (r) => { r.strongest_counterargument += '\u0000'; }, 'arbiter-control-character',
    { field: 'strongest_counterargument', codePoint: 'U+0000' }],
  ['lone surrogate', (r) => { r.residual_gaps[0].gap += '\uD800'; }, 'arbiter-lone-surrogate',
    { field: 'residual_gaps[0].gap', codePoint: 'U+D800' }],
];

for (const [name, mutate, key, values] of cases) {
  test(`rejects ${name} with its own reason`, () => {
    const result = validResult();
    mutate(result);
    assert.deepEqual(judge(result), { ok: false, reasons: [answerRuleMessage('codex-arbiter', key, values)] });
  });
}

test('reports unreadable structured evidence through its catalog rule', (t) => {
  const result = validResult();
  result.recommendation.text = 'Refuse at the gate.';
  result.pre_mortem[0].early_check = 'Inspect the gate.';
  result.probes[0].finding = 'Found validation.';
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === path.join(repoRoot, 'src/gate.mjs')) throw new Error('permission denied');
    return readFileSync(file, ...args);
  });
  assert.deepEqual(judge(result), { ok: false, reasons: [answerRuleMessage('codex-arbiter', 'arbiter-citation-readable-file', {
    field: 'checks[0].evidence[0]', label: 'src/gate.mjs:2',
  })] });
});
