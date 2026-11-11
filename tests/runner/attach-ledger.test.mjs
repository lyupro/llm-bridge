/** OW-083 R1: attaching cannot reuse advice checked against a different ledger. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { orderRuleMessage } from '../../src/home/lib/order-rules.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { attaching, deadPid, fixture, order, run, running } from './attach-fixtures.mjs';

const RUN = '2026-11-11_090000_advice';
const REPLY = 'OK — recommend option-a: use the existing design\nRun: archived\n';

function advisor(t, { task = {}, agent = 'codex-advisor', phase = 'advise', reply = REPLY,
  result = '{}', live = false } = {}) {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const files = {
    'advisor-task.json': JSON.stringify(task),
    'meta.json': JSON.stringify({ status: 'OK' }),
    'result.json': result,
    ...(reply === null ? {} : { 'reply.txt': reply }),
  };
  const dir = run(runsRoot, RUN, running(repo, {
    agent, phase, state: live ? 'running' : 'finished', pid: live ? process.pid : deadPid(),
  }), files);
  return { runsRoot, repo, dir };
}

function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).filter((name) =>
    fs.statSync(path.join(root, name)).isFile()).map((name) =>
    [name, fs.readFileSync(path.join(root, name), 'utf8')]);
}

test('the same normalized ledger attaches to the saved advisor answer', async (t) => {
  const decisions = path.resolve('docs', 'decisions.md');
  const { runsRoot, repo } = advisor(t, { task: { decisions } });
  const { code, lines } = await attaching(order(runsRoot, repo, {
    decisions: decisions.replaceAll('\\', '/'),
  }));
  assert.equal(code, 0);
  assert.match(lines[0], /^ATTACH=/);
  assert.match(lines[2], /^OK — recommend option-a: Already decided:/);
});

for (const [name, frozen, incoming] of [
  ['added', null, 'docs/decisions.md'],
  ['removed', 'docs/decisions.md', null],
  ['changed', 'docs/decisions.md', 'docs/other-decisions.md'],
]) {
  for (const live of [false, true]) {
    test(`a ledger ${name} refuses before ${live ? 'waiting' : 'printing the saved answer'} and changes nothing`, async (t) => {
      const { runsRoot, repo, dir } = advisor(t, {
        task: { decisions: frozen }, live, reply: live ? null : REPLY,
      });
      const before = snapshot(runsRoot);
      let waited = false;
      const { code, lines } = await attaching(order(runsRoot, repo, {
        decisions: incoming, beforeWait: () => { waited = true; },
      }));
      assert.equal(code, 2);
      assert.equal(waited, false);
      assert.deepEqual(lines, [orderRuleMessage('order-id-owner', {
        violation: 'ledger-changed', orderId: 'order-1', ownerDir: dir,
        runDecisions: frozen === null ? null : normalizeRepoPath(frozen),
        orderDecisions: incoming === null ? null : normalizeRepoPath(incoming),
      }) + '\n' + orderDiagnosticMessage('next-action', { variant: 'usage' })]);
      assert.deepEqual(snapshot(runsRoot), before);
      assert.deepEqual(fs.readdirSync(runsRoot), [RUN]);
    });
  }
}

test('a mismatched ledger refuses before the no-wait pending announcement', async (t) => {
  const { runsRoot, repo } = advisor(t, { live: true, reply: null });
  const { code, lines } = await attaching(order(runsRoot, repo, {
    decisions: 'docs/decisions.md', noWait: true,
  }));
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /ATTACH=|still in progress/);
});

test('the same ledger still permits waiting for the advisor reply', async (t) => {
  const decisions = 'docs/decisions.md';
  const { runsRoot, repo, dir } = advisor(t, { task: { decisions }, live: true, reply: null });
  let waited = false;
  const { code, lines } = await attaching(order(runsRoot, repo, {
    decisions,
    beforeWait: () => {
      waited = true;
      fs.writeFileSync(path.join(dir, 'reply.txt'), REPLY);
    },
  }));
  assert.equal(code, 0);
  assert.equal(waited, true);
  assert.equal(lines[2], REPLY.trimEnd());
});

test('an archived advisor task with no decisions key attaches without a ledger label', async (t) => {
  const { runsRoot, repo } = advisor(t);
  const { code } = await attaching(order(runsRoot, repo));
  assert.equal(code, 0);
});

for (const artifact of ['missing', 'invalid-json']) {
  test(`an archived advisor with ${artifact} task treats its ledger as null`, async (t) => {
    const { runsRoot, repo, dir } = advisor(t);
    if (artifact === 'missing') {
      fs.renameSync(path.join(dir, 'advisor-task.json'), path.join(dir, 'archived-task.json'));
    } else {
      fs.writeFileSync(path.join(dir, 'advisor-task.json'), '{');
    }
    assert.equal((await attaching(order(runsRoot, repo))).code, 0);
    const { code, lines } = await attaching(order(runsRoot, repo, { decisions: 'docs/decisions.md' }));
    assert.equal(code, 2);
    assert.match(lines[0], /ledger null/);
  });
}

for (const agent of ['codex-scout', 'codex-build']) {
  test(`${agent} attach ignores the order's decisions value and preserves its reply`, async (t) => {
    const { runsRoot, repo } = advisor(t, { agent });
    const { code, lines } = await attaching(order(runsRoot, repo, { decisions: 'docs/decisions.md' }));
    assert.equal(code, 0);
    assert.equal(lines[2], REPLY.trimEnd());
  });
}

test('a pre-B5 advise reply shows its legacy ledger state without rewriting the file', async (t) => {
  const { runsRoot, repo, dir } = advisor(t);
  const before = fs.readFileSync(path.join(dir, 'reply.txt'));
  const { code, lines } = await attaching(order(runsRoot, repo));
  assert.equal(code, 0);
  assert.equal(lines[2], 'OK — recommend option-a: Already decided: legacy result; field absent · '
    + 'use the existing design\nRun: archived');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'reply.txt')), before);
});

test('a saved advise reply uses the recorded already-decided result', async (t) => {
  const { runsRoot, repo } = advisor(t, {
    result: JSON.stringify({ already_decided: { status: 'found', address: 'R1' } }),
  });
  const { lines } = await attaching(order(runsRoot, repo));
  assert.equal(lines[2], 'OK — recommend option-a: Already decided: found R1 · '
    + 'use the existing design\nRun: archived');
});

for (const [name, options] of [
  ['current reply', { reply: 'OK — recommend option-a: Already decided: not-checked (no ledger supplied) · keep it\nRun: x\n' }],
  ['scope phase', { phase: 'scope' }],
  ['scope reply', { reply: 'OK — scope: ready\nRun: x\n' }],
  ['non-recommendation first row', { reply: 'OK — done\nOK — recommend option-a: keep it\n' }],
  ['missing recommendation id', { reply: 'OK — recommend : keep it\n' }],
  ['failed reply', { reply: 'FAIL — recommend option-a: no answer\n' }],
  ['invalid result', { result: '{' }],
  ['null result', { result: 'null' }],
]) {
  test(`a saved ${name} is printed unchanged`, async (t) => {
    const { runsRoot, repo, dir } = advisor(t, options);
    const before = snapshot(runsRoot);
    const { code, lines } = await attaching(order(runsRoot, repo));
    assert.equal(code, 0);
    assert.equal(lines[2], (options.reply ?? REPLY).trimEnd());
    assert.deepEqual(snapshot(runsRoot), before);
    assert.equal(fs.readFileSync(path.join(dir, 'reply.txt'), 'utf8'), options.reply ?? REPLY);
  });
}

test('repeating a resume without a decisions label attaches to the run that kept the frozen ledger', async (t) => {
  // B6a: a resume order without the label replays the frozen ledger, so its repeat must not read as a change.
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  run(runsRoot, RUN, running(repo, {
    agent: 'codex-advisor', phase: 'advise', state: 'finished', pid: deadPid(), resumed_from: 'B',
  }), {
    'advisor-task.json': JSON.stringify({ decisions: 'docs/decisions.md' }),
    'meta.json': JSON.stringify({ status: 'OK' }),
    'result.json': '{}',
    'reply.txt': REPLY,
  });
  const { code, lines } = await attaching(order(runsRoot, repo, { isContinue: true, resumeRun: 'B', decisions: null }));
  assert.equal(code, 0);
  assert.match(lines[0], /^ATTACH=/);
});

test('a saved advise reply with no result artifact is printed unchanged', async (t) => {
  const { runsRoot, repo, dir } = advisor(t);
  fs.renameSync(path.join(dir, 'result.json'), path.join(dir, 'archived-result.json'));
  const { code, lines } = await attaching(order(runsRoot, repo));
  assert.equal(code, 0);
  assert.equal(lines[2], REPLY.trimEnd());
  assert.equal(fs.readFileSync(path.join(dir, 'reply.txt'), 'utf8'), REPLY);
});
