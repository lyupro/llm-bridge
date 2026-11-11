import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { readEvents } from '../../src/home/lib/meta/events.mjs';
import { readExecutionFact } from '../../src/home/lib/meta/execution-fact.mjs';

const empty = { completed: 0, with_urls: 0, hosts: [] };
const evidence = { completed: 2, with_urls: 1, hosts: ['previous.example'] };
const webItem = (urls = []) => ({
  type: 'item.completed', item: { type: 'web_search', results: urls.map((url) => ({ url })) },
});

function makeRun(root, name, { from, stream = true, web = [], meta, count = 1, thread = 'thread' } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ resumed_from: from }));
  if (stream) {
    const events = [
      { type: 'thread.started', thread_id: thread },
      ...Array.from({ length: count }, () => ({ type: 'item.completed', item: { type: 'command_execution' } })),
      ...web,
    ];
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }
  if (meta) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

const factOf = (dir) => readExecutionFact(dir, readEvents(dir));
const rootOf = () => makeTempTree('execution-fact-web-');
const retained = (web_searches) => ({ session_id: 'thread', commands_executed: { run: 4, chain: 999 }, web_searches });

test('ordinary and archived runs distinguish zero web evidence from an absent stream', () => {
  assert.deepEqual(factOf(makeRun(rootOf(), 'current')).web, { run: empty, chain: empty, gap: null });
  assert.deepEqual(factOf(makeRun(rootOf(), 'archived', { stream: false })).web,
    { run: null, chain: null, gap: null });
});

test('two-run chain sums completed and URL-bearing items and unions sorted hosts', () => {
  const root = rootOf();
  makeRun(root, 'previous', { web: [webItem(['https://WWW.Shared.Example', 'https://z.example']), webItem()] });
  const dir = makeRun(root, 'current', { from: 'previous', web: [webItem(['http://shared.example', 'https://a.example'])] });
  const fact = factOf(dir);
  assert.deepEqual(fact.web, {
    run: { completed: 1, with_urls: 1, hosts: ['a.example', 'shared.example'] },
    chain: { completed: 3, with_urls: 2, hosts: ['a.example', 'shared.example', 'z.example'] },
    gap: null,
  });
  assert.equal(fact.chain, 2);
  assert.equal(fact.gap, null);
});

test('current run uses supplied web evidence without rereading the stream', () => {
  const dir = makeRun(rootOf(), 'current', { web: [webItem(['https://current.example'])] });
  const data = readEvents(dir);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  assert.deepEqual(readExecutionFact(dir, data).web.run,
    { completed: 1, with_urls: 1, hosts: ['current.example'] });
});

test('a predecessor stream takes precedence over recorded per-run and chain evidence', () => {
  const root = rootOf();
  makeRun(root, 'previous', {
    web: [webItem(['https://stream.example'])],
    meta: retained({ run: evidence, chain: { completed: 999, with_urls: 999, hosts: ['stale.example'] } }),
  });
  const fact = factOf(makeRun(root, 'current', { from: 'previous' }));
  assert.deepEqual(fact.web.chain, { completed: 1, with_urls: 1, hosts: ['stream.example'] });
});

test('pruned predecessor uses only its recorded per-run evidence across a longer chain', () => {
  const root = rootOf();
  makeRun(root, 'oldest', { web: [webItem(['https://oldest.example'])] });
  makeRun(root, 'previous', {
    stream: false, from: 'oldest',
    meta: retained({ run: evidence, chain: { completed: 999, with_urls: 999, hosts: ['stale.example'] } }),
  });
  const fact = factOf(makeRun(root, 'current', { from: 'previous', web: [webItem()] }));
  assert.deepEqual(fact.web, {
    run: { completed: 1, with_urls: 0, hosts: [] },
    chain: { completed: 4, with_urls: 2, hosts: ['oldest.example', 'previous.example'] }, gap: null,
  });
  assert.deepEqual(fact.chain_runs, ['previous', 'oldest']);
  assert.equal(fact.chain, 6);
});

test('pruned predecessor without a per-run web value creates only a web gap', () => {
  for (const web of [undefined, { chain: evidence }, { run: null }]) {
    const root = rootOf();
    makeRun(root, 'previous', { stream: false, meta: retained(web) });
    const fact = factOf(makeRun(root, 'current', { from: 'previous' }));
    assert.deepEqual(fact.web, {
      run: empty, chain: null,
      gap: 'resume chain: previous — no web evidence (stream pruned, no recorded per-run value)',
    });
    assert.equal(fact.chain, 5);
    assert.equal(fact.gap, null);
  }
});

test('recorded zero web evidence remains valid after pruning', () => {
  const root = rootOf();
  makeRun(root, 'previous', { stream: false, meta: retained({ run: empty }) });
  const fact = factOf(makeRun(root, 'current', { from: 'previous' }));
  assert.deepEqual(fact.web, { run: empty, chain: empty, gap: null });
});

test('malformed retained web values cannot silently become zero', () => {
  for (const run of [
    {}, { ...evidence, completed: -1 }, { ...evidence, completed: '2' },
    { ...evidence, with_urls: 3 }, { ...evidence, with_urls: 0 },
    { ...evidence, hosts: null }, { ...evidence, hosts: [42] },
  ]) {
    const root = rootOf();
    makeRun(root, 'previous', { stream: false, meta: retained({ run }) });
    const fact = factOf(makeRun(root, 'current', { from: 'previous' }));
    assert.equal(fact.web.chain, null);
    assert.match(fact.web.gap, /no web evidence/);
    assert.equal(fact.chain, 5);
    assert.equal(fact.gap, null);
  }
});

test('a web gap never exposes a partial total or interrupts the command chain walk', () => {
  const root = rootOf();
  makeRun(root, 'oldest', { web: [webItem(['https://oldest.example'])] });
  makeRun(root, 'previous', { from: 'oldest', stream: false, meta: retained(undefined) });
  const fact = factOf(makeRun(root, 'current', { from: 'previous', web: [webItem(['https://current.example'])] }));
  assert.equal(fact.web.chain, null);
  assert.match(fact.web.gap, /previous/);
  assert.deepEqual(fact.chain_runs, ['previous', 'oldest']);
  assert.equal(fact.chain, 6);
  assert.equal(fact.gap, null);
});

test('path, thread and command provenance failures cannot expose a web chain total', () => {
  for (const setup of ['missing', 'different-thread', 'missing-commands', 'cycle']) {
    const root = rootOf();
    if (setup !== 'missing') makeRun(root, 'previous', {
      thread: setup === 'different-thread' ? 'other-thread' : 'thread',
      from: setup === 'cycle' ? 'current' : undefined,
      stream: setup !== 'missing-commands',
      meta: setup === 'missing-commands' ? { session_id: 'thread', web_searches: { run: evidence } } : undefined,
      web: [webItem(['https://previous.example'])],
    });
    const fact = factOf(makeRun(root, 'current', { from: 'previous', web: [webItem(['https://current.example'])] }));
    assert.equal(fact.web.chain, null);
    assert.equal(fact.web.gap, fact.gap);
    assert.equal(fact.chain, null);
    assert.ok(fact.gap);
  }
});
