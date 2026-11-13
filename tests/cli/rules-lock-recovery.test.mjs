/** Guards one physical recovery target and non-stealing clearing (Plan_83 D3 / Plan_65 A5/D8/D11). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { acquireRulesDirLock, rulesLockTarget } from '../../cli/rules-dir-lock.mjs';
import { inspectRulesLock, clearRulesLock } from '../../cli/rules-lock-recovery.mjs';
import { directoryDigest, kernelLockAddress } from '../../src/home/lib/kernel-lock.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function fixture(t) {
  const tree = makeTempTree('rules-lock-recovery-');
  const codexHome = path.join(tree, 'codex');
  const rulesDir = path.join(codexHome, 'rules');
  const homeRoot = path.join(tree, 'package');
  fs.mkdirSync(rulesDir, { recursive: true });
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    removeTempTree(tree);
  });
  const options = { platform: 'darwin', homeRoot };
  const target = rulesLockTarget(rulesDir, options);
  const holder = { pid: process.pid, command: 'update', hostRoot: tree,
    acquiredAt: '2026-09-30T08:00:00.000Z', token: 'rules-recovery-token' };
  return { tree, codexHome, rulesDir, options, target, holder };
}

const dead = { kill: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } };

for (const platform of [...new Set([process.platform, 'darwin'])]) {
  test('inspection reaches the exact acquired rules lock: ' + platform, async (t) => {
    const { rulesDir, options, holder } = fixture(t);
    const target = rulesLockTarget(rulesDir, { platform });
    const held = await acquireRulesDirLock(rulesDir, { ...options, platform,
      command: holder.command, hostRoot: holder.hostRoot, waitMs: 0 });
    try {
      const observation = await inspectRulesLock(rulesDir, { platform });
      assert.equal(observation.state, 'held');
      assert.equal(observation.strategy, held.strategy);
      assert.equal(observation.holder.token, held.token);
      assert.equal(observation.holder.pid, process.pid);
      if (platform !== 'win32' && platform !== 'linux') {
        assert.equal(JSON.parse(fs.readFileSync(target.lockPath)).token, held.token);
      }
    } finally { await held.release(); }
    assert.equal((await inspectRulesLock(rulesDir, { platform })).state, 'free');
  });
}

test('one builder pins aliases to the physical file and the rules-dir kernel namespace', (t) => {
  const { tree, rulesDir } = fixture(t);
  const alias = path.join(tree, 'alias');
  fs.symlinkSync(rulesDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const target = rulesLockTarget(alias, { platform, identity: dead });
    const direct = rulesLockTarget(rulesDir, { platform });
    assert.equal(target.digest, directoryDigest(rulesDir));
    assert.equal(target.physicalDir, fs.realpathSync(rulesDir));
    assert.equal(target.lockPath, path.join(fs.realpathSync(rulesDir), '.llm-bridge-rules.lock'));
    assert.equal(target.gatePath, target.lockPath + '.clear');
    for (const key of ['digest', 'physicalDir', 'strategy', 'address', 'lockPath', 'gatePath']) {
      assert.equal(target[key], direct[key]);
    }
    assert.equal(target.address, kernelLockAddress('rules-dir', target.digest, platform) ?? target.lockPath);
    if (platform !== 'darwin') assert.notEqual(target.address, kernelLockAddress('lifecycle', target.digest, platform));
    assert.equal(target.judgeHolder({ pid: 1, acquiredAt: '2000-01-01' }), 'dead');
    assert.equal(target.parseHolder('not json'), null);
  }
});

test('missing rules directory is never created for inspect or clear on any strategy', async (t) => {
  const { tree, options } = fixture(t);
  const missing = path.join(tree, 'missing', 'rules');
  t.mock.method(fsp, 'open', () => assert.fail('missing rules must not open a gate'));
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.equal(rulesLockTarget(missing, { platform }), null);
    assert.equal((await inspectRulesLock(missing, { platform })).state, 'no-directory');
    assert.equal((await clearRulesLock(missing, { ...options, platform })).outcome, 'no-directory');
    assert.equal(fs.existsSync(path.dirname(missing)), false);
  }
});

test('clearing a dead fallback holder uses the pinned physical target through an alias', async (t) => {
  const { tree, rulesDir, target, holder, options } = fixture(t);
  const alias = path.join(tree, 'alias');
  fs.symlinkSync(rulesDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(target.lockPath, JSON.stringify(holder) + '\n');
  const result = await clearRulesLock(alias, { ...options, identity: dead });
  assert.equal(result.outcome, 'cleared');
  assert.equal(result.lockPath, target.lockPath);
  assert.deepEqual(result.holder, holder);
  assert.equal(fs.existsSync(target.lockPath), false);
  assert.equal(fs.existsSync(target.gatePath), false);
  const next = await acquireRulesDirLock(alias, { ...options, command: 'install', hostRoot: tree, waitMs: 0 });
  await next.release();
});

for (const [liveness, probe] of [
  ['alive', () => Date.parse('2026-09-29T00:00:00Z')],
  ['foreign', () => Date.parse('2026-10-01T00:00:00Z')],
  ['unverified', () => null],
]) {
  test('clearing refuses ' + liveness + ' holders without changing the file', async (t) => {
    const { rulesDir, target, holder, options } = fixture(t);
    const bytes = Buffer.from(JSON.stringify(holder) + '\n');
    fs.writeFileSync(target.lockPath, bytes);
    const identity = { kill: () => {}, probe };
    assert.equal((await inspectRulesLock(rulesDir, { ...options, identity })).liveness, liveness);
    const result = await clearRulesLock(rulesDir, { ...options, identity });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reason, 'the holder process is ' + liveness);
    assert.deepEqual(fs.readFileSync(target.lockPath), bytes);
    assert.equal(fs.existsSync(target.gatePath), false);
  });
}

test('kernel-managed clear performs no filesystem writes', async (t) => {
  const { rulesDir, options } = fixture(t);
  t.mock.method(fsp, 'open', () => assert.fail('kernel clear must not open a gate'));
  t.mock.method(fsp, 'unlink', () => assert.fail('kernel clear must not remove a file'));
  for (const platform of ['win32', 'linux']) {
    assert.equal((await clearRulesLock(rulesDir, { ...options, platform })).outcome, 'kernel-managed');
  }
  assert.deepEqual(fs.readdirSync(rulesDir), []);
});

test('clear refuses a path inside the package home before opening a gate', async (t) => {
  const { rulesDir, target, holder } = fixture(t);
  fs.writeFileSync(target.lockPath, JSON.stringify(holder) + '\n');
  const open = t.mock.method(fsp, 'open', () => assert.fail('inside-home clear must not write'));
  const result = await clearRulesLock(rulesDir, { platform: 'darwin', homeRoot: rulesDir, identity: dead });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'EHOMEREGISTRY');
  assert.equal(open.mock.callCount(), 0);
  assert.equal(fs.existsSync(target.lockPath), true);
});

test('non-directory and malformed locks fail closed', async (t) => {
  const { tree, rulesDir, target, options } = fixture(t);
  const file = path.join(tree, 'file');
  fs.writeFileSync(file, 'not a directory');
  assert.equal((await inspectRulesLock(file, options)).state, 'unverified');
  assert.equal((await clearRulesLock(file, options)).outcome, 'refused');
  fs.writeFileSync(target.lockPath, 'bad holder');
  assert.equal((await inspectRulesLock(rulesDir, options)).state, 'unverified');
  assert.equal((await clearRulesLock(rulesDir, options)).outcome, 'refused');
  assert.equal(fs.readFileSync(target.lockPath, 'utf8'), 'bad holder');
});
