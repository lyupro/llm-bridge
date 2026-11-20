/** Guards OW-097 D4 through the real worker and collection with successful and blocked report publication. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { workerOrder } from '../../src/home/lib/runner/worker-order.mjs';
import { withFakeCodex } from './fake-codex.mjs';

const workerUrl = new URL('../../src/home/lib/runner/worker.mjs', import.meta.url).href;
const contextUrl = new URL('./run-context.mjs', workerUrl).href;
const result = {
  recommendation: { option_ids: ['a'], text: 'Use A.', mix_rationale: '' },
  rejected: [],
  residual_gaps: [{ option_id: 'a', gap: 'Documentation' }],
  strongest_counterargument: 'The rollout takes time.',
  pre_mortem: [{ scenario: 'The rollout stalls.', early_check: 'Read logs.' }],
  prior_advice_review: [],
  checks: [],
  probes: [],
};

const fakeCodex = `
import fs from 'node:fs';
for await (const chunk of process.stdin) {}
const outputPath = process.argv[process.argv.indexOf('--output-last-message') + 1];
fs.writeFileSync(outputPath, ${JSON.stringify(JSON.stringify(result))}, 'utf8');
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`;

async function runArbiter({ blockReport }, check) {
  await withFakeCodex(fakeCodex, (root) => {
    const agent = 'codex-arbiter';
    const repo = path.join(root, 'repo');
    const runDir = path.join(root, 'runs', 'arbiter-run');
    fs.mkdirSync(repo);
    fs.mkdirSync(runDir, { recursive: true });
    const report = path.join(runDir, 'report.md');
    if (blockReport) fs.mkdirSync(report);

    const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value), 'utf8');
    const order = workerOrder({
      agent, repo, isGitRepo: false, launcherPid: process.pid,
      slug: 'arbiter-run', orderId: 'arbiter-run', phase: 'default', budgetMinutes: 0.5,
      args: ['exec', '--json', '--output-last-message', path.join(runDir, 'result.json'), '-'],
    });
    write('worker.json', order);
    write('status.json', {
      agent, repo, state: 'running', order_id: order.order_id, phase: order.phase, source_revision: null,
    });
    write('arbiter-input.json', {
      version: 1,
      task: {
        trigger: 'irreversible', question: 'Which option?', paths: [],
        options: [{ id: 'a', description: 'Use A' }],
        position: { option: 'a', rationale: 'Preserve the current behavior.' },
      },
      evidence: [],
    });
    fs.writeFileSync(path.join(runDir, 'task.md'), 'Choose an option.', 'utf8');

    const child = spawnSync(process.execPath, [
      '--input-type=module', '--eval',
      `import { worker } from ${JSON.stringify(workerUrl)};
import { setWorkerDir } from ${JSON.stringify(contextUrl)};
setWorkerDir(process.argv[1]);
await worker(process.argv[1]);`, runDir,
    ], { encoding: 'utf8', timeout: 35_000 });
    assert.ifError(child.error);
    const metaPath = path.join(runDir, 'meta.json');
    assert.ok(fs.existsSync(metaPath), `Worker exited ${child.status} without meta.json\n${child.stderr}`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.exit, 0, meta.reason);
    assert.equal(meta.result_ok, true, meta.reason);
    const replyPath = path.join(runDir, 'reply.txt');
    assert.ok(fs.existsSync(replyPath), `Worker exited ${child.status} without reply.txt\n${child.stderr}\n${child.stdout}`);
    check({ meta, report, reply: fs.readFileSync(replyPath, 'utf8') });
  });
}

test('the arbiter worker publishes a report and attests to its bytes in OK meta', async () => {
  await runArbiter({ blockReport: false }, ({ meta, report, reply }) => {
    assert.equal(meta.status, 'OK', meta.reason);
    assert.match(meta.report_sha256, /^[a-f0-9]{64}$/);
    assert.equal(meta.report_sha256, createHash('sha256').update(fs.readFileSync(report)).digest('hex'));
    assert.match(reply, /^OK — recommend/);
    assert.match(reply, /\breport\.md\b/);
  });
});

test('the arbiter worker publishes FAIL when the report cannot be written', async () => {
  await runArbiter({ blockReport: true }, ({ meta, reply }) => {
    assert.equal(meta.status, 'FAIL', meta.reason);
    assert.match(meta.reason, /^arbiter report write failed:/);
    assert.equal(Object.hasOwn(meta, 'report_sha256'), false);
    assert.doesNotMatch(reply, /^OK/);
  });
});
