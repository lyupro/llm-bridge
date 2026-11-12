import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { discoverVsCodeExecutable } from '../../scripts/release-check/vscode-discovery.mjs';

function fixture(platform = 'linux', arch = 'x64') {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? 'C:\\Users\\operator' : '/home/operator';
  const root = paths.join(home, '.vscode', 'extensions');
  const nodes = new Map();
  const calls = [];
  const missing = (file) => Object.assign(new Error(`Missing: ${file}`), { code: 'ENOENT' });
  const put = (file, node) => { nodes.set(paths.normalize(file), node); return file; };
  const directory = (file) => put(file, { type: 'directory' });
  const json = (file, value) => put(file, { type: 'file', text: JSON.stringify(value) });
  const canonical = (file) => {
    let resolved = paths.normalize(file);
    for (const [alias, node] of nodes) {
      if (node.type === 'link' && (resolved === alias || resolved.startsWith(`${alias}${paths.sep}`))) {
        resolved = node.target + resolved.slice(alias.length);
      }
    }
    const node = nodes.get(resolved);
    if (!node) throw missing(resolved);
    if (node.statError) throw node.statError;
    return resolved;
  };
  const makeRoot = (dir = root, entries = []) => {
    directory(dir);
    json(paths.join(dir, 'extensions.json'), entries);
    return dir;
  };
  const candidate = (dir = root, version = '2.1.322', overrides = {}) => {
    if (!nodes.has(dir)) makeRoot(dir);
    const entry = { identifier: { id: 'anthropic.claude-code', uuid: 'fixture' }, version,
      relativeLocation: `anthropic.claude-code-${version}-${platform}-${arch}`,
      metadata: { targetPlatform: `${platform}-${arch}` }, ...overrides };
    const folder = paths.join(dir, entry.relativeLocation);
    const executable = paths.join(folder, 'resources', 'native-binary', platform === 'win32' ? 'claude.exe' : 'claude');
    directory(folder);
    put(executable, { type: 'file', text: '' });
    const registry = paths.join(dir, 'extensions.json');
    json(registry, [...JSON.parse(nodes.get(registry).text), entry]);
    return { entry, folder, executable };
  };
  const input = {
    env: platform === 'win32' ? { USERPROFILE: home } : { HOME: home }, platform, arch,
    homedir: () => assert.fail('The supplied environment owns the home directory'),
    cwd: () => home,
    realpath: (file) => { calls.push(['realpath', file]); return canonical(file); },
    stat: (file) => {
      calls.push(['stat', file]);
      const node = nodes.get(canonical(file));
      return { isDirectory: () => node.type === 'directory', isFile: () => node.type === 'file' };
    },
    readFile: (file) => {
      calls.push(['readFile', file]);
      const node = nodes.get(canonical(file));
      if (node.readError) throw node.readError;
      return node.text;
    },
  };
  return { paths, home, root, nodes, calls, put, directory, json, makeRoot, candidate, input,
    run: (overrides = {}) => discoverVsCodeExecutable({ ...input, ...overrides }) };
}

function assertError(result, pattern) {
  assert.equal(result.executable, undefined);
  assert.match(result.error, pattern);
  assert.match(result.error, /--vscode-executable/);
  assert.match(result.error, /--extensions-dir/);
  assert.equal(result.selection.source, 'discovery');
  assert.equal(result.selection.root, null);
}

test('one registry-backed entry produces a complete selection record', () => {
  const f = fixture();
  const candidate = f.candidate();
  const result = f.run({ extensionsDir: f.root });
  assert.equal(result.executable, candidate.executable);
  assert.deepEqual(result.selection, {
    source: 'discovery', roots: [{ path: f.root, source: 'flag', canonicalPath: f.root,
      status: 'consulted', reason: 'Claude registry entries inspected.' }],
    root: f.root, folder: candidate.folder, version: '2.1.322', targetPlatform: 'linux-x64',
    reason: 'Exactly one registered, platform-matching candidate and no uncertain roots.',
    candidates: [{ executable: candidate.executable, root: f.root, folder: candidate.folder,
      version: '2.1.322', targetPlatform: 'linux-x64' }], rejected: [], uncertainRoots: [],
  });
});

test('all six supported platform/architecture pairs use their native binary name', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const arch of ['x64', 'arm64']) {
      const f = fixture(platform, arch);
      const candidate = f.candidate();
      const result = f.run();
      assert.equal(result.executable, candidate.executable);
      assert.equal(result.selection.targetPlatform, `${platform}-${arch}`);
      assert.ok(result.executable.endsWith(platform === 'win32' ? 'claude.exe' : '/claude'));
    }
  }
});

