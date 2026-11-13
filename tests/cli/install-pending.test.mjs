/** Verifies per-host pending evidence and pure transitions required by Plan_83 D4/D5. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import {
  otherPendingEntries, pendingEntries, validatePending, withPending, withoutPending,
} from '../../cli/install-pending.mjs';

const a = { root: '/Repos/Alpha/.claude' };
const b = { root: '/Repos/Beta/.claude' };
const aKey = normalizeRepoPath(a.root);
const bKey = normalizeRepoPath(b.root);
const startedAt = '2026-11-13T20:15:00.000Z';
const entry = { command: 'install', root: a.root, startedAt };

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('absent pending validates unchanged and lists no entries', () => {
  const record = freeze({ format: 2, owners: {} });
  assert.strictEqual(validatePending(record), record);
  assert.deepEqual(pendingEntries(record), []);
  assert.deepEqual(otherPendingEntries(record, a), []);
  assert.strictEqual(withoutPending(record, a), record);
});

for (const pending of [undefined, null, false, true, 0, 1, 'pending', [], [entry], {}]) {
  test(`pending must be a nonempty object, not ${String(pending)}`, () => {
    assert.throws(() => validatePending({ pending }), /pending field is invalid/);
  });
}

for (const value of [undefined, null, false, [], 'entry', 42]) {
  test(`a pending entry must be an object, not ${String(value)}`, () => {
    assert.throws(() => validatePending({ pending: { [aKey]: value } }), /must be an object/);
  });
}

for (const field of ['root', 'command', 'startedAt']) {
  test(`every pending entry requires ${field}`, () => {
    const missing = { ...entry };
    delete missing[field];
    assert.throws(() => validatePending({ pending: { [aKey]: missing } }), /pending field is invalid/);
  });
}

for (const root of ['', null, 42, {}, b.root]) {
  test(`entry root must name the key's host: ${String(root)}`, () => {
    assert.throws(() => validatePending({ pending: { [aKey]: { ...entry, root } } }), /root/);
  });
}

for (const command of ['uninstall', 'INSTALL', '', null, false, 12]) {
  test(`pending rejects unknown command ${String(command)}`, () => {
    assert.throws(() => validatePending({ pending: { [aKey]: { ...entry, command } } }), /command/);
  });
}

for (const time of [undefined, null, 42, '', 'yesterday', '2026-11-13',
  '2026-11-13T20:15:00', '2026-11-13T20:15:00+00:00', '2026-11-13T21:15:00+01:00',
  '2026-02-30T20:15:00Z', '2026-13-13T20:15:00Z', '2026-11-13T24:00:00Z',
  '2026-11-13T20:15:00Z\n']) {
  test(`startedAt must be a valid ISO UTC string: ${JSON.stringify(time)}`, () => {
    assert.throws(() => validatePending({ pending: { [aKey]: { ...entry, startedAt: time } } }), /startedAt/);
  });
}

test('both commands and ISO UTC precision variants validate without rewriting evidence', () => {
  for (const command of ['install', 'update']) {
    for (const time of ['2026-11-13T20:15:00Z', startedAt, '2026-11-13T20:15:00.1Z',
      '2026-11-13T20:15:00.123456Z']) {
      const record = freeze({ pending: { [aKey]: { ...entry, command, startedAt: time } } });
      assert.strictEqual(validatePending(record), record);
    }
  }
});

test('pending keys normalize lexically while the stored root retains its spelling', () => {
  const host = { root: process.platform === 'win32' ? 'C:/Repos/Mixed/./.claude/' : '/Repos/Mixed/./.claude/' };
  const key = normalizeRepoPath(host.root);
  const record = withPending({}, host, 'install', startedAt);
  assert.deepEqual(Object.keys(record.pending), [key]);
  assert.equal(record.pending[key].root, host.root);
  assert.throws(() => validatePending({ pending: { [key + '/']: record.pending[key] } }), /normalize to its key/);
  const alias = { root: process.platform === 'win32' ? host.root.toLowerCase() : host.root + './' };
  assert.deepEqual(otherPendingEntries(record, alias), []);
});

test('two interrupted hosts coexist and replacing one preserves the other and all record data', () => {
  const initial = freeze({ format: 2, owners: {}, inventory: 'incomplete', image: { files: [] } });
  const first = freeze(withPending(initial, a, 'install', startedAt));
  const both = freeze(withPending(first, b, 'update', startedAt));
  const nextTime = '2026-11-13T20:20:00Z';
  const replaced = withPending(both, { root: a.root + '/' }, 'update', nextTime);
  assert.deepEqual(Object.keys(both.pending), [aKey, bKey]);
  assert.deepEqual(both.pending[aKey], entry);
  assert.deepEqual(replaced.pending[aKey], { root: a.root + '/', command: 'update', startedAt: nextTime });
  assert.deepEqual(replaced.pending[bKey], both.pending[bKey]);
  assert.strictEqual(replaced.owners, initial.owners);
  assert.strictEqual(replaced.image, initial.image);
  assert.equal(replaced.inventory, initial.inventory);
  assert.equal(Object.hasOwn(initial, 'pending'), false);
  assert.deepEqual(Object.keys(first.pending), [aKey]);
});

test('removing one pending host leaves the other and removing the last omits the property', () => {
  const both = freeze(withPending(withPending({ owners: {} }, a, 'install', startedAt), b, 'update', startedAt));
  const remaining = freeze(withoutPending(both, { root: a.root + '/./' }));
  assert.deepEqual(remaining.pending, { [bKey]: both.pending[bKey] });
  assert.deepEqual(Object.keys(both.pending), [aKey, bKey]);
  assert.strictEqual(withoutPending(remaining, a), remaining);
  const completed = withoutPending(remaining, b);
  assert.equal(Object.hasOwn(completed, 'pending'), false);
  assert.strictEqual(completed.owners, both.owners);
  assert.strictEqual(validatePending(completed), completed);
});

test('listing returns host keys and original roots and excludes only the requested normalized host', () => {
  const both = freeze(withPending(withPending({}, a, 'install', startedAt), b, 'update', startedAt));
  const listed = pendingEntries(both);
  assert.deepEqual(listed, [{ ...entry, hostKey: aKey },
    { command: 'update', root: b.root, startedAt, hostKey: bKey }]);
  assert.deepEqual(otherPendingEntries(both, a), [listed[1]]);
  assert.deepEqual(otherPendingEntries(both, { root: '/Repos/Absent' }), listed);
  listed[0].root = '/changed';
  assert.equal(both.pending[aKey].root, a.root);
});

test('every transition and listing rejects malformed evidence rather than silently repairing it', () => {
  const invalid = { pending: {} };
  for (const operation of [validatePending, pendingEntries,
    (record) => withPending(record, a, 'install', startedAt),
    (record) => withoutPending(record, a), (record) => otherPendingEntries(record, a)]) {
    assert.throws(() => operation(invalid), /pending field is invalid/);
    assert.throws(() => operation(), /record must be an object/);
  }
  assert.throws(() => withPending({}, a), /command/);
  assert.throws(() => withPending({}, a, 'install'), /startedAt/);
  assert.throws(() => withPending({}, { root: '' }, 'install', startedAt), /root/);
});
