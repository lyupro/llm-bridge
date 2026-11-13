/** Operator consent and exact reference retirement for Plan_83 D6/D7. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { askYesNo, isInteractive } from './terminal-question.mjs';
import { retireRulesReferences, normalizedRulesOwner, rulesPathIdentity } from './rules-owners.mjs';
import { installRecordPath } from './install-record.mjs';
import { remainingRulesOwnership } from './rules-ownership.mjs';
import { fileFingerprint } from './manifest.mjs';
import { removeOutside } from './record-removal.mjs';

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

export async function retireRulesPlan(host, plan, writer, confirmed) {
  const ownRecord = rulesPathIdentity(installRecordPath(host));
  const ownUnknown = plan.ownership?.unknown.some((ref) => ref.legacy === undefined
    && rulesPathIdentity(ref.recordPath) === ownRecord);
  const ownLive = plan.live.some((ref) => rulesPathIdentity(ref.recordPath) === ownRecord);
  const records = (plan.index?.records ?? []).filter((file) =>
    (!ownUnknown && !ownLive && rulesPathIdentity(file) === ownRecord)
      || (confirmed && plan.offerable.some((ref) => ref.kind === 'missing' && ref.recordPath === file)));
  const legacy = (plan.index?.legacy ?? []).filter((name) => name === normalizedRulesOwner(host)
    || (confirmed && plan.offerable.some((ref) => ref.kind === 'legacy' && ref.legacy === name)));
  const retired = await retireRulesReferences(host, { records, legacy, expectedIndex: plan.index,
    verify: async (index) => {
      const current = await remainingRulesOwnership(index, host,
        { rules: { path: plan.rulesPath, fingerprint: plan.storedFingerprint } },
        { ownHomeAttested: plan.ownHomeAttested });
      return JSON.stringify(current) === JSON.stringify(plan.ownership);
    } });
  if (!retired || plan.live.length || (plan.ownership?.unknown.length && !confirmed)) return { retired, removed: false };
  // Plan_83 D7 (5): the directory lock covers both retirement and a fresh content check.
  const fingerprint = await fileFingerprint(plan.rulesPath);
  if (fingerprint !== plan.storedFingerprint) return { retired, removed: false, changed: fingerprint !== null };
  await removeOutside(writer, plan.rulesPath);
  return { retired, removed: true };
}
