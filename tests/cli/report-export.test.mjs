import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { reportExport } from '../../cli/report-export.mjs';
import { resolveProjectRunsDir } from '../../src/home/lib/runner/project-dir.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const cli = fileURLToPath(new URL('../../bin/llm-bridge.mjs', import.meta.url));
const exec = promisify(execFile);
const reportBytes = Buffer.from('\uFEFF# Arbitration\r\nRésumé.\r\n', 'utf8');
const runName = '2026-11-19_150000_report-export';

function fixture(t, { agent = 'codex-arbiter', verdict = 'OK', report = reportBytes, runsInRepo = false } = {}) {
  const root = makeTempTree('report-export-');
  t.after(() => removeTempTree(root));
  const repo = path.join(root, 'project');
  const runsRoot = path.join(runsInRepo ? repo : root, 'runs');
  fs.mkdirSync(repo);
  const { dir: projectRuns } = resolveProjectRunsDir(runsRoot, repo);
  const run = path.join(projectRuns, runName);
  fs.mkdirSync(run);
  fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ agent, status: verdict }), 'utf8');
  fs.writeFileSync(path.join(run, 'status.json'), JSON.stringify({ agent, repo, state: 'finished' }), 'utf8');
  fs.writeFileSync(path.join(run, 'events.jsonl'), '{}\n', 'utf8');
  if (report !== null) fs.writeFileSync(path.join(run, 'report.md'), report);
  const exportTo = (destination) => reportExport({ run: runName, cwd: repo, runsRootPath: runsRoot, destination });
  const runCommand = (destination) => exec(process.execPath, [cli, 'report', 'export', run, destination], {
    cwd: root, encoding: 'utf8',
  });
  return { exportTo, runCommand, root, repo, run };
}

function refusal(result, reason) {
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, reason);
  assert.doesNotMatch(result.output, /[\r\n]/);
}

test('CLI exports exact bytes relative to the recorded repo when invoked from elsewhere', async (t) => {
  const { runCommand, root, repo, run } = fixture(t);
  const previousRunEntries = fs.readdirSync(run);
  const result = await runCommand('decision.md');
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd(), `Exported report.md from "${runName}" to "decision.md".`);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'decision.md')), reportBytes);
  assert.deepEqual(fs.readFileSync(path.join(run, 'report.md')), reportBytes);
  assert.deepEqual(fs.readdirSync(run), previousRunEntries);
  assert.ok(!fs.existsSync(path.join(root, 'decision.md')));
});

test('a second export finds identical bytes and preserves the existing file', async (t) => {
  const { exportTo, repo } = fixture(t);
  const destination = path.join(repo, 'decision.md');
  assert.equal((await exportTo(destination)).exitCode, 0);
  fs.utimesSync(destination, 1_700_000_000, 1_700_000_000);
  const before = fs.statSync(destination);
  const result = await exportTo('decision.md');
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.output, `Already exported report.md from "${runName}" to "decision.md".`);
  assert.deepEqual(fs.readFileSync(destination), reportBytes);
  assert.equal(fs.statSync(destination).mtimeMs, before.mtimeMs);
});

test('a different existing destination is refused and left byte-identical', async (t) => {
  const { exportTo, repo } = fixture(t);
  const destination = path.join(repo, 'decision.md');
  const existing = Buffer.from([0x00, 0x7F, 0xFF]);
  fs.writeFileSync(destination, existing);
  refusal(await exportTo('decision.md'), /already exists with different bytes/);
  assert.deepEqual(fs.readFileSync(destination), existing);
});

test('concurrent CLI exports both succeed and leave one copy', async (t) => {
  const report = Buffer.alloc(8 * 1024 * 1024, 0x61);
  const { runCommand, repo } = fixture(t, { report });
  const results = await Promise.all([runCommand('plans/decision.md'), runCommand('plans/decision.md')]);
  assert.deepEqual(results.map(({ stdout }) => stdout.split(' report.md')[0]).sort(), ['Already exported', 'Exported']);
  assert.ok(results.every(({ stderr }) => stderr === ''));
  assert.deepEqual(fs.readdirSync(path.join(repo, 'plans')), ['decision.md']);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'plans', 'decision.md')), report);
});

