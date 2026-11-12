import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect, readJson, renderReply } from '../src/home/lib/write-meta.mjs';
import { readEvents, readEventsWithPassOutput } from '../src/home/lib/meta/events.mjs';
import { COMPLETED_COMMAND, makeRun } from './meta/test-fixtures.mjs';
import { makeTempTree } from './temp-tree.mjs';

const turn = { type: 'turn.started' };
const message = { type: 'item.completed', item: { type: 'agent_message', text: 'This pass answered.' } };

test('collect writes this pass output into meta.json without changing verdict, grant or reply', () => {
  const dir = makeRun({ events: [turn, COMPLETED_COMMAND] });
  const absent = collect(dir, 'codex-scout', 0);
  assert.deepEqual(absent.meta.pass_output, { state: 'absent', reason: 'no-model-output' });
  assert.deepEqual(readJson(path.join(dir, 'meta.json')).pass_output, absent.meta.pass_output);

  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(message) + '\n');
  const present = collect(dir, 'codex-scout', 0);
  assert.deepEqual(present.meta.pass_output, { state: 'present', reason: 'model-output' });
  assert.deepEqual(readJson(path.join(dir, 'meta.json')).pass_output, present.meta.pass_output);
  assert.equal(present.meta.status, absent.meta.status);
  assert.equal(present.meta.reason, absent.meta.reason);
  assert.deepEqual(present.meta.continuation_eligibility, absent.meta.continuation_eligibility);
  assert.equal(renderReply(dir, 'codex-scout', {
    ...present.meta, pass_output: absent.meta.pass_output,
  }), present.reply);

  fs.appendFileSync(path.join(dir, 'events.jsonl'), 'broken\n{}\n');
  const unknown = collect(dir, 'codex-scout', 0);
  assert.deepEqual(unknown.meta.pass_output, { state: 'unknown', reason: 'malformed-line:4' });
  assert.deepEqual(readJson(path.join(dir, 'meta.json')).pass_output, unknown.meta.pass_output);
});

test('collect records unknown when this run has no events file', () => {
  const dir = makeTempTree('pass-output-missing-');
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.deepEqual(meta.pass_output, { state: 'unknown', reason: 'missing-events' });
  assert.deepEqual(readJson(path.join(dir, 'meta.json')).pass_output, meta.pass_output);
});

test('companion reader reads once and preserves the legacy readEvents result on damaged JSONL', (t) => {
  const dir = makeRun({ events: [turn, COMPLETED_COMMAND, message] });
  const eventsPath = path.join(dir, 'events.jsonl');
  fs.appendFileSync(eventsPath, 'broken\n{}\n');
  const legacy = readEvents(dir);
  const readFile = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === eventsPath) reads += 1;
    return readFile.call(this, file, ...args);
  });
  const combined = readEventsWithPassOutput(dir);
  assert.equal(reads, 1);
  assert.deepEqual(combined.events, legacy);
  assert.deepEqual(combined.passOutput, { state: 'unknown', reason: 'malformed-line:4' });
});
