/** Verifies lossless, read-only loading and fail-loud validation of rules ownership indexes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { readRulesIndex } from '../../cli/rules-index.mjs';
import { rulesRegistryPath, normalizedRulesOwner } from '../../cli/rules-owners.mjs';

async function fixture() {
  const root = makeTempTree('rules-index-');
  const host = { codexRulesDir: path.join(root, 'rules') };
  await fs.mkdir(host.codexRulesDir);
  return { root, host, file: rulesRegistryPath(host) };
}

test('version 1 becomes legacy losslessly without rewriting the index', async () => {
  const { root, host, file } = await fixture();
  const owners = [normalizedRulesOwner({ root }), `${root}/MixedCase/`, root, root];
  const raw = `${JSON.stringify({ version: 1, owners }, null, 2)}\n`;
  await fs.writeFile(file, raw);
  assert.deepEqual(await readRulesIndex(host), { version: 2, records: [], legacy: owners });
  assert.equal(await fs.readFile(file, 'utf8'), raw);
  assert.deepEqual(await fs.readdir(host.codexRulesDir), [path.basename(file)]);
});

test('version 2 round-trips record paths and legacy references without writing', async () => {
  const { root, host, file } = await fixture();
  const index = { version: 2,
    records: [path.join(root, 'one', '.installed.json'), path.join(root, 'two', '.installed.json')],
    legacy: [normalizedRulesOwner({ root: path.join(root, 'host') })] };
  const raw = JSON.stringify(index);
  await fs.writeFile(file, raw);
  assert.deepEqual(await readRulesIndex(host), index);
  assert.equal(await fs.readFile(file, 'utf8'), raw);
});

test('an absent index returns null and creates nothing', async () => {
  const { host } = await fixture();
  assert.equal(await readRulesIndex(host), null);
  assert.deepEqual(await fs.readdir(host.codexRulesDir), []);
});

test('malformed JSON names the index and preserves its bytes', async () => {
  const { host, file } = await fixture();
  const raw = '{"version":2,';
  await fs.writeFile(file, raw);
  await assert.rejects(readRulesIndex(host), (error) => {
    assert.ok(error.message.includes(file));
    assert.match(error.message, /invalid rules ownership registry JSON/);
    return true;
  });
  assert.equal(await fs.readFile(file, 'utf8'), raw);
});

test('unknown versions fail loudly and name the index', async () => {
  const { host, file } = await fixture();
  await fs.writeFile(file, JSON.stringify({ version: 99, records: [], legacy: [] }));
  await assert.rejects(readRulesIndex(host), (error) => {
    assert.ok(error.message.includes(file));
    assert.match(error.message, /version must be 1 or 2/);
    return true;
  });
});

for (const [label, value] of [
  ['null', null], ['array', []], ['primitive', 'index'],
  ['missing owners', { version: 1 }], ['empty owner', { version: 1, owners: [''] }],
  ['non-string owner', { version: 1, owners: [null] }],
  ['missing records', { version: 2, legacy: [] }],
  ['relative record', { version: 2, records: ['home/.installed.json'], legacy: [] }],
  ['wrong record name', { version: 2, records: [path.resolve('record.json')], legacy: [] }],
  ['empty record', { version: 2, records: [''], legacy: [] }],
  ['missing legacy', { version: 2, records: [] }],
  ['non-string legacy', { version: 2, records: [], legacy: [12] }],
]) {
  test(`invalid index shape (${label}) names the index`, async () => {
    const { host, file } = await fixture();
    await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(readRulesIndex(host), (error) => error.message.includes(file));
  });
}

test('a BOM is accepted through the shared JSON reader', async () => {
  const { host, file } = await fixture();
  await fs.writeFile(file, '\ufeff{"version":2,"records":[],"legacy":[]}');
  assert.deepEqual(await readRulesIndex(host), { version: 2, records: [], legacy: [] });
});

test('an index permission error is not reported as absence', async (t) => {
  const { host, file } = await fixture();
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (target, ...args) => {
    if (target === file) throw Object.assign(new Error('EACCES: access denied'), { code: 'EACCES' });
    return readFile(target, ...args);
  });
  await assert.rejects(readRulesIndex(host), (error) => {
    assert.ok(error.message.includes(file));
    assert.match(error.message, /EACCES/);
    assert.equal(error.cause.code, 'EACCES');
    return true;
  });
});
