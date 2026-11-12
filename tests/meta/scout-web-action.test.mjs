/** OW-084 W5: the TradeForge incident needs an orderer marker, never a paid unchanged retry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, collect, renderReply } from '../../src/home/lib/write-meta.mjs';
import { resolveStatus } from '../../src/home/lib/meta/verdict.mjs';
import { failActionVariant, postRunActionVariant } from '../../src/home/lib/meta/reply.mjs';
import { scoutExecutionGap } from '../../src/home/lib/meta/execution-fact.mjs';
import { webResearchBinding } from '../../src/home/lib/meta/web-research.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { buildResult, COMPLETED_COMMAND, makeRun, makeChainRoot } from './test-fixtures.mjs';

const thread = { type: 'thread.started', thread_id: 'web-action' };
const search = {
  type: 'item.completed',
  item: { type: 'web_search', results: [{ url: 'https://example.com/docs' }] },
};
const questions = [
  { id: 'Q1', text: 'What behavior do the outside sources document?' },
  { id: 'Q2', text: 'What limitations do those sources publish?' },
];
const prose = 'The published sources explain the supported behavior and its documented limitations. '
  + 'These statements establish the relevant conditions and describe how they affect the requested '
  + 'decision, while clearly separating documented guarantees from details that remain unknown.';
const resultOf = () => ({
  answer: prose,
  answers: questions.map((q) => ({ question_id: q.id, answer: prose, evidence: ['https://example.com/docs'] })),
  findings: [], unknowns: [], report_markdown: '# External research\n\n' + prose,
});
const marked = (kind) => questions.map((q) => ({ ...q, kind }));
const oldReason = 'scout executed no command, so no answer rests on reading the code; '
  + 'check stderr.log for sandbox refusals before changing the order';

function run(extra = {}, exit = 0) {
  const dir = makeRun({
    args: ['exec', '--json'], questions, result: resultOf(), events: [thread, search, search], ...extra,
  });
  const collected = collect(dir, 'codex-scout', exit);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(saved.reason_rule, collected.meta.reason_rule);
  return { dir, ...collected };
}

function assertAction(reply, variant) {
  const rows = reply.split('\n');
  const expected = orderDiagnosticMessage('next-action', { variant });
  assert.deepEqual(rows.filter((row) => row.startsWith('Action:')), [expected]);
  assert.equal(rows[2], expected);
  return expected;
}

test('unmarked external questions, zero commands and completed URL searches keep FAIL with marker guidance', () => {
  const { dir, meta, reply } = run();
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.result_ok, true);
  assert.equal(meta.commands_executed.chain, 0);
  assert.equal(meta.web_searches.chain.completed, 2);
  assert.equal(meta.web_searches.chain.with_urls, 2);
  assert.equal(meta.reason_rule, 'scout-commands-run');
  assert.equal(meta.reason, "scout executed no command but completed 2 web searches; questions about outside sources need the orderer's [web-research] marker");
  assert.doesNotMatch(meta.reason, /stderr\.log/);
  assert.match(reply.split('\n')[0], /orderer's \[web-research\] marker/);
  const action = assertAction(reply, 'fail-scout-web-unmarked');
  assert.match(action, /report is filled and readable/);
  assert.match(action, /unchanged repeat fails the same way/);
  assert.match(action, /if the questions really are about outside sources/);
  assert.match(action, /orderer mark them \[web-research\].*new order id/);
  assert.doesNotMatch(action, /retry:|resume:|continue:/);
  const result = resultOf();
  assert.deepEqual(resolveStatus({ resultOk: true, exit: 0, agent: 'codex-scout', result, runDir: dir }),
    { status: 'FAIL', reason: meta.reason, rule: 'scout-commands-run' });
});

test('zero completed searches retain the exact sandbox reason and generic filled-result Action', () => {
  const { meta, reply } = run({ events: [thread, { ...search, type: 'item.started' }] });
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.web_searches.chain.completed, 0);
  assert.equal(meta.reason_rule, 'scout-commands-run');
  assert.equal(meta.reason, oldReason);
  assertAction(reply, 'fail-result');
});

test('mixed web and repository questions retain the no-command reason and retry Action for either binding', () => {
  const mixed = [{ ...questions[0], kind: 'web-research' }, {
    id: 'Q2', text: 'Where is the repository authentication check implemented?',
  }];
  for (const [binding, chain] of [
    ['host', { completed: 2, with_urls: 2, hosts: ['example.com'] }],
    ['unavailable', { completed: 2, with_urls: 0, hosts: [] }],
  ]) {
    const execution = { chain: 0, gap: null, web: { chain } };
    const gap = scoutExecutionGap({ execution, questions: mixed });
    assert.deepEqual(gap, { key: 'scout-commands-run', reason: oldReason });
    const meta = {
      status: 'FAIL', result_ok: true, reason_rule: gap.key, reason: gap.reason,
      web_searches: { chain, binding: webResearchBinding(mixed, execution.web) },
    };
    assert.equal(meta.web_searches.binding, binding);
    assert.equal(failActionVariant(meta), 'fail-result');
    assert.equal(postRunActionVariant(meta), 'fail-result');
    assert.match(orderDiagnosticMessage('next-action', { variant: failActionVariant(meta) }), /retry:/);
  }
});

test('the action uses the rule key even when diagnostic prose is replaced', () => {
  const { dir, meta } = run();
  const changed = { ...meta, reason: 'A completely different diagnostic.' };
  assert.equal(failActionVariant(changed), 'fail-scout-web-unmarked');
  assert.equal(postRunActionVariant(changed), 'fail-scout-web-unmarked');
  assertAction(renderReply(dir, 'codex-scout', changed), 'fail-scout-web-unmarked');
  for (const reason_rule of [null, undefined, 'scout-web-reference', 'scout-web-searches']) {
    assert.equal(failActionVariant({ ...meta, reason_rule }), 'fail-result');
  }
});

test('the incident variant requires a readable result and positive chain searches, never only run searches', () => {
  const { meta } = run();
  for (const chain of [undefined, null, { completed: 0 }]) {
    assert.equal(failActionVariant({ ...meta, web_searches: { run: { completed: 9 }, chain } }), 'fail-result');
  }
  assert.equal(failActionVariant({ ...meta, web_searches: undefined }), 'fail-result');
  assert.equal(failActionVariant({ ...meta, result_ok: false }), 'fail-no-result');
  assert.equal(failActionVariant({ ...meta, result_ok: false, situation: { kind: 'output-limit' } }), 'fail-output-limit');
});

for (const [key, extra] of [
  ['scout-answer-every-question', { result: { ...resultOf(), answers: [] } }],
  ['scout-answer-substance', { result: { ...resultOf(), answers: resultOf().answers.map((a) => ({ ...a, answer: 'Short.' })) } }],
  ['scout-answer-evidence', { result: { ...resultOf(), answers: resultOf().answers.map((a) => ({ ...a, evidence: [] })) } }],
  ['scout-single-answer-substance', { questions: [], result: { ...resultOf(), answer: 'Short.' } }],
  ['scout-startup-reference', { questions: marked('startup-context') }],
  ['scout-unread-coordinate', {
    questions: marked('web-research'), events: [thread, search],
    result: { ...resultOf(), findings: [{ where: 'src/example.mjs:12', fact: 'Unread code.' }] },
  }],
  ['scout-web-searches', { questions: marked('web-research'), events: [thread] }],
  ['scout-web-reference', {
    questions: marked('web-research'), events: [thread, search],
    result: { ...resultOf(), answers: resultOf().answers.map((a) => ({ ...a, evidence: ['https://elsewhere.example/docs'] })) },
  }],
]) {
  test(`${key} preserves its key and the existing fail-result Action`, () => {
    const { dir, meta, reply } = run({ events: [thread, COMPLETED_COMMAND, search], ...extra });
    assert.equal(meta.status, 'FAIL');
    assert.equal(meta.reason_rule, key);
    assertAction(reply, 'fail-result');
    const verdict = resolveStatus({
      resultOk: true, exit: 0, agent: 'codex-scout', runDir: dir, result: extra.result ?? resultOf(),
    });
    assert.equal(verdict.rule, key);
    assert.equal(verdict.reason, meta.reason);
  });
}

test('a correctly marked web-only run and a command-backed unmarked run remain OK with a null key', () => {
  for (const extra of [{ questions: marked('web-research') }, { events: [thread, COMPLETED_COMMAND, search] }]) {
    const { meta, reply } = run(extra);
    assert.equal(meta.status, 'OK', meta.reason);
    assert.equal(meta.reason_rule, null);
    assert.equal(meta.reason, null);
    assert.doesNotMatch(reply, /^Action:/m);
  }
});

test('non-rule scout outcomes always have a null key', () => {
  for (const [extra, exit, status] of [
    [{ result: null }, 0, 'FAIL'],
    [{}, 1, 'FAIL'],
    [{ events: [] }, 0, 'FAIL'],
    [{ status: { stopped_on_deadline: true } }, 0, 'FAIL'],
    [{ result: null, events: [{ type: 'error', message: 'quota exhausted' }] }, 1, 'LIMIT'],
  ]) {
    const { meta } = run(extra, exit);
    assert.equal(meta.status, status);
    assert.equal(meta.reason_rule, null);
  }
});

test('non-scout failures always carry a null rule key', () => {
  for (const agent of ['codex-build', 'codex-review', 'codex-advisor']) {
    const dir = makeRun({
      args: ['exec', '--json'], events: [thread, search], file: AGENTS[agent].result,
      result: agent === 'codex-build' ? buildResult([], { verify_passed: false }) : undefined,
    });
    const { meta, reply } = collect(dir, agent, 0);
    assert.equal(meta.status, 'FAIL');
    assert.equal(meta.reason_rule, null);
    assertAction(reply, agent === 'codex-build' ? 'fail-result' : 'fail-no-result');
    assert.equal(resolveStatus({ resultOk: false, exit: 0, agent, runDir: dir, result: null }).rule, null);
  }
});

test('resume-chain provenance gaps carry no answer-rule key or marker Action', () => {
  const { dir, meta, reply } = run({ status: { resumed_from: 'missing-predecessor' } });
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /^resume chain: missing-predecessor/);
  assert.equal(meta.reason_rule, null);
  assert.equal(meta.web_searches.chain, null);
  assertAction(reply, 'fail-result');
  assert.equal(resolveStatus({ resultOk: true, exit: 0, agent: 'codex-scout', runDir: dir, result: resultOf() }).rule, null);
});

test('retained predecessor searches select the incident message and Action without current searches', () => {
  const root = makeChainRoot([
    { name: 'previous', meta: {
      session_id: 'web-action', commands_executed: { run: 0 },
      web_searches: { run: { completed: 3, with_urls: 3, hosts: ['example.com'] } },
    } },
    { name: 'current', result: resultOf() },
  ]);
  const dir = path.join(root, 'current');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ resumed_from: 'previous' }));
  fs.writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(questions));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(thread) + '\n');
  const { meta, reply } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.web_searches.run.completed, 0);
  assert.equal(meta.web_searches.chain.completed, 3);
  assert.equal(meta.reason_rule, 'scout-commands-run');
  assert.match(meta.reason, /completed 3 web searches/);
  assertAction(reply, 'fail-scout-web-unmarked');
});

test('unknown chain searches keep the sandbox reason even when this run searched', () => {
  const dir = makeRun();
  const execution = { chain: 0, gap: null, web: { chain: null, run: { completed: 2 } } };
  const verdict = resolveStatus({
    resultOk: true, exit: 0, agent: 'codex-scout', runDir: dir, result: resultOf(), execution,
  });
  assert.deepEqual(verdict, { status: 'FAIL', reason: oldReason, rule: 'scout-commands-run' });
});
