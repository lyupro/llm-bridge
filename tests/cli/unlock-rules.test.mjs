/** Guards strict rules recovery grammar and operator outcomes (Plan_83 D3 / Plan_65 A5/D8/D11). */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { COMMANDS } from '../../cli/command-registry.mjs';
import { rulesLockTarget, acquireRulesDirLock } from '../../cli/rules-dir-lock.mjs';
import { unlock } from '../../cli/unlock.mjs';
import { unlockRules } from '../../cli/unlock-rules.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function fixture(t, { create = true } = {}) {
  const tree = makeTempTree('unlock-rules-');
  const codexHome = path.join(tree, 'codex');
  const rulesDir = path.join(codexHome, 'rules');
  if (create) fs.mkdirSync(rulesDir, { recursive: true });
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    removeTempTree(tree);
  });
  const options = { inspect: { platform: 'darwin' }, clear: { platform: 'darwin', homeRoot: path.join(tree, 'package') } };
  const holder = { pid: process.pid, command: 'update', hostRoot: tree,
    acquiredAt: '2026-09-30T08:00:00.000Z', token: 'unlock-rules-token' };
  return { tree, codexHome, rulesDir, options, holder,
    target: create ? rulesLockTarget(rulesDir, { platform: 'darwin' }) : null };
}

const dead = { kill: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } };
const heldLine = (holder) => `held by ${holder.command} for ${holder.hostRoot}, pid ${holder.pid}, since ${holder.acquiredAt}.`;
function header(output, rulesDir, strategy = 'file') {
  const firstLine = output.split('\n')[0];
  const prefix = `Rules lock of ${rulesDir} (${strategy}), observed `;
  assert.ok(firstLine.startsWith(prefix), firstLine);
  assert.ok(firstLine.endsWith(':'), firstLine);
  assert.equal(new Date(firstLine.slice(prefix.length, -1)).toISOString(), firstLine.slice(prefix.length, -1));
}

for (const [argv, argument] of [
  [['--rules', 'alpha'], 'alpha'], [['--rules', '--all'], '--all'],
  [['--rules', '--rules'], '--rules'], [['--rules', '--lifecycle'], '--lifecycle'],
  [['--rules', '--unknown'], '--unknown'], [['--rules', '-h'], '-h'],
  [['--rules', '--host', 'host'], '--host'], [['--rules', '--clear', '--host', 'host'], '--host'],
  [['--rules', '--clear', '--clear'], '--clear'], [['--rules', '--clear', 'extra'], 'extra'],
]) {
  test('strict grammar refuses ' + JSON.stringify(argv) + ' before inspection', async (t) => {
    const { options, codexHome } = fixture(t, { create: false });
    options.inspect.createConnection = () => assert.fail('invalid grammar must not inspect');
    const result = await unlock(argv, options);
    assert.equal(result.exitCode, 2);
    assert.equal(result.output, `llm-bridge unlock --rules: unexpected argument "${argument}".\nRun llm-bridge unlock -h for usage.`);
    assert.equal(fs.existsSync(codexHome), false);
  });
}

test('direct parser rejects missing or reordered selectors', async (t) => {
  const { options } = fixture(t, { create: false });
  for (const argv of [[], ['--clear', '--rules'], ['--lifecycle']]) {
    assert.equal((await unlockRules(argv, options)).exitCode, 2);
  }
  for (const argv of [['alpha', '--rules'], ['--clear', '--rules']]) {
    const result = unlock(argv, options);
    assert.equal(result instanceof Promise, false);
    assert.equal(result.exitCode, 2);
  }
});

test('free file inspection resolves CODEX_HOME and never plans project records', async (t) => {
  const { tree, rulesDir, options } = fixture(t);
  Object.defineProperties(options, {
    runsRootPath: { get: () => assert.fail('rules selector must precede record planning') },
    cwd: { get: () => assert.fail('rules selector must precede repository discovery') },
  });
  options.homeRoot = path.join(tree, 'different-package');
  options.host = path.join(tree, 'different-host');
  const pending = unlock(['--rules'], options);
  assert.ok(pending instanceof Promise);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  header(result.output, rulesDir);
  assert.equal(result.output.split('\n')[1], 'free \u2014 no install, update or uninstall holds it.');
  assert.deepEqual(fs.readdirSync(rulesDir), []);
});

