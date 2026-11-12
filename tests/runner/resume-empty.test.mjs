/** OW-066 B2: stored assessment and the zero-quota resume check share the empty-pass limit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { resumeRefusal } from '../../src/home/lib/runner/continuation.mjs';
import { collect, readJson } from '../../src/home/lib/write-meta.mjs';

const recordedAt = '2026-10-16T09:25:00.000Z';

function fixture() {
  const root = makeTempTree('resume-empty-');
  const calls = [];
  const options = {
    agent: 'codex-advisor', phase: 'advise', liveness: () => false,
    readSession: () => {
      calls.push('readSession');
      return { state: 'observed', last_record_at: recordedAt };
    },
  };
  function run(name, parent, output, legacy = false) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
      order_id: 'o', agent: 'codex-advisor', phase: 'advise', resumed_from: parent,
      started_at: '2026-10-16T09:00:00.000Z',
      stop: { version: 2, trigger: 'deadline', tree_stop: { state: 'stopped' },
        session: { state: 'observed', last_record_at: recordedAt } },
    }) + '\n');
    const events = [{ type: 'thread.started', thread_id: 'resume-thread' }];
    if (output !== 'unknown') events.push({ type: 'turn.started' });
    if (output === 'present') {
      events.push({ type: 'item.completed', item: { type: 'reasoning', text: 'Still working' } });
    }
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    const { meta } = collect(dir, 'codex-advisor', 1);
    if (legacy) {
      delete meta.pass_output;
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta) + '\n');
    }
    return { dir, meta };
  }
  const decide = (name, chain) => resumeRefusal(root, chain, 'o', { run: name, reason: 'finish' }, options);
  return { root, run, decide, calls };
}

test('one empty resume is allowed; two block the stored assessment and resume naming C', () => {
  const f = fixture();
  f.run('A', undefined, 'absent');
  const b = f.run('B', 'A', 'absent');
  assert.equal(b.meta.continuation_eligibility.grant.allowed, true);
  assert.equal(f.decide('B', ['A', 'B']), null);
  const c = f.run('C', 'B', 'absent');
  const expected = { allowed: false, policy_version: 3, blocking_reasons: ['empty-resumes-exhausted'] };
  assert.deepEqual(c.meta.continuation_eligibility.grant, expected);
  assert.deepEqual(readJson(path.join(c.dir, 'meta.json')).continuation_eligibility.grant, expected);
  assert.deepEqual(collect(c.dir, 'codex-advisor', 1).meta.continuation_eligibility.grant, expected);
  f.calls.length = 0;
  const refusal = f.decide('C', ['A', 'B', 'C']);
  assert.match(refusal, /run C cannot be resumed: empty-resumes-exhausted/);
  assert.match(refusal, /A retry: grant repeats it on a fresh thread/);
  assert.deepEqual(f.calls, [], 'exhaustion refuses before thread freshness');
  assert.deepEqual(fs.readdirSync(f.root), ['A', 'B', 'C'], 'refusal creates no run');
});

test('pre-B1 runs cannot bypass exhaustion with a cached allowed grant', () => {
  const f = fixture();
  f.run('A', undefined, 'present', true);
  f.run('B', 'A', 'absent', true);
  const c = f.run('C', 'B', 'absent', true);
  c.meta.continuation_eligibility.grant = { allowed: true, policy_version: 2, blocking_reasons: [] };
  fs.writeFileSync(path.join(c.dir, 'meta.json'), JSON.stringify(c.meta) + '\n');
  assert.match(f.decide('C', ['A', 'B', 'C']), /empty-resumes-exhausted/);
});

for (const [middle, last] of [['present', 'absent'], ['absent', 'unknown']]) {
  test(`${middle} then ${last} breaks the empty-resume sequence in both grant paths`, () => {
    const f = fixture();
    f.run('A', undefined, 'absent');
    f.run('B', 'A', middle);
    const c = f.run('C', 'B', last);
    assert.equal(c.meta.continuation_eligibility.grant.allowed, true);
    assert.equal(f.decide('C', ['A', 'B', 'C']), null);
  });
}
