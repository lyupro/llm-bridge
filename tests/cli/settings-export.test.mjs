/** Checks OW-081 declarations against real installs without reading live operator settings. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { main } from '../../bin/llm-bridge.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { HOOK_DEFINITIONS, packageInfo } from '../../cli/manifest.mjs';
import { hookTargets } from '../../cli/hook-targets.mjs';
import { PERMISSION_RULES } from '../../cli/settings-declarations.mjs';
import { resolveBrandHome } from '../../src/home/lib/brand-home.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { launcherEnv } from './launcher-shim.mjs';

async function withEnv(env, run) {
  const previous = process.env;
  process.env = { ...env };
  try {
    return await run();
  } finally {
    process.env = previous;
  }
}

async function invoke(argv, env) {
  const stdout = [];
  const stderr = [];
  const exitCode = await withEnv(env, () => main(argv, {
    log: (value) => stdout.push(value),
    error: (value) => stderr.push(value),
  }));
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

async function snapshot(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      if (entry.isDirectory()) {
        entries.push({ path: relative, directory: true });
        await visit(target);
      } else {
        const stat = await fs.stat(target);
        entries.push({
          path: relative,
          size: stat.size,
          modified: stat.mtimeMs,
          hash: createHash('sha256').update(await fs.readFile(target)).digest('hex'),
        });
      }
    }
  }
  await visit(root);
  return entries;
}

async function installedFixture(t, proven) {
  const root = makeTempTree('settings-export-');
  t.after(() => removeTempTree(root));
  const home = path.join(root, 'home');
  const env = {
    // OW-081: Windows PATH aliases must not shadow either fixture's launcher path.
    ...Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(path|pathext)$/i.test(key))),
    LLM_BRIDGE_HOME: home,
    CODEX_HOME: path.join(root, 'codex-home'),
    ...(proven ? launcherEnv(t, home) : { PATH: path.join(root, 'empty-path') }),
  };
  const host = await withEnv(env, () => resolveHost({ host: path.join(root, 'host') }));
  const installed = await withEnv(env, () => install({ host, env }));
  assert.equal(installed.exitCode, 0, installed.output);
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  return { root, home, host, env, settings };
}

function compareInstalled(document, fixture, proven) {
  const { host, home, settings, env } = fixture;
  assert.deepEqual(Object.keys(document), [
    'schema', 'package', 'version', 'platform', 'host', 'home', 'launcher',
    'recognizedCommands', 'permissions', 'hooks', 'retired',
  ]);
  assert.equal(document.schema, 1);
  assert.equal(document.platform, process.platform);
  assert.deepEqual(document.host, { root: host.root, scope: host.scope });
  assert.deepEqual(document.home, { root: home, source: 'LLM_BRIDGE_HOME' });
  assert.deepEqual(Object.keys(document.launcher), ['proven', 'reason', 'form']);
  assert.equal(document.launcher.proven, proven);
  assert.equal(document.launcher.form, proven ? 'short' : 'path');
  const targets = hookTargets(host, env);
  assert.equal(document.launcher.reason, targets[0].registration.reason);
  assert.deepEqual(document.permissions, PERMISSION_RULES);
  for (const group of ['allow', 'deny', 'ask']) {
    for (const rule of document.permissions[group]) {
      assert.ok(settings.permissions[group].includes(rule), `${group}: ${rule}`);
    }
  }
  const commands = [...new Set(PERMISSION_RULES.allow
    .map((rule) => rule.slice(rule.indexOf('(') + 1, -1).replace(/:\*$/, '')))];
  assert.deepEqual(document.recognizedCommands, commands);
  assert.deepEqual(document.hooks.map((entry) => entry.id), HOOK_DEFINITIONS.map((entry) => entry.name));
  const groups = new Map();
  for (const [index, entry] of document.hooks.entries()) {
    assert.deepEqual(Object.keys(entry), ['id', 'event', 'matcher', 'hook', 'alternateCommands']);
    assert.equal(entry.event, HOOK_DEFINITIONS[index].event);
    assert.equal(entry.matcher, HOOK_DEFINITIONS[index].matcher);
    assert.deepEqual(entry.alternateCommands, targets[index].spec.alternateCommands);
    assert.notEqual(entry.alternateCommands[0], entry.hook.command);
    assert.match(entry.hook.command, proven ? /^llm-bridge hook / : /^node "/);
    const key = JSON.stringify([entry.event, entry.matcher]);
    if (!groups.has(key)) groups.set(key, { event: entry.event, matcher: entry.matcher, hooks: [] });
    groups.get(key).hooks.push(entry.hook);
  }
  for (const { event, matcher, hooks } of groups.values()) {
    const written = settings.hooks[event].filter((group) => group.matcher === matcher)
      .flatMap((group) => group.hooks);
    assert.deepEqual(written, hooks, `${event}/${matcher}: hook payloads and order`);
  }
  assert.deepEqual(document.retired.entries, []);
  assert.match(document.retired.boundary, /predecessor package.*own uninstall.*not listed here/);
}

for (const proven of [false, true]) {
  test(`settings export matches an install with ${proven ? 'proven launcher' : 'no launcher'}`, async (t) => {
    const fixture = await installedFixture(t, proven);
    const before = await snapshot(fixture.root);
    for (const platformArgs of [[], ['--platform', process.platform]]) {
      const result = await invoke(['settings', 'export', '--host', fixture.host.root, ...platformArgs], fixture.env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stderr, '');
      const document = JSON.parse(result.stdout);
      assert.equal(result.stdout, JSON.stringify(document, null, 2));
      const info = await packageInfo();
      assert.equal(document.package, info.name);
      const version = await invoke(['--version'], fixture.env);
      assert.equal(document.version, version.stdout);
      compareInstalled(document, fixture, proven);
    }
    assert.deepEqual(await snapshot(fixture.root), before);
  });
}

test('foreign and invalid platforms print no JSON and leave the installation untouched', async (t) => {
  const fixture = await installedFixture(t, false);
  const before = await snapshot(fixture.root);
  const bytes = await fs.readFile(fixture.host.settingsPath);
  const foreign = process.platform === 'win32' ? 'linux' : 'win32';
  const result = await invoke([
    'settings', 'export', '--host', fixture.host.root, '--platform', foreign,
  ], fixture.env);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /this host.*home and launcher.*target host/);
  assert.equal(result.stderr.split('\n').length, 1);
  const invalid = await invoke([
    'settings', 'export', '--host', fixture.host.root, '--platform', 'macos',
  ], fixture.env);
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /win32.*linux/);
  assert.deepEqual(await fs.readFile(fixture.host.settingsPath), bytes);
  assert.deepEqual(await snapshot(fixture.root), before);
});

test('export ignores malformed settings and neither creates nor repairs files', async (t) => {
  const fixture = await installedFixture(t, false);
  await fs.writeFile(fixture.host.settingsPath, 'not valid settings JSON\n');
  const before = await snapshot(fixture.root);
  const result = await invoke(['settings', 'export', '--host', fixture.host.root], fixture.env);
  assert.equal(result.exitCode, 0, result.stderr);
  compareInstalled(JSON.parse(result.stdout), fixture, false);
  assert.deepEqual(await snapshot(fixture.root), before);
  const absent = path.join(fixture.root, 'absent-host');
  const absentHome = path.join(fixture.root, 'absent-home');
  const empty = await invoke(['settings', 'export', '--host', absent], {
    ...fixture.env, LLM_BRIDGE_HOME: absentHome,
  });
  assert.equal(empty.exitCode, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).home.root, absentHome);
  assert.deepEqual(await snapshot(fixture.root), before);
});

test('settings help and host scopes use the public command family', async (t) => {
  const fixture = await installedFixture(t, false);
  const before = await snapshot(fixture.root);
  for (const argv of [['settings'], ['settings', '--help'], ['settings', 'export', '--help']]) {
    const help = await invoke(argv, fixture.env);
    assert.equal(help.exitCode, 0, help.stderr);
    assert.match(help.stdout, /settings export/);
    assert.match(help.stdout, /--platform win32\|linux/);
  }
  for (const scope of ['user', 'project']) {
    const result = await invoke(['settings', 'export', '--scope', scope], fixture.env);
    assert.equal(result.exitCode, 0, result.stderr);
    const expected = await withEnv(fixture.env, () => resolveHost({ scope }));
    assert.deepEqual(JSON.parse(result.stdout).host, { root: expected.root, scope: expected.scope });
  }
  assert.equal(resolveBrandHome({ env: {} }).source, 'default');
  assert.deepEqual(await snapshot(fixture.root), before);
});
