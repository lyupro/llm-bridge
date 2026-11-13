/** Verifies how doctor judges the Codex rules file and its ownership registry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { diagnose, renderDoctor } from '../../cli/doctor.mjs';
import { fileFingerprint, writeInstallRecord } from '../../cli/manifest.mjs';
import { RULES_REGISTRY_NAME, rulesRegistryPath } from '../../cli/rules-owners.mjs';
import { installRecordPath } from '../../cli/install-record.mjs';
import { withPending } from '../../cli/install-pending.mjs';
import { rulesCheck } from '../../cli/doctor-installation.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { codexProbe, hostFixture, installedFixture, ownPackage, honestInstalledFixture } from './doctor-fixtures.mjs';

async function addRules(host, record, content = 'prefix_rule(pattern=["safe"], decision="allow")\n') {
  const rulePath = path.join(host.codexRulesDir, 'llm-bridge.rules');
  await fs.mkdir(path.dirname(rulePath), { recursive: true });
  await fs.writeFile(rulePath, content);
  record.rules = { path: rulePath, fingerprint: await fileFingerprint(rulePath) };
  await writeInstallRecord(host, record);
  return rulePath;
}

test('rules cannot be checked before installation', async (t) => {
  const host = await hostFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const expected = { key: 'rules', status: 'warn', value: 'cannot check before installation' };
  assert.deepEqual(await rulesCheck(host, null), [expected]);
  assert.deepEqual(result.checks.find((item) => item.key === 'rules'), expected);
});

test('an old installation record warns that update will add rules', async (t) => {
  const { host, record } = await installedFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'warn');
  assert.match(rules.value, /not installed by this installation/i);
  assert.match(rules.value, /install or update/i);
  assert.deepEqual(await rulesCheck(host, record), [rules]);
});

test('rules matching their recorded fingerprint are healthy', async (t) => {
  const { host, record } = await honestInstalledFixture(t);
  const rulePath = await addRules(host, record);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'rules'), {
    key: 'rules',
    status: 'ok',
    value: `${rulePath} (matches record)`,
  });
  assert.deepEqual(result.checks.filter((item) => item.key.startsWith('rules')), [
    { key: 'rules', status: 'ok', value: `${rulePath} (matches record)` },
    { key: 'rules owners', status: 'ok', value: `${installRecordPath(host)}: ${normalizeRepoPath(host.root)}` },
  ]);
  assert.equal(result.exitCode, 0);
});

test('doctor reports multiple owners of shared rules', async (t) => {
  const { host, record } = await installedFixture(t);
  await addRules(host, record);
  const otherHost = path.join(path.dirname(host.root), 'other-host');
  await fs.writeFile(
    path.join(host.codexRulesDir, RULES_REGISTRY_NAME),
    `${JSON.stringify({
      version: 1,
      owners: [normalizeRepoPath(host.root), normalizeRepoPath(otherHost)],
    }, null, 2)}\n`,
  );
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'warn');
  assert.match(rules.value, /matches record/);
  const rendered = renderDoctor(result);
  assert.match(rendered, /\[warn\] rules: /);
  assert.ok(rendered.includes(`[ok] rules owners: ${installRecordPath(host)}: ${normalizeRepoPath(host.root)}`));
  assert.ok(rendered.includes(`[warn] rules ownership: unknown ${normalizeRepoPath(otherHost)}`));
  assert.match(rendered, /legacy owner is not in the current installation record/);
  assert.doesNotMatch(rendered, /2 owners/);
  assert.deepEqual(result.checks.filter((item) => item.key.startsWith('rules')).map(({ key, status }) => ({ key, status })), [
    { key: 'rules', status: 'warn' },
    { key: 'rules owners', status: 'ok' },
    { key: 'rules ownership', status: 'warn' },
  ]);
});

test('corrupt rules registry fails only the rules check and keeps all diagnostics', async (t) => {
  const { host, record } = await installedFixture(t);
  await addRules(host, record);
  await fs.writeFile(
    path.join(host.codexRulesDir, RULES_REGISTRY_NAME),
    '{"version":1,"owners":[',
  );
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rendered = renderDoctor(result);
  for (const key of ['source', 'host', 'installation', 'files', 'rules', 'hook:SubagentStop', 'hook:PreToolUse', 'codex', 'node', 'runsRoot', 'liveRuns', 'projectRuns']) {
    assert.match(rendered, new RegExp(`\\] ${key}:`));
  }
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'fail');
  assert.match(rules.value, /invalid rules ownership registry JSON/);
  assert.deepEqual(await rulesCheck(host, record), [rules]);
  assert.equal(result.exitCode, 1);
});

test('missing recorded rules fail diagnosis and name their full path', async (t) => {
  const { host, record } = await installedFixture(t);
  const rulePath = await addRules(host, record);
  await fs.rm(rulePath);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'rules'), {
    key: 'rules',
    status: 'fail',
    value: rulePath,
  });
  assert.equal(result.exitCode, 1);
});

test('manually modified rules warn without failing diagnosis', async (t) => {
  const { host, record } = await honestInstalledFixture(t);
  const rulePath = await addRules(host, record);
  await fs.writeFile(rulePath, 'manual operator rules\n');
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'warn');
  assert.match(rules.value, /modified after installation/i);
  assert.match(rules.value, new RegExp(rulePath.replaceAll('\\', '\\\\')));
  assert.equal(result.exitCode, 0);
});

async function indexedFixture(t) {
  const { host, record } = await installedFixture(t);
  await addRules(host, record);
  const recordPath = installRecordPath(host);
  const raw = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  raw.inventory = 'complete';
  await fs.writeFile(recordPath, JSON.stringify(raw));
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({ version: 2, records: [recordPath], legacy: [] }));
  return { host, record, recordPath, raw };
}

test('Plan_83 D4/D5 places pending checks after the complete rules group and before host rules', async (t) => {
  const { host, recordPath, raw } = await indexedFixture(t);
  const foreign = { root: path.join(host.root, 'Other Host') };
  await fs.writeFile(recordPath, JSON.stringify(withPending(raw, foreign, 'update', '2026-11-13T20:15:00Z')));
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rulesIndex = result.checks.findIndex(({ key }) => key === 'rules');
  // Plan_83 D4/D5: pending evidence follows every ownership row without splitting that group.
  assert.deepEqual(result.checks.slice(rulesIndex, rulesIndex + 4).map(({ key }) => key),
    ['rules', 'rules ownership', 'pending install', 'claudeRules']);
});

test('version 2 reports live owners by installation record separately from content integrity', async (t) => {
  const { host, record, recordPath, raw } = await indexedFixture(t);
  const secondPath = path.join(host.root, 'second-home', '.installed.json');
  await fs.mkdir(path.dirname(secondPath));
  await fs.writeFile(secondPath, JSON.stringify(raw));
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({ version: 2, records: [recordPath, secondPath], legacy: [] }));
  const checks = await rulesCheck(host, record);
  const [rules] = checks;
  assert.equal(rules.status, 'ok');
  assert.deepEqual(checks, [
    { key: 'rules', status: 'ok', value: `${record.rules.path} (matches record)` },
    { key: 'rules owners', status: 'ok', value: `${recordPath}: ${normalizeRepoPath(host.root)}` },
    { key: 'rules owners', status: 'ok', value: `${secondPath}: ${normalizeRepoPath(host.root)}` },
  ]);
  const lines = renderDoctor({ checks }).split('\n');
  assert.equal(lines[0], `[ok] rules: ${record.rules.path} (matches record)`);
  assert.ok(lines.includes(`[ok] rules owners: ${recordPath}: ${normalizeRepoPath(host.root)}`));
  assert.ok(lines.includes(`[ok] rules owners: ${secondPath}: ${normalizeRepoPath(host.root)}`));
});

for (const kind of ['missing', 'invalid', 'incomplete', 'legacy', 'pending', 'permission']) {
  test(`doctor warns and names an unknown ${kind} indexed record`, async (t) => {
    const { host, record, recordPath, raw } = await indexedFixture(t);
    if (kind === 'missing') await fs.rm(recordPath);
    if (kind === 'invalid') await fs.writeFile(recordPath, '{bad JSON');
    if (kind === 'incomplete') await fs.writeFile(recordPath, JSON.stringify({ ...raw, inventory: 'incomplete' }));
    if (kind === 'legacy') await fs.writeFile(recordPath, JSON.stringify({ ...raw, legacy: record }));
    if (kind === 'pending') await fs.writeFile(recordPath, JSON.stringify({ ...raw, pending: false }));
    if (kind === 'permission') {
      const readFile = fs.readFile;
      t.mock.method(fs, 'readFile', async (file, ...args) => {
        if (file === recordPath) throw Object.assign(new Error('EACCES: record access denied'), { code: 'EACCES' });
        return readFile(file, ...args);
      });
    }
    const checks = await rulesCheck(host, record);
    const [rules] = checks;
    const rendered = renderDoctor({ checks });
    assert.equal(rules.status, 'warn');
    assert.equal(checks.length, 2);
    assert.equal(checks[1].key, 'rules ownership');
    assert.equal(checks[1].status, 'warn');
    assert.ok(checks[1].value.startsWith(`unknown ${recordPath}:`));
    assert.equal(rules.value, `${record.rules.path} (matches record)`);
    assert.match(rendered, /\[warn\] rules: .*matches record/);
    assert.ok(rendered.includes(`[warn] rules ownership: unknown ${recordPath}:`));
    const reasons = { missing: /ENOENT/, invalid: /cannot parse/, incomplete: /inventory is incomplete/,
      legacy: /legacy inventory/, pending: /pending field/, permission: /EACCES:.*record access denied/ };
    assert.match(rendered, reasons[kind]);
    assert.doesNotMatch(rendered, /\[ok\] rules:/);
  });
}

test('doctor warns about detached records and names the record', async (t) => {
  const { host, record, recordPath, raw } = await indexedFixture(t);
  delete raw.owners[normalizeRepoPath(host.root)].rules;
  await fs.writeFile(recordPath, JSON.stringify(raw));
  const checks = await rulesCheck(host, record);
  const [rules] = checks;
  assert.equal(rules.status, 'warn');
  assert.match(rules.value, /matches record/);
  assert.deepEqual(checks, [
    { key: 'rules', status: 'warn', value: `${record.rules.path} (matches record)` },
    { key: 'rules ownership', status: 'warn', value: `detached record ${recordPath}: complete inventory has no owner of this rules file` },
  ]);
  assert.ok(renderDoctor({ checks }).includes(`[warn] rules ownership: detached record ${recordPath}`));
});

test('unknown ownership does not hide a missing rules file failure', async (t) => {
  const { host, record, recordPath } = await indexedFixture(t);
  await fs.rm(record.rules.path);
  await fs.rm(recordPath);
  const checks = await rulesCheck(host, record);
  const [rules] = checks;
  assert.equal(rules.status, 'fail');
  const rendered = renderDoctor({ checks });
  assert.ok(rendered.startsWith(`[fail] rules: ${record.rules.path}\n`));
  assert.ok(rendered.includes(`[warn] rules ownership: unknown ${recordPath}:`));
});

test('unknown ownership preserves the modified-content warning', async (t) => {
  const { host, record, recordPath } = await indexedFixture(t);
  await fs.writeFile(record.rules.path, 'operator changes\n');
  await fs.rm(recordPath);
  const checks = await rulesCheck(host, record);
  const [rules] = checks;
  assert.equal(rules.status, 'warn');
  assert.match(rules.value, /modified after installation/);
  assert.equal(rules.value, `${record.rules.path} (modified after installation)`);
  assert.equal(checks[1].key, 'rules ownership');
  assert.equal(checks[1].status, 'warn');
  assert.match(checks[1].value, /unknown.*ENOENT/);
});

test('an unknown index version fails the rules check and names the index', async (t) => {
  const { host, record } = await indexedFixture(t);
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({ version: 3, records: [], legacy: [] }));
  const checks = await rulesCheck(host, record);
  const [rules] = checks;
  assert.equal(rules.status, 'fail');
  assert.ok(rules.value.includes(rulesRegistryPath(host)));
  assert.match(rules.value, /version must be 1 or 2/);
  assert.equal(checks.length, 1);
});

test('doctor ownership checks do not write the index, installation record, or rules', async (t) => {
  const { host, record, recordPath } = await indexedFixture(t);
  const files = [rulesRegistryPath(host), recordPath, record.rules.path];
  const before = await Promise.all(files.map((file) => fs.readFile(file)));
  await rulesCheck(host, record);
  const after = await Promise.all(files.map((file) => fs.readFile(file)));
  assert.deepEqual(after, before);
});

test('OW-086 doctor shows one record-backed owner and three unknown snapshot hints', async (t) => {
  const { host, record } = await honestInstalledFixture(t);
  await addRules(host, record);
  const auditDir = new URL('../../docs/audits/OW-086/', import.meta.url);
  const snapshotNames = (await fs.readdir(auditDir)).filter((name) => name.endsWith('-rules-owners.json'));
  assert.equal(snapshotNames.length, 1);
  const snapshot = JSON.parse(await fs.readFile(new URL(snapshotNames[0], auditDir), 'utf8'));
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({ ...snapshot,
    owners: [...snapshot.owners, normalizeRepoPath(host.root)] }));
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'warn');
  const rendered = renderDoctor(result);
  assert.equal(rendered.split('\n').filter((line) => line.startsWith('[ok] rules owners:')).length, 1);
  const unknown = rendered.split('\n').filter((line) => line.startsWith('[warn] rules ownership: unknown'));
  assert.equal(unknown.length, 3);
  assert.equal(result.checks.filter((item) => item.key === 'rules owners' && item.status === 'ok').length, 1);
  assert.equal(result.checks.filter((item) => item.key === 'rules ownership' && item.status === 'warn').length, 3);
  for (const owner of snapshot.owners) assert.ok(unknown.some((line) => line.includes(owner)));
  assert.doesNotMatch(rendered, /\[ok\] rules:/);
  assert.equal(result.exitCode, 0);
});
