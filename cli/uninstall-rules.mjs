/**
 * Decides and performs what happens to the Codex rules file when a host leaves the package.
 * Plan_65 B20a: uninstall and purge detach hosts alike, so sharing rules ownership and fingerprint
 * decisions prevents their behavior and output from drifting apart.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileFingerprint } from './manifest.mjs';
import { removeRulesOwner, rulesPathIdentity } from './rules-owners.mjs';
import { installRecordPath } from './install-record.mjs';
import { readRulesIndex } from './rules-index.mjs';
import { remainingRulesOwnership, offerableUnknown } from './rules-ownership.mjs';
import { pendingRecoveryText } from './install-pending.mjs';
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

// Plan_83 D7: only the evidence's own host may repair a non-offerable reference.
function unknownRecoveryLines(references) {
  return references.flatMap((reference) => {
    const name = reference.legacy ?? reference.recordPath;
    if (offerableUnknown(reference)) return [`Only an operator can confirm ownership reference ${name}.`];
    const home = path.dirname(reference.recordPath);
    if (reference.kind === 'pending') return reference.pendingHosts.map((entry) =>
      `Pending ${entry.command} for ${entry.root} (${reference.recordPath}); ${pendingRecoveryText(entry)}`);
    if (reference.kind === 'inventory') return [
      `Home ${home}: confirm the inventory of that home, or uninstall the home from its own host.`,
    ];
    if (reference.kind === 'invalid') return [`Home ${home}: run llm-bridge update from that home.`];
    return [`${name} (${reference.recordPath}): ${reference.reason}; repair it from its own host, or remove the record file if that home is abandoned, then run uninstall again.`];
  });
}

// Plan_83 D7: an absent file cannot be held by unknown ownership; other stat errors prove no absence.
async function rulesFilePresent(file) {
  try { await fs.stat(file); return true; }
  catch (err) { return err.code !== 'ENOENT'; }
}

export async function rulesDryRunLines({ host, record, registry, registryError, detached }) {
  const lines = [];
  let rulesUnresolved = false;
  if (!record?.rules || !detached) return { lines, rulesUnresolved };
  if (registryError) {
    lines.push(`Would leave ${record.rules.path} because the rules ownership registry is invalid; \
ownership is unknown.`);
    rulesUnresolved = await rulesFilePresent(record.rules.path);
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
        lines.push(...unknownRecoveryLines(ownership.unknown));
        rulesUnresolved = !remainingOwners && currentFingerprint !== null;
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
  return { lines, rulesUnresolved };
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
  let rulesUnresolved = false;
  if (detachedRecord?.rules) {
    if (registryError) {
      lines.push(`Left ${record.rules.path} because the rules ownership registry is invalid; ownership is unknown.`);
      rulesUnresolved = await rulesFilePresent(record.rules.path);
    } else {
      const remainingOwners = liveOwnerCount(ownership);
      if (remainingOwners || ownership?.unknown.length) {
        if (remainingOwners) {
          lines.push(`Left ${record.rules.path} because ${remainingOwnersText(remainingOwners)}.`);
        }
        if (ownership.unknown.length) {
          lines.push(`Left ${record.rules.path} because ${unknownReferencesText(ownership.unknown)}.`);
          lines.push(...unknownRecoveryLines(ownership.unknown));
          // Plan_83 D7 (6): unknowns affect the exit only when they alone keep an existing file.
          rulesUnresolved = !remainingOwners && await rulesFilePresent(record.rules.path);
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
  return { lines, registryError, rulesUnresolved };
}
