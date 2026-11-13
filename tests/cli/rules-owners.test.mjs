/** Verifies shared rules ownership survives concurrent registry updates. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { installRecordPath, readInstallRecord } from '../../cli/install-record.mjs';
import { install } from '../../cli/install.mjs';
import { update } from '../../cli/update.mjs';
import { fixture } from './host-fixture.mjs';
import {
  addRulesOwner,
  removeRulesOwner,
  rulesRegistryPath,
  isLockTaken,
  normalizedRulesOwner,
  readRulesRegistry,
} from '../../cli/rules-owners.mjs';

test('concurrent owner registrations retain every owner', async (t) => {
  const root = makeTempTree('bridge-rules-owners-');
  t.after(() => removeTempTree(root));
  const codexRulesDir = path.join(root, 'codex-home', 'rules');
  const hosts = ['first-host', 'second-host'].map((name) => ({
    root: path.join(root, name),
    brandRoot: path.join(root, 'brand'),
    codexRulesDir,
  }));

  await Promise.all(hosts.map((host) => addRulesOwner(host)));

  const registry = await readRulesRegistry(hosts[0]);
  assert.equal(registry.owners.length, hosts.length);
  for (const host of hosts) assert.ok(registry.owners.includes(normalizedRulesOwner(host)));
});

test('a lock left behind by a dead process does not block the next owner', async (t) => {
  const root = makeTempTree('bridge-rules-stale-');
  t.after(() => removeTempTree(root));
  const codexRulesDir = path.join(root, 'codex-home', 'rules');
  const host = { root: path.join(root, 'host'), brandRoot: path.join(root, 'brand'), codexRulesDir };

  const lockPath = path.join(codexRulesDir, '.llm-bridge-rules.json.lock');
  await fs.mkdir(codexRulesDir, { recursive: true });
  await fs.writeFile(lockPath, '');
  const longAgo = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, longAgo, longAgo);

  const registry = await addRulesOwner(host);

  assert.deepEqual(registry.owners, [normalizedRulesOwner(host)]);
  await assert.rejects(() => fs.stat(lockPath), { code: 'ENOENT' });
});

// Windows reported EPERM on the lock file twice on 2026-08-11 and the suite went red over a lock
// that was busy for one more millisecond. The race reproduces only by luck, so the contract is
// asserted directly: every code that means "taken" retries, everything else still fails loudly.
test('a taken lock is recognised by every code Windows uses for it', () => {
  for (const code of ['EEXIST', 'EPERM', 'EBUSY']) {
    assert.ok(isLockTaken({ code }), `${code} means the lock is taken, not that the run is broken`);
  }
  for (const code of ['ENOSPC', 'EACCES', 'EROFS', undefined]) {
    assert.equal(isLockTaken({ code }), false, `${code} is a real failure and must not be retried`);
  }
});

test('a lock a live process is holding is waited for, not stolen', async (t) => {
  const root = makeTempTree('bridge-rules-live-lock-');
  t.after(() => removeTempTree(root));
  const codexRulesDir = path.join(root, 'codex-home', 'rules');
  const host = { root: path.join(root, 'host'), brandRoot: path.join(root, 'brand'), codexRulesDir };

  const lockPath = path.join(codexRulesDir, '.llm-bridge-rules.json.lock');
  await fs.mkdir(codexRulesDir, { recursive: true });
  await fs.writeFile(lockPath, '');

  // 200 retries at 5 ms give the holder a full second; release well inside that window.
  const release = setTimeout(() => fs.rm(lockPath, { force: true }), 60);
  t.after(() => clearTimeout(release));
  const registry = await addRulesOwner(host);

  assert.deepEqual(registry.owners, [normalizedRulesOwner(host)]);
});

async function registryFixture(t, registry) {
  const root = makeTempTree('rules-registry-v2-');
  t.after(() => removeTempTree(root));
  const host = { root: path.join(root, 'host'), brandRoot: path.join(root, 'brand'),
    codexRulesDir: path.join(root, 'rules') };
  await fs.mkdir(host.codexRulesDir);
  if (registry) await fs.writeFile(rulesRegistryPath(host), JSON.stringify(registry));
  return host;
}

test('v2 reads expose legacy strings unchanged as owners and retain record paths', async (t) => {
  const host = await registryFixture(t, null);
  const records = [installRecordPath(host)];
  const legacy = ['C:/Unresolved/Host/', 'C:/Unresolved/Host/'];
  const index = { version: 2, records, legacy };
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify(index));
  const before = await fs.readFile(rulesRegistryPath(host));
  assert.deepEqual(await readRulesRegistry(host), { version: 2, owners: legacy, records });
  assert.deepEqual(await fs.readFile(rulesRegistryPath(host)), before);
});

test('v2 registration adds records once, preserves legacy verbatim, and uses lexical identity', async (t) => {
  const host = await registryFixture(t, { version: 2, records: [], legacy: ['C:/Unknown/', 'C:/Unknown/'] });
  const expected = { version: 2, records: [path.resolve(installRecordPath(host))],
    legacy: ['C:/Unknown/', 'C:/Unknown/'] };
  assert.deepEqual(await addRulesOwner(host), { version: 2, records: expected.records, owners: expected.legacy });
  assert.deepEqual(JSON.parse(await fs.readFile(rulesRegistryPath(host))), expected);
  const bytes = await fs.readFile(rulesRegistryPath(host));
  const alias = path.join(host.brandRoot, '..', 'brand', '.installed.json');
  await addRulesOwner({ ...host, brandInstallRecordPath: process.platform === 'win32'
    ? alias.toUpperCase().replaceAll('\\', '/') : alias });
  assert.deepEqual(await fs.readFile(rulesRegistryPath(host)), bytes);
});

test('concurrent v2 registrations retain both bridge-home records without adding legacy hosts', async (t) => {
  const first = await registryFixture(t, { version: 2, records: [], legacy: ['unresolved'] });
  const second = { ...first, root: path.join(first.root, 'second'), brandRoot: path.join(first.brandRoot, 'second') };
  await Promise.all([addRulesOwner(first), addRulesOwner(second)]);
  const registry = await readRulesRegistry(first);
  assert.deepEqual(registry.owners, ['unresolved']);
  assert.deepEqual(new Set(registry.records), new Set([installRecordPath(first), installRecordPath(second)]));
});

test('v2 removal drops only this host legacy string and never a record path', async (t) => {
  const host = await registryFixture(t, null);
  const records = [installRecordPath(host), path.join(host.brandRoot, 'other', '.installed.json')];
  const other = 'C:/Unresolved/Host/';
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({ version: 2, records,
    legacy: [normalizedRulesOwner(host), other, other] }));
  assert.deepEqual(await removeRulesOwner(host), { version: 2, records, owners: [other, other] });
  assert.deepEqual(JSON.parse(await fs.readFile(rulesRegistryPath(host))), { version: 2, records, legacy: [other, other] });
  const before = await fs.readFile(rulesRegistryPath(host));
  await removeRulesOwner(host);
  assert.deepEqual(await fs.readFile(rulesRegistryPath(host)), before);
});

for (const keep of ['record', 'legacy', 'nothing']) {
  test('v2 removal keeps the registry only when it still has ' + keep, async (t) => {
    const host = await registryFixture(t, null);
    const records = keep === 'record' ? [installRecordPath(host)] : [];
    const legacy = [normalizedRulesOwner(host), ...(keep === 'legacy' ? ['unknown'] : [])];
    await fs.writeFile(rulesRegistryPath(host), JSON.stringify({ version: 2, records, legacy }));
    await removeRulesOwner(host);
    assert.deepEqual(await readRulesRegistry(host), keep === 'nothing' ? null
      : { version: 2, records, owners: legacy.slice(1) });
  });
}

for (const registry of [
  { version: 3, owners: [] }, { version: 2, records: [], legacy: null },
  { version: 2, records: ['relative/.installed.json'], legacy: [] },
  { version: 2, records: [path.resolve('wrong.json')], legacy: [] },
  { version: 2, records: null, legacy: [] }, { version: 2, records: [], legacy: [''] },
]) {
  test('invalid registry refuses reads and both mutation helpers: ' + JSON.stringify(registry), async (t) => {
    const host = await registryFixture(t, registry);
    const before = await fs.readFile(rulesRegistryPath(host));
    for (const operation of [readRulesRegistry, addRulesOwner, removeRulesOwner]) {
      await assert.rejects(operation(host), /rules ownership registry/);
      assert.deepEqual(await fs.readFile(rulesRegistryPath(host)), before);
    }
  });
}

test('absent and version-1 registries keep version-1 registration and last-owner removal', async (t) => {
  const host = await registryFixture(t, null);
  assert.equal(await readRulesRegistry(host), null);
  assert.equal(await removeRulesOwner(host), null);
  const expected = { version: 1, owners: [normalizedRulesOwner(host)] };
  assert.deepEqual(await addRulesOwner(host), expected);
  assert.deepEqual(JSON.parse(await fs.readFile(rulesRegistryPath(host))), expected);
  await addRulesOwner(host);
  assert.deepEqual(await removeRulesOwner(host), { version: 1, owners: [] });
  assert.equal(await readRulesRegistry(host), null);
});

test('v2 removal preserves non-exact legacy hints until their ownership can be verified', async (t) => {
  const host = await registryFixture(t, null);
  const key = normalizedRulesOwner(host);
  const legacy = [key.toUpperCase() + '/', 'another-unknown'];
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({ version: 2, records: [], legacy: [key, ...legacy] }));
  assert.deepEqual(await removeRulesOwner(host), { version: 2, records: [], owners: legacy });
  assert.deepEqual(JSON.parse(await fs.readFile(rulesRegistryPath(host))), { version: 2, records: [], legacy });
});

test('install and update preserve an existing v2 index and its unresolved legacy hints', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  const legacy = ['C:/Unresolved/Host/', 'C:/Unresolved/Host/'];
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({ version: 2, records: [], legacy }));
  assert.equal((await install({ host })).exitCode, 0);
  const expected = { version: 2, records: [installRecordPath(host)], legacy };
  assert.deepEqual(JSON.parse(await fs.readFile(rulesRegistryPath(host))), expected);
  assert.equal((await install({ host })).exitCode, 0);
  assert.equal((await update({ host })).exitCode, 0);
  const rulesPath = (await readInstallRecord(host)).rules.path;
  await fs.writeFile(rulesPath, 'operator change');
  assert.equal((await update({ host, force: true })).exitCode, 0);
  assert.deepEqual(await fs.readFile(rulesPath), await fs.readFile('src/codex/rules/llm-bridge.rules'));
  assert.deepEqual(JSON.parse(await fs.readFile(rulesRegistryPath(host))), expected);
});

test('a failed v2 atomic publication leaves the index intact and releases its lock', async (t) => {
  const host = await registryFixture(t, { version: 2, records: [], legacy: ['unresolved'] });
  const before = await fs.readFile(rulesRegistryPath(host));
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === rulesRegistryPath(host)) throw Object.assign(new Error('publication denied'), { code: 'EACCES' });
    return rename(source, target);
  });
  await assert.rejects(addRulesOwner(host), /publication denied/);
  assert.deepEqual(await fs.readFile(rulesRegistryPath(host)), before);
  assert.deepEqual(await fs.readdir(host.codexRulesDir), [path.basename(rulesRegistryPath(host))]);
});
