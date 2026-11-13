/** Plan_83 D6/D7/D8: consent precedes mutations and retires exactly the confirmed evidence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { purge } from '../../cli/uninstall-purge.mjs';
import { installRecordPath, readInstallRecord } from '../../cli/install-record.mjs';
import { rulesRegistryPath, retireRulesReferences } from '../../cli/rules-owners.mjs';
import { preflightRulesRemoval } from '../../cli/uninstall-rules.mjs';
import { withPending } from '../../cli/install-pending.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { fixture, formatOneRecord } from './host-fixture.mjs';

const clear = () => ({ verdict: 'clear', blocked: [], unknown: [] });
const forbiddenPrompt = () => assert.fail('No rules question is allowed');
const absent = (file) => assert.rejects(fs.access(file), { code: 'ENOENT' });

async function snapshot(root) {
  const rows = [];
  async function walk(file) {
    const stat = await fs.lstat(file);
    const relative = path.relative(root, file);
    if (stat.isDirectory()) {
      rows.push([relative, 'directory']);
      for (const name of (await fs.readdir(file)).sort()) await walk(path.join(file, name));
    } else rows.push([relative, await fs.readFile(file, 'base64')]);
  }
  await walk(root);
  return rows;
}

async function setup(t, { ownLegacy = false, offers = true } = {}) {
  const state = await fixture(t);
  const { root, host } = state;
  assert.equal((await install({ host })).exitCode, 0);
  const record = await readInstallRecord(host);
  const own = installRecordPath(host);
  if (ownLegacy) await fs.writeFile(own, JSON.stringify(await formatOneRecord(host)));
  const legacy = [path.join(root, 'legacy-absent'), path.join(root, 'legacy-present')];
  const missing = [path.join(root, 'missing-home', '.installed.json'),
    path.join(root, 'existing-home', '.installed.json')];
  await fs.mkdir(legacy[1]);
  await fs.mkdir(path.dirname(missing[1]));
  const index = { version: 2, records: [own, ...(offers ? missing : [])], legacy: offers ? legacy : [] };
  const registryPath = rulesRegistryPath(host);
  await fs.writeFile(registryPath, JSON.stringify(index));
  return { ...state, record, own, legacy, missing, index, registryPath };
}

function assertQuestion(question, state) {
  for (const [kind, names] of [['legacy', state.legacy], ['missing', state.missing]]) {
    names.forEach((name, i) => assert.ok(question.includes(name + ' (' + kind + '; folder '
      + (i ? 'exists' : 'does not exist') + ')'), question));
  }
  assert.ok(question.includes(state.record.rules.path));
  assert.match(question, /Yes removes these references and the rules file\. No keeps both/);
}

for (const command of [uninstall, purge]) {
  for (const answer of ['yes', 'no', '', undefined, 'non-TTY', 'EOF', 'cancel']) {
    test(command.name + ' rules consent: ' + String(answer), async (t) => {
      const state = await setup(t);
      const { host, root, record, registryPath, own } = state;
      const before = await snapshot(root);
      const indexBefore = await fs.readFile(registryPath);
      const settingsBefore = await fs.readFile(host.settingsPath);
      const recordBefore = await fs.readFile(own);
      let calls = 0;
      const consents = command === purge ? 2 : 0;
      const options = { host, isTTY: answer !== 'non-TTY', liveRunCheck: clear,
        prompt: async (question) => {
          calls++;
          if (calls <= consents) return 'yes';
          assertQuestion(question, state);
          // Plan_83 D7 (7): even the rules question sees every original host byte.
          assert.deepEqual(await fs.readFile(host.settingsPath), settingsBefore);
          assert.deepEqual(await fs.readFile(own), recordBefore);
          if (answer === 'EOF') assert.fail('EOF uses the real terminal reader');
          return answer;
        } };
      if (answer === 'EOF') {
        // Purge's two existing consents still use its seam; uninstall tests the real EOF path.
        if (command === purge) options.prompt = () => ++calls <= 2 ? 'yes' : undefined;
        else { delete options.prompt; options.stdin = Readable.from([]); options.promptOutput = { write() {} }; }
      }
      const result = await command(options);
      if (answer === 'non-TTY' && command === purge) {
        assert.equal(result.exitCode, 1);
        assert.equal(calls, 0);
        assert.deepEqual(await snapshot(root), before);
        return;
      }
      assert.equal(calls, answer === 'non-TTY' || (answer === 'EOF' && command === uninstall) ? 0 : consents + 1);
      if (answer === 'yes') {
        assert.equal(result.exitCode, 0, result.output);
        await absent(registryPath);
        await absent(record.rules.path);
      } else if (answer === 'cancel') {
        assert.equal(result.exitCode, 130, result.output);
        assert.deepEqual(await snapshot(root), before, 'cancel preserves hooks, settings, record and index');
      } else {
        assert.equal(result.exitCode, 1, result.output);
        assert.deepEqual(await fs.readFile(registryPath), indexBefore);
        await fs.access(record.rules.path);
        assert.ok(result.output.includes('Run llm-bridge uninstall --host "' + host.root + '" again in a terminal'));
      }
    });
  }
}

for (const kind of ['pending', 'unreadable', 'inventory', 'invalid']) {
  test('blocking ' + kind + ' is never offered and preserves the entire index', async (t) => {
    const state = await setup(t, { offers: kind === 'pending' });
    const { root, host, index, registryPath, record } = state;
    const other = resolveHost({ host: path.join(root, 'Foreign Pending Root'),
      brandRoot: path.join(root, 'foreign-home'), codexHome: path.dirname(host.codexRulesDir) });
    await fs.mkdir(other.brandRoot);
    const raw = JSON.parse(await fs.readFile(state.own));
    let foreign = { ...raw, owners: {}, inventory: 'incomplete' };
    if (kind === 'pending') foreign = withPending(foreign, other, 'update', '2026-11-13T10:00:00Z');
    if (kind === 'invalid') foreign.format = 1;
    await fs.writeFile(installRecordPath(other), kind === 'unreadable' ? '{broken' : JSON.stringify(foreign));
    index.records.push(installRecordPath(other));
    await fs.writeFile(registryPath, JSON.stringify(index));
    const before = await fs.readFile(registryPath);
    const result = await uninstall({ host, isTTY: true, prompt: forbiddenPrompt });
    assert.equal(result.exitCode, 1, result.output);
    assert.deepEqual(await fs.readFile(registryPath), before);
    await fs.access(record.rules.path);
    if (kind === 'pending') {
      assert.ok(result.output.includes(other.root));
      assert.match(result.output, /uninstall --host/);
    }
  });
}

test('changed fingerprint with offerable references never asks or retires', async (t) => {
  const { host, record, registryPath } = await setup(t);
  const before = await fs.readFile(registryPath);
  await fs.writeFile(record.rules.path, 'operator change\n');
  const result = await uninstall({ host, isTTY: true, prompt: forbiddenPrompt });
  assert.equal(result.exitCode, 1, result.output);
  assert.deepEqual(await fs.readFile(registryPath), before);
  assert.equal(await fs.readFile(record.rules.path, 'utf8'), 'operator change\n');
});

for (const answer of ['yes', 'no', 'cancel']) {
  test('last-owner ' + answer + ' is the sole own-home attestation', async (t) => {
    const { host, record, registryPath, root } = await setup(t, { ownLegacy: true, offers: false });
    const before = await snapshot(root);
    let calls = 0;
    const result = await uninstall({ host, isTTY: true, prompt: (question) => {
      assert.equal(++calls, 1, 'no separate rules inventory question');
      assert.match(question, /last host using this home/);
      return answer;
    } });
    assert.equal(calls, 1);
    assert.equal(result.exitCode, answer === 'yes' ? 0 : answer === 'cancel' ? 130 : 1, result.output);
    if (answer === 'yes') { await absent(record.rules.path); await absent(registryPath); }
    else if (answer === 'cancel') assert.deepEqual(await snapshot(root), before);
    else await fs.access(record.rules.path);
  });
}

for (const command of [uninstall, purge]) {
  test(command.name + ' own-home attestation precedes the offerable question', async (t) => {
    const state = await setup(t, { ownLegacy: true });
    const { host, record, own } = state;
    const before = await fs.readFile(own);
    let calls = 0;
    const consents = command === purge ? 2 : 1;
    const result = await command({ host, isTTY: true, liveRunCheck: clear, prompt: async (question) => {
      calls++;
      assert.deepEqual(await fs.readFile(own), before);
      if (calls > consents) assertQuestion(question, state);
      else if (calls === 1) assert.match(question, command === purge ? /inventory complete/ : /last host using this home/);
      return 'yes';
    } });
    assert.equal(calls, consents + 1);
    assert.equal(result.exitCode, 0, result.output);
    await absent(record.rules.path);
    await absent(state.registryPath);
  });
}

test('last-owner no with offers never asks the rules question', async (t) => {
  const { host, registryPath, record } = await setup(t, { ownLegacy: true });
  const before = await fs.readFile(registryPath);
  let calls = 0;
  const result = await uninstall({ host, isTTY: true, prompt: () => { assert.equal(++calls, 1); return 'no'; } });
  assert.equal(result.exitCode, 1, result.output);
  assert.deepEqual(await fs.readFile(registryPath), before);
  await fs.access(record.rules.path);
});

for (const change of ['add', 'remove', 'record']) {
  test('reference ' + change + ' during consent invalidates the whole retirement', async (t) => {
    const state = await setup(t);
    const { host, index, registryPath, record, missing } = state;
    let afterQuestion;
    const result = await uninstall({ host, isTTY: true, prompt: async () => {
      if (change === 'add') index.legacy.push('new-reference');
      if (change === 'remove') index.legacy.pop();
      if (change === 'record') {
        const raw = JSON.parse(await fs.readFile(state.own));
        await fs.mkdir(path.dirname(missing[0]));
        await fs.writeFile(missing[0], JSON.stringify({ ...raw, owners: {}, inventory: 'incomplete' }));
      }
      await fs.writeFile(registryPath, JSON.stringify(index));
      afterQuestion = await fs.readFile(registryPath);
      return 'yes';
    } });
    assert.equal(result.exitCode, 1, result.output);
    assert.match(result.output, /references changed; nothing was retired/);
    assert.deepEqual(await fs.readFile(registryPath), afterQuestion);
    await fs.access(record.rules.path);
  });
}

test('a fingerprint changed during consent retires references but keeps the edited file', async (t) => {
  const { host, record, registryPath } = await setup(t);
  const result = await uninstall({ host, isTTY: true, prompt: async () => {
    await fs.writeFile(record.rules.path, 'changed during question');
    return 'yes';
  } });
  assert.equal(result.exitCode, 1, result.output);
  await absent(registryPath);
  assert.equal(await fs.readFile(record.rules.path, 'utf8'), 'changed during question');
});

for (const command of [uninstall, purge]) {
  test(command.name + ' dry-run lists a real-run question without asking or writing', async (t) => {
    const state = await setup(t);
    const before = await snapshot(state.root);
    const result = await command({ host: state.host, dryRun: true, isTTY: true,
      prompt: forbiddenPrompt, liveRunCheck: clear });
    assert.equal(result.exitCode, 1, result.output);
    assert.match(result.output, /A real run would ask/);
    assertQuestion(result.output, state);
    assert.deepEqual(await snapshot(state.root), before);
  });
}

test('a live owner keeps unknowns informational without a rules question', async (t) => {
  const state = await setup(t);
  const other = resolveHost({ host: path.join(state.root, 'live-host'),
    brandRoot: path.join(state.root, 'live-home'), codexHome: path.dirname(state.host.codexRulesDir) });
  assert.equal((await install({ host: other })).exitCode, 0);
  const result = await uninstall({ host: state.host, isTTY: true, prompt: forbiddenPrompt });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /1 other owner remains/);
  assert.match(result.output, /ownership references cannot be verified/);
  await fs.access(state.record.rules.path);
});

test('purge inventory consent never resolves a foreign pending reference in its own record', async (t) => {
  const state = await setup(t);
  const other = { root: path.join(state.root, 'pending-host'), scope: 'host' };
  const raw = JSON.parse(await fs.readFile(state.own));
  await fs.writeFile(state.own, JSON.stringify(withPending(raw, other, 'install', '2026-11-13T10:00:00Z')));
  const before = await fs.readFile(state.registryPath);
  let calls = 0;
  const result = await purge({ host: state.host, isTTY: true, liveRunCheck: clear, prompt: () => {
    assert.ok(++calls <= 2, 'foreign pending must block the rules question after inventory consent');
    return 'yes';
  } });
  assert.equal(result.exitCode, 1, result.output);
  assert.deepEqual(await fs.readFile(state.registryPath), before);
  assert.ok(result.output.includes(other.root));
  await fs.access(state.record.rules.path);
});

test('retirement API removes exactly the named set and refuses a missing confirmed reference', async (t) => {
  const { host, index, registryPath, missing, legacy } = await setup(t);
  const before = await fs.readFile(registryPath);
  assert.equal(await retireRulesReferences(host, { records: [missing[0]], legacy: ['not-present'],
    expectedIndex: index, verify: async () => true }), false);
  assert.deepEqual(await fs.readFile(registryPath), before);
  assert.equal(await retireRulesReferences(host, { records: [missing[0]], legacy: [legacy[0]],
    expectedIndex: index, verify: async () => true }), true);
  assert.deepEqual(JSON.parse(await fs.readFile(registryPath)), { version: 2,
    records: index.records.filter((file) => file !== missing[0]), legacy: [legacy[1]] });
});

test('rules preflight requires explicit fingerprint evidence and performs only reads', async (t) => {
  const state = await setup(t);
  const before = await snapshot(state.root);
  await assert.rejects(preflightRulesRemoval(state.record.rules.path, undefined, { host: state.host }), /fingerprint is required/);
  const plan = await preflightRulesRemoval(state.record.rules.path, state.record.rules.fingerprint, { host: state.host });
  assert.deepEqual(plan.live, []);
  assert.deepEqual(plan.blocking, []);
  assert.equal(plan.offerable.length, 4);
  assert.equal(plan.currentFingerprint, state.record.rules.fingerprint);
  assert.equal(plan.canAsk, true);
  assert.deepEqual(await snapshot(state.root), before);
});

for (const command of [uninstall, purge]) {
  test(command.name + ' cancellation after own-home consent preserves the whole host', async (t) => {
    const state = await setup(t, { ownLegacy: true });
    const before = await snapshot(state.root);
    const consents = command === purge ? 2 : 1;
    let calls = 0;
    const result = await command({ host: state.host, isTTY: true, liveRunCheck: clear,
      prompt: () => ++calls <= consents ? 'yes' : 'cancel' });
    assert.equal(calls, consents + 1);
    assert.equal(result.exitCode, 130, result.output);
    assert.deepEqual(await snapshot(state.root), before);
  });
}

test('version-1 yes retires the named legacy strings together with its own host hint', async (t) => {
  const state = await setup(t);
  const ownKey = state.host.root.replaceAll('\\', '/').toLowerCase();
  await fs.writeFile(state.registryPath, JSON.stringify({ version: 1, owners: [...state.legacy, ownKey] }));
  const result = await uninstall({ host: state.host, isTTY: true, prompt: () => 'yes' });
  assert.equal(result.exitCode, 0, result.output);
  await absent(state.registryPath);
  await absent(state.record.rules.path);
});

test('record without rules metadata still retires only its exact host hint', async (t) => {
  const state = await setup(t);
  const ownKey = state.host.root.replaceAll('\\', '/').toLowerCase();
  await fs.writeFile(state.registryPath, JSON.stringify({ version: 1, owners: [ownKey, ...state.legacy] }));
  const raw = JSON.parse(await fs.readFile(state.own));
  for (const owner of Object.values(raw.owners)) delete owner.rules;
  await fs.writeFile(state.own, JSON.stringify(raw));
  const result = await uninstall({ host: state.host, isTTY: true, prompt: forbiddenPrompt });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(JSON.parse(await fs.readFile(state.registryPath)), { version: 2, records: [], legacy: state.legacy });
  await fs.access(state.record.rules.path);
});

test('a failed retirement publication preserves every reference and the rules file', async (t) => {
  const state = await setup(t);
  // A verified detached foreign record keeps the index nonempty so retirement must publish atomically.
  const raw = JSON.parse(await fs.readFile(state.own));
  for (const owner of Object.values(raw.owners)) delete owner.rules;
  await fs.writeFile(state.missing[1], JSON.stringify(raw));
  const before = await fs.readFile(state.registryPath);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === state.registryPath) throw Object.assign(new Error('retirement denied'), { code: 'EACCES' });
    return rename(from, to);
  });
  const result = await uninstall({ host: state.host, isTTY: true, prompt: () => 'yes' });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /retirement denied/);
  assert.deepEqual(await fs.readFile(state.registryPath), before);
  await fs.access(state.record.rules.path);
});

for (const command of [uninstall, purge]) {
  test(command.name + ' a host with unreadable settings remains an owner and never asks about rules', async (t) => {
    const state = await setup(t);
    await fs.writeFile(state.host.settingsPath, '{broken settings');
    const before = await snapshot(state.root);
    let calls = 0;
    const result = await command({ host: state.host, isTTY: true, liveRunCheck: clear, prompt: () => {
      assert.equal(command, purge, 'only the existing purge consents are allowed');
      assert.ok(++calls <= 2);
      return 'yes';
    } });
    assert.equal(result.exitCode, 1, result.output);
    assert.equal(calls, command === purge ? 2 : 0);
    assert.deepEqual(await snapshot(state.root), before);
  });
}
