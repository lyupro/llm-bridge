import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { parseTaskHeader } from '../../src/home/lib/task-header.mjs';
import { orderFromHeader } from '../../src/home/lib/order-schema.mjs';
import { orderOptions } from '../../src/home/lib/runner/order-options.mjs';
import { decisionsPathRefusal } from '../../src/home/lib/order-values.mjs';
import { decisionsLedgerRefusal } from '../../src/home/lib/runner/decisions-ledger.mjs';

function fixture(t) {
  const tree = makeTempTree('decisions-ledger-');
  t.after(() => removeTempTree(tree));
  const repo = path.join(tree, 'repo');
  fs.mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'ledger.md'), '# Decisions\n');
  fs.writeFileSync(path.join(repo, 'docs', 'plans', 'open-work.md'), '# Decisions\n');
  fs.writeFileSync(path.join(tree, 'outside.md'), '# Outside\n');
  return { tree, repo };
}

function link(t, target, destination, type = 'file') {
  try {
    fs.symlinkSync(target, destination, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Platform refuses to create ${type} links: ${error.code}`);
      return false;
    }
    throw error;
  }
}

function settle(repo, decisions, agent = 'codex-advisor') {
  const inputUrl = new URL('../../src/home/lib/runner/task-input.mjs', import.meta.url).href;
  const script = `
    import { settleTaskInput } from ${JSON.stringify(inputUrl)};
    const opts = { agent: ${JSON.stringify(agent)} };
    try {
      const document = settleTaskInput(opts);
      console.log(JSON.stringify({ opts, ...document }));
    } catch (error) { process.exitCode = error.exitCode ?? 1; }
  `;
  const lines = ['order id: ow083-b1', `repository: ${repo}`];
  if (agent === 'codex-advisor') lines.push('phase: scope');
  if (agent === 'codex-build') lines.push('scope: src/**', 'advice: mechanical');
  if (decisions !== undefined) lines.push(`decisions: ${decisions}`);
  const input = lines.join('\n') + '\n\nInspect the plan.\n';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input, encoding: 'utf8', windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}

for (const value of ['ledger.md', 'docs/plans/open-work.md', './docs//plans/open-work.md']) {
  test(`accepts and transports one readable ledger: ${value}`, (t) => {
    const { repo } = fixture(t);
    assert.equal(decisionsLedgerRefusal(repo, value), null);
    const result = settle(repo, value);
    assert.equal(result.status, 0, result.stderr);
    const { opts, header, task } = JSON.parse(result.stdout);
    assert.equal(opts.decisions, path.posix.normalize(value));
    assert.equal(header.grant, null);
    assert.equal(task, 'Inspect the plan.');
  });
}

const malformed = [
  '/ledger.md', '\\ledger.md', 'C:/ledger.md', 'C:\\ledger.md', 'C:ledger.md',
  '//host/share/ledger.md', '\\\\host\\share\\ledger.md', '../outside.md',
  'docs/../ledger.md', 'docs/plans/../../ledger.md', 'docs\\plans\\open-work.md',
  '*.md', 'docs/?.md', 'docs/[ab].md', 'docs/{a,b}.md', 'ledger.md,outside.md',
  'ledger.md outside.md', 'ledger.md\toutside.md', 'ledger.md:12', 'ledger.md:stream',
  'ledger.md/',
];
for (const value of malformed) {
  test(`refuses malformed ledger before start: ${JSON.stringify(value)}`, (t) => {
    const { repo } = fixture(t);
    assert.match(decisionsPathRefusal(value), /exactly one repository-relative file path/);
    assert.equal(decisionsLedgerRefusal(repo, value), decisionsPathRefusal(value));
    const result = settle(repo, value);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /`decisions:`/);
    assert.match(result.stderr, /exactly one repository-relative file path/);
    assert.equal(fs.existsSync(path.join(repo, 'runs')), false);
  });
}

test('non-string and empty ledger values are not valid paths', () => {
  for (const value of [undefined, null, 42, '', ' ', '\n', '\0']) {
    assert.match(decisionsPathRefusal(value), /exactly one repository-relative file path/);
  }
});

for (const value of ['docs', 'missing.md']) {
  test(`refuses a non-file ledger before start: ${value}`, (t) => {
    const { repo } = fixture(t);
    assert.match(decisionsLedgerRefusal(repo, value), /regular readable file/);
    const result = settle(repo, value);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /`decisions:`.*regular readable file/);
    assert.match(result.stderr, /The run folder was not created; quota was not spent\./);
  });
}

test('refuses an unreadable regular file', (t) => {
  const { repo } = fixture(t);
  const access = t.mock.method(fs, 'accessSync', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  assert.match(decisionsLedgerRefusal(repo, 'ledger.md'), /regular readable file/);
  assert.equal(access.mock.calls.length, 1);
  assert.equal(access.mock.calls[0].arguments[1], fs.constants.R_OK);
});

for (const outside of [false, true]) {
  test(`${outside ? 'refuses an escaping' : 'accepts an in-repository'} file symlink`, (t) => {
    const { tree, repo } = fixture(t);
    const target = path.join(outside ? tree : repo, outside ? 'outside.md' : 'ledger.md');
    if (!link(t, target, path.join(repo, 'linked.md'))) return;
    const result = settle(repo, 'linked.md');
    if (outside) {
      assert.match(decisionsLedgerRefusal(repo, 'linked.md'), /after resolving links/);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /The run folder was not created; quota was not spent\./);
    } else {
      assert.equal(decisionsLedgerRefusal(repo, 'linked.md'), null);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).opts.decisions, 'linked.md');
    }
  });
}

for (const outside of [false, true]) {
  test(`${outside ? 'refuses an escaping' : 'accepts an in-repository'} linked parent folder`, (t) => {
    const { tree, repo } = fixture(t);
    const target = outside ? tree : path.join(repo, 'docs');
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    if (!link(t, target, path.join(repo, 'linked-folder'), type)) return;
    const value = outside ? 'linked-folder/outside.md' : 'linked-folder/plans/open-work.md';
    const result = settle(repo, value);
    assert.equal(result.status, outside ? 2 : 0, result.stderr);
    if (outside) assert.match(result.stderr, /after resolving links/);
    else assert.equal(JSON.parse(result.stdout).opts.decisions, value);
  });
}

for (const agent of ['codex-build', 'codex-scout', 'codex-review']) {
  test(`${agent} refuses decisions through the existing agent rule`, (t) => {
    const { repo } = fixture(t);
    const parsed = parseTaskHeader('order id: ow083-b1\nscope: src/**\ndecisions: ledger.md\n\nTask');
    const { order, problems } = orderFromHeader(agent, parsed);
    assert.equal(order.has('decisions'), false);
    assert.ok(problems.some(({ reason }) => reason === `label "decisions" is not accepted by ${agent}`));
    const result = settle(repo, 'ledger.md', agent);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`label "decisions" is not accepted by ${agent}`));
  });
}

test('absent decisions is null in order options and settled input', (t) => {
  const { repo } = fixture(t);
  const normalized = orderOptions('codex-advisor', new Map([['order id', 'ow083-b1']]));
  assert.equal(normalized.options.decisions, null);
  assert.deepEqual(normalized.problems, []);
  const result = settle(repo, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).opts.decisions, null);
});
