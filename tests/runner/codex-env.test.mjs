/**
 * OW-089: the 2026-11-13_203644 build read UTF-8 as cp1252 and rewrote em dashes
 * as mojibake while tests stayed green. Real Python witnesses prove the environment
 * prevents that corruption and that the unprotected control can still expose it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { makeTempTree } from '../temp-tree.mjs';
import { codexEnv } from '../../src/home/lib/runner/codex-env.mjs';
import { codexSpawnSpec, runCodex } from '../../src/home/lib/runner/codex-cmd.mjs';
import { INSTRUCTIONS } from '../../src/home/lib/runner/prompts.mjs';

test('codexEnv adds Python UTF-8 mode in a new object without changing either parent', () => {
  const inherited = Object.freeze({ Path: 'C:\\Tools;C:\\Python', OTHER: '  — Привет\r\n\t' });
  const parent = { ...process.env };
  const result = codexEnv(inherited);
  assert.notEqual(result, inherited);
  assert.deepEqual(result, { ...inherited, PYTHONUTF8: '1' });
  for (const [key, value] of Object.entries(inherited)) {
    assert.deepEqual(Buffer.from(result[key], 'utf8'), Buffer.from(value, 'utf8'));
  }
  assert.deepEqual(inherited, { Path: 'C:\\Tools;C:\\Python', OTHER: '  — Привет\r\n\t' });
  assert.deepEqual({ ...process.env }, parent);
});

test('codexEnv overrides every inherited value and removes case-insensitive duplicates', () => {
  for (const value of ['0', '1', '', 'unexpected']) {
    const inherited = Object.freeze({ PYTHONUTF8: value, pythonutf8: '0', PythonUtf8: '0', KEEP: 'same' });
    assert.deepEqual(codexEnv(inherited), { KEEP: 'same', PYTHONUTF8: '1' });
    assert.equal(inherited.PYTHONUTF8, value);
    assert.equal(inherited.pythonutf8, '0');
    assert.equal(inherited.PythonUtf8, '0');
  }
  assert.deepEqual(codexEnv({ pythonutf8: '0' }), { PYTHONUTF8: '1' });
});

for (const [kind, args] of [
  ['fresh', ['exec', '--json', '-']],
  ['resume', ['exec', 'resume', '--json', 'fixture-thread', '-']],
]) {
  test(`runCodex passes the UTF-8 environment to the ${kind} spawn`, async (t) => {
    const root = makeTempTree('codex-env-spawn-');
    const previous = process.env.PYTHONUTF8;
    process.env.PYTHONUTF8 = '0';
    t.after(() => {
      if (previous === undefined) delete process.env.PYTHONUTF8;
      else process.env.PYTHONUTF8 = previous;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const inherited = { ...process.env };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const spawn = t.mock.method(childProcess, 'spawn', () => child);
    syncBuiltinESMExports();

    const pending = runCodex(args, 'fixture', path.join(root, 'events.jsonl'), null, { cwd: root });
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0);
    child.emit('close', 0);
    assert.equal((await pending).exit, 0);
    assert.equal(spawn.mock.callCount(), 1);
    const [command, passedArgs, options] = spawn.mock.calls[0].arguments;
    const spec = codexSpawnSpec(args);
    assert.equal(command, spec.command);
    assert.deepEqual(passedArgs, spec.args);
    assert.deepEqual(options, {
      ...spec.options, cwd: root, env: codexEnv(inherited),
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    assert.notEqual(options.env, process.env);
    assert.deepEqual({ ...process.env }, inherited);
  });
}

test('build working rules require the patch tool and explicit UTF-8 for script reads and writes', () => {
  const rules = INSTRUCTIONS['codex-build']({ verify: 'fixture' });
  assert.match(rules, /Edit files with the patch tool/);
  assert.match(rules, /explicitly on both read and write/);
  for (const example of ["encoding='utf-8'", '-Encoding utf8', "Node 'utf8'"]) {
    assert.ok(rules.includes(example), example);
  }
  assert.match(rules, /legacy code page that silently corrupts non-ASCII text/);
});

const pythonInfo = [
  'import json, locale, sys',
  'print(json.dumps(dict(platform=sys.platform, utf8_mode=sys.flags.utf8_mode,',
  '                      encoding=locale.getpreferredencoding(False))))',
].join('\n');
// The implicit round trip matches the incident's read; explicit UTF-8 output made the
// misdecoded input permanent. Also guard Python's default write with an implicit output.
const pythonRoundTrip = [
  'import json, locale, sys',
  'from pathlib import Path',
  'source, implicit, incident = map(Path, sys.argv[1:])',
  'text = source.read_text()',
  'implicit.write_text(text)',
  "incident.write_text(text, encoding='utf-8')",
  'print(json.dumps(dict(utf8_mode=sys.flags.utf8_mode, encoding=locale.getpreferredencoding(False))))',
].join('\n');

function python(t, env, script, args = []) {
  const result = childProcess.spawnSync('python', ['-c', script, ...args], {
    env, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  if (result.error?.code === 'ENOENT') {
    t.skip('python is not on PATH; the real Python witness cannot run');
    return null;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function textFixture() {
  const root = makeTempTree('codex-env-python-');
  const files = ['source.txt', 'implicit.txt', 'incident.txt'].map((name) => path.join(root, name));
  // No newline translation: byte differences must come from the encoding, not CRLF.
  const bytes = Buffer.from('em dash — Cyrillic Привет мир', 'utf8');
  fs.writeFileSync(files[0], bytes);
  return { files, bytes };
}

test('real Python UTF-8 mode preserves em dash and Cyrillic bytes through implicit text I/O', (t) => {
  const { files, bytes } = textFixture();
  const info = python(t, codexEnv({ ...process.env, PYTHONUTF8: '0' }), pythonRoundTrip, files);
  if (!info) return;
  assert.equal(info.utf8_mode, 1);
  assert.deepEqual(fs.readFileSync(files[1]), bytes);
  assert.deepEqual(fs.readFileSync(files[2]), bytes);
  t.diagnostic(`protected Python: utf8_mode=${info.utf8_mode}, encoding=${info.encoding}; bytes unchanged`);
});

test('unprotected Windows legacy-code-page control exposes the incident corruption', (t) => {
  const env = { ...process.env, PYTHONUTF8: '0' };
  const info = python(t, env, pythonInfo);
  if (!info) return;
  if (info.platform !== 'win32' || /^utf-?8$/i.test(info.encoding)) {
    t.skip(`legacy-code-page control requires Windows with a non-UTF-8 default; Python reports ${info.platform}, ${info.encoding}`);
    return;
  }
  assert.equal(info.utf8_mode, 0);
  const { files, bytes } = textFixture();
  const control = python(t, env, pythonRoundTrip, files);
  if (!control) return;
  assert.equal(control.utf8_mode, 0);
  const corrupted = fs.readFileSync(files[2]);
  assert.notDeepEqual(corrupted, bytes);
  assert.ok(!corrupted.toString('utf8').includes('—'), 'the em dash must be corrupted');
  t.diagnostic(`unprotected Python: utf8_mode=${control.utf8_mode}, encoding=${control.encoding}; em dash corrupted`);
});
