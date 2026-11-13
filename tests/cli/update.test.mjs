/** Verifies recorded installation updates across content classifications and safety modes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { install } from '../../cli/install.mjs';
import {
  buildInstallPlan,
  fileFingerprint,
  installRecordPath,
  readInstallRecord,
  recordTarget,
  rulesPlan,
} from '../../cli/manifest.mjs';
import { targetMatches } from '../../cli/copy.mjs';
import { update } from '../../cli/update.mjs';
import { acquireRulesDirLock } from '../../cli/rules-dir-lock.mjs';
import { acquireLifecycleLock } from '../../cli/lifecycle-lock.mjs';

import { fixture, installOutdated, PACKAGE, packageFixture, ROOT, SOURCE } from './update-fixtures.mjs';
import { formatOneRecord } from './host-fixture.mjs';

test('update without an installation record refuses and recommends install', async (t) => {
  const { host } = await fixture(t);
  const result = await update({ host });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /not installed/i);
  assert.match(result.output, /install/i);
});

for (const version of [null, '0.5.4']) {
  test(`a fresh installation is up to date without rewriting any file${version ? ' (old installed package)' : ''}`, async (t) => {
    const { root, host } = await fixture(t);
    const packageRoot = version ? await packageFixture(root, path.join('node_modules', PACKAGE.name), { version }) : ROOT;
    const source = version ? `${PACKAGE.name}@${version} from ${packageRoot} (installed package)` : SOURCE;
    await install({ host, packageRoot });
    const record = await readInstallRecord(host);
    const watched = [
      ...record.files.map((file) => recordTarget(host, file)),
      record.rules.path,
      installRecordPath(host),
      host.settingsPath,
    ];
    const fixed = new Date('2020-01-02T03:04:05.000Z');
    await Promise.all(watched.map((target) => fs.utimes(target, fixed, fixed)));
    const before = await Promise.all(watched.map(async (target) => (await fs.stat(target)).mtimeMs));
    // The working directory is named explicitly: the suite itself runs inside a checkout, and the
    // mismatch warning below is exactly what that combination is supposed to produce.
    const env = { ...process.env, LLM_BRIDGE_CWD: packageRoot };
    const result = await update({ host, packageRoot, force: Boolean(version), env });
    assert.deepEqual(result, { exitCode: 0, output: `llm-bridge is up to date with ${source}` });
    assert.deepEqual(
      await Promise.all(watched.map(async (target) => (await fs.stat(target)).mtimeMs)),
      before,
    );
  });
}

test('an outdated recorded file updates silently', async (t) => {
  const { host, changed } = await installOutdated(t);
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.endsWith(`Source: ${SOURCE}`));
  assert.doesNotMatch(result.output, new RegExp(`${changed.root}/${changed.relativeToRoot}`));
  assert.equal(await targetMatches(changed, host.brandRoot), true);
});

test('a manually modified file stops update without changing the file or record', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const changed = (await buildInstallPlan(host))[0];
  const recordPath = installRecordPath(host);
  const recordBefore = await fs.readFile(recordPath, 'utf8');
  await fs.writeFile(changed.target, 'manual change\n');
  const result = await update({ host });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, new RegExp(`${changed.root}/${changed.relativeToRoot}`));
  assert.match(result.output, /--force/);
  assert.equal(await fs.readFile(changed.target, 'utf8'), 'manual change\n');
  assert.equal(await fs.readFile(recordPath, 'utf8'), recordBefore);
});

test('--force overwrites a manually modified file', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const changed = (await buildInstallPlan(host))[0];
  await fs.writeFile(changed.target, 'manual change\n');
  const result = await update({ host, force: true });
  assert.equal(result.exitCode, 0);
  assert.equal(await targetMatches(changed, host.brandRoot), true);
});

test('a missing file stops update then --force restores it', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const missing = (await buildInstallPlan(host))[0];
  const recordPath = installRecordPath(host);
  const recordBefore = await fs.readFile(recordPath, 'utf8');
  await fs.rm(missing.target);
  const refused = await update({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, new RegExp(`${missing.root}/${missing.relativeToRoot}`));
  assert.equal(await fs.readFile(recordPath, 'utf8'), recordBefore);
  const forced = await update({ host, force: true });
  assert.equal(forced.exitCode, 0);
  assert.equal(await targetMatches(missing, host.brandRoot), true);
});

test('a matching orphan is removed from the host and rewritten record', async (t) => {
  const { root, host } = await fixture(t);
  const oldPackage = await packageFixture(root, 'old-package', { extraFile: 'obsolete.txt' });
  await install({ host, packageRoot: oldPackage });
  const orphan = (await readInstallRecord(host)).files.find((file) => file.path.endsWith('obsolete.txt'));
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  await assert.rejects(() => fs.access(recordTarget(host, orphan)), { code: 'ENOENT' });
  assert.equal((await readInstallRecord(host)).files.some((file) =>
    file.root === orphan.root && file.path === orphan.path), false);
});

test('a modified orphan is reported and preserved without --force', async (t) => {
  const { root, host } = await fixture(t);
  const oldPackage = await packageFixture(root, 'old-package', { extraFile: 'obsolete.txt' });
  await install({ host, packageRoot: oldPackage });
  const orphan = (await readInstallRecord(host)).files.find((file) => file.path.endsWith('obsolete.txt'));
  const target = recordTarget(host, orphan);
  await fs.writeFile(target, 'manual orphan\n');
  const result = await update({ host });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /obsolete\.txt/);
  assert.match(result.output, /modified/);
  assert.equal(await fs.readFile(target, 'utf8'), 'manual orphan\n');
});

test('a record without fingerprints treats differing files as modified and explains why', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const changed = (await buildInstallPlan(host))[0];
  const recordPath = installRecordPath(host);
  const legacy = await formatOneRecord(host);
  delete legacy.fingerprints;
  await fs.writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`);
  await fs.writeFile(changed.target, 'legacy difference\n');
  const result = await update({ host });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /no fingerprints/i);
  assert.match(result.output, /treated as modified/i);
});

test('--dry-run reports future actions without changing files, record, or settings', async (t) => {
  const { host } = await installOutdated(t);
  const installed = await readInstallRecord(host);
  const recordPath = installRecordPath(host);
  const before = {
    files: await Promise.all(installed.files.map(async (file) => [
      file,
      await fs.readFile(recordTarget(host, file)),
    ])),
    record: await fs.readFile(recordPath),
    rules: await fs.readFile(installed.rules.path),
    settings: await fs.readFile(host.settingsPath),
  };
  const result = await update({ host, dryRun: true });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Would update/);
  assert.ok(result.output.startsWith(`Would update llm-bridge with ${SOURCE}.\n`));
  for (const [file, content] of before.files) {
    assert.deepEqual(await fs.readFile(recordTarget(host, file)), content);
  }
  assert.deepEqual(await fs.readFile(recordPath), before.record);
  assert.deepEqual(await fs.readFile(installed.rules.path), before.rules);
  assert.deepEqual(await fs.readFile(host.settingsPath), before.settings);
});

test('codex-runs artifacts survive update', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const artifact = path.join(host.root, 'codex-runs', 'run.json');
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, 'keep\n');
  const result = await update({ host, force: true });
  assert.equal(result.exitCode, 0);
  assert.equal(await fs.readFile(artifact, 'utf8'), 'keep\n');
});

// A record naming a run folder is refused where it is read, so neither update nor uninstall has to
// carry its own guard against deleting the user's artifacts.
test('a record that claims a run artifact is refused, not obeyed', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const artifact = path.join(host.root, 'codex-runs', 'run.json');
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, 'keep\n');
  const recordPath = installRecordPath(host);
  const record = await formatOneRecord(host);
  record.files.push({ root: 'claude', path: 'codex-runs/run.json' });
  record.fingerprints.claude['codex-runs/run.json'] = await fileFingerprint(artifact);
  await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(update({ host, force: true }), /must not name run artifacts/);
  assert.equal(await fs.readFile(artifact, 'utf8'), 'keep\n');
});

test('update names the checkout the operator is standing in when it is not the copy that ran', async (t) => {
  // 2026-09-07: the operator stood in a 0.6.0 clone while PATH held the previous release. Update
  // compared the home against its own files, answered "up to date" and named no package at all.
  const { root, host } = await fixture(t);
  const packageRoot = await packageFixture(root, path.join('node_modules', PACKAGE.name), { version: '0.5.4' });
  const checkout = await packageFixture(root, 'checkout', { version: '9.9.9' });
  await install({ host, packageRoot });
  const env = { ...process.env, LLM_BRIDGE_CWD: checkout };
  const result = await update({ host, packageRoot, force: true, env });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /up to date with @lyupro\/llm-bridge@0\.5\.4 /);
  assert.match(result.output, /Run from 0\.5\.4; the checkout at .* is 9\.9\.9\./);
  assert.match(result.output, /npm i -g @lyupro\/llm-bridge@9\.9\.9/);
});

// Plan_83 D2 / OW-086: update must exclude other homes before cleanup, through nested install.
test('update holds both locks through orphan cleanup and nested install publication', { timeout: 10_000 }, async (t) => {
  const { root, host } = await fixture(t);
  const oldPackage = await packageFixture(root, 'old-lock-package', { extraFile: 'obsolete.txt' });
  await install({ host, packageRoot: oldPackage });
  const record = await readInstallRecord(host);
  const orphan = recordTarget(host, record.files.find((file) => file.path.endsWith('obsolete.txt')));
  const seen = new Set(), unlink = fs.unlink, rename = fs.rename;
  const checkHeld = async (stage) => {
    await assert.rejects(acquireRulesDirLock(host.codexRulesDir, {
      command: 'other-home', hostRoot: host.root, homeRoot: `${host.brandRoot}-other`, waitMs: 0,
    }), /rules directory lock busy.*held by update/);
    await assert.rejects(acquireLifecycleLock(host.brandRoot, {
      command: 'contender', hostRoot: host.root, waitMs: 0,
    }), /lifecycle lock busy/);
    seen.add(stage);
  };
  t.mock.method(fs, 'unlink', async (target) => {
    if (target === orphan) await checkHeld('cleanup');
    return unlink(target);
  });
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === installRecordPath(host)) await checkHeld('nested publication');
    return rename(source, target);
  });
  assert.equal((await update({ host })).exitCode, 0);
  assert.deepEqual(seen, new Set(['cleanup', 'nested publication']));
  await assert.rejects(fs.access(orphan), { code: 'ENOENT' });
  const next = await acquireRulesDirLock(host.codexRulesDir, {
    command: 'after', hostRoot: host.root, homeRoot: host.brandRoot, waitMs: 0,
  });
  await next.release();
});

test('update without a record reuses the rules ticket in its recovery install', { timeout: 10_000 }, async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  await fs.rename(installRecordPath(host), `${installRecordPath(host)}.saved`);
  const result = await update({ host, isTTY: false });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /recording what is installed/);
  assert.ok(await readInstallRecord(host));
});

test('update dry run creates neither a rules directory nor a lock', async (t) => {
  const { host } = await fixture(t);
  const result = await update({ host, dryRun: true, rulesTicket: {} });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /not installed/);
  for (const target of [host.brandRoot, host.codexRulesDir]) {
    await assert.rejects(fs.access(target), { code: 'ENOENT' });
  }
});

// Plan_83 D2, risk r2: acquiring the rules lock must already be protected by this home's lock.
for (const command of [install, update]) {
  test(`${command.name} takes its home lock before preparing the rules directory`, async (t) => {
    const { host } = await fixture(t);
    await install({ host });
    const mkdir = fs.mkdir;
    let checked = false;
    t.mock.method(fs, 'mkdir', async (target, options) => {
      if (target === host.codexRulesDir && !checked) {
        checked = true;
        await assert.rejects(acquireLifecycleLock(host.brandRoot, {
          command: 'order-probe', hostRoot: host.root, waitMs: 0,
        }), /lifecycle lock busy/);
      }
      return mkdir(target, options);
    });
    assert.equal((await command({ host })).exitCode, 0);
    assert.equal(checked, true);
  });
  test(`${command.name} rejects foreign and stale rules tickets before creating a rules directory`, async (t) => {
    const { root, host } = await fixture(t);
    const other = path.join(root, 'other-rules');
    await fs.mkdir(other);
    const held = await acquireRulesDirLock(other, {
      command: 'other', hostRoot: host.root, homeRoot: host.brandRoot,
    });
    try {
      await assert.rejects(command({ host, rulesTicket: held.ticket }), /different physical directory/);
      await assert.rejects(fs.access(host.codexRulesDir), { code: 'ENOENT' });
    } finally {
      await held.release();
    }
    await assert.rejects(command({ host, rulesTicket: held.ticket }), /no longer active/);
    await assert.rejects(fs.access(host.codexRulesDir), { code: 'ENOENT' });
  });
}
