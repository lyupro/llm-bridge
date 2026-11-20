import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { measureFolderAcls } from '../../src/home/lib/meta/write-refusal-acl.mjs';
import { withTempTree } from '../temp-tree.mjs';

const ENV_KEY = 'LLM_BRIDGE_ACL_PATHS';
const OWNER_SID = 'S-1-5-32-544';
const SANDBOX_SID = 'S-1-5-21-123-456-789-1001';
const request = {
  repoRoot: "C:\\repo with space\\[root]'é",
  folders: ['C:\\repo with space\\[root]\'é\\$env:Path; & echo "literal"', 'C:\\repo with space\\[root]\'é\\next'],
};

const inheritedRule = {
  sid: OWNER_SID,
  rights: 'ReadAndExecute, Write, Synchronize',
  type: 'Allow',
  inherited: true,
  containerInherit: true,
  objectInherit: false,
};
const rawIdentityRule = {
  sid: 'HOST\\unmapped',
  rights: 'Write',
  type: 'Deny',
  inherited: false,
  containerInherit: false,
  objectInherit: true,
};

function replyFor({ repoRoot, folders }) {
  return {
    root: {
      path: repoRoot,
      exists: true,
      isReparsePoint: false,
      ownerSid: OWNER_SID,
      rules: [inheritedRule, rawIdentityRule],
      sandboxSid: SANDBOX_SID,
    },
    folders: folders.map((folder) => ({
      path: folder,
      exists: true,
      isReparsePoint: true,
      ownerSid: SANDBOX_SID,
      rules: [],
    })),
  };
}

function captureOutput(output) {
  return { status: 0, stdout: JSON.stringify(output) };
}

function measure(capture, options = {}) {
  return measureFolderAcls({ ...request, platform: 'win32', capture, ...options });
}

test('keeps ACL facts, exact paths, order, and duplicates across one capture per request', async () => {
  const calls = [];
  const originalEnv = process.env[ENV_KEY];
  const capture = async (command, args, options) => {
    calls.push({ command, args, options });
    return captureOutput(replyFor(JSON.parse(options.env[ENV_KEY])));
  };
  const otherRequest = { repoRoot: 'D:\\elsewhere', folders: Array(20).fill('D:\\elsewhere\\folder') };
  assert.deepEqual(await measure(capture, { timeoutMs: 1234 }), { status: 'measured', ...replyFor(request) });
  assert.deepEqual(await measure(capture, otherRequest), { status: 'measured', ...replyFor(otherRequest) });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, calls[1].args);
  for (const [index, { command, args, options }] of calls.entries()) {
    assert.equal(command, 'powershell.exe');
    assert.equal(options.windowsHide, true);
    assert.equal(Object.hasOwn(options, 'shell'), false);
    assert.equal(options.timeout, index === 0 ? 1234 : 5000);
    assert.deepEqual(args.slice(0, -1), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    ]);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const input = index === 0 ? request : otherRequest;
    assert.ok(script.includes('$env:LLM_BRIDGE_ACL_PATHS'));
    assert.deepEqual(JSON.parse(options.env[ENV_KEY]), input);
    for (const inputPath of [input.repoRoot, ...input.folders]) {
      assert.equal(script.includes(inputPath), false);
      assert.equal(args.some((arg) => arg.includes(inputPath)), false);
    }
  }
  assert.equal(process.env[ENV_KEY], originalEnv);
});

test('keeps a path error and a missing folder in an otherwise measured result', async () => {
  const output = replyFor(request);
  output.root.sandboxSid = null;
  output.folders = [
    { path: request.folders[0], error: 'Get-Acl failed' },
    { path: request.folders[1], exists: false, isReparsePoint: false, ownerSid: null, rules: [] },
  ];
  assert.deepEqual(await measure(async () => captureOutput(output)), { status: 'measured', ...output });
});

test('preserves the account SID and other measurements when the root fails', async () => {
  const output = replyFor(request);
  output.root = { path: request.repoRoot, error: 'Get-Acl failed', sandboxSid: SANDBOX_SID };
  assert.deepEqual(await measure(async () => captureOutput(output)), { status: 'measured', ...output });
});

