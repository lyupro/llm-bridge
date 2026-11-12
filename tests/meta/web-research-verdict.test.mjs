/** OW-084 R1: web answers are grounded in the searches this resume chain actually completed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { answerRuleMessage } from '../../src/home/lib/answer-rules.mjs';
import { scoutExecutionGap } from '../../src/home/lib/meta/execution-fact.mjs';
import { allStartupContext } from '../../src/home/lib/meta/context-only.mjs';
import { webResearchBinding, webResearchGap } from '../../src/home/lib/meta/web-research.mjs';
import { COMPLETED_COMMAND, makeRun, makeChainRoot } from './test-fixtures.mjs';

const questions = [
  { id: 'Q1', text: 'What do the external sources say?', kind: 'web-research' },
  { id: 'Q2', text: 'What terms do the external sources publish?', kind: 'web-research' },
];
const prose = 'The published sources describe the supported behavior and its documented limitations. '
  + 'The answer compares the available statements, identifies the relevant conditions, and explains '
  + 'how those conditions affect the requested decision without claiming unsupported certainty.';
const resultOf = (evidence = ['https://example.com/docs']) => ({
  answer: prose,
  answers: questions.map((question) => ({ question_id: question.id, answer: prose, evidence })),
  findings: [], unknowns: [], report_markdown: '# External sources',
});
const thread = { type: 'thread.started', thread_id: 'web-thread' };
const webItem = (urls = ['https://example.com/search-result']) => ({
  type: 'item.completed', item: { type: 'web_search', results: urls.map((url) => ({ url })) },
});
const web = { chain: { completed: 1, with_urls: 1, hosts: ['example.com'] }, gap: null };
const reason = (key, values = {}) => answerRuleMessage('codex-scout', key, values);
const searchesReason = (gap = null) => reason('scout-web-searches', { questions: 'Q1, Q2', gap });
const referenceReason = (ids = 'Q1, Q2') => reason('scout-web-reference', { questions: ids });

function verdict(extra = {}) {
  const dir = makeRun({
    args: ['exec', '--json'], questions, result: resultOf(), events: [thread, webItem()], ...extra,
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual(saved.web_searches, meta.web_searches);
  return meta;
}

test('all-web order with matching returned hosts passes with no commands and persists host binding', () => {
  const meta = verdict();
  assert.equal(meta.status, 'OK', meta.reason);
  assert.equal(meta.commands_executed.chain, 0);
  assert.equal(meta.web_searches.binding, 'host');
});

test('real web-search fixture supports an end-to-end verdict with no commands', () => {
  const events = fs.readFileSync(new URL('./fixtures/web-search-events.jsonl', import.meta.url), 'utf8');
  const meta = verdict({ events, result: resultOf(['https://docs.alpaca.markets/us/docs/historical-news-data']) });
  assert.equal(meta.status, 'OK', meta.reason);
  assert.equal(meta.web_searches.chain.completed, 3);
  assert.equal(meta.web_searches.binding, 'host');
  assert.equal(meta.commands_executed.chain, 0);
});

test('host matching uses the hostname rather than path, port, capitalization or leading www.', () => {
  for (const url of ['https://WWW.EXAMPLE.COM/docs', 'http://EXAMPLE.COM:8080/docs']) {
    const meta = verdict({ result: resultOf([url]) });
    assert.equal(meta.status, 'OK', `${url}: ${meta.reason}`);
  }
});

test('a cited host not returned by searches fails and names only the offending question', () => {
  const result = resultOf();
  result.answers[1].evidence = ['https://elsewhere.example/docs'];
  const meta = verdict({ result });
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, referenceReason('Q2'));
});

test('a URL must be absolute HTTP(S), not FTP, relative, malformed, or a hostname substring', () => {
  for (const url of ['ftp://example.com/docs', '/docs', '//example.com/docs', 'https://',
    'https://example.com.evil.test/docs', 'https://example.com@evil.test/docs', 'see https://example.com/docs']) {
    const meta = verdict({ result: resultOf([url]) });
    assert.equal(meta.status, 'FAIL', url);
    assert.equal(meta.reason, referenceReason(), url);
  }
});

test('one matching URL suffices even if other evidence items do not match', () => {
  assert.equal(verdict({ result: resultOf(['not a URL', 'https://elsewhere.example', 'https://example.com']) }).status, 'OK');
});

test('zero completed searches fail before the URL reference check', () => {
  const meta = verdict({ events: [thread], result: resultOf(['https://elsewhere.example']) });
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, searchesReason());
  assert.equal(meta.web_searches.binding, null);
});

test('started web searches do not satisfy the completed search requirement', () => {
  const meta = verdict({ events: [thread, { ...webItem(), type: 'item.started' }] });
  assert.equal(meta.reason, searchesReason());
});

test('R1 CLI shape softening accepts any absolute HTTP(S) URL and persists unavailable binding', () => {
  const meta = verdict({ events: [thread, webItem([])], result: resultOf(['https://unreturned.example/docs']) });
  assert.equal(meta.status, 'OK', meta.reason);
  assert.equal(meta.web_searches.binding, 'unavailable');
  assert.equal(meta.web_searches.chain.completed, 1);
  assert.equal(meta.web_searches.chain.with_urls, 0);
});

test('R1 unavailable binding still requires a valid absolute HTTP(S) URL per web answer', () => {
  for (const evidence of [['plain evidence'], ['ftp://example.com/docs'], ['/relative'], []]) {
    assert.equal(webResearchGap({
      questions, result: resultOf(evidence),
      web: { chain: { completed: 1, with_urls: 0, hosts: [] }, gap: null },
    }), referenceReason());
  }
  const meta = verdict({ events: [thread, webItem([])], result: resultOf(['plain evidence']) });
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, referenceReason());
  assert.equal(meta.web_searches.binding, 'unavailable');
});

test('pruned predecessor without retained web evidence fails naming the web gap', () => {
  const root = makeChainRoot([
    { name: 'previous', meta: { session_id: 'web-thread', commands_executed: { run: 0 } } },
    { name: 'current', result: resultOf() },
  ]);
  const dir = path.join(root, 'current');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ resumed_from: 'previous' }));
  fs.writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(questions));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [thread, webItem()].map(JSON.stringify).join('\n') + '\n');
  const meta = collect(dir, 'codex-scout', 0).meta;
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.web_searches.gap, /previous.*no web evidence/);
  assert.equal(meta.reason, searchesReason(meta.web_searches.gap));
  assert.equal(meta.commands_executed.chain, 0);
  assert.equal(meta.commands_executed.gap, null);
  assert.equal(meta.web_searches.binding, null);
});

test('retained predecessor search hosts satisfy the resumed answer without current searches', () => {
  const root = makeChainRoot([
    { name: 'previous', meta: {
      session_id: 'web-thread', commands_executed: { run: 0 }, web_searches: { run: web.chain },
    } },
    { name: 'current', result: resultOf() },
  ]);
  const dir = path.join(root, 'current');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ resumed_from: 'previous' }));
  fs.writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(questions));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(thread) + '\n');
  const meta = collect(dir, 'codex-scout', 0).meta;
  assert.equal(meta.status, 'OK', meta.reason);
  assert.equal(meta.web_searches.run.completed, 0);
  assert.equal(meta.web_searches.binding, 'host');
});

test('mixed repository and web questions require commands, then accept their own evidence kinds', () => {
  const mixed = [{ ...questions[0], kind: 'code-required' }, questions[1]];
  const result = resultOf();
  result.answers[0].evidence = ['src/example.mjs:12'];
  const failed = verdict({ questions: mixed, result });
  assert.equal(failed.status, 'FAIL');
  assert.equal(failed.reason, reason('scout-commands-run'));
  assert.equal(verdict({ questions: mixed, result, events: [thread, COMPLETED_COMMAND, webItem()] }).status, 'OK');
});

test('startup and web questions pass without commands but retain independent reference checks', () => {
  const mixed = [{ ...questions[0], kind: 'startup-context' }, questions[1]];
  const result = resultOf();
  result.answers[0].evidence = ['startup:task'];
  assert.equal(verdict({ questions: mixed, result }).status, 'OK');
  result.answers[0].evidence = ['https://example.com/docs'];
  const meta = verdict({ questions: mixed, result, events: [thread] });
  assert.equal(meta.reason, reason('scout-startup-reference', { questions: 'Q1' }));
});

test('URL ports in both evidence and finding locations are not unread repository coordinates', () => {
  const result = resultOf(['https://example.com:8080/docs']);
  result.findings = [{ where: 'https://example.com:8080/docs', fact: 'External documentation.' }];
  assert.equal(verdict({ result }).status, 'OK');
  result.findings.push({ where: 'src/example.mjs:12', fact: 'Unread repository claim.' });
  const meta = verdict({ result });
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, reason('scout-unread-coordinate', { coordinate: 'src/example.mjs:12' }));
});

test('unknown, missing and empty question lists fail closed on commands', () => {
  for (const ordered of [undefined, [], [{ id: 'Q1' }], [{ id: 'Q1', kind: 'future-kind' }],
    [questions[0], { id: 'Q2', kind: 'future-kind' }]]) {
    assert.equal(scoutExecutionGap({ execution: { chain: 0, gap: null }, questions: ordered }),
      reason('scout-commands-run'));
    assert.equal(verdict({ questions: ordered }).reason, reason('scout-commands-run'));
  }
  assert.equal(allStartupContext(questions), false);
  assert.equal(allStartupContext([{ id: 'Q1', kind: 'startup-context' }]), true);
});

test('binding is null without web questions or known evidence; unknown evidence fails closed', () => {
  assert.equal(webResearchBinding([], web), null);
  assert.equal(webResearchBinding(questions, { chain: null, gap: 'unknown' }), null);
  // The marker postdates `--json`: no stream, no gap and no web fact prove no search, unlike
  // the archived-run exemption that the command count keeps.
  assert.equal(webResearchGap({ questions, result: resultOf(), web: { chain: null, gap: null } }), searchesReason());
  assert.equal(webResearchGap({ questions, result: resultOf(), web: undefined }), searchesReason());
  assert.equal(webResearchGap({ questions: [], result: resultOf(), web: { chain: null, gap: 'unknown' } }), null);
  assert.equal(verdict({ questions: questions.map((q) => ({ ...q, kind: 'code-required' })),
    events: [thread, COMPLETED_COMMAND, webItem()] }).web_searches.binding, null);
});

test('the web judge matches trimmed question ids without case and keeps the first answer', () => {
  const result = resultOf();
  result.answers[0].question_id = ' q1 ';
  assert.equal(webResearchGap({ questions, result, web }), null);
  result.answers.unshift({ question_id: 'Q1', answer: prose, evidence: ['https://wrong.example'] });
  assert.equal(webResearchGap({ questions, result, web }), referenceReason('Q1'));
});
