/** Guards explicit pending-host recovery without certifying foreign users (Plan_83 D1/D5). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, allFiles } from './host-fixture.mjs';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { inspectHost, hasPackageMarks } from '../../cli/host-inspection.mjs';
import { inspectPermissions } from '../../cli/permissions.mjs';
import { readInstallRecordFile, installRecordPath } from '../../cli/install-record.mjs';
import { withPending, hasOwnPending } from '../../cli/install-pending.mjs';
import { withoutOwner, validateFormat2 } from '../../cli/install-owners.mjs';
import { rulesRegistryPath } from '../../cli/rules-owners.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';

const startedAt = '2026-11-13T19:00:00.000Z';

async function pendingFixture(t, { owner = false, absent = false, foreign = false } = {}) {
  const state = await fixture(t);
  const { host, root } = state;
  await install({ host });
  let record = withPending(await readInstallRecordFile(host), host, 'install', startedAt);
  const ownRow = record.owners[normalizeRepoPath(host.root)];
  const rules = ownRow.rules;
  const image = path.join(host.brandRoot, record.image.files.find((file) => file.path.endsWith('.mjs')).path);
  // Plan_65 D12: ownerless inventory is incomplete even when its image bytes are known.
  if (!owner) record = withoutOwner({ ...record, inventory: 'incomplete' }, host);
  const other = resolveHost({ host: path.join(root, 'Other-Host'),
    codexHome: path.join(root, 'codex-home'), brandRoot: host.brandRoot });
  if (foreign) record = withPending(record, other, 'update', startedAt);
  await fs.writeFile(installRecordPath(host), `${JSON.stringify(validateFormat2(record), null, 2)}\n`);
  if (absent) await fs.rename(host.root, path.join(root, 'saved-host'));
  return { ...state, other, rules, image, record };
}

async function assertPendingGone(host) {
  assert.equal(hasOwnPending(await readInstallRecordFile(host), host), false);
}

async function assertAbsent(host) {
  await assert.rejects(fs.access(host.root), { code: 'ENOENT' });
  await assert.rejects(fs.access(host.settingsPath), { code: 'ENOENT' });
}

async function treeBytes(root) {
  const entries = await allFiles(root);
  return Promise.all(entries.map(async (file) => [file, await fs.readFile(path.join(root, file), 'base64')]));
}

function assertNamedRecovery(output, other) {
  assert.ok(output.includes(`llm-bridge uninstall --host "${other.root}"`));
  assert.ok(output.includes(`llm-bridge install --host "${other.root}"`));
  const line = output.split('\n').find((text) => text.includes('the shared image in'));
  assert.ok(line.includes(other.root));
  assert.doesNotMatch(line, /inventory is incomplete/);
}

test('pending host without an owner row removes its marks and permissions successfully', async (t) => {
  const { host } = await pendingFixture(t);
  assert.equal(hasPackageMarks(await inspectHost(host)), true);
  assert.ok((await inspectPermissions(host.settingsPath)).present > 0);
  const result = await uninstall({ host, isTTY: true, prompt: async () => 'yes' });
  assert.equal(result.exitCode, 0, result.output);
  assert.doesNotMatch(result.output, /is not installed/);
  assert.equal(hasPackageMarks(await inspectHost(host)), false);
  assert.equal((await inspectPermissions(host.settingsPath)).present, 0);
  await assertPendingGone(host);
});

// Plan_83 D5 pre-mortem 3: an explicit absent-host recovery must never recreate its settings.
for (const owner of [false, true]) {
  test(`missing pending host is detached without creating its folder (owner row: ${owner})`, async (t) => {
    const { host } = await pendingFixture(t, { owner, absent: true });
    await assertAbsent(host);
    const result = await uninstall({ host, isTTY: true, prompt: async () => 'yes' });
    assert.equal(result.exitCode, 0, result.output);
    assert.doesNotMatch(result.output, /is not installed/);
    await assertAbsent(host);
    await assertPendingGone(host);
  });
}

for (const owner of [false, true]) {
  test(`foreign pending retains image and rules while own entry departs (owner row: ${owner})`, async (t) => {
    const { host, other, rules, image, record } = await pendingFixture(t, { owner, foreign: true });
    const imageBefore = await fs.readFile(image);
    const rulesBefore = await fs.readFile(rules.path);
    const result = await uninstall({ host });
    assert.notEqual(result.exitCode, 0);
    assertNamedRecovery(result.output, other);
    const after = await readInstallRecordFile(host);
    assert.equal(hasOwnPending(after, host), false);
    assert.deepEqual(after.pending, { [normalizeRepoPath(other.root)]: record.pending[normalizeRepoPath(other.root)] });
    assert.equal(Object.hasOwn(after.owners, normalizeRepoPath(host.root)), false);
    assert.deepEqual(await fs.readFile(image), imageBefore);
    assert.deepEqual(await fs.readFile(rules.path), rulesBefore);
    assert.equal(hasPackageMarks(await inspectHost(host)), false);
  });
}

for (const owner of [false, true]) {
  test(`unreadable settings keep own pending and owner evidence (owner row: ${owner})`, async (t) => {
    const { host, record, image } = await pendingFixture(t, { owner });
    await fs.rename(host.settingsPath, `${host.settingsPath}.saved`);
    await fs.mkdir(host.settingsPath);
    const imageBefore = await fs.readFile(image);
    const result = await uninstall({ host });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.output, /could not be read|still has its hooks/);
    assert.deepEqual(await readInstallRecordFile(host), record);
    assert.deepEqual(await fs.readFile(image), imageBefore);
  });
}

for (const absent of [false, true]) {
  test(`dry run describes pending recovery without writes (absent: ${absent})`, async (t) => {
    const { root, host } = await pendingFixture(t, { absent });
    const before = await treeBytes(root);
    const result = await uninstall({ host, dryRun: true });
    assert.equal(result.exitCode, 1, result.output);
    assert.ok(result.output.includes(`Would remove the pending entry for ${host.root}`));
    assert.deepEqual(await treeBytes(root), before);
    if (absent) await assertAbsent(host);
  });
}

test('dry run names foreign recovery and keeps all evidence unchanged', async (t) => {
  const { root, host, other } = await pendingFixture(t, { owner: true, foreign: true });
  const before = await treeBytes(root);
  const result = await uninstall({ host, dryRun: true });
  assert.notEqual(result.exitCode, 0);
  assertNamedRecovery(result.output, other);
  assert.match(result.output, /Would leave .*cannot be verified/);
  assert.deepEqual(await treeBytes(root), before);
});

test('departing own pending does not prevent removal of its unchanged sole-owner rules', async (t) => {
  const { host, rules } = await pendingFixture(t, { owner: true });
  const preview = await uninstall({ host, dryRun: true });
  assert.match(preview.output, /Would remove .*llm-bridge\.rules/);
  const result = await uninstall({ host });
  assert.equal(result.exitCode, 0, result.output);
  await assert.rejects(fs.access(rules.path), { code: 'ENOENT' });
  await assertPendingGone(host);
});

test('an orphan foreign entry keeps the image even when the operator answers yes', async (t) => {
  const { host, other, image, record, rules } = await pendingFixture(t, { foreign: true });
  delete record.pending[normalizeRepoPath(host.root)];
  await fs.writeFile(installRecordPath(host), `${JSON.stringify(validateFormat2(record), null, 2)}\n`);
  let calls = 0;
  const result = await uninstall({ host, isTTY: true, prompt: async () => { calls++; return 'yes'; } });
  assert.equal(calls, 1);
  assert.notEqual(result.exitCode, 0);
  assertNamedRecovery(result.output, other);
  assert.deepEqual(await readInstallRecordFile(host), record);
  await fs.access(image);
  await fs.access(rules.path);
});

test('recovering pending publishes entry and owner removal together while another owner remains', async (t) => {
  const { host, other } = await pendingFixture(t, { owner: true });
  await install({ host: other });
  const publications = [];
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target, ...args) => {
    if (target === installRecordPath(host)) publications.push(JSON.parse(await fs.readFile(source, 'utf8')));
    return rename(source, target, ...args);
  });
  const result = await uninstall({ host });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(publications.length, 1);
  assert.equal(hasOwnPending(publications[0], host), false);
  assert.equal(Object.hasOwn(publications[0].owners, normalizeRepoPath(host.root)), false);
  const after = await readInstallRecordFile(host);
  assert.equal(Object.hasOwn(after.owners, normalizeRepoPath(host.root)), false);
  assert.equal(Object.hasOwn(after.owners, normalizeRepoPath(other.root)), true);
  assert.equal(Object.hasOwn(after, 'pending'), false);
});

// Plan_83 D1/D5: hints are an index, never permission to ignore the record's foreign evidence.
for (const registry of ['legacy', 'empty', 'missing']) {
  test(`foreign pending preserves rules with a ${registry} rules index`, async (t) => {
    const { host, other, rules } = await pendingFixture(t, { owner: true, foreign: true });
    const target = rulesRegistryPath(host);
    if (registry === 'missing') await fs.rename(target, `${target}.saved`);
    else await fs.writeFile(target, JSON.stringify(registry === 'legacy'
      ? { version: 1, owners: [normalizeRepoPath(host.root)] }
      : { version: 2, records: [], legacy: [] }));
    const before = await fs.readFile(rules.path);
    const preview = await uninstall({ host, dryRun: true });
    assert.match(preview.output, /Would leave .*pending hosts/);
    const result = await uninstall({ host });
    assert.notEqual(result.exitCode, 0);
    assertNamedRecovery(result.output, other);
    assert.deepEqual(await fs.readFile(rules.path), before);
    await assertPendingGone(host);
  });
}

for (const owner of [false, true]) {
  test(`absent host recovery retains foreign intent without recreating settings (owner row: ${owner})`, async (t) => {
    const { host, other } = await pendingFixture(t, { owner, absent: true, foreign: true });
    const result = await uninstall({ host });
    assert.notEqual(result.exitCode, 0);
    assertNamedRecovery(result.output, other);
    await assertAbsent(host);
    const after = await readInstallRecordFile(host);
    assert.equal(hasOwnPending(after, host), false);
    assert.equal(hasOwnPending(after, other), true);
  });
}

test('pending-only recovery without inventory consent clears intent while keeping the unknown image', async (t) => {
  const { host, image } = await pendingFixture(t);
  const result = await uninstall({ host, isTTY: false });
  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(result.output, /is not installed/);
  await assertPendingGone(host);
  await fs.access(image);
  assert.equal((await readInstallRecordFile(host)).inventory, 'incomplete');
});

test('failed record publication keeps the departing owner row and intent together', async (t) => {
  const { host, other } = await pendingFixture(t, { owner: true });
  await install({ host: other });
  const before = await readInstallRecordFile(host);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target, ...args) => {
    if (target === installRecordPath(host)) throw new Error('forced pending departure publication failure');
    return rename(source, target, ...args);
  });
  const result = await uninstall({ host });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /forced pending departure publication failure/);
  assert.deepEqual(await readInstallRecordFile(host), before);
});
