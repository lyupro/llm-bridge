/** Verifies record-backed rules ownership and conservative treatment of uncertain references. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { classifyRulesOwnership, remainingRulesOwnership, rulesOwnerHints } from '../../cli/rules-ownership.mjs';
import { readRulesIndex } from '../../cli/rules-index.mjs';
import { withOwner } from '../../cli/install-owners.mjs';
import { withPending } from '../../cli/install-pending.mjs';
import { normalizedRulesOwner, rulesRegistryPath } from '../../cli/rules-owners.mjs';

function fixture() {
  const root = makeTempTree('rules-ownership-');
  const host = { root: path.join(root, 'host'), scope: 'host', codexRulesDir: path.join(root, 'rules') };
  const rulesPath = path.join(host.codexRulesDir, 'llm-bridge.rules');
  const recordPath = path.join(root, '.installed.json');
  const old = {
    name: '@lyupro/llm-bridge', version: '0.7.0', installedAt: '2026-11-12T10:00:00Z', mode: 'copy',
    files: [{ root: 'brand', path: 'hooks/reply-guard.mjs' }],
    hooks: [{ event: 'SubagentStop', root: 'brand', path: 'hooks/reply-guard.mjs',
      command: 'llm-bridge hook reply-guard' }],
    rules: { path: rulesPath, fingerprint: 'a'.repeat(64) },
  };
  const record = withOwner(null, host, old, { homeHadImage: false });
  const key = normalizedRulesOwner(host);
  const index = { version: 2, records: [recordPath], legacy: [] };
  return { root, host, rulesPath, recordPath, old, record, key, index };
}

async function publish(f, record = f.record) {
  await fs.writeFile(f.recordPath, JSON.stringify(record));
}

function classify(f) {
  return classifyRulesOwnership(f.index, f.rulesPath, f.recordPath);
}

function unknown(result, reference, reason) {
  assert.deepEqual(result.live, []);
  assert.deepEqual(result.detached, []);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.unknown[0].recordPath, reference);
  assert.match(result.unknown[0].reason, reason);
}

test('a complete record lists only owners referring to this rules file', async () => {
  const f = fixture();
  const secondHost = { root: path.join(f.root, 'second'), scope: 'host' };
  const secondKey = normalizedRulesOwner(secondHost);
  const thirdHost = { root: path.join(f.root, 'third'), scope: 'host' };
  const multi = withOwner(withOwner(f.record, secondHost, f.old), thirdHost,
    { ...f.old, rules: { ...f.old.rules, path: path.join(f.root, 'other', 'llm-bridge.rules') } });
  await publish(f, multi);
  assert.deepEqual(await classify(f), {
    live: [{ recordPath: f.recordPath, owners: [f.key, secondKey] }], unknown: [], detached: [],
  });
});

for (const [label, change, reason] of [
  ['invalid structure', (f) => ({ ...f.record, owners: [] }), /invalid installation record/],
  ['invalid owner rules', (f) => ({ ...f.record, owners: { [f.key]: { ...f.record.owners[f.key], rules: {} } } }), /invalid installation record/],
  ['not format 2', (f) => f.old, /not format 2/],
  ['unknown format', (f) => ({ ...f.record, format: 3 }), /not format 2/],
  ['legacy present', (f) => ({ ...f.record, legacy: f.old }), /legacy/],
  ['legacy null present', (f) => ({ ...f.record, legacy: null }), /invalid installation record/],
  ['incomplete inventory', (f) => ({ ...f.record, inventory: 'incomplete' }), /inventory is incomplete/],
  ['missing inventory', (f) => { const { inventory, ...rest } = f.record; return rest; }, /invalid installation record/],
  ['pending hosts', (f) => withPending(withPending(f.record, f.host, 'install', f.old.installedAt), { root: path.join(f.root, 'OtherHost') }, 'update', f.old.installedAt), /pending hosts/],
  ['pending object', (f) => ({ ...f.record, pending: { rules: f.rulesPath } }), /invalid.*pending/],
  ['pending false', (f) => ({ ...f.record, pending: false }), /invalid.*pending/],
  ['pending null', (f) => ({ ...f.record, pending: null }), /invalid.*pending/],
]) {
  test(`an indexed record with ${label} is unknown`, async () => {
    const f = fixture();
    await publish(f, change(f));
    const result = await classify(f); unknown(result, f.recordPath, reason);
    if (label === 'pending hosts') for (const text of [f.host.root + ' (install)', path.join(f.root, 'OtherHost') + ' (update)']) assert.ok(result.unknown[0].reason.includes(text));
  });
}

test('a missing indexed record is unknown, never detached', async () => {
  const f = fixture();
  unknown(await classify(f), f.recordPath, /does not exist.*ENOENT/);
});

test('malformed record JSON stays unknown with its parse reason and file', async () => {
  const f = fixture();
  await fs.writeFile(f.recordPath, '{"format":2,');
  const result = await classify(f);
  unknown(result, f.recordPath, /cannot parse/);
  assert.ok(result.unknown[0].reason.includes(f.recordPath));
});

for (const code of ['EACCES', 'EPERM', 'ENOTDIR']) {
  test(`${code} remains unknown with its reason rather than becoming absence`, async (t) => {
    const f = fixture();
    await publish(f);
    const readFile = fs.readFile;
    t.mock.method(fs, 'readFile', async (file, ...args) => {
      if (file === f.recordPath) throw Object.assign(new Error(`${code}: record access refused`), { code });
      return readFile(file, ...args);
    });
    const result = await classify(f);
    unknown(result, f.recordPath, new RegExp(`${code}:.*record access refused`));
    assert.doesNotMatch(result.unknown[0].reason, /does not exist/);
  });
}

test('an unreadable directory in place of a record stays unknown', async () => {
  const f = fixture();
  await fs.mkdir(f.recordPath);
  unknown(await classify(f), f.recordPath, /cannot read installation record/);
});

for (const hasRules of [true, false]) {
  test(`a complete record with ${hasRules ? 'different' : 'no'} rules is detached`, async () => {
    const f = fixture();
    if (hasRules) f.record.owners[f.key].rules.path = path.join(f.root, 'other', 'llm-bridge.rules');
    else delete f.record.owners[f.key].rules;
    await publish(f);
    assert.deepEqual(await classify(f), { live: [], unknown: [], detached: [{ recordPath: f.recordPath }] });
  });
}

test('relative rules paths compare by resolved lexical identity without reading the rules file', async (t) => {
  const f = fixture();
  f.record.owners[f.key].rules.path = path.relative(process.cwd(), f.rulesPath);
  await publish(f);
  t.mock.method(fs, 'realpath', () => { throw new Error('Plan_65 D5 forbids realpath'); });
  t.mock.method(fs, 'stat', () => { throw new Error('folder existence is not evidence'); });
  t.mock.method(fs, 'access', () => { throw new Error('folder existence is not evidence'); });
  const result = await classify(f);
  assert.deepEqual(result.live, [{ recordPath: f.recordPath, owners: [f.key] }]);
});

test('Windows case and slash variants follow the existing lexical normalizer', async () => {
  const f = fixture();
  f.record.owners[f.key].rules.path = process.platform === 'win32'
    ? path.join(path.dirname(f.rulesPath).toUpperCase(), path.basename(f.rulesPath)).replaceAll('\\', '/') : f.rulesPath;
  await publish(f);
  assert.equal((await classify(f)).live.length, 1);
});

test('link aliases are not resolved into rules-file identity', async () => {
  const f = fixture();
  const real = path.join(f.root, 'real');
  const alias = path.join(f.root, 'alias');
  await fs.mkdir(real);
  await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.record.owners[f.key].rules.path = path.join(alias, 'llm-bridge.rules');
  await publish(f);
  const result = await classifyRulesOwnership(f.index, path.join(real, 'llm-bridge.rules'), f.recordPath);
  assert.deepEqual(result.detached, [{ recordPath: f.recordPath }]);
  assert.deepEqual(result.live, []);
});

test('matching legacy and indexed evidence group owners by record without double counting', async () => {
  const f = fixture();
  await publish(f);
  f.index.legacy = [f.key, f.key];
  assert.deepEqual(await classify(f), {
    live: [{ recordPath: f.recordPath, owners: [f.key] }], unknown: [], detached: [],
  });
});

for (const extra of [{ inventory: 'incomplete' }, { pending: false }, 'legacy']) {
  test(`a matching legacy key uses readable format-2 evidence (${JSON.stringify(extra)})`, async () => {
    const f = fixture();
    // B1's legacy exception proves this owner only; it does not attest the entire inventory.
    await publish(f, { ...f.record, ...(extra === 'legacy' ? { legacy: f.old } : extra) });
    f.index = { version: 2, records: [], legacy: [f.key] };
    if (extra.pending === false) return unknown(await classify(f), f.recordPath, /invalid.*pending/);
    assert.deepEqual(await classify(f), {
      live: [{ recordPath: f.recordPath, owners: [f.key] }], unknown: [], detached: [],
    });
  });
}

for (const kind of ['absent owner', 'different rules', 'no rules', 'non-exact key']) {
  test(`a legacy reference with ${kind} is unknown`, async () => {
    const f = fixture();
    const legacy = kind === 'absent owner' ? path.join(f.root, 'vanished')
      : kind === 'non-exact key' ? `${f.key}/` : f.key;
    if (kind === 'different rules') f.record.owners[f.key].rules.path = path.join(f.root, 'other', 'llm-bridge.rules');
    if (kind === 'no rules') delete f.record.owners[f.key].rules;
    await publish(f);
    f.index = { version: 2, records: [], legacy: [legacy] };
    const result = await classify(f);
    unknown(result, f.recordPath, /not in the current|does not reference/);
    assert.equal(result.unknown[0].legacy, legacy);
  });
}

for (const kind of ['missing', 'invalid', 'format 1', 'permission']) {
  test(`legacy hints stay unknown when the current record is ${kind}`, async (t) => {
    const f = fixture();
    if (kind === 'invalid') await fs.writeFile(f.recordPath, '{broken');
    if (kind === 'format 1') await publish(f, f.old);
    if (kind === 'permission') {
      t.mock.method(fs, 'readFile', async () => {
        throw Object.assign(new Error('EACCES: record denied'), { code: 'EACCES' });
      });
    }
    f.index = { version: 2, records: [], legacy: [f.key] };
    const result = await classify(f);
    unknown(result, f.recordPath, /ENOENT|cannot parse|not format 2|EACCES/);
    assert.equal(result.unknown[0].legacy, f.key);
  });
}

test('OW-086 retains three snapshot hints and reconstructs one live plus three unknown', async () => {
  const f = fixture();
  // OW-086: vanished scratchpad probe folders remain unknown ownership hints.
  const probes = [1, 2, 3].map((id) => path.join(f.root, `scratchpad-probe-${id}`));
  for (const probe of probes) {
    await fs.mkdir(probe);
    await fs.rmdir(probe);
  }
  const snapshot = { version: 1, owners: probes.map((root) => normalizedRulesOwner({ root })) };
  assert.equal(snapshot.owners.length, 3);
  await publish(f);
  await fs.mkdir(f.host.codexRulesDir);
  await fs.writeFile(rulesRegistryPath(f.host), JSON.stringify(snapshot));
  const snapshotIndex = await readRulesIndex(f.host);
  const unresolved = await classifyRulesOwnership(snapshotIndex, f.rulesPath, f.recordPath);
  assert.deepEqual(unresolved.unknown.map((item) => item.legacy), snapshot.owners);
  assert.equal(unresolved.live.length, 0);
  const four = { ...snapshot, owners: [...snapshot.owners, f.key] };
  await fs.writeFile(rulesRegistryPath(f.host), JSON.stringify(four));
  const before = await fs.readFile(f.recordPath, 'utf8');
  const result = await classifyRulesOwnership(await readRulesIndex(f.host), f.rulesPath, f.recordPath);
  assert.deepEqual(result.live, [{ recordPath: f.recordPath, owners: [f.key] }]);
  assert.deepEqual(result.unknown.map((item) => item.legacy), snapshot.owners);
  assert.equal(result.detached.length, 0);
  assert.equal(await fs.readFile(f.recordPath, 'utf8'), before);
  assert.deepEqual(JSON.parse(await fs.readFile(rulesRegistryPath(f.host), 'utf8')), four);
});

test('classifications remain separate across multiple bridge-home records', async () => {
  const f = fixture();
  const second = fixture();
  await publish(f);
  await publish(second);
  const index = { version: 2, records: [f.recordPath, second.recordPath, path.join(f.root, 'missing', '.installed.json')], legacy: [] };
  const result = await classifyRulesOwnership(index, f.rulesPath, f.recordPath);
  assert.deepEqual(result.live, [{ recordPath: f.recordPath, owners: [f.key] }]);
  assert.deepEqual(result.detached, [{ recordPath: second.recordPath }]);
  assert.equal(result.unknown.length, 1);
});

test('an absent index has no references and does not read a record', async (t) => {
  const f = fixture();
  t.mock.method(fs, 'readFile', () => { throw new Error('unexpected read'); });
  assert.deepEqual(await classifyRulesOwnership(null, f.rulesPath, f.recordPath), { live: [], unknown: [], detached: [] });
});

test('required rules and current-record paths never silently default', async () => {
  const f = fixture();
  await assert.rejects(classifyRulesOwnership(undefined, f.rulesPath, f.recordPath), /rules index is required/);
  await assert.rejects(rulesOwnerHints(undefined), /rules index is required/);
  await assert.rejects(classifyRulesOwnership(f.index, undefined, f.recordPath), /rules path is required/);
  await assert.rejects(classifyRulesOwnership(f.index, f.rulesPath), /current installation-record path is required/);
});

function afterDeparture(f) {
  return remainingRulesOwnership(f.index, { ...f.host, brandInstallRecordPath: f.recordPath }, f.old);
}

test('departure removes this host from its own record and legacy without changing either input', async () => {
  const f = fixture();
  const second = { root: path.join(f.root, 'second'), scope: 'host' };
  await publish(f, withOwner(f.record, second, f.old));
  f.index.legacy = [f.key, normalizedRulesOwner(second), path.join(f.root, 'vanished')];
  const before = await fs.readFile(f.recordPath, 'utf8');
  const indexBefore = structuredClone(f.index);
  const result = await afterDeparture(f);
  assert.deepEqual(result.live, [{ recordPath: f.recordPath, owners: [normalizedRulesOwner(second)] }]);
  assert.deepEqual(result.unknown.map((item) => item.legacy), [path.join(f.root, 'vanished')]);
  assert.match(result.unknown[0].reason, /not in the current installation record/);
  assert.equal(await fs.readFile(f.recordPath, 'utf8'), before);
  assert.deepEqual(f.index, indexBefore);
});

test('departure preserves the same host key when a different bridge-home record still owns rules', async () => {
  const f = fixture();
  const other = path.join(f.root, 'other', '.installed.json');
  await fs.mkdir(path.dirname(other));
  await publish(f);
  await fs.writeFile(other, JSON.stringify(f.record));
  f.index.records.push(other);
  assert.deepEqual((await afterDeparture(f)).live, [{ recordPath: other, owners: [f.key] }]);
});

test('departure removes its own legacy hint even when its record cannot verify that hint', async () => {
  const f = fixture();
  f.index.legacy = [f.key, 'vanished'];
  const result = await afterDeparture(f);
  assert.deepEqual(result.live, []);
  assert.equal(result.unknown.length, 2);
  assert.equal(result.unknown[0].recordPath, f.recordPath);
  assert.equal(result.unknown[1].legacy, 'vanished');
  assert.match(result.unknown[1].reason, /ENOENT/);
});

test('departure leaves unknown records blocking and ignores verified detached records', async () => {
  const f = fixture();
  await publish(f);
  const other = fixture();
  await publish(other);
  const missing = path.join(f.root, 'missing', '.installed.json');
  f.index.records.push(other.recordPath, missing);
  const result = await afterDeparture(f);
  assert.deepEqual(result.live, []);
  assert.deepEqual(result.detached, [{ recordPath: other.recordPath }]);
  assert.equal(result.unknown[0].recordPath, missing);
  assert.match(result.unknown[0].reason, /ENOENT/);
});

test('departure with only its own legacy hint has no remaining references', async () => {
  const f = fixture();
  await publish(f);
  f.index = { version: 2, records: [], legacy: [f.key] };
  assert.deepEqual(await afterDeparture(f), { live: [], unknown: [], detached: [] });
});

test('departure preserves no-registry separately from an empty index', async (t) => {
  const f = fixture();
  t.mock.method(fs, 'readFile', () => { throw new Error('unexpected record read'); });
  f.index = null;
  assert.equal(await afterDeparture(f), null);
  f.index = { version: 2, records: [], legacy: [] };
  assert.deepEqual(await afterDeparture(f), { live: [], unknown: [], detached: [] });
  f.index = undefined;
  await assert.rejects(afterDeparture(f), /rules index is required/);
});

for (const [label, change, reason] of [
  ['incomplete', (f) => ({ ...f.record, inventory: 'incomplete' }), /inventory is incomplete/],
  ['pending', (f) => ({ ...f.record, pending: false }), /invalid.*pending/],
  ['legacy', (f) => ({ ...f.record, legacy: f.old }), /legacy/],
]) {
  test('departure cannot clear its indexed ' + label + ' record uncertainty', async () => {
    const f = fixture();
    await publish(f, change(f));
    f.index.legacy = [f.key];
    const result = await afterDeparture(f);
    assert.deepEqual(result.live, []);
    assert.equal(result.unknown.length, 1);
    assert.equal(result.unknown[0].recordPath, f.recordPath);
    assert.equal(result.unknown[0].legacy, undefined);
    assert.match(result.unknown[0].reason, reason);
  });
}

// OW-086 / Plan_83 B3a: hints retain legacy order and every host named by readable records.
test('version-1 hint strings remain unchanged through the index reader', async () => {
  const f = fixture();
  const owners = ['legacy-first', 'legacy-second'];
  await fs.mkdir(f.host.codexRulesDir);
  await fs.writeFile(rulesRegistryPath(f.host), JSON.stringify({ version: 1, owners }));
  assert.deepEqual(await rulesOwnerHints(await readRulesIndex(f.host)), owners);
});

test('version-2 hints deduplicate legacy and record owners in index order without changing evidence', async () => {
  const f = fixture();
  const other = fixture();
  const second = { root: path.join(f.root, 'second'), scope: 'host' };
  await publish(f, withOwner(f.record, second, f.old));
  delete other.record.owners[other.key].rules;
  await publish(other, withPending({ ...other.record, inventory: 'incomplete' }, other.host, 'install', other.old.installedAt));
  const index = { version: 2, legacy: ['legacy', f.key, 'legacy'], records: [f.recordPath, other.recordPath, f.recordPath] };
  assert.deepEqual(await rulesOwnerHints({ version: 2, legacy: ['legacy'], records: [f.recordPath] }),
    ['legacy', f.key, normalizedRulesOwner(second)]);
  const before = structuredClone(index);
  const bytes = await fs.readFile(f.recordPath);
  assert.deepEqual(await rulesOwnerHints(index), ['legacy', f.key, normalizedRulesOwner(second), other.key]);
  assert.deepEqual(index, before);
  assert.deepEqual(await fs.readFile(f.recordPath), bytes);
});

for (const kind of ['missing', 'malformed', 'invalid', 'format 1', 'directory', 'permission']) {
  test(`hint records that are ${kind} contribute no host keys`, async (t) => {
    const f = fixture();
    if (kind === 'malformed') await fs.writeFile(f.recordPath, '{');
    if (kind === 'invalid') await publish(f, { ...f.record, owners: [] });
    if (kind === 'format 1') await publish(f, f.old);
    if (kind === 'directory') await fs.mkdir(f.recordPath);
    if (kind === 'permission') t.mock.method(fs, 'readFile', async () => {
      throw Object.assign(new Error('record access refused'), { code: 'EACCES' });
    });
    assert.deepEqual(await rulesOwnerHints({ ...f.index, legacy: ['legacy'] }), ['legacy']);
  });
}

test('an absent hint index returns no hosts and reads no record', async (t) => {
  t.mock.method(fs, 'readFile', () => { throw new Error('unexpected record read'); });
  assert.deepEqual(await rulesOwnerHints(null), []);
});