test('rejects wrong platform, missing version and unsafe or mismatched relativeLocation with reasons', () => {
  const cases = [
    [{ metadata: { targetPlatform: 'darwin-arm64' } }, /target platform/],
    [{ metadata: {} }, /target platform/],
    [{ version: '' }, /version/], [{ version: '   ' }, /version/], [{ version: 123 }, /version/],
    [{ relativeLocation: '../outside' }, /relativeLocation/],
    [{ relativeLocation: 'nested/folder' }, /relativeLocation/],
    [{ relativeLocation: 'nested\\folder' }, /relativeLocation/],
    [{ relativeLocation: '..' }, /relativeLocation/],
    [{ relativeLocation: 'anthropic.claude-code-wrong-linux-x64' }, /relativeLocation/],
  ];
  for (const [overrides, reason] of cases) {
    const f = fixture();
    f.candidate(f.root, '2.1.322', overrides);
    const result = f.run();
    assertError(result, /found 0/);
    assert.match(result.selection.rejected[0].reason, reason);
  }
});

test('wrong IDs are ignored even when their folder and location resemble Claude', () => {
  const f = fixture();
  f.candidate(f.root, '2.1.322', { identifier: { id: 'other.extension' } });
  const result = f.run();
  assertError(result, /found 0/);
  assert.match(result.selection.roots[0].reason, /No anthropic\.claude-code entries/);
  assert.deepEqual(result.selection.rejected, []);
});

test('case-insensitive IDs work and location cannot redirect the authoritative relativeLocation', () => {
  const f = fixture();
  const candidate = f.candidate(f.root, '2.1.322', { identifier: { id: 'ANTHROPIC.CLAUDE-CODE' },
    location: { scheme: 'file', path: '/outside/untrusted' } });
  assert.equal(f.run().executable, candidate.executable);
});

test('canonical containment rejects folder and binary symlinks that escape their boundary', () => {
  for (const escape of ['folder', 'binary']) {
    const f = fixture();
    const candidate = f.candidate();
    const outside = `${f.home}/outside`;
    if (escape === 'folder') {
      f.directory(outside);
      f.put(candidate.folder, { type: 'link', target: outside });
    } else {
      f.put(outside, { type: 'file', text: '' });
      f.put(candidate.executable, { type: 'link', target: outside });
    }
    const result = f.run();
    assertError(result, /found 0/);
    assert.match(result.selection.rejected[0].reason, /outside/);
  }
});

test('missing folders, missing binaries and non-regular binaries are rejected with reasons', () => {
  for (const failure of ['folder', 'missing', 'directory']) {
    const f = fixture();
    const candidate = f.candidate();
    if (failure === 'folder') f.nodes.delete(candidate.folder);
    if (failure === 'missing') f.nodes.delete(candidate.executable);
    if (failure === 'directory') f.directory(candidate.executable);
    const result = f.run();
    assertError(result, /found 0/);
    assert.match(result.selection.rejected[0].reason,
      failure === 'folder' ? /extension folder/ : failure === 'missing' ? /Cannot read Claude binary/ : /regular file/);
  }
});

test('only true obsolete keys exclude a folder; missing .obsolete means no exclusions', () => {
  for (const value of [true, false, 'true', null]) {
    const f = fixture();
    const candidate = f.candidate();
    f.json(f.paths.join(f.root, '.obsolete'), { [candidate.entry.relativeLocation]: value });
    const result = f.run();
    if (value === true) {
      assertError(result, /found 0/);
      assert.match(result.selection.rejected[0].reason, /marked true in .obsolete/);
    } else assert.equal(result.executable, candidate.executable);
  }
});

test('two candidates are ambiguous across roots regardless of version, root order or release channel', () => {
  for (const version of ['2.1.322', '9.9.999']) {
    for (const first of ['.vscode', '.vscode-insiders', '.vscode-server', '.vscode-server-insiders']) {
      const f = fixture();
      const one = f.candidate(f.paths.join(f.home, first, 'extensions'));
      const two = f.candidate(f.paths.join(f.home, '.local', 'share', 'code-server', 'extensions'), version);
      const result = f.run();
      assertError(result, /found 2/);
      assert.ok(result.error.includes(one.executable));
      assert.ok(result.error.includes(two.executable));
      assert.equal(result.selection.candidates.length, 2);
    }
  }
});

