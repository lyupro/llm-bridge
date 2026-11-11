import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { readEvents } from '../../src/home/lib/meta/events.mjs';
import { webEvidenceOf } from '../../src/home/lib/meta/web-evidence.mjs';

const completed = (item) => ({ type: 'item.completed', item: { type: 'web_search', ...item } });
const fixture = new URL('./fixtures/web-search-events.jsonl', import.meta.url);
const expected = {
  completed: 3, with_urls: 3,
  hosts: ['docs.alpaca.markets', 'gdeltproject.org', 'huggingface.co', 'tiingo.com'],
};

test('incident fixture proves three completed web items and exactly their returned hosts', () => {
  const events = fs.readFileSync(fixture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(webEvidenceOf(events), expected);
  const dir = makeTempTree('web-evidence-');
  fs.copyFileSync(fixture, path.join(dir, 'events.jsonl'));
  const data = readEvents(dir);
  assert.deepEqual(data.web_searches, expected);
  assert.equal(data.commands_executed, 0);
});

test('open_page action URL counts even without result URLs', () => {
  assert.deepEqual(webEvidenceOf([completed({
    action: { type: 'open_page', url: 'https://Opened.Example:8443/path' },
  })]), { completed: 1, with_urls: 1, hosts: ['opened.example'] });
});

test('started searches and other completed item types prove no web evidence', () => {
  assert.deepEqual(webEvidenceOf([
    { type: 'item.started', item: { type: 'web_search', action: { url: 'https://started.example' } } },
    { type: 'item.completed', item: { type: 'command_execution', results: [{ url: 'https://command.example' }] } },
  ]), { completed: 0, with_urls: 0, hosts: [] });
});

test('completed items without usable URLs still count as completed', () => {
  for (const item of [
    {}, { results: [] }, { results: [{ url: 'ftp://files.example/a' }] },
    { results: [{ url: 'https://[malformed' }] }, { action: { url: '/relative/path' } },
    { results: [null, {}, { url: 123 }], action: { url: 'mailto:person@example.org' } },
  ]) {
    assert.deepEqual(webEvidenceOf([completed(item)]), { completed: 1, with_urls: 0, hosts: [] });
  }
});

test('hostnames are normalized, deduplicated and sorted across result and action URLs', () => {
  assert.deepEqual(webEvidenceOf([
    completed({ action: { url: 'HTTPS://WWW.Z.Example/a' }, results: [
      { url: 'http://z.example:8080/b', domain: 'untrusted.example' },
      { url: 'https://WWW.A.Example/' }, { url: 'https://a.example/more' },
      { url: 'https://www.www.nested.example/' },
    ] }),
    completed({ results: [{ url: 'https://A.EXAMPLE/again' }, { url: 'not a URL' }] }),
  ]), { completed: 2, with_urls: 2, hosts: ['a.example', 'www.nested.example', 'z.example'] });
});

test('empty streams have zero evidence and a missing events argument fails loudly', () => {
  assert.deepEqual(webEvidenceOf([]), { completed: 0, with_urls: 0, hosts: [] });
  assert.throws(() => webEvidenceOf(), TypeError);
});
