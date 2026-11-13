/** Adapts physical rules-directory locks to non-stealing recovery (Plan_83 D3 / Plan_65 A5/D8/D11). */
import fsp from 'node:fs/promises';
import net from 'node:net';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { kernelLockStrategy } from '../src/home/lib/kernel-lock.mjs';
import { clearLock, inspectLock } from './lock-recovery.mjs';
import { rulesLockTarget } from './rules-dir-lock.mjs';

const errorReason = (error) => error?.code || error?.message || String(error);

export async function inspectRulesLock(rulesDir, {
  platform = process.platform,
  identity = {},
  answerTimeoutMs = 1_000,
  createConnection = net.createConnection,
  createServer = net.createServer,
} = {}) {
  const base = { rulesDir, strategy: kernelLockStrategy(platform) ?? 'file', observedAt: new Date().toISOString() };
  try {
    const target = rulesLockTarget(rulesDir, { platform, identity });
    if (target === null) return { ...base, state: 'no-directory' };
    return { ...base, ...await inspectLock(target, {
      readLock: (file, encoding) => fsp.readFile(file, encoding),
    }, { answerTimeoutMs, createConnection, createServer }) };
  } catch (error) {
    return { ...base, state: 'unverified', reason: errorReason(error) };
  }
}

export async function clearRulesLock(rulesDir, {
  platform = process.platform,
  identity = {},
  homeRoot = resolveBrandHome().root,
} = {}) {
  let base = { rulesDir, strategy: kernelLockStrategy(platform) ?? 'file' };
  try {
    const target = rulesLockTarget(rulesDir, { platform, identity });
    if (target === null) return { ...base, outcome: 'no-directory' };
    base = { ...base, lockPath: target.lockPath };
    if (target.strategy !== 'file') return { ...base, ...await clearLock(target, {}) };
    const writer = createHomeWriter({ root: homeRoot });
    // Plan_83 D3 / Plan_65 D11: these host-shared sinks must never bypass the home boundary.
    const remove = (file) => {
      writer.assertOutside(file);
      return fsp.unlink(file);
    };
    return { ...base, ...await clearLock(target, {
      createGate: (file) => {
        writer.assertOutside(file);
        return fsp.open(file, 'wx');
      },
      writeGate: (handle) => handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`),
      removeGate: remove,
      statLock: (file) => fsp.lstat(file),
      readLock: (file) => fsp.readFile(file),
      unlinkLock: remove,
    }) };
  } catch (error) {
    return { ...base, outcome: 'refused', reason: errorReason(error) };
  }
}
