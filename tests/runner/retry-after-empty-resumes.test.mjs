/** OW-066 B3: exhausted empty resumes retry against the original advise scope. */
import { test } from 'node:test';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTempTree } from '../temp-tree.mjs';
import { validScope } from '../meta/advisor-fixtures.mjs';
import { passGate } from '../../src/home/lib/runner/pass-gate.mjs';
import { orderRuleMessage } from '../../src/home/lib/order-rules.mjs';

const S = '2026-10-03_180000_scope';
const A = '2026-10-03_180100_advise';
const R1 = '2026-10-03_180200_resume';
const R2 = '2026-10-03_180300_resume';
const START = '2026-10-03T18:00:00.000Z';
const STOP = '2026-10-03T18:01:00.000Z';
const REASON = 'finish the stopped pass';
const TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- source.mjs\n';

function fixture(agent, phase) {
  const root = makeTempTree('retry-after-empty-resumes-');
  const repoRoot = path.join(root, 'repo');
  const projectRunsRoot = path.join(root, 'runs');
  const codexHome = path.join(root, 'codex-home');
  for (const dir of [repoRoot, projectRunsRoot, codexHome]) fs.mkdirSync(dir);
  const thread = randomUUID();
  const day = new Date(START);
  const folder = path.join(codexHome, 'sessions', String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `rollout-2026-10-03T18-00-00-${thread}.jsonl`),
    `${JSON.stringify({ timestamp: STOP, ordinal: 1, type: 'session_meta', payload: { id: thread } })}\n`);
  return { repoRoot, projectRunsRoot, codexHome, thread,
    opts: { agent, phase, orderId: 'resume-chain', slug: 'resume-chain', continue: true } };
}

function run(tree, name, outcome, extra = {}) {
  const dir = path.join(tree.projectRunsRoot, name);
  fs.mkdirSync(dir);
  const status = {
    agent: tree.opts.agent, phase: tree.opts.phase, repo: tree.repoRoot,
    slug: tree.opts.slug, order_id: tree.opts.orderId, state: 'finished',
    started_at: START, task_hash: 'frozen-task-hash', ...extra,
  };
  const files = {
    'status.json': JSON.stringify(status),
    'meta.json': JSON.stringify({
      agent: status.agent, phase: status.phase, status: outcome, result_ok: outcome === 'OK', session_id: tree.thread,
      pass_output: { state: status.resumed_from ? 'absent' : 'present' },
      stop: { trigger: 'deadline', tree_stop: { state: 'stopped' },
        session: { state: 'observed', last_record_at: STOP } },
    }),
    'worker.json': JSON.stringify({ profile: { model: 'fixture-model', effort: 'high' } }),
    'events.jsonl': `${JSON.stringify({ type: 'thread.started', thread_id: tree.thread })}\n`,
    'task-original.md': TASK,
    'schema.json': '{"type":"object"}\n',
    ...(status.phase === 'scope' ? { 'result.json': JSON.stringify(validScope()) } : {}),
    ...(status.agent === 'codex-advisor' && status.phase === 'advise'
      ? { 'advisor-task.json': '{"frozen":true}\n' } : {}),
    ...(status.agent === 'codex-scout' ? { 'questions.json': '[{"id":"Q1","text":"Inspect the boundary"}]\n' } : {}),
  };
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  return dir;
}

async function gate(tree, kind, name) {
  // E13 requires real session evidence, isolated from the operator's Codex home.
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tree.codexHome;
  try {
    return await passGate({ ...tree, taskText: TASK,
      header: { grant: { kind, run: name, reason: REASON } } });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
}

test('two empty advise resumes refuse resume but allow retry under the same order and original scope', async () => {
  const tree = fixture('codex-advisor', 'advise');
  run(tree, S, 'OK', { phase: 'scope' });
  run(tree, A, 'FAIL', { continued_from: S });
  for (const [named, destination] of [[A, R1], [R1, R2]]) {
    const resumed = await gate(tree, 'resume', named);
    assert.equal(resumed.resumedFrom, named);
    assert.equal(resumed.resumeInputs.thread_id, tree.thread);
    assert.deepEqual(resumed.continuationGrant, { run: S, reason: REASON });
    // Match resume-chain's launcher provenance without starting a real Codex process.
    run(tree, destination, 'FAIL', {
      resumed_from: resumed.resumedFrom, continued_from: resumed.continuationGrant.run,
    });
  }
  await assert.rejects(gate(tree, 'resume', R2), (error) => {
    assert.equal(error.exitCode, 2);
    assert.ok(error.message.startsWith(orderRuleMessage('resume-grant-usable', {
      violation: 'not-eligible', run: R2, blockers: ['empty-resumes-exhausted'],
    })), error.message);
    const action = orderDiagnosticMessage('next-action', { variant: 'grant-decision' });
    assert.deepEqual(error.message.split(/\r?\n/).filter((row) => row.startsWith('Action: ')), [action]);
    assert.equal(error.message.split(/\r?\n/).at(-1), action);
    return true;
  });
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A, R1, R2]);
  const retried = await gate(tree, 'retry', R2);
  assert.equal(retried.retryOf, R2);
  assert.equal(retried.resumedFrom, null);
  assert.equal(retried.resumeInputs, null);
  assert.deepEqual(retried.startedChain, [S, A, R1, R2]);
  assert.deepEqual(retried.continuationGrant, { run: S, reason: REASON });
  assert.equal(retried.advisorTask.scope.run, S);
  assert.deepEqual(retried.advisorTask.scope.predicted_risks, validScope().predicted_risks);
  // Model the launch fields as in resume-chain.test.mjs, then check the recorded scope link.
  const retryDir = run(tree, '2026-10-03_180400_retry', 'FAIL', {
    retry_of: retried.retryOf, continued_from: retried.continuationGrant.run,
  });
  const status = JSON.parse(fs.readFileSync(path.join(retryDir, 'status.json'), 'utf8'));
  assert.equal(status.order_id, tree.opts.orderId);
  assert.equal(status.continued_from, S);
  assert.equal(status.retry_of, R2);
  assert.equal(Object.hasOwn(status, 'resumed_from'), false);
});
