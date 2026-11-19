import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArbiterTask } from '../../src/home/lib/meta/arbiter-task.mjs';
import { bindArbiterProbes } from '../../src/home/lib/meta/arbiter-probe-receipts.mjs';
import { renderArbiterReport } from '../../src/home/lib/runner/arbiter-report.mjs';
import { COMPLETED_COMMAND } from '../meta/test-fixtures.mjs';

const TAG = 'ARBITER_PROBE_0123456789abcdef';
const OTHER_TAG = 'ARBITER_PROBE_fedcba9876543210';
const SHA = 'be'.repeat(32);

function commandEvent(tag, item = {}) {
  return {
    ...COMPLETED_COMMAND,
    item: {
      ...COMPLETED_COMMAND.item,
      command: `Get-Content src/example.mjs # ${tag}`,
      ...item,
    },
  };
}

function boundReceipts(probes, events) {
  const { receipts, problems } = bindArbiterProbes({ probes, events, captureComplete: true });
  assert.deepEqual(problems, []);
  return receipts;
}

function snapshot(run, result_sha256, option_id, text, strongest_counterargument) {
  return Object.freeze({
    run, result_sha256, recommendation: Object.freeze({ option_id, text }),
    rejected: Object.freeze([]), strongest_counterargument,
  });
}

function reportInput(item) {
  const task = parseArbiterTask(`## Question
Which mode should we ship?

## Options
- fast: Use the fast path.
- safe: Validate each change.
- manual: Review each change by hand.

## Trigger
disagreement

## Position
safe: Validation catches malformed data.

## Prior runs
- advisor-fast
- advisor-manual

## Paths
- src/example.mjs`);
  const evidence = Object.freeze([
    snapshot('advisor-manual', 'ab'.repeat(32), 'manual', 'Review each change by hand.', 'Manual review is slow.'),
    snapshot('advisor-fast', SHA, 'fast', 'Use the fast path.', 'Unchecked data may be malformed.'),
  ]);
  const result = {
    recommendation: {
      option_ids: ['safe', 'fast'],
      text: 'Validate writes and keep reads fast.',
      mix_rationale: 'Writes and reads have different failure modes.',
    },
    rejected: [{ option_id: 'manual', cost: 'Review would delay writes.' }],
    residual_gaps: [
      { option_id: 'safe', gap: 'Validation takes time.' },
      { option_id: 'fast', gap: 'Reads still trust stored data.' },
      { option_id: 'manual', gap: 'Review is hard to scale.' },
    ],
    strongest_counterargument: 'Validation increases write latency.',
    pre_mortem: [
      { scenario: 'Writes exceed the latency budget.', early_check: 'Time a batch of writes.' },
      { scenario: 'Stored data is malformed.', early_check: 'Try reading a malformed record.' },
    ],
    prior_advice_review: [
      { run: 'advisor-fast', stance: 'partial', note: 'Keep the fast path for reads.' },
      { run: 'advisor-manual', stance: 'disagrees', note: 'Automated validation scales.' },
    ],
    checks: [
      { claim: 'The example exports a value.', verified: true, evidence: [
        { file: 'src/example.mjs', line_start: 1, line_end: 2 },
        { file: 'src/example.mjs', line_start: 4, line_end: 4 },
      ] },
      { claim: 'Writes stay within the latency budget.', verified: false, evidence: [] },
    ],
    probes: [{ probe_tag: TAG, purpose: 'Read the example.', finding: 'The value is exported.' }],
  };
  const receipts = boundReceipts(result.probes, [{ type: 'turn.started' }, commandEvent(TAG, item)]);
  return { run: '2026-11-19_150000_arbiter', revision: '0123456789abcdef'.repeat(2) + '01234567', task,
    evidence, result, receipts };
}

test('renders the complete report byte for byte with ordered decisions and receipt evidence', () => {
  const expected = `# Arbiter report

- Run: \`2026-11-19_150000_arbiter\`
- Source revision: \`0123456789abcdef0123456789abcdef01234567\`
- Trigger: \`disagreement\`
- Orchestrator position: \`safe\`

## Question

> Which mode should we ship?

## Options

- \`fast\`

  > Use the fast path.

- \`safe\`

  > Validate each change.

- \`manual\`

  > Review each change by hand.

## Orchestrator position

Option: \`safe\`

> Validation catches malformed data.

## Recommendation

Recommended: \`safe\`, \`fast\`

> Validate writes and keep reads fast.

Mix rationale:

> Writes and reads have different failure modes.

## Rejected options

- \`manual\`

  > Review would delay writes.

## Residual gaps

- \`safe\`

  > Validation takes time.

- \`fast\`

  > Reads still trust stored data.

- \`manual\`

  > Review is hard to scale.

## Strongest counterargument

> Validation increases write latency.

## Pre-mortem

1. Scenario:

   > Writes exceed the latency budget.

   Early check:

   > Time a batch of writes.

2. Scenario:

   > Stored data is malformed.

   Early check:

   > Try reading a malformed record.

## Prior advice review

- \`advisor-fast\` — stance \`partial\`, result SHA-256 \`bebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe\`

  > Keep the fast path for reads.

- \`advisor-manual\` — stance \`disagrees\`, result SHA-256 \`abababababababababababababababababababababababababababababababab\`

  > Automated validation scales.

## Checks

- Verified: yes

  > The example exports a value.

  Evidence: \`src/example.mjs:1-2\`, \`src/example.mjs:4-4\`

- Verified: no

  > Writes stay within the latency budget.

  Evidence: none

## Probes

### Probe \`ARBITER_PROBE_0123456789abcdef\`

Purpose:

> Read the example.

Finding:

> The value is exported.

Receipt: item \`item_3\`, event 1, status \`completed\`, exit code 0, succeeded: yes.

Command:

\`\`\`
Get-Content src/example.mjs # ARBITER_PROBE_0123456789abcdef
\`\`\`

Output excerpt (23 bytes in full):

\`\`\`
export const value = 1;
\`\`\`
`;
  assert.equal(renderArbiterReport(reportInput()), expected);
});

