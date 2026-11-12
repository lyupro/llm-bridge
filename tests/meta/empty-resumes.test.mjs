import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { consecutiveEmptyResumes } from '../../src/home/lib/meta/empty-resumes.mjs';

const turn = { type: 'turn.started' };
const message = { type: 'item.completed', item: { type: 'agent_message', text: 'Output' } };
const stream = (...events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

function fixture() {
  const runsRoot = makeTempTree('empty-resumes-');
  function run(name, parent, state, events) {
    const dir = path.join(runsRoot, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ resumed_from: parent }) + '\n');
    if (state !== undefined) {
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ pass_output: { state } }) + '\n');
    }
    if (events !== undefined) fs.writeFileSync(path.join(dir, 'events.jsonl'), events);
    return dir;
  }
  return { runsRoot, run, count: (run) => consecutiveEmptyResumes({ runsRoot, run }) };
}

for (const [middle, last, expected] of [
  ['absent', 'absent', 2], ['present', 'absent', 1], ['absent', 'unknown', 0],
  ['unknown', 'absent', 1], ['absent', 'present', 0],
]) {
  test(`A -> B(${middle}) -> C(${last}) counts ${expected}`, () => {
    const f = fixture();
    f.run('A', undefined, 'absent');
    f.run('B', 'A', middle);
    f.run('C', 'B', last);
    assert.equal(f.count('A'), 0, 'an empty initial pass is not an empty resume');
    assert.equal(f.count('B'), middle === 'absent' ? 1 : 0);
    assert.equal(f.count('C'), expected);
  });
}

test('pre-B1 passes use their own events, including the shared malformed-line rules', () => {
  const f = fixture();
  f.run('A', undefined, undefined, stream(turn, message));
  f.run('B', 'A', undefined, stream(turn));
  f.run('C', 'B', undefined, stream(turn));
  assert.equal(f.count('C'), 2);
  f.run('D', 'C', undefined, stream(turn, message));
  f.run('E', 'D', undefined, stream(turn));
  assert.equal(f.count('E'), 1);
  f.run('F', 'E', undefined, stream(turn) + 'broken\n{}\n');
  assert.equal(f.count('F'), 0);
});

test('recorded output states take precedence over events', () => {
  const f = fixture();
  f.run('A', undefined, 'absent');
  f.run('B', 'A', 'unknown', stream(turn));
  f.run('C', 'A', 'present', stream(turn));
  f.run('D', 'A', 'absent', stream(turn, message));
  assert.equal(f.count('B'), 0);
  assert.equal(f.count('C'), 0);
  assert.equal(f.count('D'), 1);
});

test('missing, empty and unreadable events never count as empty', (t) => {
  const f = fixture();
  f.run('A', undefined, 'absent');
  f.run('missing', 'A');
  f.run('empty', 'A', undefined, '');
  const dir = f.run('unreadable', 'A', undefined, stream(turn));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === path.join(dir, 'events.jsonl')) throw new Error('unreadable fixture');
    return read.call(this, file, ...args);
  });
  for (const name of ['missing', 'empty', 'unreadable']) assert.equal(f.count(name), 0);
});

test('missing or unreadable run folders stop the walk without throwing', (t) => {
  const f = fixture();
  f.run('B', 'missing', 'absent');
  const dir = f.run('C', 'B', 'absent');
  assert.equal(f.count('missing'), 0);
  assert.equal(f.count('B'), 1);
  assert.equal(f.count('C'), 2);
  fs.writeFileSync(path.join(f.runsRoot, 'file'), 'not a folder');
  assert.equal(f.count('file'), 0);
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', function (file, ...args) {
    if (file === dir) throw new Error('unreadable fixture');
    return realpath.call(this, file, ...args);
  });
  assert.equal(f.count('C'), 0);
  assert.equal(consecutiveEmptyResumes({ runsRoot: path.join(f.runsRoot, 'missing'), run: 'B' }), 0);
});

test('invalid resume origins and unreadable status stop without counting the run', () => {
  const f = fixture();
  for (const [index, parent] of [undefined, null, '', ' ', '.', '..', '../A', 'nested/A', 'nested\\A', 42].entries()) {
    f.run(`B${index}`, parent, 'absent');
    assert.equal(f.count(`B${index}`), 0);
  }
  const dir = f.run('broken', 'A', 'absent');
  fs.writeFileSync(path.join(dir, 'status.json'), 'broken');
  assert.equal(f.count('broken'), 0);
  for (const run of [undefined, '', '.', '..', '../A', 'nested\\A']) assert.equal(f.count(run), 0);
});

test('cycles count each empty resumed pass at most once', () => {
  const f = fixture();
  f.run('A', 'B', 'absent');
  f.run('B', 'A', 'absent');
  f.run('self', 'self', 'absent');
  assert.equal(f.count('B'), 2);
  assert.equal(f.count('self'), 1);
});
