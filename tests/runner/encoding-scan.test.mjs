/** Guards OW-089 D1: encoding evidence never decides a run's status in pass 2b. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { worktreeSnapshot } from '../../src/home/lib/runner/git-state.mjs';
import { captureFlagBaseline, FLAG_BASELINE_DIR, FLAG_BASELINE_MANIFEST } from '../../src/home/lib/runner/flag-baseline.mjs';
import { writeBuildAfter } from '../../src/home/lib/runner/build-evidence.mjs';

const dash = '\u2014';
const image = '\u00e2\u20ac\u201d';

function fixture(t) {
  const repoRoot = makeTempTree('bridge-encoding-repo-');
  const runDir = makeTempTree('bridge-encoding-run-');
  t.after(async () => { await removeTempTree(repoRoot); await removeTempTree(runDir); });
  const environment = {
    GIT_CONFIG_GLOBAL: path.join(runDir, 'absent-config'),
    GIT_CONFIG_SYSTEM: path.join(runDir, 'absent-config'), GIT_CONFIG_COUNT: undefined,
    LLM_BRIDGE_RUNS_ROOT: path.join(runDir, 'runs'),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const setEnvironment = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  setEnvironment(environment);
  t.after(() => setEnvironment(saved));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repoRoot, '-c', 'core.autocrlf=false', ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const write = (name, content) => fs.writeFileSync(path.join(repoRoot, name), content);
  const commit = () => {
    git('add', '--', '.');
    git('-c', 'user.name=Encoding Test', '-c', 'user.email=encoding@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'encoding fixture');
  };
  git('init', '-q');
  write('file.txt', 'start\n');
  commit();
  const capture = (limits) => {
    fs.writeFileSync(path.join(runDir, 'state-before.txt'), worktreeSnapshot(repoRoot));
    return captureFlagBaseline({ runDir, repoRoot, isGitRepo: true, ...(limits ? { limits } : {}) });
  };
  const read = (name) => fs.readFileSync(path.join(runDir, name));
  const records = { 'status.json': '{"status":"running"}\n', 'meta.json': '{"status":"OK"}\n', 'reply.txt': 'OK\n' };
  for (const [name, text] of Object.entries(records)) fs.writeFileSync(path.join(runDir, name), text);
  const finish = () => {
    writeBuildAfter({ runDir, repoRoot, isGitRepo: true });
    for (const [name, text] of Object.entries(records)) assert.deepEqual(read(name), Buffer.from(text));
    assert.equal(fs.existsSync(path.join(runDir, FLAG_BASELINE_DIR)), false);
    return JSON.parse(read('encoding.json'));
  };
  return { repoRoot, runDir, write, commit, capture, finish, read };
}

function empty(report, complete = true) {
  assert.deepEqual(report.proven, []);
  assert.deepEqual(report.suspected, []);
  assert.deepEqual(report.counts, { proven: 0, suspected: 0 });
  assert.equal(report.truncated, false);
  assert.equal(report.coverage.complete, complete);
}

for (const [label, startEol, endEol, dirty] of [
  ['clean LF', '\n', '\n', false], ['clean CRLF', '\r\n', '\r\n', false],
  ['dirty LF', '\n', '\n', true], ['dirty CRLF', '\r\n', '\r\n', true],
  ['CRLF to LF', '\r\n', '\n', false], ['LF to CRLF', '\n', '\r\n', false],
]) {
  test(`incident: three original comment dashes are proven with end line numbers (${label})`, (t) => {
    const f = fixture(t);
    const lines = ['// first ' + dash, 'unchanged', '// second ' + dash, '// third ' + dash];
    f.write('file.txt', lines.join(startEol) + startEol);
    f.commit();
    if (dirty) f.write('file.txt', ['dirty prefix', ...lines].join(startEol) + startEol);
    f.capture();
    const endLines = (dirty ? ['dirty prefix', ...lines] : lines).map((line) => line.replace(dash, image));
    f.write('file.txt', endLines.join(endEol) + endEol);
    const report = f.finish();
    assert.equal(report.version, 1);
    assert.deepEqual(report.proven, [0, 2, 3].map((index) => ({
      path: 'file.txt', line: index + 1 + Number(dirty), text: lines[index].replace(dash, image),
    })));
    assert.deepEqual(report.suspected, []);
    assert.deepEqual(report.counts, { proven: 3, suspected: 0 });
    assert.deepEqual(report.coverage, { complete: true, gaps: [] });
  });
}

test('new-file candidates are suspected and unchanged accented text beside an addition is ignored', (t) => {
  const f = fixture(t);
  f.write('file.txt', 'caf\u00e9 d\u00e9j\u00e0\n');
  f.commit();
  f.capture();
  f.write('file.txt', 'caf\u00e9 d\u00e9j\u00e0\nplain addition\n');
  f.write('fresh.txt', `new ${image}\n`);
  const report = f.finish();
  assert.deepEqual(report.proven, []);
  assert.deepEqual(report.suspected, [{
    path: 'fresh.txt', line: 1, kind: 'candidate', index: 4, text: image, repaired: dash,
  }]);
});

test('legitimate Portuguese, French, German, Cyrillic, CJK and emoji edits produce no findings', (t) => {
  const f = fixture(t);
  const samples = [
    'Portuguese: a\u00e7\u00e3o, cora\u00e7\u00e3o, S\u00c3O',
    'French: caf\u00e9, d\u00e9j\u00e0, \u0153uvre',
    'German: Gr\u00fc\u00dfe, Stra\u00dfe',
    'Cyrillic: \u041f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440',
    'CJK: \u4e2d\u6587 \u65e5\u672c\u8a9e \ud55c\uad6d\uc5b4',
    'Emoji: \ud83d\ude80 \ud83d\udc69\u200d\ud83d\udcbb \ud83c\udf0d',
  ];
  f.write('file.txt', samples.join('\n') + '\n');
  f.commit();
  f.capture();
  f.write('file.txt', samples.map((line) => line + ' updated').join('\n') + '\n');
  f.write('fresh.txt', samples.join('\n') + '\n');
  empty(f.finish());
});

test('same-hunk proof searches all removed lines while unrelated edits stay suspected', (t) => {
  const f = fixture(t);
  f.write('file.txt', `// original ${dash}\n// other original\n`);
  f.commit();
  f.capture();
  f.write('file.txt', `// edited ${image}\n// original ${image}\n`);
  const report = f.finish();
  assert.deepEqual(report.proven, [{ path: 'file.txt', line: 2, text: `// original ${image}` }]);
  assert.deepEqual(report.suspected, [{
    path: 'file.txt', line: 1, kind: 'candidate', index: 10, text: image, repaired: dash,
  }]);
});

test('a matching original in a different hunk cannot prove a candidate', (t) => {
  const f = fixture(t);
  f.write('file.txt', `// original ${dash}\nkeep a\nkeep b\n// other\n`);
  f.commit();
  f.capture();
  f.write('file.txt', `// legitimate edit\nkeep a\nkeep b\n// original ${image}\n`);
  const report = f.finish();
  assert.deepEqual(report.proven, []);
  assert.equal(report.suspected[0].kind, 'candidate');
  assert.equal(report.suspected[0].line, 4);
});

test('literal replacement characters are suspected separately even on a proven line', (t) => {
  const f = fixture(t);
  f.write('file.txt', `// ${dash} \ufffd\n`);
  f.commit();
  f.capture();
  f.write('file.txt', `// ${image} \ufffd\n`);
  const report = f.finish();
  assert.equal(report.counts.proven, 1);
  assert.deepEqual(report.suspected, [{ path: 'file.txt', line: 1, kind: 'replacement-char', index: 7 }]);
});

for (const newFile of [false, true]) {
  test(`malformed UTF-8 is suspected by byte offset and skips line findings (new=${newFile})`, (t) => {
    const f = fixture(t);
    f.capture();
    f.write(newFile ? 'fresh.txt' : 'file.txt', Buffer.concat([
      Buffer.from(`${image}\n\ufffd\n`), Buffer.from([0xff]),
    ]));
    const report = f.finish();
    assert.deepEqual(report.proven, []);
    assert.deepEqual(report.suspected, [{
      path: newFile ? 'fresh.txt' : 'file.txt', kind: 'malformed-utf8',
      byteOffset: Buffer.byteLength(`${image}\n\ufffd\n`),
    }]);
  });
}

test('already malformed dirty-start content does not accuse the run of malformed end bytes', (t) => {
  const f = fixture(t);
  f.write('file.txt', Buffer.from([0xff, 0x0a]));
  f.capture();
  f.write('file.txt', Buffer.from([0xff, 0x0a, 0xfe]));
  empty(f.finish());
});

test('blind repeat reports a dirty-start candidate absent from the start commit as inherited', (t) => {
  const f = fixture(t);
  f.write('file.txt', `// ${dash}\n`);
  f.commit();
  f.write('file.txt', `// ${image}\r\n`);
  f.capture();
  const report = f.finish();
  assert.deepEqual(report.proven, []);
  assert.deepEqual(report.suspected, [{
    path: 'file.txt', line: 1, kind: 'inherited', index: 3, text: image, repaired: dash,
  }]);
});

test('committed candidates are not inherited when their dirty-start line positions change', (t) => {
  const f = fixture(t);
  f.write('file.txt', `${image}\n`);
  f.commit();
  f.write('file.txt', `prefix\n${image}\n`);
  f.capture();
  empty(f.finish());
});

test('extra dirty-start occurrences and earlier untracked copies remain inherited', (t) => {
  const f = fixture(t);
  f.write('file.txt', `${image}\n`);
  f.commit();
  f.write('file.txt', `${image}\n${image}\n`);
  f.write('earlier.txt', `${image}\n`);
  f.capture();
  const report = f.finish();
  assert.deepEqual(report.suspected.map(({ path, line, kind }) => ({ path, line, kind })), [
    { path: 'earlier.txt', line: 1, kind: 'inherited' },
    { path: 'file.txt', line: 2, kind: 'inherited' },
  ]);
});

test('caps apply across files, preserve true counts and still record later coverage gaps', (t) => {
  const f = fixture(t);
  for (const name of ['a.txt', 'b.txt']) f.write(name, (`// ${dash}\n`).repeat(30));
  f.commit();
  f.capture({ perFileBytes: 2000, perRunBytes: 4000 });
  for (const name of ['a.txt', 'b.txt']) f.write(name, (`// ${image}\n`).repeat(30));
  for (const name of ['c.txt', 'd.txt']) f.write(name, `${image}\n`.repeat(30));
  f.write('z.txt', 'x'.repeat(2001));
  const report = f.finish();
  assert.equal(report.proven.length, 50);
  assert.equal(report.suspected.length, 50);
  assert.deepEqual(report.counts, { proven: 60, suspected: 60 });
  assert.equal(report.truncated, true);
  assert.deepEqual(report.coverage, { complete: false, gaps: ['z.txt: end content over the limit'] });
  assert.deepEqual(f.read('flags-coverage.txt'), Buffer.from('z.txt: end content over the limit\n'));
});

test('per-file inherited cap preserves its true count', (t) => {
  const f = fixture(t);
  f.write('file.txt', `${image}\n`.repeat(60));
  f.capture();
  const report = f.finish();
  assert.equal(report.suspected.length, 50);
  assert.equal(report.counts.suspected, 60);
  assert.equal(report.truncated, true);
  assert.ok(report.suspected.every((finding) => finding.kind === 'inherited'));
});

test('flags artifacts retain their bytes when encoding classification fails and scanning continues', (t) => {
  const f = fixture(t);
  f.write('file.txt', 'dirty\n');
  f.capture();
  f.write('file.txt', 'dirty\r\n// TODO: marker\r\n');
  f.write('fresh.txt', `${image}\n`);
  const original = childProcess.spawnSync;
  const mocked = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (args.includes('show') && args.some((arg) => arg.endsWith(':file.txt'))) throw new Error('encoding fault');
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const report = f.finish();
  assert.deepEqual(f.read('flags.txt'), Buffer.from('file.txt:2: // TODO: marker\n'));
  assert.deepEqual(f.read('flags-coverage.txt'), Buffer.alloc(0));
  assert.deepEqual(report.coverage, { complete: false, gaps: ['file.txt: encoding classification failed'] });
  assert.equal(report.suspected[0].path, 'fresh.txt');
});

for (const mode of ['missing baseline', 'non-git baseline', 'incomparable snapshots', 'unknown start bytes']) {
  test(`${mode} produces empty encoding evidence and explicit incomplete coverage`, (t) => {
    const f = fixture(t);
    if (mode === 'non-git baseline') captureFlagBaseline({ runDir: f.runDir, repoRoot: f.repoRoot, isGitRepo: false });
    if (mode === 'incomparable snapshots') {
      f.write('file.txt', `dirty ${image}\n`);
      f.capture();
      fs.writeFileSync(path.join(f.runDir, 'state-before.txt'), 'not a snapshot\n');
    }
    if (mode === 'unknown start bytes') {
      f.write('file.txt', 'dirty\n');
      f.capture();
      const manifest = JSON.parse(f.read(FLAG_BASELINE_MANIFEST));
      manifest.files[0].state = 'truncated';
      fs.writeFileSync(path.join(f.runDir, FLAG_BASELINE_MANIFEST), JSON.stringify(manifest));
    }
    f.write('file.txt', `${image}\n// TODO: added\n`);
    const report = f.finish();
    empty(report, false);
    assert.ok(report.coverage.gaps.length > 0);
    assert.deepEqual(report.coverage.gaps, f.read('flags-coverage.txt').toString().trim().split('\n'));
  });
}

test('a newly added literal replacement character is advisory without tier A proof', (t) => {
  const f = fixture(t);
  f.capture();
  f.write('file.txt', 'start\nnew \ufffd\n');
  const report = f.finish();
  assert.deepEqual(report.proven, []);
  assert.deepEqual(report.suspected, [{ path: 'file.txt', line: 2, kind: 'replacement-char', index: 4 }]);
});

test('unchanged committed candidate typography beside a new line is not scanned', (t) => {
  const f = fixture(t);
  const text = 'French typography: \u00c9\u00bb\n';
  f.write('file.txt', text);
  f.commit();
  f.capture();
  f.write('file.txt', text + 'new ordinary line\n');
  empty(f.finish());
});

test('arbiter typography counterexamples are tier B, never proof', (t) => {
  const f = fixture(t);
  f.capture();
  f.write('fresh.txt', '\u00df\u201c\n\u00df\u2026\n\u00c9\u00bb\n\u00d3\u00bb\n\u00c3\u00bb\n');
  const report = f.finish();
  assert.deepEqual(report.proven, []);
  assert.equal(report.counts.suspected, 5);
  assert.ok(report.suspected.every(({ kind }) => kind === 'candidate'));
});

test('one-file proof and candidate caps preserve all counts independently', (t) => {
  const f = fixture(t);
  f.write('file.txt', (`// ${dash}\n`).repeat(60));
  f.commit();
  f.capture();
  f.write('file.txt', (`// ${image}\n`).repeat(60));
  f.write('fresh.txt', `${image}\n`.repeat(60));
  const report = f.finish();
  assert.deepEqual(report.counts, { proven: 60, suspected: 60 });
  assert.equal(report.proven.length, 50);
  assert.equal(report.suspected.length, 50);
  assert.equal(report.truncated, true);
});

test('trailing spaces remain significant for proof while missing final newlines do not hide it', (t) => {
  const f = fixture(t);
  f.write('file.txt', `// ${dash}`);
  f.write('spaces.txt', `// ${dash} `);
  f.commit();
  f.capture();
  f.write('file.txt', `// ${image}`);
  f.write('spaces.txt', `// ${image}`);
  const report = f.finish();
  assert.deepEqual(report.proven, [{ path: 'file.txt', line: 1, text: `// ${image}` }]);
  assert.equal(report.suspected[0].path, 'spaces.txt');
  assert.equal(report.suspected[0].kind, 'candidate');
});
