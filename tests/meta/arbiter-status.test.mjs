/** Guards OW-097 D4 collection of frozen arbiter inputs and probe capture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { answerRuleMessage } from '../../src/home/lib/answer-rules.mjs';
import { arbitrationGap } from '../../src/home/lib/meta/arbiter-status.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const result = {
  recommendation: { option_ids: ['a'], mix_rationale: '' },
  rejected: [],
  residual_gaps: [{ option_id: 'a' }],
  pre_mortem: [{ scenario: 'The rollout stalls.' }],
  prior_advice_review: [],
  checks: [],
  probes: [],
};

function fixture(t, { input, status = {}, withInput = true } = {}) {
  const runDir = makeTempTree('arbiter-status-');
  t.after(() => removeTempTree(runDir));
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    repo: runDir, stdio_drained: true, stop: { receipts: { lines: 1 } }, ...status,
  }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), '{"type":"turn.completed"}\n', 'utf8');
  if (withInput) fs.writeFileSync(path.join(runDir, 'arbiter-input.json'), input ?? JSON.stringify({
    version: 1, task: { options: [{ id: 'a' }], paths: [] }, evidence: [],
  }), 'utf8');
  return runDir;
}

test('arbitrationGap accepts a passing result', (t) => {
  assert.equal(arbitrationGap(fixture(t), result), null);
});

test('arbitrationGap names a missing frozen input', (t) => {
  assert.match(arbitrationGap(fixture(t, { withInput: false }), result), /arbiter-input\.json is missing/);
});

test('arbitrationGap names malformed frozen inputs', (t) => {
  const inputs = [
    '{',
    JSON.stringify({ version: 2, task: { options: [], paths: [] }, evidence: [] }),
    JSON.stringify({ version: 1, task: [], evidence: [] }),
    JSON.stringify({ version: 1, task: { options: [], paths: null }, evidence: [] }),
    JSON.stringify({ version: 1, task: { options: [], paths: [] }, evidence: {} }),
  ];
  for (const input of inputs) {
    assert.match(arbitrationGap(fixture(t, { input }), result), /arbiter-input\.json is malformed/);
  }
});

test('arbitrationGap names a status without a repository', (t) => {
  assert.match(arbitrationGap(fixture(t, { status: { repo: undefined } }), result), /status\.json#repo/);
});

test('arbitrationGap rejects a non-object result', (t) => {
  const runDir = fixture(t);
  for (const value of [null, [], 'result']) {
    assert.match(arbitrationGap(runDir, value), /result\.json is missing or is not an object/);
  }
});

test('arbitrationGap returns the judge reasons', (t) => {
  const recommendation = { ...result.recommendation, option_ids: [] };
  const rejected = [{ option_id: 'a' }];
  const reason = answerRuleMessage('codex-arbiter', 'arbiter-recommendation-required');
  const preMortem = answerRuleMessage('codex-arbiter', 'arbiter-pre-mortem-count');
  assert.equal(arbitrationGap(fixture(t), { ...result, recommendation, rejected, pre_mortem: [] }),
    `arbiter contract broken (2): ${reason}; ${preMortem}`);
});

test('arbitrationGap turns a judge TypeError into a shape reason', (t) => {
  assert.match(arbitrationGap(fixture(t), {}),
    /result\.json is missing required fields or has an unexpected shape \(.+\)/);
});

test('arbitrationGap lets the judge require complete capture only for claimed probes', (t) => {
  const runDir = fixture(t, { status: { stdio_drained: false } });
  assert.equal(arbitrationGap(runDir, result), null);
  const probes = [{ probe_tag: 'ARBITER_PROBE_1' }];
  const reason = answerRuleMessage('codex-arbiter', 'arbiter-probe-capture-incomplete');
  assert.ok(arbitrationGap(runDir, { ...result, probes })?.includes(reason));
});