test('an exclusive-create collision can expose an in-progress copy', async (t) => {
  const { exportTo, repo } = fixture(t);
  const destination = path.join(repo, 'decision.md');
  const write = fs.writeFileSync;
  const create = t.mock.method(fs, 'writeFileSync', (file, bytes, options) => {
    assert.equal(file, path.join(fs.realpathSync.native(repo), 'decision.md'));
    assert.equal(options.flag, 'wx');
    write(file, bytes.subarray(0, 5), options);
    setTimeout(() => write(file, bytes.subarray(5), { flag: 'a' }), 40);
    return write(file, bytes, options);
  });
  const result = await exportTo('decision.md');
  assert.equal(create.mock.callCount(), 1);
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /^Already exported /);
  assert.deepEqual(fs.readFileSync(destination), reportBytes);
});

for (const [label, options, reason] of [
  ['a non-arbiter run', { agent: 'codex-advisor' }, /codex-arbiter/],
  ['a non-OK verdict', { verdict: 'FAIL' }, /OK verdict in meta\.json/],
  ['a missing report', { report: null }, /report\.md as a regular file/],
]) {
  test(`export refuses ${label}`, async (t) => {
    const { exportTo, repo } = fixture(t, options);
    refusal(await exportTo('plans/decision.md'), reason);
    assert.deepEqual(fs.readdirSync(repo), []);
  });
}

test('export refuses a report path that is a directory', async (t) => {
  const { exportTo, run, repo } = fixture(t, { report: null });
  fs.mkdirSync(path.join(run, 'report.md'));
  refusal(await exportTo('decision.md'), /report\.md as a regular file/);
  assert.deepEqual(fs.readdirSync(repo), []);
});

test('export refuses destinations outside the recorded repo, including a sibling with its prefix', async (t) => {
  const { exportTo, root } = fixture(t);
  for (const target of ['../project-other/decision.md', path.join(root, 'project-other', 'decision.md')]) {
    refusal(await exportTo(target), /outside the recorded repository/);
  }
  assert.ok(!fs.existsSync(path.join(root, 'project-other')));
});

test('export refuses to follow a linked parent outside the repository', async (t) => {
  const { exportTo, root, repo } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, 'plans'), process.platform === 'win32' ? 'junction' : 'dir');
  refusal(await exportTo('plans/missing/decision.md'), /outside the recorded repository/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('export refuses a destination link outside the repository', async (t) => {
  const { exportTo, root, repo } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, 'decision.md'), process.platform === 'win32' ? 'junction' : 'dir');
  refusal(await exportTo('decision.md'), /outside the recorded repository/);
  assert.ok(fs.lstatSync(path.join(repo, 'decision.md')).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('export allows linked parents inside the repository', async (t) => {
  const { exportTo, repo } = fixture(t);
  const plans = path.join(repo, 'plans');
  fs.mkdirSync(plans);
  fs.symlinkSync(plans, path.join(repo, 'plan-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await exportTo('plan-link/decision.md');
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /"plan-link\/decision\.md"/);
  assert.deepEqual(fs.readFileSync(path.join(plans, 'decision.md')), reportBytes);
});

test('export refuses to write into a run folder inside the repository', async (t) => {
  const { exportTo, repo, run } = fixture(t, { runsInRepo: true });
  fs.symlinkSync(run, path.join(repo, 'run-link'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [path.join(run, 'missing', 'decision.md'), 'run-link/missing/decision.md']) {
    refusal(await exportTo(target), /inside the run folder/);
  }
  assert.ok(!fs.existsSync(path.join(run, 'missing')));
});

test('export refuses non-Markdown paths and directory destinations', async (t) => {
  const { exportTo, repo } = fixture(t);
  fs.mkdirSync(path.join(repo, 'directory.md'));
  refusal(await exportTo('missing/decision.txt'), /ending in \.md/);
  refusal(await exportTo('directory.md'), /Destination is a directory/);
  assert.deepEqual(fs.readdirSync(repo), ['directory.md']);
});

test('export requires an absolute repository root from the run record', async (t) => {
  const { exportTo, run, repo } = fixture(t);
  const status = path.join(run, 'status.json');
  for (const record of [{}, { repo: '.' }]) {
    fs.writeFileSync(status, JSON.stringify(record), 'utf8');
    refusal(await exportTo('decision.md'), /absolute repository root in status\.json/);
  }
  assert.deepEqual(fs.readdirSync(repo), []);
});

test('export creates nested parents even after events.jsonl was pruned', async (t) => {
  const { exportTo, repo, run } = fixture(t);
  fs.unlinkSync(path.join(run, 'events.jsonl'));
  const destination = path.join('docs', 'plans', 'decision.md');
  const result = await exportTo(destination);
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(fs.readFileSync(path.join(repo, destination)), reportBytes);
  assert.ok(!fs.existsSync(path.join(run, 'events.jsonl')));
});
