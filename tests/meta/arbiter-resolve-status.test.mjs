/** Guards where the OW-097 arbiter judge sits in the resolveStatus check order. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { answerRuleMessage } from '../../src/home/lib/answer-rules.mjs';
import { resolveStatus } from '../../src/home/lib/meta/verdict.mjs';
import { makeRun, CHAIN_REPO } from './test-fixtures.mjs';

const arbiterResult = {
  recommendation: { option_ids: ['a'], mix_rationale: '' },
  rejected: [],
  residual_gaps: [{ option_id: 'a' }],
  pre_mortem: [{ scenario: 'The rollout stalls.' }],
  prior_advice_review: [],
  checks: [],
  probes: [],
};

function arbiterRun(result) {
  const runDir = makeRun({
    args: ['exec', '--json'],
    stderr: '',
    events: [{ type: 'turn.completed' }],
    status: { repo: CHAIN_REPO, stdio_drained: true, stop: { receipts: { lines: 1 } } },
    result,
  });
  fs.writeFileSync(path.join(runDir, 'arbiter-input.json'), JSON.stringify({
    version: 1, task: { options: [{ id: 'a' }], paths: [] }, evidence: [],
  }), 'utf8');
  return { agent: 'codex-arbiter', runDir, result, resultOk: true, exit: 0 };
}

test('resolveStatus fails an arbiter with the judge reason', () => {
  const input = arbiterRun({ ...arbiterResult, pre_mortem: [] });
  const verdict = resolveStatus(input);
  const reason = answerRuleMessage('codex-arbiter', 'arbiter-pre-mortem-count');
  assert.deepEqual(verdict, { rule: null, status: 'FAIL', reason: `arbiter contract broken (1): ${reason}` });
});

// OW-097 D4 puts the judge after host failures, even when the frozen input is missing.
test('resolveStatus keeps a transport error ahead of the arbiter judge', () => {
  const message = 'arbiter transport disconnected';
  const runDir = makeRun({
    args: ['exec', '--json'],
    stderr: message,
    events: [{ type: 'error', message }],
  });
  const verdict = resolveStatus({ agent: 'codex-arbiter', runDir, result: {}, resultOk: true, exit: 1 });
  assert.equal(verdict.status, 'FAIL');
  assert.match(verdict.reason, /arbiter transport disconnected/);
});

test('resolveStatus keeps the deadline ahead of the arbiter judge', () => {
  const runDir = makeRun({
    args: ['exec', '--json'],
    stderr: '',
    events: [{ type: 'turn.completed' }],
    status: { stopped_on_deadline: true, elapsed_ms: 60012 },
  });
  const verdict = resolveStatus({ agent: 'codex-arbiter', runDir, result: {}, resultOk: true, exit: 0 });
  assert.equal(verdict.status, 'FAIL');
  assert.match(verdict.reason, /deadline after 60012 ms/);
});

test('resolveStatus keeps an empty result ahead of the arbiter judge', () => {
  const runDir = makeRun({
    args: ['exec', '--json'],
    log: '',
    stderr: '',
    events: [{ type: 'turn.completed' }],
  });
  const verdict = resolveStatus({ agent: 'codex-arbiter', runDir, result: null, resultOk: false, exit: 0 });
  assert.deepEqual(verdict, { rule: null, status: 'FAIL', reason: 'result is empty, exit=0' });
});

test('resolveStatus accepts an arbiter that passes the judge', () => {
  assert.deepEqual(resolveStatus(arbiterRun(arbiterResult)), { rule: null, status: 'OK', reason: null });
});
