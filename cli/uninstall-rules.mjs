/**
 * Decides and performs what happens to the Codex rules file when a host leaves the package.
 * Plan_65 B20a: uninstall and purge detach hosts alike, so sharing rules ownership and fingerprint
 * decisions prevents their behavior and output from drifting apart.
 */
import { fileFingerprint } from './manifest.mjs';
import { removeRulesOwner, rulesPathIdentity } from './rules-owners.mjs';
import { installRecordPath } from './install-record.mjs';
import { readRulesIndex } from './rules-index.mjs';
import { remainingRulesOwnership } from './rules-ownership.mjs';
import { removeOutside } from './record-removal.mjs';

export function remainingOwnersText(count) {
  return `${count} other owner${count === 1 ? '' : 's'} ${count === 1 ? 'remains' : 'remain'}`;
}

function indexFromRegistry(registry) {
  return registry === null ? null : {
    version: 2, records: registry.records ?? [], legacy: registry.owners,
  };
}

function liveOwnerCount(ownership) {
  return ownership?.live.reduce((count, live) => count + live.owners.length, 0) ?? 0;
}

function unknownReferencesText(references) {
  return `${references.length} ownership reference${references.length === 1 ? '' : 's'} cannot be verified: `
    + references.map((reference) => `${reference.legacy ?? reference.recordPath} (${reference.reason})`).join('; ');
}

export async function rulesDryRunLines({ host, record, registry, registryError, detached }) {
  const lines = [];
  if (!record?.rules || !detached) return lines;
  if (registryError) {
    lines.push(`Would leave ${record.rules.path} because the rules ownership registry is invalid; \
ownership is unknown.`);
  } else {
    const ownership = await remainingRulesOwnership(indexFromRegistry(registry), host, record);
    const remainingOwners = liveOwnerCount(ownership);
    const currentFingerprint = await fileFingerprint(record.rules.path);
    if (remainingOwners || ownership?.unknown.length) {
      if (remainingOwners) {
        lines.push(`Would leave ${record.rules.path} because ${remainingOwnersText(remainingOwners)}.`);
      }
      if (ownership.unknown.length) {
        lines.push(`Would leave ${record.rules.path} because ${unknownReferencesText(ownership.unknown)}.`);
      }
    } else if (currentFingerprint === record.rules.fingerprint) {
      lines.push(`Would remove ${record.rules.path}; no other owners remain and its fingerprint is unchanged.`);
    } else if (currentFingerprint !== null) {
      lines.push(`Would leave ${record.rules.path} because its contents changed after installation.`);
    } else {
      lines.push(`Would leave ${record.rules.path} because it is already absent.`);
    }
    if (!registry) {
      lines.push(`Warning: the rules ownership registry was missing; \
other installations may use ${record.rules.path}.`);
    }
  }
  return lines;
}

export async function removeRulesForHost({ host, record, registry, registryError, detached, writer }) {
  const detachedRecord = record && detached ? record : null;
  let ownership = null;
  if (detachedRecord && !registryError) {
    try {
      // OW-086 / Plan_65 D5: classify before detaching the legacy hint; unknown evidence keeps the file.
      const index = await readRulesIndex(host);
      if (detachedRecord.rules) ownership = await remainingRulesOwnership(index, host, record);
      const recordKey = rulesPathIdentity(installRecordPath(host));
      // OW-086 / Plan_83 B3b: retire only a readable, complete indexed record with no remaining live owner.
      // Unresolved legacy hints stay independent; uncertainty in this indexed record forbids retirement.
      const removeRecord = ownership !== null
        && index.records.some((file) => rulesPathIdentity(file) === recordKey)
        && !ownership.unknown.some((ref) => ref.legacy === undefined && rulesPathIdentity(ref.recordPath) === recordKey)
        && !ownership.live.some((live) => rulesPathIdentity(live.recordPath) === recordKey);
      await removeRulesOwner(host, { removeRecord });
    } catch (err) {
      registryError = err;
    }
  }
  const lines = [];
  if (detachedRecord?.rules) {
    if (registryError) {
      lines.push(`Left ${record.rules.path} because the rules ownership registry is invalid; ownership is unknown.`);
    } else {
      const remainingOwners = liveOwnerCount(ownership);
      if (remainingOwners || ownership?.unknown.length) {
        if (remainingOwners) {
          lines.push(`Left ${record.rules.path} because ${remainingOwnersText(remainingOwners)}.`);
        }
        if (ownership.unknown.length) {
          lines.push(`Left ${record.rules.path} because ${unknownReferencesText(ownership.unknown)}.`);
        }
      } else {
        const currentFingerprint = await fileFingerprint(record.rules.path);
        if (currentFingerprint === record.rules.fingerprint) {
          await removeOutside(writer, record.rules.path);
        } else if (currentFingerprint !== null) {
          lines.push(`Left ${record.rules.path} because its contents changed after installation.`);
        }
      }
      if (!registry) {
        lines.push(`Warning: the rules ownership registry was missing; \
other installations may use ${record.rules.path}.`);
      }
    }
  }
  return { lines, registryError };
}
