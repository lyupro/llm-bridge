/** Adapts lifecycle diagnosis to the shared non-stealing recovery policy (Plan_83 D3 / Plan_65 D11). */
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  holderLiveness, lifecycleLockAddress, lifecycleLockStrategy, parseHolder,
} from './lifecycle-lock.mjs';
import { inspectLock } from './lock-recovery.mjs';

const errorReason = (error) => error?.code || error?.message || String(error);

export async function inspectLifecycleLock(homeRoot, {
  platform = process.platform,
  createServer = net.createServer,
  answerTimeoutMs = 1_000,
  identity = {},
  createConnection = net.createConnection,
} = {}) {
  const observation = {
    strategy: lifecycleLockStrategy(platform),
    homeRoot,
    observedAt: new Date().toISOString(),
  };
  const result = (value) => ({ ...observation, ...value });
  try {
    const address = lifecycleLockAddress(homeRoot, { platform });
    if (address === null) return result({ state: 'no-home' });
    const lockPath = path.join(homeRoot, '.installed.json.lock');
    const target = {
      ...address, lockPath, gatePath: `${lockPath}.clear`, parseHolder,
      judgeHolder: (holder) => holderLiveness(holder, identity),
      label: 'lifecycle lock',
    };
    return result(await inspectLock(target, {
      readLock: (file, encoding) => fsp.readFile(file, encoding),
    }, { answerTimeoutMs, createConnection, createServer }));
  } catch (error) {
    return result({ state: 'unverified', reason: errorReason(error) });
  }
}
