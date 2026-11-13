/** Plan_65 B20a: exact dry-run rules decisions stay shared with purge, without installing a host. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { installRecordPath } from '../../cli/install-record.mjs';
import { withOwner } from '../../cli/install-owners.mjs';
import { fileFingerprint } from '../../cli/manifest.mjs';
import { rulesDryRunLines } from '../../cli/uninstall-rules.mjs';

const rulesPath = 'codex-home/rules/llm-bridge.rules';
const host = { root: 'C:/Repos/Current', scope: 'host', brandRoot: 'bridge-home' };

function installationRecord() {
  const view = { name: '@lyupro/llm-bridge', version: '0.7.0', mode: 'copy',
    installedAt: '2026-11-13T10:00:00Z', files: [{ root: 'brand', path: 'hooks/reply-guard.mjs' }],
    hooks: [{ event: 'SubagentStop', root: 'brand', path: 'hooks/reply-guard.mjs' }],
    rules: { path: rulesPath, fingerprint: 'a'.repeat(64) } };
  let record = withOwner(null, host, view, { homeHadImage: false });
  for (const root of ['c:/repos/other', 'd:/repos/shared']) {
    record = withOwner(record, { root, scope: 'host' }, view);
  }
  return record;
}

function inputs(fingerprint) {
  return {
    host,
    record: { rules: { path: rulesPath, fingerprint } },
    registry: { version: 1, owners: ['c:/repos/current'] },
    registryError: null,
    detached: true,
  };
}

async function stubFingerprint(t, contents) {
  const read = t.mock.method(fs, 'readFile', async (file) => {
    if (file === installRecordPath(host)) return JSON.stringify(installationRecord());
    assert.equal(file, rulesPath);
    return Buffer.from(contents);
  });
  const fingerprint = await fileFingerprint(rulesPath);
  read.mock.resetCalls();
  return { fingerprint, read };
}

function forbidReads(t) {
  return t.mock.method(fs, 'readFile', async () => {
    assert.fail('this branch must not read the rules file');
  });
}

test('a host that remains attached has no rules dry-run lines', async (t) => {
  const read = forbidReads(t);
  assert.deepEqual(await rulesDryRunLines({ ...inputs('recorded'), detached: false }), []);
  assert.equal(read.mock.callCount(), 0);
});

test('a missing installation record has no rules dry-run lines', async (t) => {
  const read = forbidReads(t);
  assert.deepEqual(await rulesDryRunLines({ ...inputs('recorded'), record: null }), []);
  assert.equal(read.mock.callCount(), 0);
});

test('a record without rules metadata has no rules dry-run lines', async (t) => {
  const read = forbidReads(t);
  assert.deepEqual(await rulesDryRunLines({ ...inputs('recorded'), record: {} }), []);
  assert.equal(read.mock.callCount(), 0);
});

test('an invalid registry leaves rules with unknown ownership', async (t) => {
  const read = forbidReads(t);
  assert.deepEqual(await rulesDryRunLines({
    ...inputs('recorded'), registry: null, registryError: new Error('invalid registry'),
  }), [
    `Would leave ${rulesPath} because the rules ownership registry is invalid; ownership is unknown.`,
  ]);
  assert.equal(read.mock.callCount(), 0);
});

test('one other owner uses singular text', async (t) => {
  const { fingerprint } = await stubFingerprint(t, 'unchanged');
  assert.deepEqual(await rulesDryRunLines({
    ...inputs(fingerprint), registry: { version: 1, owners: ['c:/repos/current', 'c:/repos/other'] },
  }), [`Would leave ${rulesPath} because 1 other owner remains.`]);
});

test('multiple other owners use plural text', async (t) => {
  const { fingerprint } = await stubFingerprint(t, 'unchanged');
  assert.deepEqual(await rulesDryRunLines({
    ...inputs(fingerprint),
    registry: { version: 1, owners: ['c:/repos/current', 'c:/repos/other', 'd:/repos/shared'] },
  }), [`Would leave ${rulesPath} because 2 other owners remain.`]);
});

test('an unchanged fingerprint and no other owners would remove rules', async (t) => {
  const { fingerprint, read } = await stubFingerprint(t, 'unchanged');
  assert.deepEqual(await rulesDryRunLines(inputs(fingerprint)), [
    `Would remove ${rulesPath}; no other owners remain and its fingerprint is unchanged.`,
  ]);
  assert.equal(read.mock.calls.filter(({ arguments: [file] }) => file === rulesPath).length, 1);
});

test('a changed fingerprint would leave rules', async (t) => {
  await stubFingerprint(t, 'operator change');
  assert.deepEqual(await rulesDryRunLines(inputs('original fingerprint')), [
    `Would leave ${rulesPath} because its contents changed after installation.`,
  ]);
});

test('an absent rules file is reported as already absent', async (t) => {
  t.mock.method(fs, 'readFile', async (file) => {
    if (file === installRecordPath(host)) return JSON.stringify(installationRecord());
    assert.equal(file, rulesPath);
    throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
  });
  assert.deepEqual(await rulesDryRunLines(inputs('original fingerprint')), [
    `Would leave ${rulesPath} because it is already absent.`,
  ]);
});

test('a missing registry adds its warning after the rules disposition', async (t) => {
  const { fingerprint } = await stubFingerprint(t, 'unchanged');
  assert.deepEqual(await rulesDryRunLines({ ...inputs(fingerprint), registry: null }), [
    `Would remove ${rulesPath}; no other owners remain and its fingerprint is unchanged.`,
    `Warning: the rules ownership registry was missing; other installations may use ${rulesPath}.`,
  ]);
});

for (const version of [1, 2]) {
  test('v' + version + ' dry run names every unknown legacy reference with its reason', async (t) => {
    const { fingerprint } = await stubFingerprint(t, 'unchanged');
    const unknown = ['vanished-first', 'vanished-second'];
    const lines = await rulesDryRunLines({ ...inputs(fingerprint),
      registry: { version, owners: ['c:/repos/current', ...unknown], ...(version === 2 ? { records: [] } : {}) } });
    assert.deepEqual(lines, [
      'Would leave ' + rulesPath + ' because 2 ownership references cannot be verified: '
      + unknown.map((ref) => ref + ' (legacy owner is not in the current installation record)').join('; ') + '.',
    ]);
  });
}

test('an unknown record reference is named even if its folder vanished', async (t) => {
  await stubFingerprint(t, 'unchanged');
  const missing = 'vanished/.installed.json';
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === missing) throw Object.assign(new Error('record missing'), { code: 'ENOENT' });
    return readFile(file, ...args);
  });
  const lines = await rulesDryRunLines({ ...inputs('original fingerprint'),
    registry: { version: 2, owners: [], records: [missing] } });
  assert.deepEqual(lines, ['Would leave ' + rulesPath + ' because 1 ownership reference cannot be verified: '
    + missing + ' (installation record does not exist (ENOENT)).']);
});

test('live owners do not hide unknown references from the dry-run explanation', async (t) => {
  const { fingerprint } = await stubFingerprint(t, 'unchanged');
  const lines = await rulesDryRunLines({ ...inputs(fingerprint),
    registry: { version: 1, owners: ['c:/repos/current', 'c:/repos/other', 'vanished'] } });
  assert.deepEqual(lines, [
    'Would leave ' + rulesPath + ' because 1 other owner remains.',
    'Would leave ' + rulesPath + ' because 1 ownership reference cannot be verified: '
      + 'vanished (legacy owner is not in the current installation record).',
  ]);
});