test('unreadable or malformed registries make a root uncertain even with a valid candidate elsewhere', () => {
  for (const registryName of ['extensions.json', '.obsolete']) {
    for (const value of ['unreadable', 'invalid-json', null, [], 'missing', 123]) {
      if (registryName === 'extensions.json' && Array.isArray(value)) continue;
      if (registryName === '.obsolete' && value === 'missing') continue;
      const f = fixture();
      const candidate = f.candidate();
      const other = f.makeRoot(f.paths.join(f.home, '.vscode-server', 'extensions'));
      const registry = f.paths.join(other, registryName);
      if (value === 'missing') f.nodes.delete(registry);
      else if (value === 'unreadable') f.put(registry, { type: 'file',
        readError: Object.assign(new Error('Access denied'), { code: 'EACCES' }) });
      else if (value === 'invalid-json') f.put(registry, { type: 'file', text: '{broken' });
      else f.json(registry, value);
      const result = f.run();
      assertError(result, /uncertain roots/);
      assert.ok(result.error.includes(candidate.executable));
      assert.equal(result.selection.uncertainRoots[0].root, other);
      assert.ok(result.selection.rejected.some((item) => item.registry === registry));
    }
  }
});

test('existing unregistered folders cannot become candidates; missing defaults are skipped', () => {
  const f = fixture();
  f.candidate();
  f.json(f.paths.join(f.root, 'extensions.json'), []);
  const result = f.run();
  assertError(result, /found 0/);
  assert.equal(result.selection.roots.filter(({ status }) => status === 'missing').length, 4);
  assert.deepEqual(result.selection.uncertainRoots, []);
  assert.equal(result.selection.roots.every(({ source }) => source === 'default'), true);
});

test('missing or unreadable explicit roots are terminal and never consult default roots', () => {
  for (const source of ['flag', 'env']) {
    for (const failure of ['missing', 'unreadable']) {
      const f = fixture();
      f.candidate();
      const override = f.paths.join(f.home, 'override');
      if (failure === 'unreadable') f.put(override, { type: 'directory',
        statError: Object.assign(new Error('Root denied'), { code: 'EACCES' }) });
      const result = f.run(source === 'flag' ? { extensionsDir: override }
        : { env: { ...f.input.env, VSCODE_EXTENSIONS: override } });
      assertError(result, /Cannot read extension root/);
      assert.equal(result.selection.roots.length, 1);
      assert.equal(result.selection.roots[0].source, source === 'flag' ? 'flag' : 'env:VSCODE_EXTENSIONS');
      assert.equal(f.calls.some(([, file]) => file.startsWith(f.root)), false);
    }
  }
});

test('VSCODE_EXTENSIONS is authoritative and extensionsDir beats it', () => {
  const f = fixture();
  const one = f.candidate();
  const override = f.paths.join(f.home, 'override');
  const two = f.candidate(override);
  const env = { ...f.input.env, VSCODE_EXTENSIONS: override };
  const fromEnv = f.run({ env });
  assert.equal(fromEnv.executable, two.executable);
  assert.equal(fromEnv.selection.roots[0].source, 'env:VSCODE_EXTENSIONS');
  assert.equal(fromEnv.selection.roots.length, 1);
  assert.equal(f.run({ env, extensionsDir: f.root }).executable, one.executable);
  assertError(f.run({ env, extensionsDir: '' }), /--extensions-dir must/);
});

test('canonical roots and duplicate registry entries are deduplicated', () => {
  const f = fixture();
  const candidate = f.candidate();
  f.json(f.paths.join(f.root, 'extensions.json'), [candidate.entry, candidate.entry]);
  const alias = f.paths.join(f.home, '.vscode-insiders', 'extensions');
  f.put(alias, { type: 'link', target: f.root });
  const result = f.run();
  assert.equal(result.executable, candidate.executable);
  assert.equal(result.selection.candidates.length, 1);
  assert.equal(result.selection.roots[1].status, 'duplicate');
  assert.equal(f.calls.filter(([operation, file]) => operation === 'readFile'
    && file === f.paths.join(f.root, 'extensions.json')).length, 1);
});

test('XDG data home, homedir fallback, Windows home variables and relative override use injected facts', () => {
  const f = fixture();
  const customData = f.paths.join(f.home, 'data');
  const candidate = f.candidate(f.paths.join(customData, 'code-server', 'extensions'));
  assert.equal(f.run({ env: { HOME: f.home, XDG_DATA_HOME: customData } }).executable, candidate.executable);
  const fallback = fixture();
  const expected = fallback.candidate();
  assert.equal(fallback.run({ env: {}, homedir: () => fallback.home }).executable, expected.executable);
  assert.equal(fallback.run({ extensionsDir: '.vscode/extensions' }).executable, expected.executable);
  const windows = fixture('win32');
  const binary = windows.candidate();
  assert.equal(windows.run({ env: { HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\operator' } }).executable, binary.executable);
  assert.equal(windows.run().selection.roots.length, 4);
});

test('unsupported platforms and architectures fail before any filesystem access', () => {
  for (const [platform, arch] of [['freebsd', 'x64'], ['linux', 'riscv64'], ['win32', 'ia32']]) {
    const f = fixture();
    assertError(f.run({ platform, arch }), /Unsupported/);
    assert.deepEqual(f.calls, []);
  }
});
