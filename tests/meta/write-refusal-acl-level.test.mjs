import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyFolderAcls, FOLDER_ACL_EXIT_REASON_PREFIX, FOLDER_ACL_LEVELS, FOLDER_ACL_REASONS,
} from '../../src/home/lib/meta/write-refusal-acl-level.mjs';

const sandboxSid = 'S-1-5-21-1000';
const otherOwnerSid = 'S-1-5-32-544';
const rootRule = {
  sid: 'S-1-5-11', rights: '268435456', type: 'Allow', inherited: false,
  containerInherit: true, objectInherit: true,
};
const inheritedRule = { ...rootRule, rights: 'FullControl', inherited: true };
const root = {
  path: 'C:/repo', exists: true, isReparsePoint: false, ownerSid: otherOwnerSid,
  sandboxSid, rules: [rootRule],
};
const folder = {
  path: 'C:/repo/refused', exists: true, isReparsePoint: false, ownerSid: sandboxSid, rules: [],
};
const missingFolder = { ...folder, exists: false, ownerSid: null };
const unreadableFolder = { path: folder.path, error: 'Get-Acl failed' };
const intactFolder = { ...folder, path: 'C:/repo/intact', rules: [inheritedRule] };
const otherOwnerFolder = { ...folder, path: 'C:/repo/other', ownerSid: otherOwnerSid };

function classify(folders, measuredRoot = root) {
  return classifyFolderAcls({ status: 'measured', root: measuredRoot, folders });
}

function expectFolder(result, entry, level, reason, overallReason = reason) {
  assert.deepEqual(result, {
    level, reason: overallReason, folders: [{ path: entry.path, level, reason }],
  });
}

test('publishes frozen ACL classifications for callers', () => {
  assert.deepEqual(FOLDER_ACL_LEVELS, ['confirmed', 'not-confirmed', 'not-measured']);
  assert.ok(Object.isFrozen(FOLDER_ACL_LEVELS));
  assert.ok(Object.isFrozen(FOLDER_ACL_REASONS));
});

test('OW-092 D3 confirms when any inheritable root Allow is missing on a sandbox-owned folder', () => {
  const secondRule = { ...rootRule, sid: 'S-1-5-18' };
  expectFolder(classify([intactFolder], { ...root, rules: [rootRule, secondRule] }),
    intactFolder, 'confirmed', null);
});

test('OW-092 D3 treats an inherited generic right mapped by Windows as intact', () => {
  expectFolder(classify([intactFolder]), intactFolder, 'not-confirmed', 'inheritance-intact');
});

test('OW-092 D3 requires an inherited Allow with the same SID', () => {
  const wrongRules = [
    { ...inheritedRule, inherited: false },
    { ...inheritedRule, type: 'Deny' },
    { ...inheritedRule, sid: 'S-1-5-18' },
  ];
  const entry = { ...folder, rules: wrongRules };
  expectFolder(classify([entry]), entry, 'confirmed', null);
});

test('OW-092 D3 ignores root Deny and object-only rules', () => {
  const deny = { ...rootRule, sid: 'S-1-5-18', type: 'Deny' };
  const objectOnly = { ...rootRule, sid: 'S-1-5-19', containerInherit: false };
  expectFolder(classify([intactFolder], { ...root, rules: [rootRule, deny, objectOnly] }),
    intactFolder, 'not-confirmed', 'inheritance-intact');
  expectFolder(classify([folder], { ...root, rules: [deny, objectOnly] }),
    folder, 'not-measured', 'root-not-inheritable', 'partial');
});

test('a different owner prevents confirmation even when inheritance is incomplete', () => {
  expectFolder(classify([otherOwnerFolder]), otherOwnerFolder, 'not-confirmed', 'owner-not-sandbox');
});

for (const [reason, measuredRoot] of [
  ['root-unreadable', { path: root.path, sandboxSid: null, error: 'Get-Acl failed' }],
  ['root-missing', { ...root, exists: false, sandboxSid: null, ownerSid: null, rules: [] }],
  ['root-reparse-point', { ...root, isReparsePoint: true, sandboxSid: null, rules: [] }],
  ['no-sandbox-account', { ...root, sandboxSid: null, rules: [] }],
  ['root-not-inheritable', { ...root, rules: [] }],
]) {
  test(`${reason} takes precedence over a folder error`, () => {
    assert.ok(FOLDER_ACL_REASONS.includes(reason));
    expectFolder(classify([unreadableFolder], measuredRoot), unreadableFolder, 'not-measured', reason, 'partial');
  });
}

