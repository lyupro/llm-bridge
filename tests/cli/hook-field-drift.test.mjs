/** R2: report operator-owned hook fields without restoring package values. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { hookChecks } from '../../cli/doctor-hooks.mjs';
import { HOOK_DEFINITIONS, readInstallRecord } from '../../cli/manifest.mjs';
import { declaredHook } from '../../cli/settings-declarations.mjs';
import { inspectHook, mergeHook, shortCommandFor } from '../../cli/settings-merge.mjs';
import { launcherEnv } from './launcher-shim.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function fixture(t) {
  const root = makeTempTree('bridge-hook-field-drift-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'home'),
  });
  // R2's Windows fixture must drop Path as well as PATH before choosing its launcher.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|pathext)$/i.test(key))),
    HOME: path.join(root, 'user-home'),
    USERPROFILE: path.join(root, 'user-home'),
    ...launcherEnv(t, host.brandRoot),
  };
  return { root, host, env };
}

function specFor(definition) {
  return { event: definition.event, matcher: definition.matcher, command: shortCommandFor(definition.name) };
}

function entryFor(settings, definition) {
  return settings.hooks[definition.event]
    .find((group) => group.matcher === definition.matcher).hooks
    .find((hook) => hook.command === shortCommandFor(definition.name));
}

async function snapshot(root) {
  const entries = [];
  async function visit(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const target = path.join(directory, name);
      const stat = await fs.stat(target);
      entries.push([path.relative(root, target), stat.mtimeMs,
        stat.isDirectory() ? null : (await fs.readFile(target)).toString('base64')]);
      if (stat.isDirectory()) await visit(target);
    }
  }
  await visit(root);
  return entries;
}

function editLines(output) {
  return output.split('\n').filter((line) => line.startsWith('Kept your edit to the '));
}

const launcher = () => ({ ok: true });

test('install, dry run and doctor name precisely three preserved hook edits', async (t) => {
  const { root, host, env } = fixture(t);
  assert.equal((await install({ host, env })).exitCode, 0);
  const record = await readInstallRecord(host);
  const baseline = await hookChecks(host, record, launcher);
  assert.ok(baseline.every((row) => row.status === 'ok'), JSON.stringify(baseline));
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  const edited = HOOK_DEFINITIONS.slice(0, 3);
  entryFor(settings, edited[0]).timeout = 30;
  entryFor(settings, edited[1]).async = true;
  delete entryFor(settings, edited[2]).timeout;
  const bytes = Buffer.from(JSON.stringify(settings, null, 4) + '\n');
  await fs.writeFile(host.settingsPath, bytes);
  const packageValue = declaredHook('').timeout;
  const drifts = [
    [{ field: 'timeout', actual: 30, packageValue }],
    [{ field: 'async', actual: true, packageValue: undefined }],
    [{ field: 'timeout', actual: undefined, packageValue }],
  ];
  const wording = [
    `timeout is 30, the package sets ${JSON.stringify(packageValue)}`,
    'async is true, the package does not set it',
    `timeout is absent, the package sets ${JSON.stringify(packageValue)}`,
  ];
  const expectedLines = edited.map((definition, index) =>
    `Kept your edit to the ${definition.event} hook ${definition.name}: ${wording[index]}.`);
  for (const [index, definition] of HOOK_DEFINITIONS.entries()) {
    const state = await inspectHook(host.settingsPath, specFor(definition));
    assert.deepEqual(state.fieldDrift, drifts[index] || []);
    assert.equal(state.current, true);
  }
  const again = await install({ host, env });
  assert.equal(again.exitCode, 0);
  assert.deepEqual(editLines(again.output), expectedLines);
  assert.deepEqual(await fs.readFile(host.settingsPath), bytes);
  const beforeDryRun = await snapshot(root);
  const dryRun = await install({ host, env, dryRun: true });
  assert.equal(dryRun.exitCode, 0);
  assert.deepEqual(editLines(dryRun.output), expectedLines);
  assert.deepEqual(await snapshot(root), beforeDryRun);
  const checks = await hookChecks(host, record, launcher);
  assert.deepEqual(checks.map((row) => row.status), baseline.map((row) => row.status));
  for (const [index, row] of checks.entries()) {
    const line = JSON.stringify(row);
    if (index < edited.length) assert.ok(line.includes(`; your edit kept: ${wording[index]}`), line);
    else assert.doesNotMatch(line, /your edit kept:/);
  }
  assert.equal(checks.filter((row) => JSON.stringify(row).includes('; your edit kept:')).length, 3);
  // Exercise the writing branch too: --force restores a package file changed by this fixture.
  const installedFile = path.join(host.brandHooksDir, HOOK_DEFINITIONS[0].file);
  await fs.writeFile(installedFile, '// changed fixture copy\n');
  const forcedDryBefore = await snapshot(root);
  const forcedDry = await install({ host, env, force: true, dryRun: true });
  assert.equal(forcedDry.exitCode, 0);
  assert.deepEqual(editLines(forcedDry.output), expectedLines);
  assert.deepEqual(await snapshot(root), forcedDryBefore);
  const forced = await install({ host, env, force: true });
  assert.equal(forced.exitCode, 0);
  assert.deepEqual(editLines(forced.output), expectedLines);
  assert.deepEqual(await fs.readFile(host.settingsPath), bytes);
});

test('an unedited host reports no field edits in any install or doctor branch', async (t) => {
  const { host, env } = fixture(t);
  assert.deepEqual((await inspectHook(host.settingsPath, specFor(HOOK_DEFINITIONS[0]))).fieldDrift, []);
  for (const options of [{ dryRun: true }, {}, {}, { dryRun: true }]) {
    const result = await install({ host, env, ...options });
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.output, /Kept your edit|your edit kept:/);
  }
  const checks = await hookChecks(host, await readInstallRecord(host), launcher);
  assert.doesNotMatch(JSON.stringify(checks), /your edit kept:/);
});

test('multiple fields use JSON values on one line per hook', async (t) => {
  const { host, env } = fixture(t);
  assert.equal((await install({ host, env })).exitCode, 0);
  const definition = HOOK_DEFINITIONS[0];
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  const hook = entryFor(settings, definition);
  hook.timeout = 30;
  hook.async = true;
  hook.label = 'operator "choice"';
  hook.extra = { enabled: false, values: [1, null] };
  hook.toString = 'operator field';
  await fs.writeFile(host.settingsPath, JSON.stringify(settings) + '\n');
  const wording = `timeout is 30, the package sets ${JSON.stringify(declaredHook('').timeout)}; async is true, the package does not set it; label is ${JSON.stringify(hook.label)}, the package does not set it; extra is ${JSON.stringify(hook.extra)}, the package does not set it; toString is ${JSON.stringify(hook.toString)}, the package does not set it`;
  const expected = `Kept your edit to the ${definition.event} hook ${definition.name}: ${wording}.`;
  for (const options of [{}, { dryRun: true }]) {
    const result = await install({ host, env, ...options });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(editLines(result.output), [expected]);
  }
  const checks = await hookChecks(host, await readInstallRecord(host), launcher);
  assert.ok(JSON.stringify(checks[0]).includes(JSON.stringify(`; your edit kept: ${wording}`).slice(1, -1)));
});

test('inspection and merge choose the same survivor without treating command form as drift', async (t) => {
  const { host } = fixture(t);
  await fs.mkdir(host.root, { recursive: true });
  const spec = { event: 'PreToolUse', matcher: 'declared', command: 'selected', alternateCommands: ['old'] };
  const cases = [
    { matchers: ['stale', 'declared', 'stale-again'], survivor: 1 },
    { matchers: ['stale', 'stale-again'], survivor: 1 },
    { matchers: ['declared', 'stale', 'declared'], survivor: 2 },
  ];
  for (const { matchers, survivor } of cases) {
    const hooks = matchers.map((matcher, index) => ({ matcher, hooks: [
      { ...declaredHook('old'), timeout: 30 + index },
      { ...declaredHook('old'), timeout: 80 + index },
    ] }));
    await fs.writeFile(host.settingsPath, JSON.stringify({ hooks: { [spec.event]: hooks } }));
    const state = await inspectHook(host.settingsPath, spec);
    assert.equal(state.requiresRewrite, true);
    assert.deepEqual(state.fieldDrift, [
      { field: 'timeout', actual: 30 + survivor, packageValue: declaredHook('old').timeout },
    ]);
    assert.equal((await mergeHook(host.settingsPath, spec)).changed, true);
    const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
    assert.deepEqual(settings.hooks[spec.event], [
      { matcher: spec.matcher, hooks: [{ ...declaredHook(spec.command), timeout: 30 + survivor }] },
    ]);
  }
  await fs.writeFile(host.settingsPath, JSON.stringify({ hooks: { [spec.event]: [
    { matcher: spec.matcher, hooks: [declaredHook('old')] },
  ] } }));
  const state = await inspectHook(host.settingsPath, spec);
  assert.equal(state.requiresRewrite, true);
  assert.deepEqual(state.fieldDrift, []);
});
