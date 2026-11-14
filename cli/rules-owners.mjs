/** Tracks which Claude Code hosts own the shared Codex rules file. */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PACKAGE_NAME } from '../src/home/lib/package-identity.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { readJsonFile } from '../src/home/lib/json-file.mjs';
import { withOutsideFileLock } from '../src/home/lib/file-lock.mjs';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { installRecordPath, RULES_NAME } from './install-record.mjs';
import { readRulesIndex, validateIndex } from './rules-index.mjs';
export { isLockTaken } from '../src/home/lib/file-lock.mjs';

export const RULES_REGISTRY_NAME = `.${PACKAGE_NAME}-rules.json`;
export const RULES_REGISTRY_VERSION = 2;

export function rulesRegistryPath(host) {
  return path.join(host.codexRulesDir, RULES_REGISTRY_NAME);
}

export function normalizedRulesOwner(host) {
  return normalizeRepoPath(host.root);
}

export function rulesPathIdentity(file) {
  // Plan_65 D5 / Plan_83 B3b: lexical identity must not resolve links into different owner keys.
  return normalizedRulesOwner({ root: path.resolve(file) });
}

function normalizeOwners(owners) {
  return [...new Set(owners.map((owner) => normalizeRepoPath(owner)))];
}

function validateRegistry(parsed) {
  // OW-086 / Plan_83 B3b: the reader and writers must accept exactly the same index formats.
  const index = validateIndex(parsed);
  if (parsed.version === 2) {
    // OW-086: unresolved legacy hints must remain visible to callers not yet using record evidence.
    return { version: 2, owners: index.legacy, records: index.records,
      ...(index.retained ? { retained: index.retained } : {}) };
  }
  return { version: 1, owners: normalizeOwners(index.legacy) };
}

async function loadRulesRegistry(host) {
  let parsed;
  try {
    parsed = await readJsonFile(rulesRegistryPath(host));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.cause) {
      throw new Error(`invalid rules ownership registry JSON: ${err.cause.message}`, { cause: err.cause });
    }
    throw err;
  }
  return { raw: parsed, registry: validateRegistry(parsed) };
}

function hasSameOwners(raw, registry) {
  if (registry.version === 2) {
    return raw.version === 2
      && JSON.stringify(raw.retained) === JSON.stringify(registry.retained)
      && ['records', 'legacy'].every((field) => raw[field].length === registry[field].length
        && raw[field].every((value, index) => value === registry[field][index]));
  }
  return raw?.version === registry.version
    && Array.isArray(raw.owners)
    && raw.owners.length === registry.owners.length
    && raw.owners.every((owner, index) => owner === registry.owners[index]);
}

async function writeRulesRegistry(host, registry) {
  const target = rulesRegistryPath(host);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, target);
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
}

function registryLockPath(host) {
  return `${rulesRegistryPath(host)}.lock`;
}

async function withRegistryLock(host, action) {
  const writer = createHomeWriter({ root: host.brandRoot });
  return withOutsideFileLock(writer, registryLockPath(host), action, { description: 'rules ownership registry' });
}

export async function readRulesRegistry(host) {
  return (await loadRulesRegistry(host))?.registry ?? null;
}

export async function addRulesOwner(host) {
  await loadRulesRegistry(host);
  return withRegistryLock(host, async () => {
    // Read after locking so a concurrent installer is merged instead of overwritten.
    const loaded = await loadRulesRegistry(host);
    const owner = normalizedRulesOwner(host);
    const current = loaded ? validateIndex(loaded.raw) : { records: [], legacy: [] };
    const records = [...current.records];
    const recordPath = path.resolve(installRecordPath(host));
    if (!records.some((file) => rulesPathIdentity(file) === rulesPathIdentity(recordPath))) records.push(recordPath);
    // OW-086 / Plan_83 B3b: only this exact host key is now proved by its record; preserve all other hints.
    const registry = {
      version: RULES_REGISTRY_VERSION,
      records,
      legacy: current.legacy.filter((candidate) => candidate !== owner),
    };
    // Plan_83 D8: registration replaces this file's retained evidence with a live owner's baseline.
    const retained = current.retained?.filter((entry) => rulesPathIdentity(entry.path)
      !== rulesPathIdentity(path.join(host.codexRulesDir, RULES_NAME)));
    if (retained?.length) registry.retained = retained;
    if (!loaded || !hasSameOwners(loaded.raw, registry)) await writeRulesRegistry(host, registry);
    return validateRegistry(registry);
  });
}

