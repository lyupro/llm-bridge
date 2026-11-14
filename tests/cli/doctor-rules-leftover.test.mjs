/** Guards the record-free rules diagnostics required by Plan_83 D7 (8) / D8. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rulesCheck } from '../../cli/doctor-installation.mjs';
import { diagnose } from '../../cli/doctor.mjs';
import { fileFingerprint } from '../../cli/manifest.mjs';
import { installRecordPath, RULES_NAME } from '../../cli/install-record.mjs';
import { rulesRegistryPath } from '../../cli/rules-owners.mjs';
import { readRulesIndex } from '../../cli/rules-index.mjs';
import { classifyRulesOwnership } from '../../cli/rules-ownership.mjs';
import { withPending } from '../../cli/install-pending.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { codexProbe, hostFixture, installedFixture, ownPackage } from './doctor-fixtures.mjs';

const content = 'prefix_rule(pattern=["safe"], decision="allow")\n';
const rulesPathFor = (host) => path.join(host.codexRulesDir, RULES_NAME);
const recovery = (host) => `llm-bridge uninstall --host "${host.root}" in a terminal`;

async function writeRules(host) {
  const rulesPath = rulesPathFor(host);
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(rulesPath, content);
  return { path: rulesPath, fingerprint: await fileFingerprint(rulesPath) };
}

async function writeIndex(host, entries) {
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({ version: 2, records: [], legacy: [], ...entries }));
}

for (const record of [null, {}]) {
  const branch = record === null ? 'no record' : 'record without rules';

  test(`Plan_83 D7 (8): ${branch} preserves the exact clean-host row and creates no directory`, async (t) => {
    const host = await hostFixture(t);
    const before = await fs.readdir(host.root);
    assert.deepEqual(await rulesCheck(host, record), [{ key: 'rules', status: 'warn', value: record === null
      ? 'cannot check before installation'
      : 'rules were not installed by this installation; install or update will add them' }]);
    assert.deepEqual(await fs.readdir(host.root), before);
    await assert.rejects(fs.access(host.codexRulesDir), { code: 'ENOENT' });
  });

  for (const withLegacy of [false, true]) {
    test(`Plan_83 D8: ${branch} does not call a live owner's file a leftover, legacy=${withLegacy}`, async (t) => {
      const host = record === null ? await hostFixture(t) : (await installedFixture(t)).host;
      const rules = await writeRules(host);
      const { host: ownerHost } = await installedFixture(t);
      const ownerRecordPath = installRecordPath(ownerHost);
      const ownerRecord = JSON.parse(await fs.readFile(ownerRecordPath, 'utf8'));
      const ownerKey = normalizeRepoPath(ownerHost.root);
      ownerRecord.inventory = 'complete';
      ownerRecord.owners[ownerKey].rules = rules;
      await fs.writeFile(ownerRecordPath, JSON.stringify(ownerRecord));
      const legacy = path.join(host.root, 'legacy-host');
      // Plan_83 D8: a live owner takes precedence even when a retained baseline also exists.
      await writeIndex(host, { records: [ownerRecordPath],
        ...(withLegacy ? { legacy: [legacy], retained: [rules] } : {}) });
      const checks = await rulesCheck(host, record);
      assert.deepEqual(checks, [
        { key: 'rules', status: 'warn', value: `${record === null ? 'cannot check before installation'
          : 'rules were not installed by this installation; install or update will add them'}; the rules file ${rules.path} belongs to another installation` },
        { key: 'rules owners', status: 'ok', value: `${ownerRecordPath}: ${ownerKey}` },
        ...(withLegacy ? [{ key: 'rules ownership', status: 'warn',
          value: `unknown ${legacy} (record ${installRecordPath(host)}): ${record === null
            ? 'installation record does not exist (ENOENT)' : 'legacy owner is not in the current installation record'}` }] : []),
      ]);
      assert.doesNotMatch(checks[0].value,
        /matches retained installation fingerprint|modified after installation|integrity since installation cannot be proven/);
      assert.ok(checks.every(({ value }) => !value.includes('uninstall --host')));
    });
  }

  test(`Plan_83 D8: ${branch} reports a matching retained installation fingerprint`, async (t) => {
    const host = await hostFixture(t);
    const rules = await writeRules(host);
    // D8: any historical baseline for this path may match, not just the first entry.
    await writeIndex(host, { retained: [{ ...rules, fingerprint: 'a'.repeat(64) }, rules] });
    assert.deepEqual(await rulesCheck(host, record), [{ key: 'rules', status: 'warn',
      value: `${rules.path} (matches retained installation fingerprint); run ${recovery(host)}` }]);
  });

  test(`Plan_83 D8: ${branch} reports edits after the retained baseline`, async (t) => {
    const host = await hostFixture(t);
    const rules = await writeRules(host);
    await writeIndex(host, { retained: [rules] });
    await fs.writeFile(rules.path, 'operator edit\n');
    assert.deepEqual(await rulesCheck(host, record), [{ key: 'rules', status: 'warn',
      value: `${rules.path} (modified after installation); run ${recovery(host)}` }]);
  });

  for (const indexKind of ['absent', 'pre-D8', 'retained for another path']) {
    test(`Plan_83 D8: ${branch}, ${indexKind} index cannot prove installation integrity`, async (t) => {
      const host = await hostFixture(t);
      const rules = await writeRules(host);
      if (indexKind !== 'absent') await writeIndex(host, indexKind === 'pre-D8' ? {}
        : { retained: [{ ...rules, path: path.join(host.codexRulesDir, 'other.rules') }] });
      assert.deepEqual(await rulesCheck(host, record), [{ key: 'rules', status: 'warn',
        value: `${rules.path} (integrity since installation cannot be proven); run ${recovery(host)}` }]);
    });
  }

  test(`Plan_83 D7 (8): ${branch} shows an absent file and an unknown legacy reference`, async (t) => {
    const host = await hostFixture(t);
    const legacy = path.join(host.root, 'departed-host');
    await fs.mkdir(host.codexRulesDir, { recursive: true });
    await fs.writeFile(rulesRegistryPath(host), JSON.stringify({ version: 1, owners: [legacy] }));
    assert.deepEqual(await rulesCheck(host, record), [
      { key: 'rules', status: 'warn', value: `${rulesPathFor(host)} (no rules file; the index still lists references)` },
      { key: 'rules ownership', status: 'warn',
        value: `unknown ${legacy} (record ${installRecordPath(host)}): installation record does not exist (ENOENT)` },
    ]);
  });

  for (const broken of ['{"version":', '{"version":3}', '{"version":2,"records":[],"legacy":[],"retained":[]}']) {
    test(`Plan_83 D7 (8): ${branch} returns exactly one failure for broken index ${broken}`, async (t) => {
      const host = await hostFixture(t);
      await writeRules(host);
      await fs.writeFile(rulesRegistryPath(host), broken);
      let message;
      await assert.rejects(readRulesIndex(host), (error) => {
        message = error.message;
        return true;
      });
      assert.ok(message.includes(rulesRegistryPath(host)));
      assert.deepEqual(await rulesCheck(host, record), [{ key: 'rules', status: 'fail', value: message }]);
    });
  }

  test(`Plan_83 D7 (8): ${branch} fails an unreadable rules file without hiding ownership`, async (t) => {
    const host = await hostFixture(t);
    const rules = await writeRules(host);
    const missing = path.join(host.root, 'missing-home', '.installed.json');
    await writeIndex(host, { records: [missing] });
    const readFile = fs.readFile;
    const mock = t.mock.method(fs, 'readFile', async (file, ...args) => {
      if (file === rules.path) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return readFile(file, ...args);
    });
    try {
      assert.deepEqual(await rulesCheck(host, record), [
        { key: 'rules', status: 'fail', value: rules.path },
        { key: 'rules ownership', status: 'warn', value: `unknown ${missing}: installation record does not exist (ENOENT)` },
      ]);
    } finally {
      mock.mock.restore();
    }
  });

  test(`Plan_83 D7 (8): ${branch} reports an unreadable index as one failure`, async (t) => {
    const host = await hostFixture(t);
    await fs.mkdir(rulesRegistryPath(host), { recursive: true });
    const checks = await rulesCheck(host, record);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].key, 'rules');
    assert.equal(checks[0].status, 'fail');
    assert.ok(checks[0].value.includes(rulesRegistryPath(host)));
  });
}

test('Plan_83 D7 (8): leftover and recorded branches print identical live, missing, legacy and detached ownership rows', async (t) => {
  const { host, record } = await installedFixture(t);
  const rules = await writeRules(host);
  const raw = JSON.parse(await fs.readFile(installRecordPath(host), 'utf8'));
  raw.inventory = 'complete';
  const ownerKey = normalizeRepoPath(host.root);
  const livePath = path.join(host.root, 'live-home', '.installed.json');
  const detachedPath = path.join(host.root, 'detached-home', '.installed.json');
  const missingPath = path.join(host.root, 'missing-home', '.installed.json');
  const legacy = path.join(host.root, 'legacy-host');
  for (const file of [livePath, detachedPath]) await fs.mkdir(path.dirname(file));
  await fs.writeFile(detachedPath, JSON.stringify(raw));
  raw.owners[ownerKey].rules = rules;
  await fs.writeFile(livePath, JSON.stringify(raw));
  await writeIndex(host, { records: [livePath, missingPath, detachedPath], legacy: [legacy] });
  const ownership = await classifyRulesOwnership(await readRulesIndex(host), rules.path, installRecordPath(host));
  assert.deepEqual(ownership.unknown.map(({ kind }) => kind), ['missing', 'legacy']);
  const expected = [
    { key: 'rules owners', status: 'ok', value: `${livePath}: ${ownerKey}` },
    { key: 'rules ownership', status: 'warn', value: `unknown ${missingPath}: installation record does not exist (ENOENT)` },
    { key: 'rules ownership', status: 'warn',
      value: `unknown ${legacy} (record ${installRecordPath(host)}): legacy owner is not in the current installation record` },
    { key: 'rules ownership', status: 'warn',
      value: `detached record ${detachedPath}: complete inventory has no owner of this rules file` },
  ];
  const recorded = await rulesCheck(host, { ...record, rules });
  assert.deepEqual(recorded, [{ key: 'rules', status: 'warn', value: `${rules.path} (matches record)` }, ...expected]);
  for (const recordView of [null, record]) {
    const checks = await rulesCheck(host, recordView);
    assert.deepEqual(checks.slice(1), expected);
    assert.equal(checks[0].status, 'warn');
    assert.equal(checks[0].value, `${recordView === null ? 'cannot check before installation'
      : 'rules were not installed by this installation; install or update will add them'}; the rules file ${rules.path} belongs to another installation`);
  }
});

for (const withRecord of [false, true]) {
  test(`Plan_83 D7 (8): leftover group precedes pending checks and host rules, record=${withRecord}`, async (t) => {
    const { host } = withRecord ? await installedFixture(t) : { host: await hostFixture(t) };
    const rules = await writeRules(host);
    const missing = path.join(host.root, 'missing-home', '.installed.json');
    await writeIndex(host, { records: [missing], retained: [rules] });
    if (withRecord) {
      const file = installRecordPath(host);
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.writeFile(file, JSON.stringify(withPending(raw, host, 'update', '2026-11-13T20:15:00Z')));
    }
    const { checks } = await diagnose({ host, codexProbe, currentPackage: ownPackage });
    const start = checks.findIndex(({ key }) => key === 'rules');
    assert.deepEqual(checks.slice(start, start + (withRecord ? 4 : 3)).map(({ key }) => key),
      withRecord ? ['rules', 'rules ownership', 'pending install', 'claudeRules'] : ['rules', 'rules ownership', 'claudeRules']);
    assert.equal(checks[start].status, 'warn');
    assert.ok(checks[start].value.includes('matches retained installation fingerprint'));
    assert.ok(checks[start].value.includes(recovery(host)));
  });
}

test('Plan_83 D7 (8) / D8: doctor leaves file and index byte-identical and never creates locks or directories', async (t) => {
  const host = await hostFixture(t);
  const rules = await writeRules(host);
  await writeIndex(host, { retained: [rules], legacy: [path.join(host.root, 'departed-host')] });
  const files = [rules.path, rulesRegistryPath(host)];
  const before = await Promise.all(files.map((file) => fs.readFile(file)));
  const directories = await fs.readdir(host.codexRulesDir, { recursive: true });
  // D7 (8): forbid transient writes too; a lock created and removed would escape a final snapshot.
  const writes = ['writeFile', 'appendFile', 'mkdir', 'open', 'rename', 'unlink', 'rm'].map((method) =>
    t.mock.method(fs, method, () => { throw new Error(`doctor attempted ${method}`); }));
  try {
    for (const record of [null, {}]) {
      const checks = await rulesCheck(host, record);
      assert.equal(checks[0].status, 'warn');
      assert.ok(checks[0].value.includes('matches retained installation fingerprint'));
      assert.equal(checks[1].key, 'rules ownership');
    }
    const { checks } = await diagnose({ host, codexProbe, currentPackage: ownPackage });
    assert.ok(checks.find(({ key }) => key === 'rules').value.includes('matches retained installation fingerprint'));
    for (const write of writes) assert.equal(write.mock.callCount(), 0);
  } finally {
    for (const write of writes) write.mock.restore();
  }
  assert.deepEqual(await Promise.all(files.map((file) => fs.readFile(file))), before);
  assert.deepEqual(await fs.readdir(host.codexRulesDir, { recursive: true }), directories);
  await assert.rejects(fs.access(`${rulesRegistryPath(host)}.lock`), { code: 'ENOENT' });
});
