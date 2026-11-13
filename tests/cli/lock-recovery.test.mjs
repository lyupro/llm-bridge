/** Guards shared recovery ordering and refusal invariants against policy drift (Plan_83 D3 / Plan_65 A5/D8/D11). */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { clearLock, inspectLock } from '../../cli/lock-recovery.mjs';

const failure = (code) => Object.assign(new Error(code), { code });
const holder = { owner: 'a non-lifecycle holder' };
const options = {
  answerTimeoutMs: 20,
  createConnection: () => assert.fail('file recovery must not connect'),
  createServer: () => assert.fail('file recovery must not listen'),
};

function fixture() {
  const calls = [];
  const state = {
    present: true, gate: false, content: Buffer.from(JSON.stringify(holder) + '\r\nignored\r\n'),
    ino: 1, size: 40, mtimeMs: 2, regular: true, liveness: 'dead',
  };
  const target = {
    strategy: 'file', address: 'kernel:explicit-target', lockPath: '/selected/holder',
    gatePath: '/selected/recovery-gate', label: 'selected lock',
    parseHolder(line) {
      try {
        const value = JSON.parse(line);
        return value.owner ? value : null;
      } catch { return null; }
    },
    judgeHolder(value) {
      calls.push('judge');
      assert.deepEqual(value, holder);
      state.onJudge?.();
      return state.liveness;
    },
  };
  const handle = { close: async () => { calls.push('close'); } };
  const files = {
    async createGate(file) {
      calls.push('gate');
      assert.equal(file, target.gatePath);
      if (state.gate) throw failure('EEXIST');
      state.gate = true;
      return handle;
    },
    async writeGate(value) {
      calls.push('write-gate');
      assert.equal(value, handle);
    },
    async removeGate(file) {
      calls.push('remove-gate');
      assert.equal(file, target.gatePath);
      state.gate = false;
    },
    async statLock(file) {
      calls.push('stat');
      assert.equal(file, target.lockPath);
      assert.equal(state.gate, true, 'Plan_65 A5/D11: authoritative read requires the gate');
      if (!state.present) throw failure('ENOENT');
      return { isFile: () => state.regular, ino: state.ino, size: state.size, mtimeMs: state.mtimeMs };
    },
    async readLock(file, encoding) {
      calls.push('read');
      assert.equal(file, target.lockPath);
      if (!state.present) throw failure('ENOENT');
      return encoding ? state.content.toString(encoding) : Buffer.from(state.content);
    },
    async unlinkLock(file) {
      calls.push('unlink');
      assert.equal(file, target.lockPath);
      assert.equal(state.gate, true);
      state.present = false;
    },
  };
  return { target, files, state, calls };
}

test('free inspection does not create a gate or mutate the target', async () => {
  const { target, files, state, calls } = fixture();
  state.present = false;
  assert.deepEqual(await inspectLock(target, files, options), { state: 'free' });
  assert.deepEqual(calls, ['read']);
  assert.equal(state.gate, false);
});

for (const liveness of ['alive', 'dead', 'foreign', 'unverified']) {
  test(`inspection reports a ${liveness} holder as held without clearing`, async () => {
    const { target, files, state, calls } = fixture();
    state.liveness = liveness;
    assert.deepEqual(await inspectLock(target, files, options), { state: 'held', holder, liveness });
    assert.deepEqual(calls, ['read', 'judge']);
    assert.equal(state.present, true);
    assert.equal(state.gate, false);
  });
}

test('dead holder clears only after gate, authoritative read, and content/identity recheck', async () => {
  const { target, files, state, calls } = fixture();
  assert.deepEqual(await clearLock(target, files), { outcome: 'cleared', holder });
  assert.deepEqual(calls, [
    'gate', 'write-gate', 'stat', 'read', 'judge', 'read', 'stat', 'unlink', 'stat', 'close', 'remove-gate',
  ]);
  assert.equal(state.present, false);
  assert.equal(state.gate, false);
});

for (const liveness of ['alive', 'foreign', 'unverified']) {
  test(`${liveness} holder refuses clearing and preserves its bytes`, async () => {
    const { target, files, state, calls } = fixture();
    state.liveness = liveness;
    const content = Buffer.from(state.content);
    assert.deepEqual(await clearLock(target, files), {
      outcome: 'refused', reason: `the holder process is ${liveness}`, holder,
    });
    assert.deepEqual(state.content, content);
    assert.equal(state.present, true);
    assert.equal(state.gate, false);
    assert.equal(calls.includes('unlink'), false);
  });
}

test('absent file clears as free after taking and releasing the gate', async () => {
  const { target, files, state, calls } = fixture();
  state.present = false;
  assert.deepEqual(await clearLock(target, files), { outcome: 'free' });
  assert.deepEqual(calls, ['gate', 'write-gate', 'stat', 'close', 'remove-gate']);
  assert.equal(state.gate, false);
});

test('busy gate prevents all authoritative reads and is left untouched', async () => {
  const { target, files, state, calls } = fixture();
  state.gate = true;
  assert.deepEqual(await clearLock(target, files), { outcome: 'gate-busy', gatePath: target.gatePath });
  assert.deepEqual(calls, ['gate']);
  assert.equal(state.gate, true);
  assert.equal(state.present, true);
});

