/** Tracks which Claude Code hosts own the shared Codex rules file. */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PACKAGE_NAME } from '../src/home/lib/package-identity.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { readJsonFile } from '../src/home/lib/json-file.mjs';
import { withOutsideFileLock } from '../src/home/lib/file-lock.mjs';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { INSTALL_RECORD_NAME, installRecordPath } from './install-record.mjs';
export { isLockTaken } from '../src/home/lib/file-lock.mjs';

export const RULES_REGISTRY_NAME = `.${PACKAGE_NAME}-rules.json`;
export const RULES_REGISTRY_VERSION = 1;

export function rulesRegistryPath(host) {
  return path.join(host.codexRulesDir, RULES_REGISTRY_NAME);
}

export function normalizedRulesOwner(host) {
  return normalizeRepoPath(host.root);
}

function normalizeOwners(owners) {
  return [...new Set(owners.map((owner) => normalizeRepoPath(owner)))];
}

function validateRegistry(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('rules ownership registry must be an object');
  }
  if (parsed.version === 2) {
    for (const field of ['records', 'legacy']) {
      if (!Array.isArray(parsed[field])
        || parsed[field].some((item) => typeof item !== 'string' || !item)) {
        throw new Error(`rules ownership registry ${field} must be a list of non-empty strings`);
      }
    }
    if (parsed.records.some((file) => !path.isAbsolute(file) || path.basename(file) !== INSTALL_RECORD_NAME)) {
      throw new Error(`rules ownership registry records must be absolute paths to ${INSTALL_RECORD_NAME}`);
    }
    // OW-086: unresolved legacy hints must remain visible to callers not yet using record evidence.
    return { version: 2, owners: [...parsed.legacy], records: [...parsed.records] };
  }
  if (parsed.version !== RULES_REGISTRY_VERSION) {
    throw new Error('rules ownership registry version must be 1 or 2');
  }
  if (!Array.isArray(parsed.owners) || parsed.owners.some((owner) => typeof owner !== 'string' || !owner)) {
    throw new Error('rules ownership registry owners must be a list of non-empty strings');
  }
  return {
    version: RULES_REGISTRY_VERSION,
    owners: normalizeOwners(parsed.owners),
  };
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
    const current = loaded?.registry || { version: RULES_REGISTRY_VERSION, owners: [] };
    if (current.version === 2) {
      const records = [...current.records];
      const recordPath = path.resolve(installRecordPath(host));
      const identity = (file) => normalizedRulesOwner({ root: path.resolve(file) });
      if (!records.some((file) => identity(file) === identity(recordPath))) records.push(recordPath);
      const registry = { version: 2, records, legacy: current.owners };
      if (!hasSameOwners(loaded.raw, registry)) await writeRulesRegistry(host, registry);
      return validateRegistry(registry);
    }
    const registry = {
      version: RULES_REGISTRY_VERSION,
      owners: normalizeOwners([...current.owners, owner]),
    };
    if (!loaded || !hasSameOwners(loaded.raw, registry)) await writeRulesRegistry(host, registry);
    return registry;
  });
}

export function remainingRulesOwners(registry, host) {
  if (!registry) return null;
  const owner = normalizedRulesOwner(host);
  return registry.owners.filter((candidate) => candidate !== owner);
}

export async function removeRulesOwner(host) {
  const initial = await loadRulesRegistry(host);
  if (!initial) return null;
  return withRegistryLock(host, async () => {
    const loaded = await loadRulesRegistry(host);
    if (!loaded) return null;
    const registry = loaded.registry.version === 2 ? {
      version: 2,
      records: loaded.registry.records,
      legacy: loaded.registry.owners.filter((owner) => owner !== normalizedRulesOwner(host)),
    } : {
      version: RULES_REGISTRY_VERSION,
      owners: remainingRulesOwners(loaded.registry, host),
    };
    // Plan_65 D5 / OW-086: dropping a host hint cannot attest that a bridge-home record is unused.
    if (registry.version === 2 ? registry.records.length || registry.legacy.length : registry.owners.length) {
      if (!hasSameOwners(loaded.raw, registry)) await writeRulesRegistry(host, registry);
    } else {
      await fs.rm(rulesRegistryPath(host), { force: true });
    }
    return validateRegistry(registry);
  });
}
