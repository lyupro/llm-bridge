/** OW-084 R1: replay the incident's own searches through the real verdict, metadata and Action reply. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { makeRun } from './test-fixtures.mjs';

const events = fs.readFileSync(new URL('./fixtures/web-search-events.jsonl', import.meta.url), 'utf8');
const completed = events.trim().split('\n').map((line) => JSON.parse(line))
  .filter((event) => event.type === 'item.completed' && event.item?.type === 'web_search');
const urls = completed.flatMap((event) => event.item.results.map((result) => result.url));
const hosts = [...new Set(urls.map((url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '')))].sort();
const questions = [
  { id: 'Q1', text: 'What historical news access do the published sources describe?' },
  { id: 'Q2', text: 'What financial sentiment resources do the published sources describe?' },
];
const prose = 'The published sources describe historical news access and financial sentiment resources. '
  + 'Their documented capabilities establish what the order can rely on, while terms and limitations '
  + 'must be checked before using these resources. The cited sources support this external research '
  + 'without making claims about repository code that the scout has not read.';

function run(ordered, evidence = [urls[0], urls.at(-1)]) {
  const result = {
    answer: prose,
    answers: questions.map((question, index) => ({
      question_id: question.id, answer: prose, evidence: [evidence[index]],
    })),
    findings: [], unknowns: [], report_markdown: '# Incident research\n\n' + prose,
  };
  const dir = makeRun({
    args: ['exec', '--json'], events, questions: ordered, result,
    status: { state: 'finished', agent: 'codex-scout', order_id: 'ow084-incident' },
  });
  const collected = collect(dir, 'codex-scout', 0);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual(meta, collected.meta);
  assert.equal(meta.result_ok, true);
  assert.equal(meta.commands_executed.chain, 0);
  assert.equal(completed.length, 3, 'The incident fixture contains three completed searches.');
  assert.deepEqual(meta.web_searches.chain, {
    completed: completed.length,
    with_urls: completed.filter((event) => event.item.results.some((result) => result.url)).length,
    hosts,
  });
  return { meta, reply: collected.reply };
}

function assertAction(reply, variant) {
  assert.deepEqual(reply.split('\n').filter((row) => row.startsWith('Action:')),
    [orderDiagnosticMessage('next-action', { variant })]);
}

// Finished questions.json stores the orderer's extracted marker as kind, not as question text.
const marked = questions.map((question) => ({ ...question, kind: 'web-research' }));

test('incident searches pass with all web markers and citations to returned hosts', () => {
  const { meta, reply } = run(marked);
  assert.equal(meta.status, 'OK', meta.reason);
  assert.equal(meta.reason_rule, null);
  assert.equal(meta.web_searches.binding, 'host');
  assert.doesNotMatch(reply, /^Action:/m);
});

test('unmarked incident fails with marker guidance and no paid retry Action', () => {
  const { meta, reply } = run(questions);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason_rule, 'scout-commands-run');
  assert.match(meta.reason, /\[web-research\] marker/);
  assert.doesNotMatch(meta.reason, /stderr\.log/);
  assertAction(reply, 'fail-scout-web-unmarked');
  assert.doesNotMatch(reply, /retry:/);
});

test('incident web answer citing only an absent host fails with the generic result Action', () => {
  const absent = 'https://not-returned.invalid/docs';
  assert.ok(!hosts.includes(new URL(absent).hostname));
  const { meta, reply } = run(marked, [urls[0], absent]);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason_rule, 'scout-web-reference');
  assert.match(meta.reason, /Q2/);
  assert.doesNotMatch(meta.reason, /Q1/);
  assert.equal(meta.web_searches.binding, 'host');
  assertAction(reply, 'fail-result');
});

test('incident searches cannot replace commands for an unmarked code question in a mixed order', () => {
  const { meta, reply } = run([marked[0], {
    id: 'Q2', text: 'Where is the repository authentication check implemented?',
  }]);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason_rule, 'scout-commands-run');
  assert.doesNotMatch(meta.reason, /\[web-research\]/);
  assertAction(reply, 'fail-result');
});