test('empty CODEX_HOME uses the existing user-home resolver default', async (t) => {
  const { tree, options } = fixture(t);
  const rulesDir = path.join(tree, '.codex', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  const result = await unlock(['--rules'], { ...options, env: { CODEX_HOME: '' }, homedir: tree });
  assert.equal(result.exitCode, 0);
  header(result.output, rulesDir);
});

for (const clearing of [false, true]) {
  test('missing directory is named and never created: clear=' + clearing, async (t) => {
    const { rulesDir, codexHome, options } = fixture(t, { create: false });
    const result = await unlock(clearing ? ['--rules', '--clear'] : ['--rules'], options);
    assert.equal(result.exitCode, 1);
    if (clearing) assert.equal(result.output.split('\n')[0], `Rules lock of ${rulesDir} (file), clearing:`);
    else header(result.output, rulesDir);
    assert.equal(result.output.split('\n')[1], `llm-bridge unlock --rules: no rules directory at ${rulesDir}; nothing to inspect.`);
    assert.equal(fs.existsSync(codexHome), false);
  });
}

test('dead file inspection names holder and repair without changing the lock', async (t) => {
  const { rulesDir, target, holder, options } = fixture(t);
  const content = JSON.stringify(holder) + '\n';
  fs.writeFileSync(target.lockPath, content);
  options.inspect.identity = dead;
  const result = await unlock(['--rules'], options);
  assert.equal(result.exitCode, 0);
  header(result.output, rulesDir);
  assert.equal(result.output.split('\n')[1], heldLine(holder));
  assert.equal(result.output.split('\n')[2], 'Holder process: dead.');
  assert.match(result.output, /Clear it with llm-bridge unlock --rules --clear$/m);
  assert.equal(fs.readFileSync(target.lockPath, 'utf8'), content);
});

for (const [liveness, probe] of [
  ['alive', () => Date.parse('2026-09-29T00:00:00Z')],
  ['foreign', () => Date.parse('2026-10-01T00:00:00Z')],
  ['unverified', () => null],
]) {
  test('file inspection and clearing preserve ' + liveness + ' holder', async (t) => {
    const { rulesDir, target, holder, options } = fixture(t);
    const content = JSON.stringify(holder) + '\n';
    fs.writeFileSync(target.lockPath, content);
    options.inspect.identity = options.clear.identity = { kill: () => {}, probe };
    const observed = await unlock(['--rules'], options);
    assert.equal(observed.exitCode, 0);
    assert.equal(observed.output.split('\n')[2], `Holder process: ${liveness}.`);
    assert.doesNotMatch(observed.output, /crash|--clear/);
    const cleared = await unlock(['--rules', '--clear'], options);
    assert.equal(cleared.exitCode, 1);
    assert.equal(cleared.output, `Rules lock of ${rulesDir} (file), clearing:\nRefused: the holder process is ${liveness}. Nothing was removed.\n${heldLine(holder)}\nIf you are sure no install, update or uninstall is running, delete ${target.lockPath} yourself.`);
    assert.equal(fs.readFileSync(target.lockPath, 'utf8'), content);
  });
}

test('malformed holder is unverified on inspection and refused on clearing', async (t) => {
  const { rulesDir, target, options } = fixture(t);
  fs.writeFileSync(target.lockPath, '');
  const observed = await unlock(['--rules'], options);
  assert.equal(observed.exitCode, 1);
  header(observed.output, rulesDir);
  assert.equal(observed.output.split('\n')[1], 'could not be verified: malformed holder file. Nothing was changed.');
  const cleared = await unlock(['--rules', '--clear'], options);
  assert.equal(cleared.exitCode, 1);
  assert.match(cleared.output, /Refused: holder record is unreadable or incomplete. Nothing was removed./);
  assert.equal(fs.readFileSync(target.lockPath, 'utf8'), '');
});

test('dead clear renders the removed holder and a subsequent free clear', async (t) => {
  const { rulesDir, target, holder, options } = fixture(t);
  fs.writeFileSync(target.lockPath, JSON.stringify(holder) + '\n');
  options.clear.identity = dead;
  const result = await unlock(['--rules', '--clear'], options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, `Rules lock of ${rulesDir} (file), clearing:\nRemoved the lock left by ${holder.command} for ${holder.hostRoot}, pid ${holder.pid} (dead).\nThe next install, update or uninstall may take it.`);
  assert.equal(fs.existsSync(target.lockPath), false);
  assert.equal(fs.existsSync(target.gatePath), false);
  const free = await unlock(['--rules', '--clear'], options);
  assert.equal(free.exitCode, 0);
  assert.equal(free.output, `Rules lock of ${rulesDir} (file), clearing:\nNothing to clear; the lock is free.`);
});

test('busy gate is named and preserved', async (t) => {
  const { rulesDir, target, options } = fixture(t);
  fs.writeFileSync(target.gatePath, 'crashed clearer');
  const result = await unlock(['--rules', '--clear'], options);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output, `Rules lock of ${rulesDir} (file), clearing:\nAnother clear is in progress or crashed: ${target.gatePath}.\nIf none is running, delete that file yourself.`);
  assert.equal(fs.readFileSync(target.gatePath, 'utf8'), 'crashed clearer');
});