test('renders the same bytes twice and formats null revision and empty mix rationale', () => {
  const input = reportInput();
  input.revision = null;
  input.result.recommendation.option_ids = ['safe'];
  input.result.recommendation.mix_rationale = '';
  input.result.rejected.unshift({ option_id: 'fast', cost: 'Reads trust stored data.' });
  const report = renderArbiterReport(input);
  assert.equal(renderArbiterReport(input), report);
  assert.match(report, /^- Source revision: not recorded$/m);
  assert.doesNotMatch(report, /^Mix rationale:$/m);
});

test('uses a longer code span than the longest backtick run in an identifier', () => {
  const input = reportInput();
  input.run = 'run``name';
  assert.match(renderArbiterReport(input), /^- Run: ```run``name```$/m);
});

test('pads both sides of a code span when an identifier starts or ends with a backtick', () => {
  const input = reportInput();
  input.result.recommendation.option_ids = ['`safe', 'fast`'];
  assert.match(renderArbiterReport(input), /^Recommended: `` `safe ``, `` fast` ``$/m);
});

test('rejects line breaks in an identifier', () => {
  const input = reportInput();
  for (const lineBreak of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    input.task.trigger = `dis${lineBreak}agreement`;
    assert.throws(() => renderArbiterReport(input), TypeError);
  }
});

test('prints Evidence: none for a check without locations', () => {
  const report = renderArbiterReport(reportInput());
  assert.match(report, /^- Verified: no\n\n  > Writes stay within the latency budget\.\n\n  Evidence: none$/m);
});

test('quotes multiline text and fences each receipt verbatim with LF line endings', () => {
  const command = `Get-Content src/example.mjs # ${TAG}\r\n${'`'.repeat(3)}`;
  const output = `line\r${'`'.repeat(5)}\r\n## Probes\r\n`;
  const input = reportInput({ command, aggregated_output: output });
  input.result.probes[0].finding = 'First line\r\n## Probes\r\n\r\nLast line';
  const report = renderArbiterReport(input);
  assert.ok(report.includes('> First line\n> ## Probes\n> \n> Last line'));
  assert.ok(report.includes(`Command:\n\n${'`'.repeat(4)}\n${command.replace('\r\n', '\n')}\n${'`'.repeat(4)}\n`));
  assert.ok(report.includes('Output excerpt (23 bytes in full):\n\n``````\nline\n`````\n## Probes\n``````\n'));
  assert.doesNotMatch(report, /\r/);
});

test('prints a failed receipt and reports the full byte count when its excerpt is truncated', () => {
  const report = renderArbiterReport(reportInput({
    status: 'failed', exit_code: 7, aggregated_output: '\u00e9'.repeat(2100),
  }));
  assert.match(report, /^Receipt: item `item_3`, event 1, status `failed`, exit code 7, succeeded: no\.$/m);
  assert.ok(report.endsWith('Output excerpt (4200 bytes in full, truncated):\n\n```\n' +
    '\u00e9'.repeat(2048) + '\n```\n'));
});

test('matches receipts by tag while keeping probe order', () => {
  const input = reportInput();
  input.result.probes.push({ probe_tag: OTHER_TAG, purpose: 'Read again.', finding: 'The value is still exported.' });
  input.receipts = boundReceipts(input.result.probes, [
    commandEvent(OTHER_TAG, { id: 'item_2' }), commandEvent(TAG, { id: 'item_5' }),
  ]).reverse();
  const report = renderArbiterReport(input);
  const identifiers = report.matchAll(/^### Probe `(ARBITER_PROBE_\w+)`$|^Receipt: item `(item_\d+)`, /gm);
  assert.deepEqual([...identifiers].map((match) => match[1] ?? match[2]), [TAG, 'item_5', OTHER_TAG, 'item_2']);
});

test('uses one sentence when no probes were run', () => {
  const input = reportInput();
  input.result.probes = [];
  input.receipts = boundReceipts(input.result.probes, []);
  assert.equal(renderArbiterReport(input).split('## Probes\n')[1], '\nNo probes were run.\n');
});

test('rejects missing, unmatched, or duplicate probe receipts', () => {
  const input = reportInput();
  assert.throws(() => renderArbiterReport({ ...input, receipts: [] }), /Missing receipt for probe/);
  assert.throws(() => renderArbiterReport({ ...input, result: { ...input.result, probes: [] } }), /no matching probe/);
  assert.throws(() => renderArbiterReport({ ...input, receipts: [...input.receipts, ...input.receipts] }),
    /Duplicate receipt/);
});

test('rejects a prior advice review with no frozen snapshot to cite', () => {
  assert.throws(() => renderArbiterReport({ ...reportInput(), evidence: [] }), TypeError);
});

test('throws TypeError for each missing or wrongly typed input', () => {
  const input = reportInput();
  assert.throws(() => renderArbiterReport(), TypeError);
  for (const [field, invalid] of Object.entries({ run: 1, revision: 'invalid', task: [], evidence: {},
    result: null, receipts: 'invalid' })) {
    const incomplete = { ...input };
    delete incomplete[field];
    assert.throws(() => renderArbiterReport(incomplete), TypeError, `missing ${field}`);
    assert.throws(() => renderArbiterReport({ ...input, [field]: invalid }), TypeError, `invalid ${field}`);
  }
});
