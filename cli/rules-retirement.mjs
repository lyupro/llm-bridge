/** Operator consent and exact reference retirement for Plan_83 D6/D7. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { askYesNo, isInteractive } from './terminal-question.mjs';
import { retireRulesReferences, normalizedRulesOwner, rulesPathIdentity } from './rules-owners.mjs';
import { installRecordPath } from './install-record.mjs';
import { remainingRulesOwnership } from './rules-ownership.mjs';
import { fileFingerprint } from './manifest.mjs';
import { removeOutside } from './record-removal.mjs';
import { readRulesIndex } from './rules-index.mjs';

async function folderMark(folder) {
  try { return (await fs.stat(folder)).isDirectory() ? 'folder exists' : 'folder does not exist'; }
  catch (err) { return err.code === 'ENOENT' ? 'folder does not exist' : 'folder existence unknown: ' + err.code; }
}

export async function rulesQuestion(plan) {
  const listed = await Promise.all(plan.offerable.map(async (ref) => {
    const name = ref.legacy ?? ref.recordPath;
    const folder = ref.kind === 'missing' ? path.dirname(ref.recordPath) : ref.legacy;
    return '  ' + name + ' (' + ref.kind + '; ' + await folderMark(folder) + ')';
  }));
  return ['Rules file: ' + plan.rulesPath, 'Unverified ownership references:', ...listed,
    'Yes removes these references and the rules file. No keeps both. Remove them?'].join('\n');
}

export async function confirmRulesRetirement(plan, options) {
  // Plan_83 D7: neither a test prompt nor redirected input substitutes for a terminal.
  if (!plan?.canAsk || options.dryRun || !isInteractive(options)) return 'no';
  return askYesNo(await rulesQuestion(plan), options);
}

export function rulesRepeatLine(host) {
  return 'Run llm-bridge uninstall --host "' + host.root + '" again in a terminal to confirm the rules references and remove the rules file.';
}

// Plan_83 D8: a historical baseline for this path is evidence even after its owner has departed.
export function matchesRulesFingerprint(index, rulesPath, storedFingerprint, fingerprint) {
  return fingerprint !== null && (fingerprint === storedFingerprint || (index?.retained ?? []).some((entry) =>
    rulesPathIdentity(entry.path) === rulesPathIdentity(rulesPath) && entry.fingerprint === fingerprint));
}

// Plan_83 D8: failed removal must not discard the only surviving installation evidence.
async function restoreRetainedRules(host, plan, retainOwner) {
  const index = await readRulesIndex(host);
  const retained = [...(index?.retained ?? [])];
  const previous = (plan.index?.retained ?? []).filter((entry) =>
    rulesPathIdentity(entry.path) === rulesPathIdentity(plan.rulesPath));
  if (retainOwner && plan.storedFingerprint !== null) {
    previous.push({ path: path.resolve(plan.rulesPath), fingerprint: plan.storedFingerprint });
  }
  for (const entry of previous) {
    if (!retained.some((item) => item.path === entry.path && item.fingerprint === entry.fingerprint)) retained.push(entry);
  }
  if (!await retireRulesReferences(host, { records: [], legacy: [], retained,
    expectedIndex: index, verify: async () => true })) throw new Error('rules evidence changed during removal recovery');
}

export async function retireRulesPlan(host, plan, writer, confirmed, { keepFile = false } = {}) {
  const ownRecord = rulesPathIdentity(installRecordPath(host));
  const ownUnknown = plan.ownership?.unknown.some((ref) => ref.legacy === undefined
    && rulesPathIdentity(ref.recordPath) === ownRecord);
  const ownLive = plan.live.some((ref) => rulesPathIdentity(ref.recordPath) === ownRecord);
  const records = (plan.index?.records ?? []).filter((file) =>
    (!ownUnknown && !ownLive && rulesPathIdentity(file) === ownRecord)
      || (confirmed && plan.offerable.some((ref) => ref.kind === 'missing' && ref.recordPath === file)));
  const legacy = (plan.index?.legacy ?? []).filter((name) => name === normalizedRulesOwner(host)
    || (confirmed && plan.offerable.some((ref) => ref.kind === 'legacy' && ref.legacy === name)));
  const fingerprint = await fileFingerprint(plan.rulesPath);
  const unchanged = matchesRulesFingerprint(plan.index, plan.rulesPath, plan.storedFingerprint, fingerprint);
  const remove = !keepFile && !plan.live.length && (!plan.ownership?.unknown.length || confirmed) && unchanged;
  let retained = plan.index?.retained ?? [];
  if (fingerprint === null || remove) {
    retained = retained.filter((entry) => rulesPathIdentity(entry.path) !== rulesPathIdentity(plan.rulesPath));
  } else if (!plan.live.length && unchanged && plan.storedFingerprint !== null && !retained.some((entry) =>
    entry.path === path.resolve(plan.rulesPath) && entry.fingerprint === plan.storedFingerprint)) {
    // Plan_83 D8: never turn a fresh content hash into an installation baseline.
    retained = [...retained, { path: path.resolve(plan.rulesPath), fingerprint: plan.storedFingerprint }];
  }
  const retired = await retireRulesReferences(host, { records, legacy, retained, expectedIndex: plan.index,
    verify: async (index) => {
      const current = await remainingRulesOwnership(index, host,
        { rules: { path: plan.rulesPath, fingerprint: plan.storedFingerprint } },
        { ownHomeAttested: plan.ownHomeAttested });
      return JSON.stringify(current) === JSON.stringify(plan.ownership)
        && await fileFingerprint(plan.rulesPath) === fingerprint;
    } });
  if (!retired || keepFile || plan.live.length || (plan.ownership?.unknown.length && !confirmed)) return { retired, removed: false };
  // Plan_83 D7 (5) / D8: recheck content after publication, accepting only historical evidence.
  const finalFingerprint = await fileFingerprint(plan.rulesPath);
  if (!remove || !matchesRulesFingerprint(plan.index, plan.rulesPath, plan.storedFingerprint, finalFingerprint)) {
    if (remove && finalFingerprint !== null) await restoreRetainedRules(host, plan, false);
    return { retired, removed: false, changed: finalFingerprint !== null };
  }
  try { await removeOutside(writer, plan.rulesPath); }
  catch (err) {
    await restoreRetainedRules(host, plan, true);
    throw err;
  }
  return { retired, removed: true };
}
