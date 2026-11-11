/** OW-083 B7: declarations must survive launch, judging and the operator reply. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { validAdvice, validScope } from '../meta/advisor-fixtures.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';
import { orderInvocation } from './order-invocation.mjs';

const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const WORKER = new URL('../../src/home/lib/runner/worker.mjs', import.meta.url).href;
const TASK = `## Question
Which boundary should own validation?
## Options
- keep: Keep the current boundary.
- split: Split the boundary.
## Paths
- src/entry.mjs
`;
const LEDGER = 'docs/decisions.md';
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

function fixture(t, ledger) {
  const root = makeTempTree('advisor-ledger-flow-');
  t.after(() => removeTempTree(root));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, 'src/entry.mjs'), 'export function validate(value) {\n  return value;\n}\n');
  fs.writeFileSync(path.join(home, 'config.json'), '{}\n');
  if (ledger) {
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, LEDGER), '# Decisions\n\nR1: Keep validation in the current boundary.\n');
  }
  return { root, repo, home, runs: path.join(repo, 'runs') };
}

function execute(tree, source) {
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: tree.repo, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    env: { ...process.env, LLM_BRIDGE_HOME: tree.home, LLM_BRIDGE_RUNS_ROOT: tree.runs },
  });
  assert.equal(output.status, 0, output.stderr || output.stdout || output.error?.message);
  return output;
}

function launch(tree, phase, decisions, grant) {
  const { argv } = orderInvocation({
    agent: 'codex-advisor',
    order: { repository: tree.repo, 'order id': 'ledger-flow', phase,
      ...(decisions ? { decisions } : {}) },
    grant, task: TASK, dir: tree.root,
  });
  const output = execute(tree, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
${launcherProcessMocks({ worker: 'spawn', probe: 'marker' })}
syncBuiltinESMExports();
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
process.exitCode = await launcher(${JSON.stringify(argv)});
`);
  const row = output.stdout.split(/\r?\n/).find((line) => line.startsWith('RUN='));
  assert.ok(row, output.stdout);
  return row.slice(4).split(' order-id=')[0];
}

function finish(tree, dir, result) {
  const phase = read(dir, 'status.json').phase;
  const decisions = read(dir, 'advisor-task.json').decisions;
  const { argv } = orderInvocation({ agent: 'codex-advisor', dir: tree.root, task: TASK,
    order: { repository: tree.repo, 'order id': 'ledger-flow', phase,
      ...(decisions ? { decisions } : {}) } });
  const output = execute(tree, `
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
${launcherProcessMocks({ worker: 'forbidden', probe: 'marker' })}
const probeSpawn = childProcess.spawn;
childProcess.spawn = (command, args = [], options) => {
  if (command === 'git' || launcherMocksIsProbe(args)) return probeSpawn(command, args, options);
  const child = new LauncherMocksEventEmitter();
  child.pid = 999998;
  child.stdin = new LauncherMocksPassThrough();
  child.stdout = new LauncherMocksPassThrough();
  child.stderr = new LauncherMocksPassThrough();
  child.kill = () => true;
  child.stdin.resume();
  setImmediate(() => {
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'result.json'))}, ${JSON.stringify(JSON.stringify(result))});
    child.emit('spawn');
    child.stdout.end(JSON.stringify({ type: 'item.completed', item: {
      type: 'command_execution', command: 'cat src/entry.mjs', exit_code: 0,
      aggregated_output: 'export function validate(value) { return value; }'
    } }) + '\\n' + JSON.stringify({ type: 'turn.completed' }) + '\\n');
    child.stderr.end();
    setImmediate(() => {
      child.emit('exit', 0, null);
      setImmediate(() => child.emit('close', 0, null));
    });
  });
  return child;
};
syncBuiltinESMExports();
const { worker } = await import(${JSON.stringify(WORKER)});
await worker(${JSON.stringify(dir)});
childProcess.spawn = probeSpawn;
syncBuiltinESMExports();
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
process.exitCode = await launcher(${JSON.stringify(argv)});
`);
  const meta = read(dir, 'meta.json');
  const reply = output.stdout.split(/\r?\n/).filter((line) => !line.startsWith('ATTACH=') && !line.startsWith('Saved reply')).join('\n');
  assert.equal(meta.status, 'OK', JSON.stringify(meta));
  assert.equal(read(dir, 'status.json').state, 'finished');
  assert.deepEqual(read(dir, 'result.json'), result);
  return { meta, reply };
}

function scopeThenAdvise(tree, decisions) {
  const scope = launch(tree, 'scope', decisions);
  finish(tree, scope, validScope());
  const advise = launch(tree, 'advise', decisions, {
    kind: 'continue', run: path.basename(scope), reason: 'resolve the scoped design question',
  });
  for (const dir of [scope, advise]) {
    assert.equal(read(dir, 'advisor-task.json').decisions, decisions ?? null);
    const prompt = fs.readFileSync(path.join(dir, 'task.md'), 'utf8');
    if (decisions) assert.ok(prompt.includes(`## Decision ledger\n\n${decisions}`));
    else assert.doesNotMatch(prompt, /## Decision ledger/);
  }
  return advise;
}

test('a duplicate question reaches OK with the ledger address in the first row', (t) => {
  const tree = fixture(t, true);
  const dir = scopeThenAdvise(tree, LEDGER);
  const result = validAdvice();
  result.already_decided = { status: 'found', address: `${LEDGER}:3` };
  const { reply } = finish(tree, dir, result);
  assert.equal(reply.split(/\r?\n/)[0],
    `OK — recommend keep: Already decided: found ${LEDGER}:3 · ${result.recommendation.text}`);
});

test('an order without a ledger reaches OK with the explicit not-checked state', (t) => {
  const tree = fixture(t, false);
  const dir = scopeThenAdvise(tree);
  const result = validAdvice();
  const { reply } = finish(tree, dir, result);
  assert.equal(reply.split(/\r?\n/)[0],
    `OK — recommend keep: Already decided: not-checked (no ledger supplied) · ${result.recommendation.text}`);
});

test('a saved legacy schema and result preserve the verdict and name the absent field', (t) => {
  const tree = fixture(t, false);
  const dir = scopeThenAdvise(tree);
  // OW-083 B3/B5: replay the saved contract rather than applying today's schema to old results.
  const schema = read(dir, 'schema.json');
  delete schema.properties.already_decided;
  schema.required = schema.required.filter((name) => name !== 'already_decided');
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema));
  const result = validAdvice();
  delete result.already_decided;
  const { reply } = finish(tree, dir, result);
  assert.deepEqual(read(dir, 'schema.json'), schema);
  assert.equal(reply.split(/\r?\n/)[0],
    `OK — recommend keep: Already decided: legacy result; field absent · ${result.recommendation.text}`);
});