test('reports timeout before interpreting exit status or partial stdout', async () => {
  const result = { status: 1, error: { code: 'ETIMEDOUT' }, stdout: '{' };
  assert.deepEqual(await measure(async () => result), { status: 'not-measured', reason: 'timeout' });
});

test('reports the PowerShell exit code', async () => {
  const result = { status: 3, stdout: '{' };
  assert.deepEqual(await measure(async () => result), { status: 'not-measured', reason: 'exit-3' });
});

test('rejects malformed JSON', async () => {
  assert.deepEqual(await measure(async () => ({ status: 0, stdout: '{' })), {
    status: 'not-measured', reason: 'malformed-output',
  });
});

test('rejects incomplete, mismatched, or incorrectly typed payloads', async () => {
  const valid = replyFor(request);
  const wrongShapes = [
    null,
    { ...valid, extra: true },
    { ...valid, root: { ...valid.root, path: 'C:\\other' } },
    { ...valid, root: { ...valid.root, sandboxSid: 'HOST\\sandbox' } },
    { ...valid, root: { ...valid.root, ownerSid: null } },
    { ...valid, root: { ...valid.root, exists: 'true' } },
    { ...valid, root: { ...valid.root, isReparsePoint: 0 } },
    { ...valid, root: { ...valid.root, rules: inheritedRule } },
    ...[
      ['sid', null], ['rights', 2], ['type', 'Other'], ['inherited', 0],
      ['containerInherit', 'true'], ['objectInherit', null],
    ].map(([key, value]) => ({
      ...valid, root: { ...valid.root, rules: [{ ...inheritedRule, [key]: value }] },
    })),
    { ...valid, folders: [] },
    { ...valid, folders: [...valid.folders].reverse() },
    { ...valid, folders: [{ ...valid.folders[0], error: 'mixed shape' }, valid.folders[1]] },
    { ...valid, folders: [{ path: request.folders[0], error: '' }, valid.folders[1]] },
  ];
  for (const output of wrongShapes) {
    assert.deepEqual(await measure(async () => captureOutput(output)), {
      status: 'not-measured', reason: 'malformed-output',
    }, JSON.stringify(output));
  }
});

test('reports both returned and thrown spawn errors', async () => {
  const error = Object.assign(new Error('PowerShell unavailable'), { code: 'ENOENT' });
  const expected = { status: 'not-measured', reason: 'spawn-error' };
  assert.deepEqual(await measure(async () => ({ status: null, error })), expected);
  assert.deepEqual(await measure(async () => { throw error; }), expected);
});

test('does not capture on other platforms or above twenty folders', async () => {
  let calls = 0;
  const capture = async () => { calls += 1; };
  assert.deepEqual(await measure(capture, { platform: 'linux' }), { status: 'not-measured', reason: 'not-windows' });
  assert.deepEqual(await measure(capture, { folders: Array(21).fill(request.repoRoot) }), {
    status: 'not-measured', reason: 'too-many-folders',
  });
  assert.equal(calls, 0);
});

test('reads a real Windows ACL with a literal folder name', { skip: process.platform !== 'win32' }, async () => {
  await withTempTree('write-refusal-acl-', async (repoRoot) => {
    const folder = path.join(repoRoot, "folder [literal] 'é");
    const missing = path.join(repoRoot, 'missing');
    fs.mkdirSync(folder);
    const result = await measureFolderAcls({ repoRoot, folders: [folder, missing] });
    assert.equal(result.status, 'measured', JSON.stringify(result));
    for (const [entry, expectedPath] of [[result.root, repoRoot], [result.folders[0], folder]]) {
      assert.equal(entry.path, expectedPath);
      assert.equal(entry.exists, true, JSON.stringify(entry));
      assert.equal(entry.isReparsePoint, false);
      assert.match(entry.ownerSid, /^S-\d+(?:-\d+)+$/);
    }
    assert.deepEqual(result.folders[1], {
      path: missing, exists: false, isReparsePoint: false, ownerSid: null, rules: [],
    });
  });
});