for (const [name, mutate] of [
  ['content', (state) => { state.content = Buffer.from('{"owner":"replacement"}\n'); }],
  ['inode with identical content', (state) => { state.ino += 1; }],
  ['size', (state) => { state.size += 1; }],
  ['mtime', (state) => { state.mtimeMs += 1; }],
  ['file type', (state) => { state.regular = false; }],
  ['disappearance', (state) => { state.present = false; }],
]) {
  test(`${name} change between authoritative read and unlink refuses removal`, async () => {
    const { target, files, state, calls } = fixture();
    state.onJudge = () => mutate(state);
    assert.deepEqual(await clearLock(target, files), {
      outcome: 'refused', reason: 'the lock changed while clearing', holder,
    });
    assert.equal(calls.includes('unlink'), false);
    assert.equal(state.gate, false);
  });
}

for (const code of ['EPERM', 'EACCES']) {
  test(`${code} during inspection or death judgment never proves death`, async () => {
    const { target, files, state, calls } = fixture();
    assert.deepEqual(await inspectLock(target, {
      ...files, readLock: async () => { throw failure(code); },
    }, options), { state: 'unverified', reason: code });
    target.judgeHolder = () => { throw failure(code); };
    assert.deepEqual(await clearLock(target, files), { outcome: 'refused', reason: code });
    assert.equal(state.present, true);
    assert.equal(state.gate, false);
    assert.equal(calls.includes('unlink'), false);
  });
}

test('nonregular and malformed lock files are refused without unlink', async () => {
  for (const malformed of [false, true]) {
    const { target, files, state, calls } = fixture();
    state.regular = malformed;
    if (malformed) state.content = Buffer.from('{broken}\n');
    assert.deepEqual(await clearLock(target, files), {
      outcome: 'refused',
      reason: malformed ? 'holder record is unreadable or incomplete' : 'not a regular file',
    });
    assert.equal(calls.includes('unlink'), false);
    assert.equal(state.gate, false);
    if (malformed) {
      assert.deepEqual(await inspectLock(target, files, options), {
        state: 'unverified', reason: 'malformed holder file',
      });
    }
  }
});

for (const strategy of ['named-pipe', 'abstract-socket']) {
  test(`${strategy} clearing is kernel-managed and never calls a file operation`, async () => {
    const { target } = fixture();
    target.strategy = strategy;
    const files = new Proxy({}, { get: () => assert.fail('kernel clearing must not access files') });
    assert.deepEqual(await clearLock(target, files), { outcome: 'kernel-managed' });
  });
}

function connection(target, action) {
  return (address) => {
    assert.equal(address, target.address);
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(() => action(socket));
    return socket;
  };
}

function servers(target, outcomes) {
  const opened = [];
  return {
    opened,
    createServer() {
      const server = new EventEmitter();
      const code = outcomes[opened.length];
      server.closed = false;
      server.listen = (address) => {
        assert.equal(address, target.address);
        setImmediate(() => code ? server.emit('error', failure(code)) : server.emit('listening'));
      };
      server.close = (callback) => { server.closed = true; callback(); };
      opened.push(server);
      return server;
    },
  };
}

test('kernel holder answers use the explicit parser without consulting file liveness', async () => {
  const { target } = fixture();
  target.strategy = 'abstract-socket';
  target.judgeHolder = () => assert.fail('kernel answer is diagnosis only');
  assert.deepEqual(await inspectLock(target, {}, {
    ...options,
    createConnection: connection(target, (socket) => socket.emit('data', Buffer.from(JSON.stringify(holder) + '\n'))),
  }), { state: 'held', holder });
});

for (const code of ['ECONNREFUSED', 'ENOENT']) {
  test(`${code} requires an exclusive trial hold and release before reporting free`, async () => {
    const { target } = fixture();
    target.strategy = 'named-pipe';
    const stub = servers(target, [null, 'EADDRINUSE']);
    assert.deepEqual(await inspectLock(target, {}, {
      ...options, createServer: stub.createServer,
      createConnection: connection(target, (socket) => socket.emit('error', failure(code))),
    }), { state: 'free' });
    assert.equal(stub.opened.length, 2);
    assert.ok(stub.opened.every((server) => server.closed));
  });
}

for (const [name, action, reason] of [
  ['permission denial', (socket) => socket.emit('error', failure('EACCES')), 'EACCES'],
  ['silence', () => {}, 'holder answer timed out'],
  ['malformed answer', (socket) => socket.emit('data', Buffer.from('{broken}\n')), 'malformed holder answer'],
]) {
  test(`kernel ${name} stays unverified without a trial hold`, async () => {
    const { target } = fixture();
    target.strategy = 'abstract-socket';
    assert.deepEqual(await inspectLock(target, {}, {
      ...options, createConnection: connection(target, action),
    }), { state: 'unverified', reason });
  });
}

test('kernel holder arriving after refusal remains held with unknown metadata', async () => {
  const { target } = fixture();
  target.strategy = 'abstract-socket';
  const stub = servers(target, ['EADDRINUSE']);
  assert.deepEqual(await inspectLock(target, {}, {
    ...options, createServer: stub.createServer,
    createConnection: connection(target, (socket) => socket.emit('error', failure('ECONNREFUSED'))),
  }), { state: 'held', holder: null });
  assert.ok(stub.opened.every((server) => server.closed));
});