for (const [reason, entry] of [
  ['folder-unreadable', { ...unreadableFolder, path: 'C:/elsewhere' }],
  ['folder-missing', { ...missingFolder, path: 'C:/elsewhere' }],
  ['folder-reparse-point', { ...folder, path: 'C:/elsewhere', isReparsePoint: true }],
]) {
  test(`${reason} takes precedence over the path check`, () => {
    assert.ok(FOLDER_ACL_REASONS.includes(reason));
    expectFolder(classify([entry]), entry, 'not-measured', reason, 'partial');
  });
}

test('containment rejects sibling prefixes, the root itself, and paths that traverse out', () => {
  for (const path of ['C:/repo2', 'C:/repo2/refused', 'c:/REPO/', 'C:/repo/../other']) {
    const entry = { ...otherOwnerFolder, path };
    expectFolder(classify([entry]), entry, 'not-measured', 'outside-root', 'partial');
  }
});

test('containment folds case and separators and preserves the measured path in the result', () => {
  const entry = { ...folder, path: 'c:\\REPO\\parent\\refused\\' };
  expectFolder(classify([entry], { ...root, path: 'C:/repo/' }), entry, 'confirmed', null);
});

test('confirmation wins over unreadable and non-confirmed folders', () => {
  assert.deepEqual(classify([unreadableFolder, otherOwnerFolder, folder]), {
    level: 'confirmed', reason: null, folders: [
      { path: unreadableFolder.path, level: 'not-measured', reason: 'folder-unreadable' },
      { path: otherOwnerFolder.path, level: 'not-confirmed', reason: 'owner-not-sandbox' },
      { path: folder.path, level: 'confirmed', reason: null },
    ],
  });
});

test('overall non-confirmation preserves a shared reason and reports mixed reasons', () => {
  const secondIntact = { ...intactFolder, path: 'C:/repo/second' };
  assert.deepEqual(classify([intactFolder, secondIntact]), {
    level: 'not-confirmed', reason: 'inheritance-intact', folders: [
      { path: intactFolder.path, level: 'not-confirmed', reason: 'inheritance-intact' },
      { path: secondIntact.path, level: 'not-confirmed', reason: 'inheritance-intact' },
    ],
  });
  assert.deepEqual(classify([intactFolder, otherOwnerFolder]), {
    level: 'not-confirmed', reason: 'mixed', folders: [
      { path: intactFolder.path, level: 'not-confirmed', reason: 'inheritance-intact' },
      { path: otherOwnerFolder.path, level: 'not-confirmed', reason: 'owner-not-sandbox' },
    ],
  });
});

test('overall classification is partial when only some folders could be classified', () => {
  assert.deepEqual(classify([missingFolder, intactFolder]), {
    level: 'not-measured', reason: 'partial', folders: [
      { path: missingFolder.path, level: 'not-measured', reason: 'folder-missing' },
      { path: intactFolder.path, level: 'not-confirmed', reason: 'inheritance-intact' },
    ],
  });
});

test('a measured empty folder list has the no-folders reason', () => {
  assert.deepEqual(classify([]), { level: 'not-measured', reason: 'no-folders', folders: [] });
});

test('measurement failure preserves its own reason with or without folder entries', () => {
  const exitReason = `${FOLDER_ACL_EXIT_REASON_PREFIX}7`;
  assert.equal(exitReason, 'exit-7');
  for (const reason of ['not-windows', 'too-many-folders', 'timeout', 'spawn-error', 'malformed-output', exitReason]) {
    const measurement = { status: 'not-measured', reason };
    assert.deepEqual(classifyFolderAcls(measurement), { level: 'not-measured', reason, folders: [] });
    expectFolder(classifyFolderAcls({ ...measurement, folders: [unreadableFolder] }),
      unreadableFolder, 'not-measured', reason);
  }
});
