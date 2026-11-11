/** OW-083 B3: only the run's saved top-level required array selects the ledger contract. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree } from '../temp-tree.mjs';
import { adviceLedgerContract } from '../../src/home/lib/meta/advice-contract.mjs';

test('an absent schema preserves the legacy contract', () => {
  assert.equal(adviceLedgerContract(makeTempTree('advice-contract-')), 'legacy');
});

for (const [name, schema, expected] of [
  ['legacy', { required: ['recommendation'] }, 'legacy'],
  ['empty required array', { required: [] }, 'legacy'],
  ['required', { required: ['recommendation', 'already_decided'] }, 'required'],
  ['optional field', { required: [], properties: { already_decided: {} } }, 'legacy'],
  ['nested requirement', { required: [], properties: { nested: { required: ['already_decided'] } } }, 'legacy'],
  ['array-less', {}, 'unreadable'],
  ['non-array required', { required: 'already_decided' }, 'unreadable'],
  ['null schema', null, 'unreadable'],
]) {
  test(`${name} schema returns ${expected}`, () => {
    const dir = makeTempTree('advice-contract-');
    fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema));
    assert.equal(adviceLedgerContract(dir), expected);
  });
}

test('corrupt JSON is unreadable without throwing', () => {
  const dir = makeTempTree('advice-contract-');
  fs.writeFileSync(path.join(dir, 'schema.json'), '{');
  assert.equal(adviceLedgerContract(dir), 'unreadable');
});

test('a schema that cannot be read as a file is unreadable without throwing', () => {
  const dir = makeTempTree('advice-contract-');
  fs.mkdirSync(path.join(dir, 'schema.json'));
  assert.equal(adviceLedgerContract(dir), 'unreadable');
});
