/** Adapts lifecycle home-artifact operations to shared safe clearing (Plan_83 D3 / Plan_65 A5/D8/D11). */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { holderLiveness, lifecycleLockStrategy, parseHolder } from './lifecycle-lock.mjs';
import { clearLock } from './lock-recovery.mjs';

const ARTIFACT_ID = 'install-record';
const errorReason = (error) => error?.code || error?.message || String(error);

export async function clearLifecycleLock(homeRoot, {
  platform = process.platform,
  identity = {},
  writer,
} = {}) {
  const strategy = lifecycleLockStrategy(platform);
  const lockPath = strategy === 'file' ? path.join(homeRoot, '.installed.json.lock') : undefined;
  const base = { homeRoot, strategy, ...(lockPath === undefined ? {} : { lockPath }) };
  const gatePath = lockPath === undefined ? undefined : `${lockPath}.clear`;
  try {
    let home;
    try {
      home = await fsp.stat(homeRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...base, outcome: 'no-home' };
      throw error;
    }
    if (!home.isDirectory()) return { ...base, outcome: 'refused', reason: 'home is not a directory' };
    const target = {
      strategy, address: undefined, lockPath, gatePath, parseHolder,
      judgeHolder: (holder) => holderLiveness(holder, identity),
      label: 'lifecycle lock',
    };
    // Plan_65 D11: kernel-managed clearing must not even initialize a home writer.
    if (strategy !== 'file') return { ...base, ...await clearLock(target, {}) };
    writer ??= createHomeWriter({ root: homeRoot });
    return { ...base, ...await clearLock(target, {
      createGate: (file) => writer.open(ARTIFACT_ID, file, 'wx'),
      writeGate: (handle) => handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`),
      removeGate: (file) => writer.unlink(ARTIFACT_ID, file),
      statLock: (file) => fsp.lstat(file),
      readLock: (file) => fsp.readFile(file),
      unlinkLock: (file) => writer.unlink(ARTIFACT_ID, file),
    }) };
  } catch (error) {
    return { ...base, outcome: 'refused', reason: errorReason(error) };
  }
}
