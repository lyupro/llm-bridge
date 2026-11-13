/** Verifies physical rules-directory exclusion and non-stealing fallback ownership for Plan_83 D2. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { acquireLifecycleLock, parseHolder } from '../../cli/lifecycle-lock.mjs';
import { acquireRulesDirLock, assertLiveRulesTicket, withRulesDirLock } from '../../cli/rules-dir-lock.mjs';
import { openOutsideFileLock } from '../../src/home/lib/file-lock.mjs';
import { makeTempTree } from '../temp-tree.mjs';
import { fixture as hostFixture } from './host-fixture.mjs';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { purge } from '../../cli/uninstall-purge.mjs';
import { rulesRegistryPath } from '../../cli/rules-owners.mjs';

const platforms = [...new Set([process.platform, 'darwin'])];
const lockName = '.llm-bridge-rules.lock';

// Plan_83 D2 / Plan_65 A5: the sanctioned sink checks ownership before one open, without reclaiming.
test('outside lock opener checks the path before returning the caller-owned handle', async (context) => {
  const events = [];
  const handle = {};
  const lockPath = 'outside.lock';
  const writer = { assertOutside(target) { events.push(['check', target]); } };
  context.mock.method(fsp, 'open', async (...args) => {
    events.push(['open', ...args]);
    return handle;
  });
  assert.equal(await openOutsideFileLock(writer, lockPath), handle);
  assert.deepEqual(events, [['check', lockPath], ['open', lockPath, 'wx']]);
});

test('outside lock opener refuses an unchecked path before opening it', (context) => {
  const refused = new Error('outside check refused');
  const open = context.mock.method(fsp, 'open', async () => {});
  const writer = { assertOutside() { throw refused; } };
  assert.throws(() => openOutsideFileLock(writer, 'inside.lock'), (error) => error === refused);
  assert.equal(open.mock.callCount(), 0);
});

test('outside lock opener propagates each open failure after exactly one attempt', async (context) => {
  for (const code of ['EEXIST', 'EPERM', 'EBUSY', 'ENOENT']) {
    const refused = Object.assign(new Error(code), { code });
    const open = context.mock.method(fsp, 'open', async () => { throw refused; });
    await assert.rejects(openOutsideFileLock({ assertOutside() {} }, 'outside.lock'),
      (error) => error === refused);
    assert.equal(open.mock.callCount(), 1);
    context.mock.restoreAll();
  }
});

function fixture() {
  const tree = makeTempTree('rules-dir-lock-');
  const rulesDir = path.join(tree, 'rules');
  const otherDir = path.join(tree, 'other');
  const homeRoot = path.join(tree, 'home');
  for (const directory of [rulesDir, otherDir, homeRoot]) fs.mkdirSync(directory);
  const alias = path.join(tree, 'rules-alias');
  fs.symlinkSync(rulesDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return {
    tree, rulesDir, otherDir, alias,
    options: { command: 'install', hostRoot: tree, homeRoot, waitMs: 80, retryMs: 10, answerTimeoutMs: 100 },
  };
}

// Plan_83 D2 / OW-086: independent homes must contend on physical rules identity, not owner keys.
for (const platform of platforms) {
  test(`different spellings and links of a rules directory exclude each other (${platform})`, async () => {
    const { rulesDir, alias, options, tree } = fixture();
    const held = await acquireRulesDirLock(rulesDir, { ...options, platform });
    try {
      const spellings = [`${rulesDir}${path.sep}.`, alias];
      if (process.platform === 'win32') spellings.push(rulesDir.toUpperCase().replaceAll('\\', '/'));
      for (const spelling of spellings) {
        await assert.rejects(acquireRulesDirLock(spelling, {
          ...options, homeRoot: path.join(tree, 'second-home'), command: 'update', platform,
        }), /rules directory lock busy.*held by install/);
      }
    } finally {
      await held.release();
    }
    const next = await acquireRulesDirLock(alias, { ...options, platform });
    await next.release();
  });

  test(`a different physical directory acquires independently (${platform})`, async () => {
    const { rulesDir, otherDir, options } = fixture();
    const held = await acquireRulesDirLock(rulesDir, { ...options, platform });
    try {
      const independent = await acquireRulesDirLock(otherDir, { ...options, platform });
      await independent.release();
    } finally {
      await held.release();
    }
  });

  test(`rules and lifecycle locks on the same directory do not collide (${platform})`, async () => {
    const { rulesDir, options } = fixture();
    const homeLock = await acquireLifecycleLock(rulesDir, { ...options, platform });
    try {
      const rulesLock = await acquireRulesDirLock(rulesDir, { ...options, platform });
      await rulesLock.release();
    } finally {
      await homeLock.release();
    }
  });

  test(`nested tickets borrow only the same live physical directory (${platform})`, async () => {
    const { rulesDir, alias, otherDir, options } = fixture();
    const held = await acquireRulesDirLock(rulesDir, { ...options, platform });
    try {
      assert.ok(Object.isFrozen(held.ticket));
      const borrowed = await acquireRulesDirLock(alias, { ticket: held.ticket });
      assert.equal(borrowed.ticket, held.ticket);
      assert.equal(borrowed.token, held.token);
      assert.equal(borrowed.strategy, held.strategy);
      await borrowed.release();
      await borrowed.release();
      assert.doesNotThrow(() => assertLiveRulesTicket(held.ticket, alias));
      await assert.rejects(acquireRulesDirLock(rulesDir, { ...options, platform }), /lock busy/);
      await assert.rejects(acquireRulesDirLock(otherDir, { ticket: held.ticket }), /different physical directory/);
      await assert.rejects(acquireRulesDirLock(rulesDir, { ticket: {} }), /no longer active/);
    } finally {
      const released = held.release();
      assert.throws(() => assertLiveRulesTicket(held.ticket, rulesDir), /no longer active/);
      assert.equal(held.release(), released);
      await released;
    }
    await assert.rejects(acquireRulesDirLock(rulesDir, { ticket: held.ticket }), /no longer active/);
    const next = await acquireRulesDirLock(rulesDir, { ...options, platform });
    await next.release();
  });
}

test('fallback bounds waiting, diagnoses the holder, and never steals even an ancient lock', async () => {
  const { rulesDir, options } = fixture();
  const lockPath = path.join(rulesDir, lockName);
  const holder = {
    pid: 1, command: 'old-update', hostRoot: options.hostRoot,
    acquiredAt: '2000-01-01T00:00:00.000Z', token: 'old-token',
  };
  const bytes = JSON.stringify(holder) + '\n';
  fs.writeFileSync(lockPath, bytes);
  fs.utimesSync(lockPath, new Date(0), new Date(0));
  const before = fs.statSync(lockPath);
  const started = Date.now();
  await assert.rejects(acquireRulesDirLock(rulesDir, { ...options, platform: 'darwin' }), (error) => {
    assert.match(error.message, /held by old-update/);
    assert.ok(error.message.includes(options.hostRoot));
    assert.match(error.message, /pid 1, since 2000-01-01/);
    assert.match(error.message, /If no install, update or uninstall is running/);
    assert.match(error.message, /left by a crash.*llm-bridge unlock --rules/);
    return true;
  });
  assert.ok(Date.now() - started >= options.waitMs - 5);
  assert.ok(Date.now() - started < 5_000, 'bounded wait must not become the default 15 seconds');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), bytes);
  assert.equal(fs.statSync(lockPath).ino, before.ino);
  assert.equal(fs.statSync(lockPath).mtimeMs, before.mtimeMs);
});

test('fallback publishes a lifecycle-format holder and removes only its own file', async () => {
  const { rulesDir, options } = fixture();
  const lockPath = path.join(rulesDir, lockName);
  const held = await acquireRulesDirLock(rulesDir, { ...options, platform: 'darwin' });
  try {
    const line = fs.readFileSync(lockPath, 'utf8');
    assert.equal(line.split('\n').length, 2);
    assert.deepEqual(parseHolder(line), {
      pid: process.pid, command: options.command, hostRoot: options.hostRoot,
      acquiredAt: JSON.parse(line).acquiredAt, token: held.token,
    });
    assert.equal(held.strategy, 'file');
  } finally {
    await held.release();
  }
  assert.equal(fs.existsSync(lockPath), false);
});

test('fallback refuses a checked outside-home write into the home, including through an alias', async () => {
  const { rulesDir, alias, options } = fixture();
  for (const directory of [rulesDir, alias]) {
    await assert.rejects(acquireRulesDirLock(directory, {
      ...options, homeRoot: rulesDir, platform: 'darwin',
    }), /path is inside the home root/);
  }
  assert.equal(fs.existsSync(path.join(rulesDir, lockName)), false);
});

test('fallback holder write failure releases the exclusively created file', async (context) => {
  const { rulesDir, options } = fixture();
  const open = fsp.open;
  context.mock.method(fsp, 'open', async (...args) => {
    const handle = await open(...args);
    context.mock.method(handle, 'writeFile', async () => { throw new Error('holder write failed'); });
    return handle;
  });
  await assert.rejects(acquireRulesDirLock(rulesDir, {
    ...options, platform: 'darwin',
  }), /holder write failed/);
  assert.equal(fs.existsSync(path.join(rulesDir, lockName)), false);
  context.mock.restoreAll();
  const next = await acquireRulesDirLock(rulesDir, { ...options, platform: 'darwin' });
  await next.release();
});

test('missing directories are refused without creating them, and files are not directories', async () => {
  const { tree, options } = fixture();
  const missing = path.join(tree, 'missing');
  await assert.rejects(acquireRulesDirLock(missing, options), /directory does not exist/);
  assert.equal(fs.existsSync(missing), false);
  const file = path.join(tree, 'file');
  fs.writeFileSync(file, 'data');
  await assert.rejects(acquireRulesDirLock(file, options), /not a directory/);
});

test('required identity and holder arguments and bounded-wait options fail loudly', async () => {
  const { rulesDir, options } = fixture();
  for (const key of ['command', 'homeRoot', 'hostRoot']) {
    await assert.rejects(acquireRulesDirLock(rulesDir, { ...options, [key]: undefined }), new RegExp(key));
  }
  await assert.rejects(acquireRulesDirLock(undefined, options), /rulesDir/);
  for (const [key, value] of [['waitMs', -1], ['retryMs', 0], ['answerTimeoutMs', NaN]]) {
    await assert.rejects(acquireRulesDirLock(rulesDir, { ...options, [key]: value }), new RegExp(key));
  }
});

if (['win32', 'linux'].includes(process.platform)) {
  test('a replaced directory fails the post-acquisition identity check and releases the kernel lock', async () => {
    const { rulesDir, tree, options } = fixture();
    const moved = path.join(tree, 'original-rules');
    let first = true;
    const createServer = (handler) => {
      const server = net.createServer(handler);
      if (first) {
        first = false;
        server.once('listening', () => {
          fs.renameSync(rulesDir, moved);
          fs.mkdirSync(rulesDir);
        });
      }
      return server;
    };
    await assert.rejects(acquireRulesDirLock(rulesDir, { ...options, createServer }), /identity changed after acquisition/);
    // Plan_83 D2: the old device/inode lock must be free, not merely the replacement's new name.
    const original = await acquireRulesDirLock(moved, options);
    await original.release();
    const replacement = await acquireRulesDirLock(rulesDir, options);
    await replacement.release();
  });
}

test('a retargeted link fails the fallback identity check and releases its original file', async (context) => {
  const { rulesDir, alias, otherDir, options } = fixture();
  const open = fsp.open;
  context.mock.method(fsp, 'open', async (...args) => {
    const handle = await open(...args);
    fs.unlinkSync(alias);
    fs.symlinkSync(otherDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    return handle;
  });
  await assert.rejects(acquireRulesDirLock(alias, { ...options, platform: 'darwin' }), /identity changed after acquisition/);
  assert.equal(fs.existsSync(path.join(rulesDir, lockName)), false);
  assert.equal(fs.existsSync(path.join(otherDir, lockName)), false);
  context.mock.restoreAll();
  const original = await acquireRulesDirLock(rulesDir, { ...options, platform: 'darwin' });
  await original.release();
});

test('a malformed pre-existing fallback lock stays untouched even with a zero wait', async () => {
  const { rulesDir, options } = fixture();
  const lockPath = path.join(rulesDir, lockName);
  fs.writeFileSync(lockPath, 'unverified crash record\n');
  await assert.rejects(acquireRulesDirLock(rulesDir, {
    ...options, platform: 'darwin', waitMs: 0,
  }), /holder did not answer.*llm-bridge unlock --rules/);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'unverified crash record\n');
});

test('a waiting fallback contender acquires only after the owner releases', async () => {
  const { rulesDir, alias, options } = fixture();
  const held = await acquireRulesDirLock(rulesDir, { ...options, platform: 'darwin' });
  let acquired = false;
  const pending = acquireRulesDirLock(alias, {
    ...options, platform: 'darwin', command: 'update', waitMs: 1_000,
  }).then((lock) => { acquired = true; return lock; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(acquired, false);
  } finally {
    await held.release();
    const next = await pending;
    await next.release();
  }
});

// Plan_83 D2 / OW-086: only an acquiring action owns release; update lends install its live ticket.
test('rules action creates its outside directory, passes a live ticket and releases on failure', async () => {
  const { tree, options } = fixture();
  const host = { root: options.hostRoot, brandRoot: options.homeRoot, codexRulesDir: path.join(tree, 'new', 'rules') };
  let ticket;
  await assert.rejects(withRulesDirLock(host, 'install', async (live) => {
    ticket = live;
    assert.doesNotThrow(() => assertLiveRulesTicket(live, host.codexRulesDir));
    await assert.rejects(acquireRulesDirLock(host.codexRulesDir, { ...options, waitMs: 0 }), /lock busy/);
    throw new Error('action failed');
  }), /action failed/);
  assert.throws(() => assertLiveRulesTicket(ticket, host.codexRulesDir), /no longer active/);
  await withRulesDirLock(host, 'update', async (live) => {
    assert.notEqual(live, ticket);
    const value = await withRulesDirLock(host, 'install', async (borrowed) => {
      assert.equal(borrowed, live);
      return 'completed';
    }, { ticket: live });
    assert.equal(value, 'completed');
    await assert.rejects(withRulesDirLock(host, 'install', () => { throw new Error('borrowed failure'); },
      { ticket: live }), /borrowed failure/);
    assert.doesNotThrow(() => assertLiveRulesTicket(live, host.codexRulesDir));
    await assert.rejects(acquireRulesDirLock(host.codexRulesDir, { ...options, waitMs: 0 }), /lock busy/);
    ticket = live;
  });
  assert.throws(() => assertLiveRulesTicket(ticket, host.codexRulesDir), /no longer active/);
});

test('rules action rejects stale and foreign tickets before creating a directory or running', async () => {
  const { tree, rulesDir, otherDir, options } = fixture();
  const host = { root: options.hostRoot, brandRoot: options.homeRoot, codexRulesDir: otherDir };
  const held = await acquireRulesDirLock(rulesDir, options);
  const action = () => assert.fail('invalid ticket must not run the action');
  try {
    await assert.rejects(withRulesDirLock(host, 'install', action, { ticket: held.ticket }), /different physical directory/);
    const missing = { ...host, codexRulesDir: path.join(tree, 'missing-ticket-target') };
    await assert.rejects(withRulesDirLock(missing, 'install', action, { ticket: held.ticket }), /different physical directory/);
    assert.equal(fs.existsSync(missing.codexRulesDir), false);
  } finally {
    await held.release();
  }
  await assert.rejects(withRulesDirLock(host, 'install', action, { ticket: held.ticket }), /no longer active/);
});

test('rules action refuses an inside-home directory before creating it and requires its inputs', async () => {
  const { tree, options } = fixture();
  const host = { root: options.hostRoot, brandRoot: options.homeRoot, codexRulesDir: path.join(options.homeRoot, 'rules') };
  const action = () => assert.fail('invalid input must not run the action');
  await assert.rejects(withRulesDirLock(host, 'install', action), /path is inside the home root/);
  assert.equal(fs.existsSync(host.codexRulesDir), false);
  const outside = { ...host, codexRulesDir: path.join(tree, 'missing-input-target') };
  await assert.rejects(withRulesDirLock(outside, 'install', null), /action must be a function/);
  await assert.rejects(withRulesDirLock(outside, undefined, action), /command must be/);
  for (const field of ['root', 'brandRoot', 'codexRulesDir']) {
    await assert.rejects(withRulesDirLock({ ...outside, [field]: undefined }, 'install', action), /must be a non-empty path/);
  }
  assert.equal(fs.existsSync(outside.codexRulesDir), false);
});

// Plan_83 D2 / OW-086, risk r5: every ownership read and destructive decision needs both locks.
for (const command of [uninstall, purge]) {
  test(command.name + ' holds home and rules locks from preflight through removal', async (t) => {
    const { host } = await hostFixture(t);
    await install({ host });
    const registry = rulesRegistryPath(host), rules = path.join(host.codexRulesDir, 'llm-bridge.rules');
    const seen = new Set(), readFile = fsp.readFile, rm = fsp.rm;
    const checkHeld = async (stage) => {
      await assert.rejects(acquireRulesDirLock(host.codexRulesDir, {
        command: 'contender', hostRoot: host.root, homeRoot: host.brandRoot + '-other', waitMs: 0,
      }), /rules directory lock busy/);
      await assert.rejects(acquireLifecycleLock(host.brandRoot, {
        command: 'contender', hostRoot: host.root, waitMs: 0,
      }), /lifecycle lock busy/);
      seen.add(stage);
    };
    t.mock.method(fsp, 'readFile', async (target, ...args) => {
      if (target === registry) await checkHeld('registry read');
      if (target === rules) await checkHeld('fingerprint');
      return readFile(target, ...args);
    });
    t.mock.method(fsp, 'rm', async (target, ...args) => {
      if (target === registry) await checkHeld('index edit');
      if (target === rules) await checkHeld('rules removal');
      return rm(target, ...args);
    });
    const result = await command({ host, isTTY: true, prompt: async () => 'yes',
      liveRunCheck: () => ({ verdict: 'clear', blocked: [], unknown: [] }) });
    assert.equal(result.exitCode, 0, result.output);
    assert.deepEqual(seen, new Set(['registry read', 'fingerprint', 'index edit', 'rules removal']));
    const next = await acquireRulesDirLock(host.codexRulesDir, {
      command: 'after', hostRoot: host.root, homeRoot: host.brandRoot, waitMs: 0,
    });
    await next.release();
  });
}
