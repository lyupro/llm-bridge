/**
 * Inspects what the package left in one host and which of it may be deleted, without changing
 * anything (Plan_65 D10 items 1 and 3).
 *
 * What lies in a host is read from the package's marks there, not from the home record: a format-1
 * record never named its host. Deletion needs content evidence — the host's own recorded
 * fingerprint or the current package's bytes — because uninstall used to delete recorded files
 * without comparing anything, and an operator-edited agent file was lost with them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildInstallPlan,
  contentFingerprint,
} from './manifest.mjs';
import { plannedContent } from './copy.mjs';
import { findOwnHooks } from './hook-recognizer.mjs';
import { readSettings } from './settings-merge.mjs';
import { inspectPermissions } from './permissions.mjs';

const SEED_NAMES = new Set(['config.json', 'conventions.md']);
const posix = (value) => value.split(path.sep).join('/');

function result(context, target, disposition, reason) {
  const relativeToHost = posix(path.relative(context.host.root, target));
  return { target, relativeToHost, disposition, reason };
}

const unreadable = (context, target, error) => result(context, target, 'keep', `unreadable: ${error.code ?? 'UNKNOWN'}`);

async function judgeFile(context, target, item) {
  const { host, owner } = context;
  let bytes;
  try {
    bytes = await fs.readFile(target);
  } catch (error) {
    return unreadable(context, target, error);
  }
  const relative = posix(path.relative(host.root, target));
  const recorded = owner?.fingerprints?.claude?.[relative];
  if (typeof recorded === 'string' && contentFingerprint(bytes) === recorded) {
    return result(context, target, 'remove', "matches this host's record");
  }
  if (item && bytes.equals(await plannedContent(item, host.brandRoot))) {
    return result(context, target, 'remove', 'matches the package');
  }
  return result(context, target, 'keep', item ? 'changed' : 'unknown');
}

// Links are never followed (Plan_65 D4): a junction inside a package folder points somewhere else.
async function lstatOrReport(context, target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code !== 'ENOENT') context.files.push(unreadable(context, target, error));
    return null;
  }
}

async function walk(context, target) {
  const stat = await lstatOrReport(context, target);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    context.files.push(result(context, target, 'keep', 'link'));
    return;
  }
  if (stat.isDirectory()) {
    let entries;
    try {
      entries = await fs.readdir(target);
    } catch (error) {
      context.files.push(unreadable(context, target, error));
      return;
    }
    for (const entry of entries) await walk(context, path.join(target, entry));
    return;
  }
  const { host, planByTarget } = context;
  if (SEED_NAMES.has(path.basename(target)) && [host.agentsDir, host.commandsDir].includes(path.dirname(target))) {
    context.files.push(result(context, target, 'keep', 'seed'));
    return;
  }
  context.files.push(await judgeFile(context, target, planByTarget.get(path.resolve(target))));
}

async function inspectSettings(host) {
  try {
    const state = await readSettings(host.settingsPath);
    return { hooks: state.exists ? findOwnHooks(state.settings, host) : [], settingsError: null };
  } catch (error) {
    return { hooks: [], settingsError: error.message };
  }
}

// Own permission strings are reported, not counted as an installation: `codex-bridge permissions
// add` sets them alone. An unparseable settings file is already named by settingsError.
async function inspectOwnPermissions(host) {
  try {
    return { present: (await inspectPermissions(host.settingsPath)).present };
  } catch {
    return { present: null };
  }
}

export async function inspectHost(host, { owner = null, packageRoot } = {}) {
  const plan = await buildInstallPlan(host, packageRoot);
  const context = {
    host,
    owner,
    planByTarget: new Map(plan.map((item) => [path.resolve(item.target), item])),
    files: [],
  };
  await walk(context, host.agentsDir);
  await walk(context, host.commandsDir);
  await walk(context, host.rulesDir);
  const files = context.files.sort((a, b) => a.relativeToHost.localeCompare(b.relativeToHost));
  return { files, ...(await inspectSettings(host)), permissions: await inspectOwnPermissions(host) };
}

export function hasPackageMarks(inspection) {
  return inspection.files.length > 0 || inspection.hooks.length > 0;
}
