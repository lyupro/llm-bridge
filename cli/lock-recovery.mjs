/** Shares non-stealing lock inspection and clearing policy so recovery cannot drift (Plan_83 D3). */
import { tryHoldSocket } from '../src/home/lib/kernel-lock.mjs';

const refusedCodes = new Set(['ECONNREFUSED', 'ENOENT']);
const errorReason = (error) => error?.code || error?.message || String(error);

function readSocketAnswer(target, timeoutMs, createConnection) {
  return new Promise((resolve) => {
    let socket;
    let timer;
    let data = '';
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(outcome);
    };
    const failed = (error) => finish({
      kind: refusedCodes.has(error?.code) ? 'refused' : 'error',
      reason: errorReason(error),
    });
    const answered = (line) => {
      const holder = target.parseHolder(line);
      finish(holder ? { kind: 'answer', holder } : { kind: 'malformed', reason: 'malformed holder answer' });
    };
    try {
      socket = createConnection(target.address);
      timer = setTimeout(() => finish({ kind: 'timeout', reason: 'holder answer timed out' }), timeoutMs);
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        const newline = data.indexOf('\n');
        if (newline !== -1) answered(data.slice(0, newline));
      });
      socket.once('end', () => answered(data));
      socket.once('error', failed);
      socket.once('close', () => finish({ kind: 'error', reason: 'connection closed without a holder answer' }));
    } catch (error) {
      failed(error);
    }
  });
}

export async function inspectLock(target, files, { answerTimeoutMs, createConnection, createServer }) {
  try {
    if (target.strategy === 'file') {
      let content;
      try {
        content = await files.readLock(target.lockPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return { state: 'free' };
        return { state: 'unverified', reason: errorReason(error) };
      }
      const holder = target.parseHolder(content.split(/\r?\n/, 1)[0]);
      if (!holder) return { state: 'unverified', reason: 'malformed holder file' };
      return { state: 'held', holder, liveness: target.judgeHolder(holder) };
    }
    const answer = await readSocketAnswer(target, answerTimeoutMs, createConnection);
    if (answer.kind === 'answer') return { state: 'held', holder: answer.holder };
    // Plan_65 D11/A14: silence and permission denial cannot prove freedom; trial only after refusal.
    if (answer.kind !== 'refused') return { state: 'unverified', reason: answer.reason };
    const release = await tryHoldSocket(target.address, createServer, target.label);
    if (release === 'in-use') return { state: 'held', holder: null };
    await release();
    return { state: 'free' };
  } catch (error) {
    return { state: 'unverified', reason: errorReason(error) };
  }
}

async function clearHeldGate(target, files) {
  const { lockPath } = target;
  let before;
  try {
    before = await files.statLock(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { outcome: 'free' };
    throw error;
  }
  if (!before.isFile()) return { outcome: 'refused', reason: 'not a regular file' };
  const content = await files.readLock(lockPath);
  const holder = target.parseHolder(content.toString('utf8').split(/\r?\n/, 1)[0]);
  if (!holder) return { outcome: 'refused', reason: 'holder record is unreadable or incomplete' };
  const liveness = target.judgeHolder(holder);
  // Plan_65 D8: foreign and unverified holders never authorize removal.
  if (liveness !== 'dead') return { outcome: 'refused', reason: `the holder process is ${liveness}`, holder };

  let current;
  let after;
  try {
    current = await files.readLock(lockPath);
    after = await files.statLock(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { outcome: 'refused', reason: 'the lock changed while clearing', holder };
    }
    return { outcome: 'refused', reason: errorReason(error), holder };
  }
  // Plan_65 A5/D11: renaming first would already free a replacement holder's name.
  if (!after.isFile() || !content.equals(current)
    || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    return { outcome: 'refused', reason: 'the lock changed while clearing', holder };
  }
  try {
    await files.unlinkLock(lockPath);
  } catch (error) {
    return { outcome: 'refused', reason: errorReason(error), holder };
  }
  try {
    await files.statLock(lockPath);
    return { outcome: 'refused', reason: 'the lock is still present after clearing', holder };
  } catch (error) {
    if (error?.code === 'ENOENT') return { outcome: 'cleared', holder };
    return { outcome: 'refused', reason: errorReason(error), holder };
  }
}

export async function clearLock(target, files) {
  if (target.strategy !== 'file') return { outcome: 'kernel-managed' };
  let handle;
  let result;
  try {
    // Plan_65 A5/D11: clearers must serialize before the authoritative read, never on stale diagnosis.
    try {
      handle = await files.createGate(target.gatePath);
    } catch (error) {
      if (error?.code === 'EEXIST') return { outcome: 'gate-busy', gatePath: target.gatePath };
      throw error;
    }
    await files.writeGate(handle);
    result = await clearHeldGate(target, files);
  } catch (error) {
    result = { outcome: 'refused', reason: errorReason(error) };
  } finally {
    if (handle) {
      // Plan_65 D11: cleanup failure cannot change an already completed removal into a refusal.
      await handle.close().catch(() => {});
      try {
        await files.removeGate(target.gatePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') result = { ...result, gateLeft: target.gatePath };
      }
    }
  }
  return result;
}
