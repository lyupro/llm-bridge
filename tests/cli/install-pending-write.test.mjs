/** Plan_83 D4/D5: intent survives crashes and only the completing host can clear it. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { update } from '../../cli/update.mjs';
import { buildInstallPlan, fileFingerprint, readInstallRecord } from '../../cli/manifest.mjs';
import { publishInstallRecordOnly, readInstallRecordFile, writeInstallRecord } from '../../cli/install-record.mjs';
import { validateFormat2 } from '../../cli/install-owners.mjs';
import { withPending } from '../../cli/install-pending.mjs';
import { syncOtherOwners } from '../../cli/owner-sync-apply.mjs';
import { RULES_REGISTRY_NAME } from '../../cli/rules-owners.mjs';
import { fixture, formatOneRecord } from './host-fixture.mjs';

const env = { PATH: '' };
const key = (host) => normalizeRepoPath(host.root);
const startedAt = '2026-11-13T20:15:00.000Z';

function foreignHost(root, host, name = 'ForeignMixedCase') {
  return resolveHost({ host: path.join(root, name), brandRoot: host.brandRoot,
    codexHome: path.dirname(host.codexRulesDir) });
}

async function mark(host, command = 'install') {
  await publishInstallRecordOnly(host, withPending(await readInstallRecordFile(host), host, command, startedAt));
}

function publications(t, host) {
  const snapshots = [];
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target, ...args) => {
    if (target === host.brandInstallRecordPath) {
      const record = JSON.parse(await fs.readFile(source, 'utf8'));
      validateFormat2(record);
      snapshots.push(record);
    }
    return rename(source, target, ...args);
  });
  return snapshots;
}

test('first install publishes a valid ownerless scaffold before its first change, then completes it', async (t) => {
  const { host } = await fixture(t);
  const snapshots = publications(t, host);
  const writeFile = fs.writeFile;
  let checked = false;
  t.mock.method(fs, 'writeFile', async (target, ...args) => {
    if (String(target).includes(RULES_REGISTRY_NAME) && String(target).endsWith('.tmp')) {
      checked = true;
      assert.equal(snapshots.length, 1);
      assert.equal((await readInstallRecordFile(host)).pending[key(host)].command, 'install');
      await assert.rejects(fs.access(host.settingsPath), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.join(host.brandRoot, 'lib')), { code: 'ENOENT' });
    }
    return writeFile(target, ...args);
  });
  assert.equal((await install({ host, env })).exitCode, 0);
  assert.equal(checked, true);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0].owners, {});
  assert.deepEqual(snapshots[0].image.files, []);
  assert.equal(snapshots[0].inventory, 'incomplete');
  const entry = snapshots[0].pending[key(host)];
  assert.equal(entry.root, host.root);
  assert.equal(entry.startedAt, new Date(entry.startedAt).toISOString());
  assert.equal(snapshots[1].pending, undefined);
  assert.ok(snapshots[1].owners[key(host)]);
  assert.equal(snapshots[1].inventory, 'complete');
});

test('failure at the first registry change leaves the published install entry and no owner', async (t) => {
  const { host } = await fixture(t);
  const writeFile = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (target, ...args) => {
    if (String(target).includes(RULES_REGISTRY_NAME) && String(target).endsWith('.tmp')) {
      assert.equal((await readInstallRecordFile(host)).pending[key(host)].command, 'install');
      throw new Error('forced registry failure');
    }
    return writeFile(target, ...args);
  });
  await assert.rejects(install({ host, env }), /forced registry failure/);
  const record = validateFormat2(await readInstallRecordFile(host));
  assert.equal(record.pending[key(host)].command, 'install');
  assert.deepEqual(record.owners, {});
  await assert.rejects(fs.access(host.settingsPath), { code: 'ENOENT' });
});

test('a later copy failure retains install evidence after the registry was published', async (t) => {
  const { host } = await fixture(t);
  const item = (await buildInstallPlan(host))[0];
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target, ...args) => {
    if (target === item.target) throw new Error('forced copy failure');
    return rename(source, target, ...args);
  });
  await assert.rejects(install({ host, env }), /forced copy failure/);
  assert.equal((await readInstallRecordFile(host)).pending[key(host)].command, 'install');
  await fs.access(path.join(host.codexRulesDir, RULES_REGISTRY_NAME));
});

test('successful install clears only its own entry and reports each foreign entry with stored roots', async (t) => {
  const { root, host } = await fixture(t);
  await install({ host, env });
  const a = foreignHost(root, host);
  const c = foreignHost(root, host, 'OtherMixedCase');
  await mark(a, 'update');
  await mark(c);
  await mark(host);
  const before = await readInstallRecordFile(host);
  const result = await install({ host, env });
  const after = await readInstallRecordFile(host);
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.startsWith('Installed '));
  assert.deepEqual(after.pending, { [key(a)]: before.pending[key(a)], [key(c)]: before.pending[key(c)] });
  for (const other of [a, c]) {
    const line = result.output.split('\n').filter((value) => value.startsWith('Pending ')
      && value.includes(other.root));
    assert.equal(line.length, 1);
    assert.ok(line[0].includes(before.pending[key(other)].command));
    assert.ok(line[0].includes(`llm-bridge install --host "${other.root}"`));
    assert.ok(line[0].includes(`llm-bridge uninstall --host "${other.root}"`));
  }
});

test('B no-op install with A pending remains already-installed and exits zero without publishing', async (t) => {
  const { root, host } = await fixture(t);
  await install({ host, env });
  const a = foreignHost(root, host);
  await mark(a, 'update');
  const before = await fs.readFile(host.brandInstallRecordPath);
  const snapshots = publications(t, host);
  const result = await install({ host, env });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^llm-bridge is already installed; nothing to do\./);
  assert.ok(result.output.includes(`Pending update for ${a.root};`));
  assert.deepEqual(await fs.readFile(host.brandInstallRecordPath), before);
  assert.equal(snapshots.length, 0);
});

test('own pending disables no-op install and completion clears it', async (t) => {
  const { host } = await fixture(t);
  await install({ host, env });
  await mark(host);
  const snapshots = publications(t, host);
  const result = await install({ host, env });
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.startsWith('Installed '));
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].pending[key(host)].command, 'install');
  assert.equal(snapshots[1].pending, undefined);
});

test('update keeps the same update ticket through nested install until its own completion', async (t) => {
  const { root, host } = await fixture(t);
  await install({ host, env });
  const a = foreignHost(root, host);
  await mark(a);
  await mark(host, 'install');
  const foreign = (await readInstallRecordFile(host)).pending[key(a)];
  const snapshots = publications(t, host);
  const result = await update({ host, env });
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.startsWith('Updated llm-bridge.'));
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[0].pending[key(host)].command, 'update');
  assert.deepEqual(snapshots[1].pending[key(host)], snapshots[0].pending[key(host)]);
  assert.deepEqual(snapshots[2].pending, { [key(a)]: foreign });
  assert.equal(result.output.split('\n').filter((line) => line.startsWith('Pending ')).length, 1);
});

test('failed nested install leaves update ticket intact', async (t) => {
  const { host } = await fixture(t);
  await install({ host, env });
  const item = (await buildInstallPlan(host))[0];
  await fs.writeFile(item.target, 'operator change\n');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target, ...args) => {
    if (target === item.target) {
      assert.equal((await readInstallRecordFile(host)).pending[key(host)].command, 'update');
      throw new Error('forced nested failure');
    }
    return rename(source, target, ...args);
  });
  await assert.rejects(update({ host, env, force: true }), /forced nested failure/);
  assert.equal((await readInstallRecordFile(host)).pending[key(host)].command, 'update');
});

test('B no-op update remains up to date with A pending and reports recovery', async (t) => {
  const { root, host } = await fixture(t);
  await install({ host, env });
  const a = foreignHost(root, host);
  await mark(a);
  const before = await fs.readFile(host.brandInstallRecordPath);
  const result = await update({ host, env });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^llm-bridge is up to date/);
  assert.ok(result.output.includes(`Pending install for ${a.root};`));
  assert.deepEqual(await fs.readFile(host.brandInstallRecordPath), before);
});

test('owner synchronization from B updates A but preserves A pending', async (t) => {
  const { root, host: b } = await fixture(t);
  const a = foreignHost(root, b);
  await install({ host: a, env });
  await install({ host: b, env });
  const agent = (await buildInstallPlan(a)).find((item) => item.root === 'claude');
  await fs.writeFile(agent.target, 'old recorded agent\n');
  const record = await readInstallRecordFile(a);
  record.owners[key(a)].fingerprints.claude[agent.relativeToRoot] = await fileFingerprint(agent.target);
  const pending = withPending(record, a, 'install', startedAt);
  await publishInstallRecordOnly(a, pending);
  const snapshots = publications(t, a);
  const result = await syncOtherOwners(b, { env });
  assert.equal(result.complete, true);
  assert.ok(result.lines.some((line) => line.startsWith('Updated 1 file(s)')));
  assert.ok(snapshots.length > 0);
  for (const snapshot of snapshots) assert.deepEqual(snapshot.pending, pending.pending);
  assert.equal((await readInstallRecordFile(a)).pending[key(a)].startedAt, startedAt);
});

test('generic writer preserves all entries; explicit completion removes only the publishing host', async (t) => {
  const { root, host } = await fixture(t);
  await install({ host, env });
  const a = foreignHost(root, host);
  await mark(host);
  await mark(a, 'update');
  const before = await readInstallRecordFile(host);
  const row = await readInstallRecord(host);
  await writeInstallRecord(host, row);
  assert.deepEqual((await readInstallRecordFile(host)).pending, before.pending);
  await writeInstallRecord(host, row, { completes: true });
  assert.deepEqual((await readInstallRecordFile(host)).pending, { [key(a)]: before.pending[key(a)] });
});

test('legacy migration preserves foreign pending through the generic writer', async (t) => {
  const { root, host } = await fixture(t);
  await install({ host, env });
  const a = foreignHost(root, host);
  const legacy = withPending(await formatOneRecord(host), a, 'update', startedAt);
  await publishInstallRecordOnly(host, legacy);
  await writeInstallRecord(host, await readInstallRecord(host));
  assert.deepEqual((await readInstallRecordFile(host)).pending, legacy.pending);
});

for (const command of [install, update]) {
  test(`${command.name} dry-run and refused conflict preserve pending and publish nothing`, async (t) => {
    const { host } = await fixture(t);
    await install({ host, env });
    await mark(host);
    const before = await fs.readFile(host.brandInstallRecordPath);
    const snapshots = publications(t, host);
    assert.equal((await command({ host, env, dryRun: true })).exitCode, 0);
    const item = (await buildInstallPlan(host))[0];
    await fs.writeFile(item.target, 'operator conflict\n');
    assert.equal((await command({ host, env })).exitCode, 1);
    assert.deepEqual(await fs.readFile(host.brandInstallRecordPath), before);
    assert.equal(snapshots.length, 0);
  });
}

test('update recovering a missing record publishes only update tickets through nested install', async (t) => {
  const { host } = await fixture(t);
  await install({ host, env });
  await fs.rename(host.brandInstallRecordPath, host.brandInstallRecordPath + '.saved');
  const snapshots = publications(t, host);
  assert.equal((await update({ host, env, isTTY: false })).exitCode, 0);
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[0].pending[key(host)].command, 'update');
  assert.deepEqual(snapshots[0].owners, {});
  assert.deepEqual(snapshots[1].pending, snapshots[0].pending);
  assert.equal(snapshots[2].pending, undefined);
});

test('update publishes before orphan cleanup and cleanup failure retains its ticket', async (t) => {
  const { host } = await fixture(t);
  await install({ host, env });
  const orphan = path.join(host.root, 'obsolete.txt');
  await fs.writeFile(orphan, 'old package file\n');
  const record = await readInstallRecordFile(host);
  const owner = record.owners[key(host)];
  owner.files.push({ root: 'claude', path: 'obsolete.txt' });
  owner.fingerprints.claude['obsolete.txt'] = await fileFingerprint(orphan);
  await publishInstallRecordOnly(host, record);
  const rm = fs.rm;
  let checked = false;
  t.mock.method(fs, 'rm', async (target, ...args) => {
    if (target === orphan) {
      checked = true;
      assert.equal((await readInstallRecordFile(host)).pending[key(host)].command, 'update');
      throw new Error('forced cleanup failure');
    }
    return rm(target, ...args);
  });
  await assert.rejects(update({ host, env }), /forced cleanup failure/);
  assert.equal(checked, true);
  assert.equal((await readInstallRecordFile(host)).pending[key(host)].command, 'update');
  assert.equal(await fs.readFile(orphan, 'utf8'), 'old package file\n');
});

for (const command of [install, update]) {
  test(`${command.name} completing publication failure leaves the prior pending record`, async (t) => {
    const { host } = await fixture(t);
    await install({ host, env });
    await mark(host);
    const rename = fs.rename;
    let checked = false;
    t.mock.method(fs, 'rename', async (source, target, ...args) => {
      if (target === host.brandInstallRecordPath) {
        const next = JSON.parse(await fs.readFile(source, 'utf8'));
        if (!next.pending?.[key(host)]) {
          checked = true;
          throw new Error('forced completing publication failure');
        }
      }
      return rename(source, target, ...args);
    });
    await assert.rejects(command({ host, env }), /forced completing publication failure/);
    assert.equal(checked, true);
    const record = validateFormat2(await readInstallRecordFile(host));
    assert.equal(record.pending[key(host)].command, command.name);
  });
}
