/** Serializes writers of one existing physical Codex rules directory; dry runs must never call this module. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { isLockTaken, openOutsideFileLock } from '../src/home/lib/file-lock.mjs';
import {
  acquireKernelLock, directoryDigest, kernelLockAddress, kernelLockStrategy,
} from '../src/home/lib/kernel-lock.mjs';
import { PACKAGE_NAME } from '../src/home/lib/package-identity.mjs';
import { holderLiveness, parseHolder } from './lifecycle-lock.mjs';

const LOCK_NAME = `.${PACKAGE_NAME}-rules.lock`;
const liveTickets = new WeakMap();
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function withRulesDirLock(host, command, action, { ticket, createDirectory = true } = {}) {
  if (typeof action !== 'function') throw new TypeError('rules lock action must be a function');
  requirePath('rulesDir', host?.codexRulesDir);
  if (ticket !== undefined) {
    assertLiveRulesTicket(ticket, host.codexRulesDir);
    return action(ticket);
  }
  requirePath('homeRoot', host?.brandRoot);
  requirePath('hostRoot', host?.root);
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('command must be a non-empty string');
  }
  // Plan_83 D2 / OW-086: the physical lock needs a directory; never bypass home-write checks.
  const writer = createHomeWriter({ root: host.brandRoot });
  writer.assertOutside(host.codexRulesDir);
  // Plan_83 D2 / OW-086, risk r5: removal must not create a directory with no rules to protect.
  if (createDirectory) await fsp.mkdir(host.codexRulesDir, { recursive: true });
  else if (directoryDigest(host.codexRulesDir) === null) return action(undefined);
  const lock = await acquireRulesDirLock(host.codexRulesDir, {
    command, hostRoot: host.root, homeRoot: host.brandRoot,
  });
  try {
    return await action(lock.ticket);
  } finally {
    await lock.release();
  }
}

function requirePath(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty path`);
  }
}

export function rulesLockTarget(rulesDir, { platform = process.platform, identity = {} } = {}) {
  requirePath('rulesDir', rulesDir);
  const digest = directoryDigest(rulesDir);
  if (digest === null) return null;
  // Plan_83 D3: acquisition and recovery must agree even through a retargetable directory alias.
  const physicalDir = fs.realpathSync(rulesDir);
  assertIdentity(physicalDir, digest);
  const strategy = kernelLockStrategy(platform) ?? 'file';
  const lockPath = path.join(physicalDir, LOCK_NAME);
  return {
    digest, physicalDir, strategy,
    address: kernelLockAddress('rules-dir', digest, platform) ?? lockPath,
    lockPath, gatePath: `${lockPath}.clear`, parseHolder,
    judgeHolder: (holder) => holderLiveness(holder, identity),
    label: 'rules directory lock',
  };
}

function assertIdentity(rulesDir, digest) {
  if (directoryDigest(rulesDir) !== digest) {
    throw new Error(`rules lock directory identity changed after acquisition: ${rulesDir}`);
  }
}

export function assertLiveRulesTicket(ticket, rulesDir) {
  requirePath('rulesDir', rulesDir);
  const held = ticket && typeof ticket === 'object' ? liveTickets.get(ticket) : null;
  if (!held) throw new Error('rules lock ticket is no longer active');
  if (directoryDigest(rulesDir) !== held.digest) {
    throw new Error('rules lock ticket belongs to a different physical directory');
  }
}

function busyError(rulesDir, holder, fallback = false) {
  const details = holder
    ? `held by ${holder.command} for ${holder.hostRoot}, pid ${holder.pid}, since ${holder.acquiredAt}`
    : 'the holder did not answer (unverified)';
  const repair = fallback
    ? '. If no install, update or uninstall is running, the lock was left by a crash and must be cleared with llm-bridge unlock --rules'
    : '';
  return new Error(`rules directory lock busy for ${rulesDir}: ${details}; nothing was changed${repair}`);
}

function checkedOutsideFiles(homeRoot, lockPath) {
  const writer = createHomeWriter({ root: homeRoot });
  writer.assertOutside(lockPath);
  // Plan_83 D2 / OW-086: this host-shared file is not a home artifact; every raw sink is inventoried.
  return {
    open() {
      return openOutsideFileLock(writer, lockPath);
    },
    write(handle, line) {
      writer.assertOutside(lockPath);
      return handle.writeFile(line);
    },
    async removeOwned(owned) {
      writer.assertOutside(lockPath);
      try {
        const current = await fsp.stat(lockPath, { bigint: true });
        if (current.dev !== owned.dev || current.ino !== owned.ino) return;
        await fsp.unlink(lockPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}

async function acquireFile(rulesDir, target, holder, { homeRoot, waitMs, retryMs }) {
  const { lockPath, parseHolder } = target;
  const files = checkedOutsideFiles(homeRoot, lockPath);
  const deadline = Date.now() + waitMs;
  let handle;
  for (;;) {
    try {
      handle = await files.open();
      break;
    } catch (error) {
      if (!isLockTaken(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        let current = null;
        try { current = parseHolder((await fsp.readFile(lockPath, 'utf8')).split(/\r?\n/, 1)[0]); } catch { /* Diagnosis only. */ }
        throw busyError(rulesDir, current, true);
      }
      // Plan_65 A5: age and apparent process death never authorize stealing a paused writer's lock.
      await wait(Math.min(retryMs, remaining));
    }
  }

  let owned;
  const release = async () => {
    try { await handle.close(); } finally {
      if (owned) await files.removeOwned(owned);
    }
  };
  try {
    owned = await handle.stat({ bigint: true });
    holder.acquiredAt = new Date().toISOString();
    await files.write(handle, `${JSON.stringify(holder)}\n`);
    return { strategy: 'file', release };
  } catch (error) {
    await release();
    throw error;
  }
}