test('leftover clear gate names cleanup failure after successful removal', async (t) => {
  const { target, holder, options } = fixture(t);
  fs.writeFileSync(target.lockPath, JSON.stringify(holder) + '\n');
  options.clear.identity = dead;
  const unlink = fsp.unlink;
  t.mock.method(fsp, 'unlink', async (file) => {
    if (file === target.gatePath) throw Object.assign(new Error('gate denied'), { code: 'EACCES' });
    return unlink(file);
  });
  const result = await unlock(['--rules', '--clear'], options);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Removed the lock left by/);
  assert.ok(result.output.includes(`Could not remove the clear gate: ${target.gatePath}.`));
  assert.equal(fs.existsSync(target.lockPath), false);
  assert.equal(fs.existsSync(target.gatePath), true);
});

for (const [platform, strategy] of [['win32', 'named-pipe'], ['linux', 'abstract-socket']]) {
  test('kernel clear needs no gate: ' + platform, async (t) => {
    const { rulesDir, options } = fixture(t);
    options.clear.platform = platform;
    const result = await unlock(['--rules', '--clear'], options);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, `Rules lock of ${rulesDir} (${strategy}), clearing:\nKernel-managed lock; nothing to clear.\nRun llm-bridge unlock --rules to see its holder.`);
    assert.deepEqual(fs.readdirSync(rulesDir), []);
  });
}

if (['win32', 'linux'].includes(process.platform)) {
  test('real kernel inspection renders free and held without suggesting removal', async (t) => {
    const { tree, rulesDir, options, holder } = fixture(t);
    delete options.inspect.platform;
    const strategy = process.platform === 'win32' ? 'named-pipe' : 'abstract-socket';
    const free = await unlock(['--rules'], options);
    assert.equal(free.exitCode, 0);
    header(free.output, rulesDir, strategy);
    const held = await acquireRulesDirLock(rulesDir, { command: 'install', hostRoot: holder.hostRoot,
      homeRoot: path.join(tree, 'package'), waitMs: 0 });
    try {
      const observed = await unlock(['--rules'], options);
      assert.equal(observed.exitCode, 0);
      header(observed.output, rulesDir, strategy);
      assert.match(observed.output, /held by install/);
      assert.doesNotMatch(observed.output, /Holder process:|--clear/);
    } finally { await held.release(); }
  });
}

test('kernel holder arriving after refusal is held without an invented identity', async (t) => {
  const { rulesDir, options } = fixture(t);
  options.inspect = { platform: 'linux', createConnection: () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    return socket;
  }, createServer: () => {
    const server = new EventEmitter();
    server.listen = () => setImmediate(() => server.emit('error', Object.assign(new Error('held'), { code: 'EADDRINUSE' })));
    server.close = (callback) => callback();
    return server;
  } };
  const result = await unlock(['--rules'], options);
  assert.equal(result.exitCode, 0);
  header(result.output, rulesDir, 'abstract-socket');
  assert.equal(result.output.split('\n')[1], 'held; the holder did not identify itself.');
});

test('registry awaits the rules branch and resolves actual CODEX_HOME', async (t) => {
  const { rulesDir } = fixture(t, { create: false });
  const output = [];
  const entry = COMMANDS.find(({ name }) => name === 'unlock');
  const code = await entry.handler(['--rules'], { log: (line) => output.push(line) });
  assert.equal(code, 1);
  assert.equal(output.length, 1);
  assert.ok(output[0].startsWith(`Rules lock of ${rulesDir} (`));
  assert.ok(output[0].includes('nothing to inspect'));
});
