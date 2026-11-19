/** Guards the OW-097 D4 snapshot and source revision used for an arbiter launch. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { writeRunJsonAtomic } from '../../src/home/lib/atomic-json.mjs';
import { arbiterTaskRefusal } from '../../src/home/lib/meta/arbiter-task.mjs';
import { RunnerUsageError } from '../../src/home/lib/runner/args.mjs';
import { arbiterEvidenceSection } from '../../src/home/lib/runner/arbiter-evidence.mjs';
import {
  arbiterInputOrRefuse, arbiterInputSection, arbiterStatusFields, sourceRevision,
} from '../../src/home/lib/runner/arbiter-launch.mjs';
import { EXIT } from '../../src/home/lib/runner/exit-codes.mjs';
import { git } from '../../src/home/lib/runner/git-state.mjs';
import { validAdvice } from '../meta/advisor-fixtures.mjs';
import { makeTempTree } from '../temp-tree.mjs';

const PRIOR_RUN = '2026-11-19_145500_keep-boundary';
const TASK = `## Question
Which boundary should own the decision?

## Options
- keep: Keep the current boundary.
- split: Split the boundary.

## Trigger
disagreement

## Position
split: Each caller should make its own decision.

## Prior runs
- ${PRIOR_RUN}

## Paths
- src/entry.mjs
`;

function fixtureGit(repo, ...args) {
  const result = git(repo, args);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

function repository({ commit = false, objectFormat = 'sha1' } = {}) {
  const repo = makeTempTree('arbiter-repo-');
  fixtureGit(repo, 'init', '--quiet', `--object-format=${objectFormat}`);
  if (commit) {
    fixtureGit(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/no-fixture-hooks',
      'commit', '--quiet', '--allow-empty', '-m', 'Source revision');
  }
  return repo;
}

function mockGit(t, implementation) {
  t.mock.method(childProcess, 'spawnSync', implementation);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function adviceFixture(projectRunsRoot) {
  const dir = path.join(projectRunsRoot, PRIOR_RUN);
  fs.mkdirSync(dir);
  const meta = { agent: 'codex-advisor', phase: 'advise', status: 'OK', finished_at: '2026-11-19T14:56:00Z' };
  const result = validAdvice();
  result.recommendation.text = 'Keep the boundary café-side.\r\nPreserve the stable entry point.';
  const resultText = JSON.stringify(result, null, 2) + '\n';
  const resultFile = path.join(dir, 'result.json');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
  fs.writeFileSync(resultFile, resultText, 'utf8');
  const { recommendation, rejected, strongest_counterargument } = result;
  return { resultFile, snapshot: {
    run: PRIOR_RUN, result_sha256: createHash('sha256').update(resultText, 'utf8').digest('hex'),
    recommendation, rejected, strongest_counterargument,
  } };
}

test('source revision records the full SHA-1 commit', () => {
  const repo = repository({ commit: true });
  const revision = fixtureGit(repo, 'rev-parse', 'HEAD');
  assert.match(revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(sourceRevision(repo), { revision });
});

test('source revision records null for an unborn repository and for a non-worktree', () => {
  assert.deepEqual(sourceRevision(repository()), { revision: null });
  assert.deepEqual(sourceRevision(makeTempTree('arbiter-no-git-')), { revision: null });
});

test('source revision reports an unexpected Git failure', (t) => {
  const repo = repository({ commit: true });
  mockGit(t, () => ({ error: new Error('simulated Git execution failure'), status: null,
    stdout: null, stderr: null }));
  assert.throws(() => sourceRevision(repo), /arbiter source revision:.*simulated Git execution failure/);
});

test('an unresolved HEAD with an existing branch is a Git failure', (t) => {
  const repo = repository({ commit: true });
  const spawnSync = childProcess.spawnSync;
  mockGit(t, (command, args, options) => {
    if (args.at(-1) === 'HEAD^{commit}') return { status: 1, stdout: '', stderr: '' };
    return spawnSync(command, args, options);
  });
  assert.throws(() => sourceRevision(repo), /rev-parse HEAD\^\{commit\} failed/);
});

test('source revision refuses a SHA-256 commit', () => {
  const repo = repository({ commit: true, objectFormat: 'sha256' });
  assert.throws(() => sourceRevision(repo), /unsupported HEAD commit hash.*[0-9a-f]{64}/);
});

test('the atomically saved OW-097 D4 input and the prompt use one advice snapshot', () => {
  const repoRoot = repository({ commit: true });
  const projectRunsRoot = makeTempTree('arbiter-runs-');
  const { resultFile, snapshot } = adviceFixture(projectRunsRoot);
  const { input, revision } = arbiterInputOrRefuse({ taskText: TASK, projectRunsRoot, repoRoot });
  assert.equal(revision, fixtureGit(repoRoot, 'rev-parse', 'HEAD'));
  assert.deepEqual(input, {
    version: 1,
    task: {
      question: 'Which boundary should own the decision?',
      options: [
        { id: 'keep', description: 'Keep the current boundary.' },
        { id: 'split', description: 'Split the boundary.' },
      ],
      trigger: 'disagreement',
      position: { option: 'split', rationale: 'Each caller should make its own decision.' },
      priorRuns: [PRIOR_RUN],
      paths: ['src/entry.mjs'],
    },
    evidence: [snapshot],
  });
  assert.ok(Object.isFrozen(input.evidence));

  const file = path.join(projectRunsRoot, 'arbiter', 'arbiter-input.json');
  writeRunJsonAtomic(file, input);
  fs.writeFileSync(resultFile, '{}', 'utf8');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, input);
  const section = arbiterInputSection(saved);
  assert.equal(section, arbiterEvidenceSection(saved.evidence));
  assert.match(section, /^## Prior advice\n/);
  assert.deepEqual(Buffer.from(section, 'utf8'), Buffer.from(arbiterInputSection(input), 'utf8'));
});

for (const [name, taskText, cause] of [
  ['malformed task', '## Options\n- keep: Keep.\n', /add a "## Question" section/],
  ['missing prior run', TASK, /Prior run "2026-11-19_145500_keep-boundary".*folder does not exist/],
]) {
  test(`refuses ${name} before a launch can create a run`, (t) => {
    const repoRoot = makeTempTree('arbiter-refusal-repo-');
    const projectRunsRoot = makeTempTree('arbiter-refusal-runs-');
    mockGit(t, () => assert.fail('invalid arbiter input reached Git'));
    const printed = t.mock.method(console, 'error', () => {});
    assert.throws(() => arbiterInputOrRefuse({ taskText, projectRunsRoot, repoRoot }), (error) => {
      assert.ok(error instanceof RunnerUsageError);
      assert.equal(error.exitCode, EXIT.FAIL);
      assert.match(error.message, cause);
      assert.match(error.message, /The run folder was not created; quota was not spent\./);
      if (taskText !== TASK) assert.ok(error.message.startsWith(arbiterTaskRefusal(taskText)));
      return true;
    });
    assert.equal(printed.mock.callCount(), 1);
    assert.deepEqual(fs.readdirSync(projectRunsRoot), []);
  });
}

test('refuses to launch when the source revision cannot be resolved', (t) => {
  const repoRoot = makeTempTree('arbiter-git-refusal-repo-');
  const projectRunsRoot = makeTempTree('arbiter-git-refusal-runs-');
  adviceFixture(projectRunsRoot);
  mockGit(t, () => ({ status: 128, stdout: '', stderr: 'fatal: bad Git configuration' }));
  t.mock.method(console, 'error', () => {});
  assert.throws(() => arbiterInputOrRefuse({ taskText: TASK, projectRunsRoot, repoRoot }), {
    name: 'Error',
    exitCode: EXIT.FAIL,
    message: /bad Git configuration.*The run folder was not created; quota was not spent\./,
  });
  assert.deepEqual(fs.readdirSync(projectRunsRoot), [PRIOR_RUN]);
});

test('arbiter status records the fresh or inherited revision, including null', () => {
  for (const revision of ['ab'.repeat(20), null]) {
    assert.deepEqual(arbiterStatusFields({ arbiterInput: { revision } }), { source_revision: revision });
    assert.deepEqual(arbiterStatusFields({ resumeInputs: { agent: 'codex-arbiter', source_revision: revision } }),
      { source_revision: revision });
  }
  assert.deepEqual(arbiterStatusFields({}), {});
  assert.deepEqual(arbiterStatusFields({ resumeInputs: { agent: 'codex-advisor' } }), {});
});

test('the OW-097 D4 launch saves the source and input before assembling the prompt', () => {
  // Guard the wiring while arbiter is still unavailable through public admission.
  const read = (name) => fs.readFileSync(new URL(`../../src/home/lib/runner/${name}.mjs`, import.meta.url), 'utf8');
  const gate = read('pass-gate');
  assert.match(gate, /!resumedFrom && opts\.agent === 'codex-arbiter'\s*\?\s*arbiterInputOrRefuse\(/);

  const launcher = read('launcher');
  assert.match(launcher.slice(launcher.indexOf('writeStatus(runDir,'), launcher.indexOf('console.log(`RUN=')),
    /\.\.\.arbiterStatusFields\(\{ arbiterInput, resumeInputs \}\)/);
  const steps = [
    'await passGate(',
    'await probeSandbox(',
    'writeStatus(runDir,',
    "writeRunJsonAtomic(path.join(runDir, 'arbiter-input.json'), arbiterInput.input)",
    'arbiterInputSection(arbiterInput.input)',
    "path.join(runDir, 'schema.json')",
    'writeWorkerOrder(runDir,',
    'spawn(process.execPath,',
  ];
  let previous = -1;
  for (const step of steps) {
    const next = launcher.indexOf(step);
    assert.ok(next > previous, `Missing or out of order: ${step}`);
    previous = next;
  }
});