function makeTicket(digest, holder, lock) {
  const ticket = Object.freeze({});
  const held = { digest, token: holder.token, strategy: lock.strategy };
  liveTickets.set(ticket, held);
  let releasePromise;
  return {
    ticket,
    token: held.token,
    strategy: held.strategy,
    release() {
      // Plan_83 D2: nested update/install calls may borrow, but only the outer owner releases.
      liveTickets.delete(ticket);
      return (releasePromise ??= lock.release());
    },
  };
}

export async function acquireRulesDirLock(rulesDir, {
  command,
  hostRoot,
  homeRoot,
  ticket,
  waitMs = 15_000,
  retryMs = 100,
  platform = process.platform,
  answerTimeoutMs = 1_000,
  createServer = net.createServer,
} = {}) {
  requirePath('rulesDir', rulesDir);
  if (ticket !== undefined) {
    assertLiveRulesTicket(ticket, rulesDir);
    const held = liveTickets.get(ticket);
    return { ticket, token: held.token, strategy: held.strategy, release: async () => {} };
  }
  requirePath('homeRoot', homeRoot);
  requirePath('hostRoot', hostRoot);
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('command must be a non-empty string');
  }
  for (const [name, value, minimum] of [
    ['waitMs', waitMs, 0], ['retryMs', retryMs, 1], ['answerTimeoutMs', answerTimeoutMs, 0],
  ]) {
    if (!Number.isFinite(value) || value < minimum) {
      throw new TypeError(`${name} must be a ${minimum ? 'positive' : 'non-negative'} number`);
    }
  }
  const target = rulesLockTarget(rulesDir, { platform });
  if (target === null) throw new Error(`rules lock directory does not exist: ${rulesDir}`);
  const { digest, strategy } = target;
  const holder = { pid: process.pid, command, hostRoot, token: randomUUID() };
  let lock;
  if (strategy !== 'file') {
    // Plan_83 D2 / OW-086: physical exclusion is independent of lexical ownership and home locks.
    const result = await acquireKernelLock({
      address: target.address,
      holder, waitMs, retryMs, answerTimeoutMs, createServer,
      parseAnswer: target.parseHolder,
      label: target.label,
    });
    if (!result.held) throw busyError(rulesDir, result.holder);
    lock = { strategy, release: result.release };
  } else {
    lock = await acquireFile(rulesDir, target, holder, { homeRoot, waitMs, retryMs });
  }
  try {
    assertIdentity(rulesDir, digest);
    return makeTicket(digest, holder, lock);
  } catch (error) {
    await lock.release();
    throw error;
  }
}
