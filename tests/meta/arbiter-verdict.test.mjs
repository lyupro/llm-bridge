/** Guards verdicts for the OW-097 arbitration design chosen by the advise run named in `advice:`. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
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
  }, /recommendation\.option_ids.*at least one/],
  ['unknown recommendation', (r) => {
    r.recommendation.option_ids.push('invented');
    r.recommendation.mix_rationale = 'Added to the gate.';
  }, /recommendation\.option_ids "invented".*unknown/],
  ['duplicate recommendation', (r) => {
    r.recommendation.option_ids.push('gate');
    r.recommendation.mix_rationale = 'Repeated the gate.';
  }, /recommendation\.option_ids "gate".*duplicate/],
  ['mix without rationale', mix, /recommendation\.mix_rationale/],
  ['mix with whitespace rationale', (r) => { mix(r).recommendation.mix_rationale = ' \n '; }, /recommendation\.mix_rationale/],
  ['missing rejection', (r) => r.rejected.pop(), /rejected.*missing "log"/],
  ['duplicate rejection', (r) => r.rejected.push(r.rejected[0]), /rejected "audit".*duplicate/],
  ['rejection of the recommended option', (r) => r.rejected.push({ option_id: 'gate', cost: 'Late.' }), /rejected "gate".*unexpected/],
  ['missing gap for the recommended option', (r) => r.residual_gaps.shift(), /residual_gaps.*missing "gate"/],
  ['duplicate gap', (r) => r.residual_gaps.push(r.residual_gaps[0]), /residual_gaps "gate".*duplicate/],
  ['unknown gap', (r) => r.residual_gaps.push({ option_id: 'invented', gap: 'Unknown.' }), /residual_gaps "invented".*unexpected/],
  ['no pre-mortem scenarios', (r) => { r.pre_mortem = []; }, /pre_mortem.*between 1 and 5/],
  ['six pre-mortem scenarios', (r) => { r.pre_mortem = Array(6).fill(r.pre_mortem[0]); }, /pre_mortem.*between 1 and 5/],
  ['pre-mortem supplied as text', (r) => { r.pre_mortem = 'one'; }, /pre_mortem.*between 1 and 5/],
  ['missing review', (r) => r.prior_advice_review.pop(), /prior_advice_review.*missing "advisor-one"/],
  ['duplicate review', (r) => r.prior_advice_review.push(r.prior_advice_review[0]), /prior_advice_review "advisor-two".*duplicate/],
  ['review of an unknown run', (r) => {
    r.prior_advice_review.push({ run: 'advisor-three', stance: 'partial', note: 'Covered the gate.' });
  }, /prior_advice_review "advisor-three".*unexpected/],
  ['review run field holds a file address', (r) => {
    r.prior_advice_review.push({ run: 'src/audit.mjs:1', stance: 'partial', note: 'Covered the gate.' });
  }, /prior_advice_review "src\/audit.mjs:1".*unexpected/],
  ['out-of-scope citation in a probe finding', (r) => { r.probes[0].finding = 'See src/audit.mjs:1.'; }, /probes\[0\]\.finding "src\/audit.mjs:1".*task\.paths/],
  ['out-of-scope citation in a review note', (r) => { r.prior_advice_review[0].note = 'See src/audit.mjs:1.'; }, /prior_advice_review\[0\]\.note.*task\.paths/],
  ['missing file in an early check', (r) => { r.pre_mortem[0].early_check = 'Inspect src/missing.mjs:1.'; }, /pre_mortem\[0\]\.early_check.*existing file/],
  ['out-of-scope structured evidence', (r) => {
    r.checks[1].evidence = [{ file: 'src/audit.mjs', line_start: 1, line_end: 1 }];
  }, /checks\[1\]\.evidence\[0\] "src\/audit.mjs:1".*task\.paths/],
  ['structured evidence past the end', (r) => { r.checks[0].evidence[0].line_end = 3; }, /checks\[0\]\.evidence\[0\].*within this file's 2 lines/],
  ['control character', (r) => { r.strongest_counterargument += '\u0000'; }, /integrity strongest_counterargument.*control character U\+0000/],
  ['lone surrogate', (r) => { r.residual_gaps[0].gap += '\uD800'; }, /integrity residual_gaps\[0\]\.gap.*lone surrogate U\+D800/],
];

for (const [name, mutate, reason] of cases) {
  test(`rejects ${name} with its own reason`, () => {
    const result = validResult();
    mutate(result);
    const verdict = judge(result);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reasons.length, 1, JSON.stringify(verdict.reasons));
    assert.match(verdict.reasons[0], reason);
  });
}
