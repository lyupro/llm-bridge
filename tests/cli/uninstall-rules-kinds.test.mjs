/** Guards evidence-based eligibility and stored-root recovery (Plan_83 D7). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyRulesOwnership, offerableUnknown } from '../../cli/rules-ownership.mjs';
import { withOwner } from '../../cli/install-owners.mjs';
import { withPending } from '../../cli/install-pending.mjs';

function fixture(t) {
  const recordPath = path.resolve('virtual-home', '.installed.json');
  const rulesPath = path.resolve('virtual-codex', 'llm-bridge.rules');
  const host = { root: path.resolve('Current Host'), scope: 'host' };
  const foreign = { root: path.resolve('Mixed Case Host') + path.sep + '.' + path.sep };
  const view = { name: '@lyupro/llm-bridge', version: '0.7.0', mode: 'copy',
    installedAt: '2026-11-13T10:00:00Z', files: [{ root: 'brand', path: 'hooks/reply-guard.mjs' }], hooks: [{ event: 'SubagentStop', root: 'brand', path: 'hooks/reply-guard.mjs' }],
    rules: { path: rulesPath, fingerprint: 'a'.repeat(64) } };
  const record = withOwner(null, host, view, { homeHadImage: false });
  const index = { version: 2, records: [recordPath], legacy: [] };
  let value = JSON.stringify(record);
  let error;
  t.mock.method(fs, 'readFile', async (file) => {
    assert.equal(file, recordPath);
    if (error) throw error;
    return value;
  });
  return { record, recordPath, rulesPath, host, foreign, index,
    publish(next) { value = typeof next === 'string' ? next : JSON.stringify(next); },
    fail(code) { error = Object.assign(new Error('record read failed'), { code }); },
    classify() { return classifyRulesOwnership(index, rulesPath, recordPath, host); } };
}

function assertReference(result, kind, offerable) {
  assert.equal(result.unknown.length, 1);
  const reference = result.unknown[0];
  assert.equal(reference.kind, kind);
  assert.equal(offerableUnknown(reference), offerable);
  return reference;
}

for (const kind of ['legacy', 'legacy-unverified', 'missing', 'unreadable', 'invalid', 'inventory', 'pending']) {
  test(kind + ' has structural eligibility independent of its diagnostic text', async (t) => {
    const f = fixture(t);
    if (kind.startsWith('legacy')) {
      f.index.records = [];
      f.index.legacy = ['unconfirmed-legacy-host'];
    }
    // Plan_83 D7 (8) / D8: only a present unreadable record leaves legacy hints unverified.
    if (kind === 'legacy-unverified') f.fail('EACCES');
    if (kind === 'missing') f.fail('ENOENT');
    if (kind === 'unreadable') f.fail('EACCES');
    if (kind === 'invalid') f.publish({ ...f.record, format: 1 });
    if (kind === 'inventory') f.publish({ ...f.record, inventory: 'incomplete' });
    if (kind === 'pending') f.publish(withPending(withPending(f.record, f.host, 'install',
      '2026-11-13T10:00:00Z'), f.foreign, 'update', '2026-11-13T10:00:00Z'));
    const eligible = kind === 'legacy' || kind === 'missing';
    const reference = assertReference(await f.classify(), kind, eligible);
    const changedReason = { ...reference, reason: eligible ? 'EACCES, pending and invalid' : 'ENOENT legacy' };
    assert.equal(changedReason.kind, kind);
    assert.equal(offerableUnknown(changedReason), eligible);
    assert.equal(reference.recordPath, f.recordPath);
    if (kind === 'pending') assert.deepEqual(reference.pendingHosts, [{ root: f.foreign.root, command: 'update' }]);
  });
}

for (const code of ['EPERM', 'EBUSY', 'EISDIR', 'ENOTDIR']) {
  test(code + ' is unreadable and cannot be offered', async (t) => {
    const f = fixture(t);
    f.fail(code);
    assertReference(await f.classify(), 'unreadable', false);
  });
}

test('broken JSON is unreadable rather than invalid or offerable', async (t) => {
  const f = fixture(t);
  f.publish('{broken');
  const reference = assertReference(await f.classify(), 'unreadable', false);
  assert.match(reference.reason, /cannot parse/);
});

test('format-2 validation failure is invalid and cannot be offered', async (t) => {
  const f = fixture(t);
  f.publish({ ...f.record, owners: [] });
  assertReference(await f.classify(), 'invalid', false);
});

test('legacy inventory is inventory and cannot be offered', async (t) => {
  const f = fixture(t);
  f.publish({ ...f.record, legacy: { name: '@lyupro/llm-bridge', version: '0.7.0', mode: 'copy',
    installedAt: '2026-11-13T10:00:00Z', files: [{ root: 'brand', path: 'hooks/reply-guard.mjs' }], hooks: [{ event: 'SubagentStop', root: 'brand', path: 'hooks/reply-guard.mjs' }] } });
  assertReference(await f.classify(), 'inventory', false);
});

test('foreign pending stays structural even without an indexed current record', async (t) => {
  const f = fixture(t);
  f.index.records = [];
  f.publish(withPending(f.record, f.foreign, 'install', '2026-11-13T10:00:00Z'));
  const reference = assertReference(await f.classify(), 'pending', false);
  assert.deepEqual(reference.pendingHosts, [{ root: f.foreign.root, command: 'install' }]);
});

for (const evidence of ['unreadable', 'invalid']) {
  test('legacy hints remain unverified when the current record is ' + evidence, async (t) => {
    const f = fixture(t);
    f.index.records = [];
    f.index.legacy = ['legacy-host'];
    if (evidence === 'unreadable') f.fail('EACCES');
    else f.publish({ format: 1 });
    assertReference(await f.classify(), 'legacy-unverified', false);
  });
}

// Plan_83 D7 (8) / advisor r5: no record can confirm a hint after ENOENT.
test('absent current record makes legacy hints offerable legacy references', async (t) => {
  const f = fixture(t);
  f.index.records = [];
  f.index.legacy = ['legacy-host'];
  f.fail('ENOENT');
  const reference = assertReference(await f.classify(), 'legacy', true);
  assert.match(reference.reason, /ENOENT/);
  assert.equal(reference.legacy, 'legacy-host');
});
