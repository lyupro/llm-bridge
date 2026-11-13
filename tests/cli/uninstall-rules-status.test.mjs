/** Guards honest rules exit status across uninstall, purge, and read-only previews (Plan_83 D7). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { purge } from '../../cli/uninstall-purge.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { installRecordPath, readInstallRecord } from '../../cli/manifest.mjs';
import { readInstallRecordFile } from '../../cli/install-record.mjs';
import { readRulesRegistry, rulesRegistryPath } from '../../cli/rules-owners.mjs';
import { withPending, pendingRecoveryText } from '../../cli/install-pending.mjs';
import { rulesDryRunLines, removeRulesForHost } from '../../cli/uninstall-rules.mjs';
import { fixture } from './host-fixture.mjs';

const clear = () => ({ verdict: 'clear', blocked: [], unknown: [] });

async function snapshot(root) {
  const entries = [];
  async function walk(relative) {
    const file = path.join(root, relative);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) entries.push([relative, 'link', await fs.readlink(file)]);
    else if (stat.isDirectory()) {
      entries.push([relative, 'directory']);
      for (const name of (await fs.readdir(file)).sort()) await walk(path.join(relative, name));
    } else entries.push([relative, await fs.readFile(file, 'base64')]);
  }
  await walk('');
  return entries;
}

async function setup(t, scenario) {
  const state = await fixture(t);
  const { root, host } = state;
  assert.equal((await install({ host })).exitCode, 0);
  const record = await readInstallRecord(host);
  const raw = await readInstallRecordFile(host);
  const other = resolveHost({ host: path.join(root, 'Mixed Case Other Host'),
    brandRoot: path.join(root, 'other-home'), codexHome: path.dirname(host.codexRulesDir) });
  const otherRecord = installRecordPath(other);
  const missingRecord = path.join(root, 'missing-home', '.installed.json');
  const registryPath = rulesRegistryPath(host);
  const index = { version: 2, records: [installRecordPath(host)], legacy: [] };
  if (scenario === 'offerable' || scenario === 'mixed') {
    index.legacy.push('unconfirmed-legacy-host');
    index.records.push(missingRecord);
  }
  if (scenario === 'live-unknown') {
    assert.equal((await install({ host: other })).exitCode, 0);
    index.records.push(otherRecord, missingRecord);
  }
  if (['pending', 'mixed', 'inventory', 'invalid', 'unreadable'].includes(scenario)) {
    await fs.mkdir(other.brandRoot);
    let foreign = { ...raw, owners: {}, inventory: 'incomplete' };
    if (scenario === 'pending' || scenario === 'mixed') {
      foreign = withPending(foreign, other, 'update', '2026-11-13T10:00:00Z');
    }
    if (scenario === 'inventory') foreign.inventory = 'incomplete';
    if (scenario === 'invalid') foreign.format = 1;
    await fs.writeFile(otherRecord, scenario === 'unreadable' ? '{broken' : JSON.stringify(foreign));
    index.records.push(otherRecord);
  }
  await fs.writeFile(registryPath, scenario === 'registry-invalid' ? '{broken' : JSON.stringify(index));
  if (scenario === 'changed') await fs.writeFile(record.rules.path, 'operator changes\n');
  if (scenario === 'absent') await fs.rename(record.rules.path, path.join(root, 'saved-rules'));
  return { ...state, record, other, otherRecord, registryPath };
}

for (const command of [uninstall, purge]) {
  for (const scenario of ['offerable', 'pending', 'mixed', 'live-unknown', 'clean', 'changed', 'absent',
    'registry-invalid', 'inventory', 'invalid', 'unreadable']) {
    test(command.name + ' and dry-run report rules status for ' + scenario, async (t) => {
      const state = await setup(t, scenario);
      const { root, host, record, other, registryPath } = state;
      const unresolved = ['offerable', 'pending', 'mixed', 'registry-invalid', 'inventory', 'invalid', 'unreadable']
        .includes(scenario);
      const expectedExit = unresolved ? 1 : 0;
      const before = await snapshot(root);
      const registryBefore = await fs.readFile(registryPath);
      const preview = await command({ host, dryRun: true, isTTY: true,
        prompt: () => assert.fail('Dry-run must never ask'), liveRunCheck: clear });
      assert.equal(preview.exitCode, expectedExit, preview.output);
      assert.deepEqual(await snapshot(root), before, 'dry-run must preserve directories and every byte');
      let questions = 0;
      const result = await command({ host, isTTY: true, liveRunCheck: clear, prompt: () => {
        questions++;
        // Plan_83 D7 (1): offerable references now get one question after purge's two consents.
        const consents = command === purge ? 2 : 0;
        assert.ok(questions <= consents + Number(scenario === 'offerable'));
        return questions > consents ? 'no' : 'yes';
      } });
      assert.equal(result.exitCode, expectedExit, result.output);
      assert.equal(questions, (command === purge ? 2 : 0) + Number(scenario === 'offerable'));
      for (const output of [preview.output, result.output]) {
        if (scenario === 'offerable' || scenario === 'mixed') {
          assert.match(output, /Only an operator can confirm ownership reference unconfirmed-legacy-host/);
        }
        if (scenario === 'pending' || scenario === 'mixed') {
          assert.ok(output.includes(other.root));
          assert.ok(output.includes(pendingRecoveryText({ root: other.root, command: 'update' })));
        }
        if (scenario === 'live-unknown') {
          assert.match(output, /1 other owner remains/);
          assert.match(output, /ownership reference cannot be verified/);
        }
        if (scenario === 'changed') assert.match(output, /contents changed after installation/);
        if (scenario === 'registry-invalid') assert.match(output, /registry is invalid; ownership is unknown/);
        if (scenario === 'inventory') {
          assert.ok(output.includes(other.brandRoot));
          assert.match(output, /confirm the inventory of that home, or uninstall the home from its own host/);
        }
        if (scenario === 'invalid') {
          assert.ok(output.includes(other.brandRoot));
          assert.match(output, /llm-bridge update from that home/);
        }
        if (scenario === 'unreadable') {
          assert.ok(output.includes(state.otherRecord));
          assert.match(output, /cannot parse/);
          assert.match(output, /repair it from its own host, or remove the record file if that home is abandoned, then run uninstall again/);
        }
      }
      if (scenario === 'clean' || scenario === 'absent') {
        await assert.rejects(fs.access(record.rules.path), { code: 'ENOENT' });
      } else if (scenario === 'changed') {
        assert.equal(await fs.readFile(record.rules.path, 'utf8'), 'operator changes\n');
      } else {
        assert.deepEqual(await fs.readFile(record.rules.path),
          await fs.readFile('src/codex/rules/llm-bridge.rules'));
      }
      if (scenario === 'registry-invalid') assert.deepEqual(await fs.readFile(registryPath), registryBefore);
      if (scenario === 'mixed') {
        const remaining = JSON.parse(await fs.readFile(registryPath, 'utf8'));
        const original = JSON.parse(registryBefore);
        assert.deepEqual(remaining.legacy, original.legacy);
        // Plan_83 D8: foreign references survive a mixed set; our departed reference does not.
        assert.deepEqual(remaining.records, original.records.filter((file) => file !== installRecordPath(host)),
          'only the departing host reference may be retired');
        assert.deepEqual(remaining, { ...original, records: original.records.slice(1), retained: [record.rules] });
      }
    });
  }
}

// Plan_83 D7: the outcome belongs to the helper contract, including early returns and absent files.
test('rules helper returns explicit status without a departing rules decision', async (t) => {
  const { host, record } = await setup(t, 'clean');
  for (const options of [{ record: null, detached: true }, { record: {}, detached: true },
    { record, detached: false }]) {
    const input = { host, registry: null, registryError: null, ...options };
    assert.deepEqual(await rulesDryRunLines(input), { lines: [], rulesUnresolved: false });
    assert.deepEqual(await removeRulesForHost({ ...input, writer: null }),
      { lines: [], registryError: null, rulesUnresolved: false });
  }
});

for (const absent of [false, true]) {
  test('invalid registry status reflects whether rules still exist: ' + absent, async (t) => {
    const { host, record } = await setup(t, 'registry-invalid');
    if (absent) await fs.rename(record.rules.path, path.join(path.dirname(host.brandRoot), 'saved-rules'));
    const input = { host, record, registry: null, registryError: new Error('invalid registry'), detached: true };
    assert.equal((await rulesDryRunLines(input)).rulesUnresolved, !absent);
    assert.equal((await removeRulesForHost({ ...input, writer: null })).rulesUnresolved, !absent);
  });
}

test('unknown references cannot make an already absent rules file unresolved', async (t) => {
  const { host, record } = await setup(t, 'offerable');
  await fs.rename(record.rules.path, path.join(path.dirname(host.brandRoot), 'saved-rules'));
  const input = { host, record, registry: await readRulesRegistry(host), registryError: null, detached: true };
  assert.equal((await rulesDryRunLines(input)).rulesUnresolved, false);
  assert.equal((await removeRulesForHost({ ...input, writer: null })).rulesUnresolved, false);
});
