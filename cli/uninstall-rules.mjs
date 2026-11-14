/**
 * Decides and performs what happens to the Codex rules file when a host leaves the package.
 * Plan_65 B20a: uninstall and purge detach hosts alike, so sharing rules ownership and fingerprint
 * decisions prevents their behavior and output from drifting apart.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileFingerprint } from './manifest.mjs';
import { readRulesIndex } from './rules-index.mjs';
import { removeRulesOwner, rulesPathIdentity } from './rules-owners.mjs';
import { remainingRulesOwnership, offerableUnknown } from './rules-ownership.mjs';
import { pendingRecoveryText } from './install-pending.mjs';
import { retireRulesPlan, rulesQuestion, rulesRepeatLine, matchesRulesFingerprint } from './rules-retirement.mjs';

export function remainingOwnersText(count) {
  return `${count} other owner${count === 1 ? '' : 's'} ${count === 1 ? 'remains' : 'remain'}`;
}

function indexFromRegistry(registry) {
  return registry === null ? null : {
    version: 2, records: registry.records ?? [], legacy: registry.owners,
    ...(registry.retained ? { retained: registry.retained } : {}),
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

// Plan_83 D8: the decision consumes file evidence, not an owner view, including record-free callers.
export async function preflightRulesRemoval(rulesPath, storedFingerprint,
  { host, index, registryError = null, ownHomeAttested = false }) {
  if (typeof rulesPath !== 'string' || !rulesPath) throw new TypeError('rules path is required');
  if (storedFingerprint !== null && (typeof storedFingerprint !== 'string' || !storedFingerprint)) {
    throw new TypeError('stored rules fingerprint is required; use null without owner evidence');
  }
  if (!registryError && index === undefined) {
    try { index = await readRulesIndex(host); }
    catch (err) { registryError = err; }
  }
  const ownership = registryError ? null : await remainingRulesOwnership(index, host,
    { rules: { path: rulesPath, fingerprint: storedFingerprint } }, { ownHomeAttested });
  const currentFingerprint = registryError ? null : await fileFingerprint(rulesPath);
  const exists = registryError ? await rulesFilePresent(rulesPath) : currentFingerprint !== null;
  const unchanged = matchesRulesFingerprint(index, rulesPath, storedFingerprint, currentFingerprint);
  const live = ownership?.live ?? [];
  const unknown = ownership?.unknown ?? [];
  const offerable = unknown.filter(offerableUnknown);
  const blocking = unknown.filter((ref) => !offerableUnknown(ref));
  return { rulesPath, storedFingerprint, index, registryError, ownership, live, offerable, blocking,
    currentFingerprint, exists, unchanged, ownHomeAttested,
    canAsk: !registryError && !live.length && !blocking.length && offerable.length > 0
      && exists && unchanged };
}

function dispositionLines(plan, dryRun) {
  const { rulesPath, currentFingerprint, ownership, registryError } = plan;
  const lines = [];
  const verb = dryRun ? 'Would leave' : 'Left';
  const remainingOwners = liveOwnerCount(ownership);
  // Plan_83 D8: a fresh hash cannot rebuild lost installation evidence.
  if (plan.storedFingerprint === null && plan.exists && !plan.unchanged && !registryError) {
    lines.push(verb + ' ' + rulesPath + (plan.index?.retained?.some((entry) =>
      rulesPathIdentity(entry.path) === rulesPathIdentity(rulesPath))
      ? ' because its contents changed after installation.'
      : ' because its integrity since installation cannot be proven.'));
  }
  if (registryError) {
    lines.push(verb + ' ' + rulesPath + ' because the rules ownership registry is invalid; ownership is unknown.');
  } else if (remainingOwners || ownership?.unknown.length) {
    if (remainingOwners) lines.push(verb + ' ' + rulesPath + ' because ' + remainingOwnersText(remainingOwners) + '.');
    if (ownership.unknown.length) {
      lines.push(verb + ' ' + rulesPath + ' because ' + unknownReferencesText(ownership.unknown) + '.');
      lines.push(...unknownRecoveryLines(ownership.unknown));
    }
  } else if (plan.unchanged) {
    if (dryRun) lines.push('Would remove ' + rulesPath + '; no other owners remain and its fingerprint is unchanged.');
  } else if (currentFingerprint !== null && plan.storedFingerprint !== null) {
    lines.push(verb + ' ' + rulesPath + ' because its contents changed after installation.');
  } else if (dryRun) lines.push(verb + ' ' + rulesPath + ' because it is already absent.');
  if (!registryError && plan.index === null) {
    lines.push('Warning: the rules ownership registry was missing; other installations may use ' + rulesPath + '.');
  }
  return lines;
}

function unresolved(plan) {
  return plan.exists && !plan.live.length && Boolean(plan.registryError || plan.ownership?.unknown.length
    || (plan.storedFingerprint === null && !plan.unchanged));
}

export async function rulesDryRunLines({ host, record, registry, registryError, detached, plan }) {
  if ((!record?.rules && !plan) || !detached) return { lines: [], rulesUnresolved: false };
  plan ??= await preflightRulesRemoval(record.rules.path, record.rules.fingerprint,
    { host, index: indexFromRegistry(registry), registryError });
  const lines = dispositionLines(plan, true);
  if (plan.canAsk) lines.push('A real run would ask about these rules references:\n' + await rulesQuestion(plan));
  return { lines, rulesUnresolved: unresolved(plan) };
}

export async function removeRulesForHost({ host, record, registry, registryError, detached, writer,
  plan, answer = 'no' }) {
  if ((!record && !plan) || !detached) return { lines: [], registryError, rulesUnresolved: false };
  if (!record?.rules && !plan) {
    // Plan_83 D8: callers without a decision preserve the old no-metadata host-hint departure.
    if (!registryError) {
      try { await removeRulesOwner(host); }
      catch (err) { registryError = err; }
    }
    return { lines: [], registryError, rulesUnresolved: false };
  }
  plan ??= await preflightRulesRemoval(record.rules.path, record.rules.fingerprint, { host, registryError });
  const lines = dispositionLines(plan, false);
  let rulesUnresolved = unresolved(plan);
  if (!plan.registryError) {
    // Plan_83 D8: unresolved ownership retains the baseline while retiring only our own references.
    const confirmed = plan.canAsk && answer === 'yes';
    if (!plan.ownership?.unknown.length || plan.live.length || confirmed || plan.unchanged || !plan.exists) {
      try {
        const result = await retireRulesPlan(host, plan, writer, confirmed);
        if (!result.retired) {
          lines.push('Left ' + plan.rulesPath + ' because rules ownership references changed; nothing was retired.');
          rulesUnresolved = plan.exists;
          // Plan_83 D8: stale consent authorizes no foreign retirement; refresh only our departure.
          const fresh = await preflightRulesRemoval(plan.rulesPath, plan.storedFingerprint,
            { host, ownHomeAttested: plan.ownHomeAttested });
          if (!fresh.registryError) await retireRulesPlan(host, fresh, writer, false, { keepFile: true });
        } else if (confirmed) {
          lines.length = 0;
          if (result.changed) lines.push('Left ' + plan.rulesPath + ' because its contents changed after installation.');
          rulesUnresolved = !result.removed && await rulesFilePresent(plan.rulesPath);
        } else if (result.changed) {
          if (plan.storedFingerprint !== null || plan.unchanged) {
            lines.push('Left ' + plan.rulesPath + ' because its contents changed after installation.');
          }
          if (plan.storedFingerprint === null) rulesUnresolved = true;
        }
      } catch (err) {
        registryError = err;
        lines.push('Left ' + plan.rulesPath + ' because the rules ownership registry could not be updated: ' + err.message);
        rulesUnresolved = await rulesFilePresent(plan.rulesPath);
      }
    }
    if (plan.canAsk && !confirmed) lines.push(rulesRepeatLine(host));
  }
  return { lines, registryError: registryError ?? plan.registryError, rulesUnresolved };
}