export async function removeRulesOwner(host, { removeRecord = false } = {}) {
  const initial = await loadRulesRegistry(host);
  if (!initial) return null;
  return withRegistryLock(host, async () => {
    const loaded = await loadRulesRegistry(host);
    if (!loaded) return null;
    const current = validateIndex(loaded.raw);
    const recordKey = rulesPathIdentity(installRecordPath(host));
    const registry = {
      version: RULES_REGISTRY_VERSION,
      records: current.records.filter((file) => !removeRecord || rulesPathIdentity(file) !== recordKey),
      legacy: current.legacy.filter((owner) => owner !== normalizedRulesOwner(host)),
      ...(current.retained ? { retained: current.retained } : {}),
    };
    // OW-086 / Plan_83 B3b: without explicit record evidence, departure only clears this host's hint.
    if (registry.records.length || registry.legacy.length || registry.retained?.length) {
      if (!hasSameOwners(loaded.raw, registry)) await writeRulesRegistry(host, registry);
    } else {
      await fs.rm(rulesRegistryPath(host), { force: true });
    }
    return validateRegistry(registry);
  });
}

// Plan_83 D7 (3), (5): consent names a whole snapshot; changed evidence retires nothing.
export async function retireRulesReferences(host, { legacy, records, expectedIndex, verify, retained }) {
  if (!Array.isArray(legacy) || !Array.isArray(records) || expectedIndex === undefined
    || typeof verify !== 'function') throw new TypeError('retirement requires named references, an index and verification');
  if (retained !== undefined && !Array.isArray(retained)) throw new TypeError('retained baselines must be an array');
  const retire = async () => {
    const loaded = await loadRulesRegistry(host);
    const current = loaded ? validateIndex(loaded.raw) : null;
    if (JSON.stringify(current) !== JSON.stringify(expectedIndex)
      || legacy.some((name) => !current?.legacy.includes(name))
      || records.some((file) => !current?.records.includes(file))
      || !await verify(current)) return false;
    if (!current && !retained?.length) return true;
    const registry = { version: RULES_REGISTRY_VERSION,
      records: (current?.records ?? []).filter((file) => !records.includes(file)),
      legacy: (current?.legacy ?? []).filter((name) => !legacy.includes(name)) };
    // Plan_83 D8: baseline changes and departure references are published as one locked update.
    const baselines = retained ?? current?.retained;
    if (baselines?.length) registry.retained = baselines;
    validateIndex(registry);
    if (registry.records.length || registry.legacy.length || registry.retained?.length) {
      if (!loaded || !hasSameOwners(loaded.raw, registry)) await writeRulesRegistry(host, registry);
    } else await fs.rm(rulesRegistryPath(host), { force: true });
    return true;
  };
  // No index means no registry directory is required (the physical rules lock is already held).
  return await loadRulesRegistry(host) || retained?.length ? withRegistryLock(host, retire) : retire();
}

// Plan_83 D7 (8) / D8: deleting a home retires only its record path, never hints or retained evidence.
export async function retireDeletedRulesRecord(host) {
  const index = await readRulesIndex(host);
  const recordKey = rulesPathIdentity(installRecordPath(host));
  const records = (index?.records ?? []).filter((file) => rulesPathIdentity(file) === recordKey);
  if (!records.length) return;
  if (!await retireRulesReferences(host, { records, legacy: [], expectedIndex: index, verify: async () => true })) {
    throw new Error('rules ownership index changed while retiring the deleted installation record');
  }
}
