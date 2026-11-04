#!/usr/bin/env node
/**
 * Guards environment.mjs: which touched paths belong to the run and which to the tooling
 * writing alongside it.
 *   node --test agents/codex-bridge/meta/environment.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environmentNewFilePatterns, environmentPatterns, splitEnvironment, splitRunChanges } from '../../src/home/lib/meta/environment.mjs';
import { encodeSnapshot } from '../../src/home/lib/meta/snapshot-format.mjs';
import { makeRun } from './test-fixtures.mjs';

test('a run folder whose env.json predates the list has no environment at all', () => {
  const dir = makeRun({ before: '', after: 'U\t10\t.omc/project-memory.json\n' });
  assert.deepEqual(environmentPatterns(dir), []);
  // The pre-2026-08-02 behaviour, kept on purpose: with no recorded patterns every change
  // is the run's own, so an old run recomputed today gives the verdict it gave then.
  assert.deepEqual(splitRunChanges(dir, ['.omc/project-memory.json']), {
    work: ['.omc/project-memory.json'],
    environment: [],
  });
});

test('patterns come from the run own env.json, trimmed and without blanks', () => {
  const dir = makeRun({ envPaths: ['  .omc/**  ', '', '.claude/settings.local.json'] });
  assert.deepEqual(environmentPatterns(dir), ['.omc/**', '.claude/settings.local.json']);
});

test('the environment keeps its files and the run keeps its own', () => {
  const { work, environment } = splitEnvironment(
    ['src/a.ts', '.omc/project-memory.json', 'plugins/installed_plugins.json'],
    ['.omc/**', 'plugins/installed_plugins.json'],
  );
  assert.deepEqual(work, ['src/a.ts']);
  assert.deepEqual(environment, ['.omc/project-memory.json', 'plugins/installed_plugins.json']);
});

test('a backslash path from Codex meets a forward-slash pattern', () => {
  const backslashPath = ['.omc', 'state', 'run.json'].join(String.fromCharCode(92));
  const { work, environment } = splitEnvironment([backslashPath], ['.omc/**']);
  assert.deepEqual(work, []);
  assert.deepEqual(environment, ['.omc/state/run.json']);
});

test('an empty pattern list attributes everything to the run', () => {
  const { work, environment } = splitEnvironment(['.omc/x.json', 'src/a.ts'], []);
  assert.deepEqual(work, ['.omc/x.json', 'src/a.ts']);
  assert.deepEqual(environment, []);
});

test('a similar directory name does not match an environment glob', () => {
  const { work, environment } = splitEnvironment(
    ['.omcx/state.json', '.omc/state.json'],
    ['.omc/**'],
  );
  assert.deepEqual(work, ['.omcx/state.json']);
  assert.deepEqual(environment, ['.omc/state.json']);
});

test('each run uses the environment paths recorded in its own env.json', () => {
  const path = '.omc/project-memory.json';
  const runWithoutEnvironment = makeRun({ envPaths: [] });
  const runWithEnvironment = makeRun({ envPaths: ['.omc/**'] });

  assert.deepEqual(splitRunChanges(runWithoutEnvironment, [path]), {
    work: [path],
    environment: [],
  });
  assert.deepEqual(splitRunChanges(runWithEnvironment, [path]), {
    work: [],
    environment: [path],
  });
});

const letter = 'letters/incoming.md';
const hashed = `U\t12:${'a'.repeat(64)}`;
const snapshot = (state, file = letter) => encodeSnapshot(
  state === undefined ? [] : [{ path: file, state }],
);

test('new-file patterns are run-local, trimmed and empty for archived runs', () => {
  assert.deepEqual(environmentNewFilePatterns(makeRun()), []);
  assert.deepEqual(environmentNewFilePatterns(makeRun({ envPaths: ['letters/**'] })), []);
  assert.deepEqual(environmentNewFilePatterns(makeRun({ envNewFilePaths: null })), []);
  assert.deepEqual(environmentNewFilePatterns(makeRun({
    envNewFilePaths: ['  letters/**  ', '', '   ', 'inbox/*.md'],
  })), ['letters/**', 'inbox/*.md']);
});

const newFileCases = [
  { name: 'new hashed letter outside scope', excused: true },
  { name: 'empty new hashed file', after: snapshot(`U\t0:${'B'.repeat(64)}`), excused: true },
  { name: 'letter already present before', before: snapshot(hashed) },
  { name: 'existing letter content changed', before: snapshot(`U\t12:${'b'.repeat(64)}`) },
  { name: 'existing tracked letter replaced', before: snapshot('1\t2') },
  { name: 'existing letter removed', before: snapshot(hashed), after: snapshot() },
  { name: 'new letter explicitly named by scope', scope: letter },
  { name: 'new letter covered by scope glob', scope: '  letters/**  \n' },
  { name: 'new letter covered by wildcard scope', scope: 'letters/*.md' },
  { name: 'missing new untracked file', after: snapshot('U\tmissing') },
  { name: 'unreadable new untracked file', after: snapshot('U\tunreadable') },
  { name: 'new tracked state', after: snapshot('1\t2') },
  { name: 'new tracked deletion state', after: snapshot('-\t-') },
  { name: 'no after row', after: snapshot() },
  { name: 'damaged before text', before: 'damaged' },
  { name: 'damaged after text', after: 'damaged' },
  { name: 'null before text', before: null },
  { name: 'null after text', after: null },
  { name: 'missing before text', before: undefined },
  { name: 'missing after text', after: undefined },
  { name: 'short hash', after: `# codex-bridge-state-v2\nU\t12:abc\t"${letter}"\n` },
  { name: 'legacy untracked state without hash', before: '', after: `U\t12\t${letter}\n` },
  { name: 'third argument absent', noSnapshots: true },
  { name: 'new-file key absent', envNewFilePaths: undefined },
  { name: 'new-file key empty', envNewFilePaths: [] },
  { name: 'path outside new-file patterns', envNewFilePaths: ['inbox/**'] },
];

for (const row of newFileCases) {
  test(`new-file environment rule: ${row.name}`, () => {
    const options = { scope: 'src/**', envNewFilePaths: ['letters/**'], ...row };
    const dir = makeRun({ scope: options.scope, envPaths: [], envNewFilePaths: options.envNewFilePaths });
    const snapshots = {
      before: Object.hasOwn(row, 'before') ? row.before : snapshot(),
      after: Object.hasOwn(row, 'after') ? row.after : snapshot(hashed),
    };
    const split = row.noSnapshots
      ? splitRunChanges(dir, [letter])
      : splitRunChanges(dir, [letter], snapshots);
    assert.deepEqual(split, row.excused
      ? { work: [], environment: [letter] }
      : { work: [letter], environment: [] });
  });
}

test('ordinary environment patterns still win over scope and untrustworthy snapshots', () => {
  const dir = makeRun({ envPaths: ['letters/**'], scope: letter });
  for (const snapshots of [undefined, { before: null, after: 'damaged' }, {
    before: snapshot(hashed), after: snapshot(),
  }]) {
    assert.deepEqual(splitRunChanges(dir, [letter], snapshots), {
      work: [], environment: [letter],
    });
  }
});

test('new-file splitting preserves path normalization, order and unrelated work', () => {
  const dir = makeRun({
    envPaths: ['.omc/**'], envNewFilePaths: ['letters/**'], scope: 'src/**',
  });
  assert.deepEqual(splitRunChanges(dir, ['letters\\incoming.md', 'src/a.mjs', '.omc/state.json'], {
    before: snapshot(), after: snapshot(hashed),
  }), {
    work: ['src/a.mjs'], environment: [letter, '.omc/state.json'],
  });
});
