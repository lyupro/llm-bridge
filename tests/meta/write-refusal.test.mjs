import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { detectWriteRefusal } from '../../src/home/lib/meta/write-refusal.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const STATUS = String.raw`{"repo":"C:\\repo"}`;
const FAILED_CHANGE = String.raw`{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"C:\\repo\\src\\main.mjs","kind":"update"}],"status":"failed"}}`;
const REFUSED_LINE = String.raw`Failed to write file C:\repo\src\main.mjs`;
const INCIDENT_STDERR = String.raw`2026-11-15T23:07:14.511119Z ERROR codex_core::tools::router: error=Exit code: 1
Wall time: 1.5 seconds
Output:
Failed to write file C:\repo\src\main.mjs`;
const CONTEXT_MISMATCH_STDERR = String.raw`2026-11-15T23:07:14.511119Z ERROR codex_core::tools::router: error=Exit code: 1
Wall time: 1.5 seconds
Output:
Failed to find expected lines in C:\repo\src\main.mjs:`;

function runFixture(t, overrides = {}) {
  const runDir = makeTempTree('write-refusal-');
  t.after(() => removeTempTree(runDir));
  const artifacts = {
    'status.json': STATUS,
    'events.jsonl': FAILED_CHANGE,
    'stderr.log': INCIDENT_STDERR,
    'scope.txt': 'src/**/*.mjs\n',
    ...overrides,
  };
  for (const [name, text] of Object.entries(artifacts)) {
    if (text !== null) fs.writeFileSync(path.join(runDir, name), text, 'utf8');
  }
  return runDir;
}

test('detects the measured refusal and corroborates it with the failed change', (t) => {
  assert.deepEqual(detectWriteRefusal(runFixture(t)), {
    paths: [{ path: 'src/main.mjs', inScope: true, failedChange: true }],
    evidence: [REFUSED_LINE],
  });
});

test('detects a stderr line without a failed change', (t) => {
  const runDir = runFixture(t, { 'stderr.log': REFUSED_LINE, 'events.jsonl': '' });
  assert.deepEqual(detectWriteRefusal(runDir), {
    paths: [{ path: 'src/main.mjs', inScope: true, failedChange: false }],
    evidence: [REFUSED_LINE],
  });
});

test('returns null when the failed patch only missed its context', (t) => {
  const runDir = runFixture(t, { 'stderr.log': CONTEXT_MISMATCH_STDERR });
  assert.equal(detectWriteRefusal(runDir), null);
});

test('ignores refusal prose in an agent message and non-diagnostic stderr lines', (t) => {
  const message = String.raw`{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Failed to write file C:\\repo\\src\\main.mjs"}}`;
  const runDir = runFixture(t, {
    'events.jsonl': `${FAILED_CHANGE}\n${message}`,
    'stderr.log': `Agent said ${REFUSED_LINE}\nFailed to write file src/main.mjs`,
  });
  assert.equal(detectWriteRefusal(runDir), null);
});

test('only a completed failed file_change for the same path corroborates a refusal', (t) => {
  const completed = FAILED_CHANGE.replace('"status":"failed"', '"status":"completed"');
  const started = FAILED_CHANGE.replace('item.completed', 'item.started');
  const otherPath = FAILED_CHANGE.replace('main.mjs', 'other.mjs');
  const command = FAILED_CHANGE.replace('"file_change"', '"command_execution"');
  const runDir = runFixture(t, { 'events.jsonl': [completed, started, otherPath, command].join('\n') });
  assert.deepEqual(detectWriteRefusal(runDir).paths, [
    { path: 'src/main.mjs', inScope: true, failedChange: false },
  ]);
});

test('reports a repository path outside the allowed glob', (t) => {
  const runDir = runFixture(t, { 'scope.txt': 'tests/**\n' });
  assert.deepEqual(detectWriteRefusal(runDir).paths, [
    { path: 'src/main.mjs', inScope: false, failedChange: true },
  ]);
});

test('keeps paths outside the repository absolute even when the scope glob is broad', (t) => {
  const stderr = String.raw`Failed to write file C:\repo-other\src\main.mjs
Failed to write file C:\repo\..\outside\src\main.mjs
Failed to write file D:\repo\src\main.mjs`;
  const events = FAILED_CHANGE.replace('repo', 'repo-other');
  const runDir = runFixture(t, { 'stderr.log': stderr, 'scope.txt': '**', 'events.jsonl': events });
  assert.deepEqual(detectWriteRefusal(runDir).paths, [
    { path: 'C:/repo-other/src/main.mjs', inScope: false, failedChange: true },
    { path: 'C:/outside/src/main.mjs', inScope: false, failedChange: false },
    { path: 'D:/repo/src/main.mjs', inScope: false, failedChange: false },
  ]);
});

test('compares Windows paths and scope patterns across case and separator differences', (t) => {
  const runDir = runFixture(t, {
    'status.json': '{"repo":"c:/RePo/"}',
    'stderr.log': INCIDENT_STDERR.replace(REFUSED_LINE, 'Failed to write file C:/REPO/Src/Main.mjs')
      .replaceAll('\n', '\r\n'),
    'scope.txt': String.raw`SRC\**\MAIN.MJS`,
  });
  assert.deepEqual(detectWriteRefusal(runDir).paths, [
    { path: 'Src/Main.mjs', inScope: true, failedChange: true },
  ]);
});

test('lists each refused file once and matches add as well as update entries', (t) => {
  const stderr = String.raw`Failed to write file c:/REPO/src/main.mjs
Failed to write file C:\repo\src\new file.mjs
Failed to write file C:\repo\src\nested\main.mjs`;
  const added = String.raw`{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"C:\\repo\\src\\new file.mjs","kind":"add"}],"status":"failed"}}`;
  const runDir = runFixture(t, {
    'stderr.log': `${INCIDENT_STDERR}\n${stderr}`,
    'events.jsonl': `${FAILED_CHANGE}\n${added}\n{"type":`,
  });
  assert.deepEqual(detectWriteRefusal(runDir), {
    paths: [
      { path: 'src/main.mjs', inScope: true, failedChange: true },
      { path: 'src/new file.mjs', inScope: true, failedChange: true },
      { path: 'src/nested/main.mjs', inScope: true, failedChange: false },
    ],
    evidence: [REFUSED_LINE, ...stderr.split('\n').slice(1)],
  });
});

for (const artifact of ['stderr.log', 'events.jsonl', 'status.json']) {
  test(`returns null when ${artifact} is missing`, (t) => {
    assert.equal(detectWriteRefusal(runFixture(t, { [artifact]: null })), null);
  });
}

for (const artifact of ['stderr.log', 'events.jsonl', 'status.json', 'scope.txt']) {
  test(`returns null when ${artifact} cannot be read as a file`, (t) => {
    const runDir = runFixture(t, { [artifact]: null });
    fs.mkdirSync(path.join(runDir, artifact));
    assert.equal(detectWriteRefusal(runDir), null);
  });
}

for (const [condition, scope] of [['missing', null], ['empty', ' \r\n']]) {
  test(`reports a refusal outside scope when scope.txt is ${condition}`, (t) => {
    const runDir = runFixture(t, { 'scope.txt': scope });
    assert.deepEqual(detectWriteRefusal(runDir).paths, [
      { path: 'src/main.mjs', inScope: false, failedChange: true },
    ]);
  });
}
