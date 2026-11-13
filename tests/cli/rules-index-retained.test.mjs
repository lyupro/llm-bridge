/** Plan_83 D8: installation evidence outlives its owner without becoming ownership. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateIndex, readRulesIndex } from '../../cli/rules-index.mjs';
import { addRulesOwner, removeRulesOwner, retireRulesReferences, readRulesRegistry,
  rulesRegistryPath, normalizedRulesOwner } from '../../cli/rules-owners.mjs';
import { installRecordPath, RULES_NAME, readInstallRecord } from '../../cli/install-record.mjs';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { preflightRulesRemoval, rulesDryRunLines } from '../../cli/uninstall-rules.mjs';
import { fixture } from './host-fixture.mjs';

const fingerprint = 'a'.repeat(64);
const otherFingerprint = 'b'.repeat(64);
const base = { version: 2, records: [], legacy: [] };
const baseline = { path: path.resolve('rules', RULES_NAME), fingerprint };

async function indexFixture(t) {
  const state = await fixture(t);
  await fs.mkdir(state.host.codexRulesDir, { recursive: true });
  return { ...state, file: rulesRegistryPath(state.host),
    own: { path: path.join(state.host.codexRulesDir, RULES_NAME), fingerprint },
    other: { path: path.join(state.host.codexRulesDir, 'other.rules'), fingerprint: otherFingerprint } };
}

async function writeIndex(state, index) {
  await fs.writeFile(state.file, JSON.stringify(index));
}

async function installed(t) {
  const state = await fixture(t);
  assert.equal((await install({ host: state.host })).exitCode, 0);
  const record = await readInstallRecord(state.host);
  return { ...state, record, file: rulesRegistryPath(state.host),
    own: { path: record.rules.path, fingerprint: record.rules.fingerprint } };
}

test('v2 retains multiple installation fingerprints for one path and preserves bytes on read', async (t) => {
  const state = await indexFixture(t);
  const retained = [state.own, { ...state.own, fingerprint: otherFingerprint }, state.other];
  const index = { ...base, retained };
  await writeIndex(state, index);
  const bytes = await fs.readFile(state.file);
  assert.deepEqual(validateIndex(index), index);
  assert.deepEqual(await readRulesIndex(state.host), index);
  assert.deepEqual((await readRulesRegistry(state.host)).retained, retained);
  assert.deepEqual(await fs.readFile(state.file), bytes);
});

for (const [label, retained] of [
  ['empty', []], ['null', null], ['object', {}], ['null entry', [null]],
  ['relative path', [{ ...baseline, path: 'rules/file.rules' }]],
  ['empty path', [{ ...baseline, path: '' }]], ['non-string path', [{ ...baseline, path: 12 }]],
  ['non-hex', [{ ...baseline, fingerprint: 'g'.repeat(64) }]],
  ['short hash', [{ ...baseline, fingerprint: 'a'.repeat(63) }]],
  ['long hash', [{ ...baseline, fingerprint: 'a'.repeat(65) }]],
  ['non-string hash', [{ ...baseline, fingerprint: 123 }]],
  ['duplicate pair', [baseline, { ...baseline }]],
]) {
  test('invalid retained ' + label + ' fails readers and writers without a rewrite', async (t) => {
    const state = await indexFixture(t);
    const index = { ...base, retained };
    await writeIndex(state, index);
    const bytes = await fs.readFile(state.file);
    assert.throws(() => validateIndex(index), /retained/);
    for (const operation of [readRulesIndex, readRulesRegistry, addRulesOwner, removeRulesOwner]) {
      await assert.rejects(operation(state.host), /retained/);
      assert.deepEqual(await fs.readFile(state.file), bytes);
    }
  });
}

test('v1 reads as legacy without any retained evidence', async (t) => {
  const state = await indexFixture(t);
  await writeIndex(state, { version: 1, owners: ['legacy-host'] });
  assert.deepEqual(await readRulesIndex(state.host), { ...base, legacy: ['legacy-host'] });
  assert.equal(Object.hasOwn(await readRulesRegistry(state.host), 'retained'), false);
});

test('registration preserves other paths and removes every baseline for its lexical rules path', async (t) => {
  const state = await indexFixture(t);
  const alias = path.dirname(state.own.path) + '/unused/../' + RULES_NAME;
  const retained = [state.own, { path: alias, fingerprint: otherFingerprint }, state.other];
  await writeIndex(state, { ...base, records: [installRecordPath(state.host)], retained });
  const registry = await addRulesOwner(state.host);
  assert.deepEqual(registry.retained, [state.other]);
  assert.deepEqual(await readRulesIndex(state.host), {
    ...base, records: [installRecordPath(state.host)], retained: [state.other] });
  const bytes = await fs.readFile(state.file);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    assert.notEqual(to, state.file, 'identical retained evidence must not trigger a publication');
    return rename(from, to);
  });
  await addRulesOwner(state.host);
  assert.deepEqual(await fs.readFile(state.file), bytes);
});

test('registration omits retained when it clears the last baseline even if owners are identical', async (t) => {
  const state = await indexFixture(t);
  await writeIndex(state, { ...base, records: [installRecordPath(state.host)], retained: [state.own] });
  await addRulesOwner(state.host);
  assert.deepEqual(await readRulesIndex(state.host), { ...base, records: [installRecordPath(state.host)] });
});

for (const removeRecord of [false, true]) {
  test('owner removal round-trips retained with removeRecord=' + removeRecord, async (t) => {
    const state = await indexFixture(t);
    const retained = [state.own, state.other];
    await writeIndex(state, { ...base, records: [installRecordPath(state.host)],
      legacy: [normalizedRulesOwner(state.host)], retained });
    await removeRulesOwner(state.host, { removeRecord });
    assert.deepEqual(await readRulesIndex(state.host), { ...base,
      records: removeRecord ? [] : [installRecordPath(state.host)], retained });
  });
}

test('reference retirement keeps the otherwise empty index and every retained pair', async (t) => {
  const state = await indexFixture(t);
  const retained = [state.own, state.other];
  const index = { ...base, records: [installRecordPath(state.host)], legacy: ['offer'], retained };
  await writeIndex(state, index);
  assert.equal(await retireRulesReferences(state.host, { records: index.records, legacy: index.legacy,
    expectedIndex: index, verify: async () => true }), true);
  assert.deepEqual(await readRulesIndex(state.host), { ...base, retained });
});

test('a retained-only change invalidates the consent snapshot', async (t) => {
  const state = await indexFixture(t);
  const expectedIndex = { ...base, legacy: ['offer'], retained: [state.own] };
  await writeIndex(state, { ...expectedIndex, retained: [state.other] });
  const bytes = await fs.readFile(state.file);
  assert.equal(await retireRulesReferences(state.host, { records: [], legacy: ['offer'],
    expectedIndex, verify: async () => true }), false);
  assert.deepEqual(await fs.readFile(state.file), bytes);
});

for (const reason of ['refusal', 'no terminal', 'blocking']) {
  test('last departure stores the owner baseline and retires both own references: ' + reason, async (t) => {
    const state = await installed(t);
    const ownRecord = installRecordPath(state.host);
    const foreign = path.join(state.root, 'foreign', '.installed.json');
    const index = { ...base, records: [ownRecord, foreign],
      legacy: [normalizedRulesOwner(state.host), 'unconfirmed'] };
    if (reason === 'blocking') {
      const raw = JSON.parse(await fs.readFile(ownRecord));
      await fs.mkdir(path.dirname(foreign));
      await fs.writeFile(foreign, JSON.stringify({ ...raw, owners: {}, inventory: 'incomplete' }));
    }
    await writeIndex(state, index);
    const rename = fs.rename;
    let publications = 0;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (to === state.file) {
        publications++;
        await fs.access(state.file + '.lock');
        assert.deepEqual(JSON.parse(await fs.readFile(from)), { ...base, records: [foreign],
          legacy: ['unconfirmed'], retained: [state.own] });
      }
      return rename(from, to);
    });
    const result = await uninstall({ host: state.host, isTTY: reason !== 'no terminal', prompt: () => 'no' });
    assert.equal(result.exitCode, 1, result.output);
    assert.equal(publications, 1, 'baseline and both departing references change in one locked publication');
    assert.deepEqual(await readRulesIndex(state.host), { ...base, records: [foreign],
      legacy: ['unconfirmed'], retained: [state.own] });
    await fs.access(state.own.path);
  });
}

for (const disposition of ['removed', 'absent', 'edited']) {
  test('departure handles retained baselines when the rules file is ' + disposition, async (t) => {
    const state = await installed(t);
    const retained = [state.own, { ...state.own, fingerprint: otherFingerprint },
      { path: path.join(state.host.codexRulesDir, 'other.rules'), fingerprint }];
    await writeIndex(state, { ...base, records: [installRecordPath(state.host)], retained });
    if (disposition === 'absent') await fs.rename(state.own.path, path.join(state.root, 'saved-rules'));
    if (disposition === 'edited') await fs.writeFile(state.own.path, 'operator edit');
    const result = await uninstall({ host: state.host });
    assert.equal(result.exitCode, 0, result.output);
    assert.deepEqual(await readRulesIndex(state.host), { ...base,
      retained: disposition === 'edited' ? retained : retained.slice(2) });
    if (disposition === 'edited') assert.equal(await fs.readFile(state.own.path, 'utf8'), 'operator edit');
    else await assert.rejects(fs.access(state.own.path), { code: 'ENOENT' });
  });
}

test('an offerable refusal preserves the stored row hash rather than the matching retained hash', async (t) => {
  const state = await installed(t);
  const file = installRecordPath(state.host);
  const raw = JSON.parse(await fs.readFile(file));
  Object.values(raw.owners)[0].rules.fingerprint = otherFingerprint;
  await fs.writeFile(file, JSON.stringify(raw));
  await writeIndex(state, { ...base, records: [file], legacy: ['offer'], retained: [state.own] });
  const result = await uninstall({ host: state.host, isTTY: true, prompt: () => 'no' });
  assert.equal(result.exitCode, 1, result.output);
  assert.deepEqual(await readRulesIndex(state.host), { ...base, legacy: ['offer'],
    retained: [state.own, { ...state.own, fingerprint: otherFingerprint }] });
});

for (const offerable of [false, true]) {
  test('the existing record path accepts any retained baseline; offers=' + offerable, async (t) => {
    const state = await installed(t);
    const file = installRecordPath(state.host);
    const raw = JSON.parse(await fs.readFile(file));
    Object.values(raw.owners)[0].rules.fingerprint = otherFingerprint;
    await fs.writeFile(file, JSON.stringify(raw));
    const record = await readInstallRecord(state.host);
    await writeIndex(state, { ...base, records: [file], legacy: offerable ? ['offer'] : [],
      retained: [{ ...state.own, fingerprint: 'c'.repeat(64) }, state.own] });
    const plan = await preflightRulesRemoval(record.rules.path, record.rules.fingerprint, { host: state.host });
    assert.equal(plan.unchanged, true);
    assert.equal(plan.canAsk, offerable);
    const preview = await rulesDryRunLines({ host: state.host, record, detached: true,
      registry: await readRulesRegistry(state.host), registryError: null });
    assert.match(preview.lines.join('\n'), offerable ? /A real run would ask/ : /Would remove/);
    const result = await uninstall({ host: state.host, isTTY: true, prompt: () => 'yes' });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(await readRulesIndex(state.host), null);
    await assert.rejects(fs.access(state.own.path), { code: 'ENOENT' });
  });
}

test('a retained baseline for another path cannot authorize removal', async (t) => {
  const state = await installed(t);
  const file = installRecordPath(state.host);
  const raw = JSON.parse(await fs.readFile(file));
  Object.values(raw.owners)[0].rules.fingerprint = otherFingerprint;
  await fs.writeFile(file, JSON.stringify(raw));
  await writeIndex(state, { ...base, records: [file], legacy: ['offer'],
    retained: [{ ...state.own, path: path.join(state.root, 'another.rules') }] });
  const result = await uninstall({ host: state.host, isTTY: true, prompt: () => assert.fail('edited file') });
  assert.equal(result.exitCode, 1, result.output);
  assert.equal((await readRulesIndex(state.host)).retained.length, 1);
  await fs.access(state.own.path);
});


test('a consent race that removes all offers keeps the file and retains only our departure evidence', async (t) => {
  const state = await installed(t);
  const own = installRecordPath(state.host);
  await writeIndex(state, { ...base, records: [own], legacy: ['offer'] });
  const result = await uninstall({ host: state.host, isTTY: true, prompt: async () => {
    await writeIndex(state, { ...base, records: [own] });
    return 'yes';
  } });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /references changed; nothing was retired/);
  assert.deepEqual(await readRulesIndex(state.host), { ...base, retained: [state.own] });
  await fs.access(state.own.path);
});

test('departure can publish retained-only evidence when its index was absent', async (t) => {
  const state = await installed(t);
  const file = installRecordPath(state.host);
  const raw = JSON.parse(await fs.readFile(file));
  raw.inventory = 'incomplete';
  await fs.writeFile(file, JSON.stringify(raw));
  await fs.rename(state.file, path.join(state.root, 'saved-index'));
  const result = await uninstall({ host: state.host, isTTY: false });
  assert.equal(result.exitCode, 1, result.output);
  assert.deepEqual(await readRulesIndex(state.host), { ...base, retained: [state.own] });
  await fs.access(state.own.path);
});

test('proven absence drops retained baselines even when foreign references remain unknown', async (t) => {
  const state = await installed(t);
  await writeIndex(state, { ...base, records: [installRecordPath(state.host)],
    legacy: ['offer'], retained: [state.own] });
  await fs.rename(state.own.path, path.join(state.root, 'saved-rules'));
  const result = await uninstall({ host: state.host, isTTY: false });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(await readRulesIndex(state.host), { ...base, legacy: ['offer'] });
});

for (const operation of ['cancel', 'dry-run']) {
  test(operation + ' preserves existing retained evidence and the index bytes', async (t) => {
    const state = await installed(t);
    await writeIndex(state, { ...base, records: [installRecordPath(state.host)],
      legacy: ['offer'], retained: [state.own] });
    const bytes = await fs.readFile(state.file);
    const result = await uninstall({ host: state.host, isTTY: true, dryRun: operation === 'dry-run',
      prompt: () => {
        assert.equal(operation, 'cancel', 'dry-run must not prompt');
        return 'cancel';
      } });
    assert.equal(result.exitCode, operation === 'cancel' ? 130 : 1, result.output);
    assert.deepEqual(await fs.readFile(state.file), bytes);
    await fs.access(state.own.path);
  });
}


test('failed rules removal preserves the owner baseline after retiring its references', async (t) => {
  const state = await installed(t);
  const rm = fs.rm;
  t.mock.method(fs, 'rm', async (target, options) => {
    if (target === state.own.path) throw Object.assign(new Error('rules removal denied'), { code: 'EACCES' });
    return rm(target, options);
  });
  const result = await uninstall({ host: state.host });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /rules removal denied/);
  assert.deepEqual(await readRulesIndex(state.host), { ...base, retained: [state.own] });
  await fs.access(state.own.path);
});

test('an edit after publication preserves old retained evidence without blessing the edit', async (t) => {
  const state = await installed(t);
  const detached = path.join(state.root, 'detached', '.installed.json');
  const raw = JSON.parse(await fs.readFile(installRecordPath(state.host)));
  await fs.mkdir(path.dirname(detached));
  // A complete record with owners that do not use these rules is verified detached evidence.
  for (const owner of Object.values(raw.owners)) delete owner.rules;
  await fs.writeFile(detached, JSON.stringify(raw));
  await writeIndex(state, { ...base, records: [installRecordPath(state.host), detached], retained: [state.own] });
  const rename = fs.rename;
  let edited = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    const result = await rename(from, to);
    if (to === state.file && !edited) {
      edited = true;
      await fs.writeFile(state.own.path, 'edit after publication');
    }
    return result;
  });
  const result = await uninstall({ host: state.host });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /contents changed after installation/);
  assert.deepEqual(await readRulesIndex(state.host), { ...base, records: [detached], retained: [state.own] });
  assert.equal(await fs.readFile(state.own.path, 'utf8'), 'edit after publication');
});
