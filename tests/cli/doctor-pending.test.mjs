/** Guards raw-record pending diagnostics and stored-root recoveries required by Plan_83 D4/D5. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pendingInstallChecks } from '../../cli/doctor-pending.mjs';
import { diagnose } from '../../cli/doctor.mjs';
import {
  INSTALL_METHOD_COPY, INSTALL_METHOD_KEY, installRecordPath, readInstallRecord,
} from '../../cli/install-record.mjs';
import { validatePending, withPending } from '../../cli/install-pending.mjs';
import { rulesRegistryPath } from '../../cli/rules-owners.mjs';
import { codexProbe, hostFixture, ownPackage } from './doctor-fixtures.mjs';

const startedAt = '2026-11-13T20:15:00.000Z';
const later = '2026-11-13T20:20:00Z';
const bridgeProbe = () => ({ available: true, value: 'test' });

function scaffold() {
  return {
    format: 2, name: ownPackage.name, [INSTALL_METHOD_KEY]: INSTALL_METHOD_COPY,
    inventory: 'incomplete', owners: {},
    image: { version: ownPackage.version, installedAt: startedAt, files: [] },
  };
}

async function writeRecord(host, record) {
  await fs.mkdir(path.dirname(installRecordPath(host)), { recursive: true });
  await fs.writeFile(installRecordPath(host), `${JSON.stringify(record)}\n`);
}

function expected(entry, own = false) {
  return {
    key: 'pending install', status: 'warn',
    value: `Unfinished ${entry.command} for ${entry.root}${own ? ' (this host)' : ''}; started at ${entry.startedAt};`
      + ` complete it: llm-bridge ${entry.command} --host "${entry.root}";`
      + ` or remove it: llm-bridge uninstall --host "${entry.root}".`,
  };
}

test('no pending field produces no check', async (t) => {
  const host = await hostFixture(t);
  await writeRecord(host, scaffold());
  assert.deepEqual(await pendingInstallChecks(host), []);
});

test('own install entry names this host, its time, and both recoveries without writing', async (t) => {
  const host = await hostFixture(t);
  await writeRecord(host, withPending(scaffold(), host, 'install', startedAt));
  const before = await fs.readFile(installRecordPath(host));
  assert.deepEqual(await pendingInstallChecks(host), [expected({ ...host, command: 'install', startedAt }, true)]);
  assert.deepEqual(await fs.readFile(installRecordPath(host)), before);
});

test('foreign update recovery retains the stored mixed-case root and spaces', async (t) => {
  const host = await hostFixture(t);
  const foreign = { root: path.join(host.root, 'Mixed Case', '.claude') };
  await writeRecord(host, withPending(scaffold(), foreign, 'update', startedAt));
  const checks = await pendingInstallChecks(host);
  assert.deepEqual(checks, [expected({ ...foreign, command: 'update', startedAt })]);
  assert.ok(checks[0].value.includes(`llm-bridge update --host "${foreign.root}"`));
  assert.doesNotMatch(checks[0].value, /this host|llm-bridge install --host/);
});

test('two entries produce separate checks with their own commands, roots, and times', async (t) => {
  const host = await hostFixture(t);
  const foreign = { root: path.join(host.root, 'Other Host') };
  const record = withPending(withPending(scaffold(), host, 'install', startedAt), foreign, 'update', later);
  await writeRecord(host, record);
  assert.deepEqual(await pendingInstallChecks(host), [
    expected({ ...host, command: 'install', startedAt }, true),
    expected({ ...foreign, command: 'update', startedAt: later }),
  ]);
});

test('own-host label uses normalized identity while commands keep the stored root', async (t) => {
  const host = await hostFixture(t);
  const alias = { root: host.root + '/./' };
  await writeRecord(host, withPending(scaffold(), alias, 'update', startedAt));
  assert.deepEqual(await pendingInstallChecks(host), [expected({ ...alias, command: 'update', startedAt }, true)]);
});

for (const pending of [false, {}, { invalid: { command: 'install' } }]) {
  test(`malformed pending ${JSON.stringify(pending)} produces one validator warning`, async (t) => {
    const host = await hostFixture(t);
    const record = { ...scaffold(), pending };
    await writeRecord(host, record);
    let message;
    assert.throws(() => validatePending(record), (err) => {
      message = err.message;
      return /pending field is invalid/.test(message);
    });
    assert.deepEqual(await pendingInstallChecks(host), [{ key: 'pending install', status: 'warn', value: message }]);
  });
}

test('absent record produces no check and is not created', async (t) => {
  const host = await hostFixture(t);
  assert.deepEqual(await pendingInstallChecks(host), []);
  await assert.rejects(fs.access(installRecordPath(host)), { code: 'ENOENT' });
});

test('unparseable record produces no duplicate check', async (t) => {
  const host = await hostFixture(t);
  await fs.mkdir(path.dirname(installRecordPath(host)), { recursive: true });
  await fs.writeFile(installRecordPath(host), '{bad JSON');
  assert.deepEqual(await pendingInstallChecks(host), []);
});

test('unreadable record produces no duplicate check', async (t) => {
  const host = await hostFixture(t);
  const target = installRecordPath(host);
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === target) throw Object.assign(new Error('record access denied'), { code: 'EACCES' });
    return readFile(file, ...args);
  });
  assert.deepEqual(await pendingInstallChecks(host), []);
});

test('diagnose reports an ownerless pending record absent from the rules index', async (t) => {
  const host = await hostFixture(t);
  await writeRecord(host, withPending(scaffold(), host, 'install', startedAt));
  assert.equal(await readInstallRecord(host), null);
  await assert.rejects(fs.access(rulesRegistryPath(host)), { code: 'ENOENT' });
  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.filter(({ key }) => key === 'pending install'), [
    expected({ ...host, command: 'install', startedAt }, true),
  ]);
  const rulesIndex = result.checks.findIndex(({ key }) => key === 'rules');
  assert.deepEqual(result.checks.slice(rulesIndex, rulesIndex + 3).map(({ key }) => key),
    ['rules', 'pending install', 'claudeRules']);
});
