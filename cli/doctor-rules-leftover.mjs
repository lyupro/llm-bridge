/** Describes the host's Codex rules file and index without an owning installation record. */
import path from 'node:path';
import { fileFingerprint } from './manifest.mjs';
import { installRecordPath, RULES_NAME } from './install-record.mjs';
import { readRulesIndex } from './rules-index.mjs';
import { classifyRulesOwnership } from './rules-ownership.mjs';
import { rulesPathIdentity } from './rules-owners.mjs';
import { matchesRulesFingerprint } from './rules-retirement.mjs';
import { check } from './doctor-format.mjs';

// Plan_83 D7 (8): ownership diagnostics must not depend on whether this host still has a record.
export function rulesOwnershipChecks(ownership) {
  return [
    ...ownership.live.map(({ recordPath, owners }) => check('rules owners', 'ok',
      `${recordPath}: ${owners.join(', ')}`)),
    ...ownership.unknown.map(({ legacy, recordPath, reason }) => check('rules ownership', 'warn',
      `unknown ${legacy === undefined ? recordPath : `${legacy} (record ${recordPath})`}: ${reason}`)),
    ...ownership.detached.map(({ recordPath }) => check('rules ownership', 'warn',
      `detached record ${recordPath}: complete inventory has no owner of this rules file`)),
  ];
}

export async function rulesLeftoverCheck(host, absentMessage) {
  const rulesPath = path.join(host.codexRulesDir, RULES_NAME);
  let index;
  try {
    index = await readRulesIndex(host);
  } catch (err) {
    return [check('rules', 'fail', err.message)];
  }
  let fingerprint;
  let unreadable = false;
  try {
    fingerprint = await fileFingerprint(rulesPath);
  } catch {
    unreadable = true;
  }
  if (!unreadable && fingerprint === null && index === null) {
    return [check('rules', 'warn', absentMessage)];
  }
  const ownership = await classifyRulesOwnership(index, rulesPath, installRecordPath(host));
  const ownershipChecks = rulesOwnershipChecks(ownership);
  // Plan_83 D8: retained integrity evidence applies after the last live owner departs.
  if (ownership.live.length > 0) {
    return [check('rules', 'warn', `${absentMessage}; the rules file ${rulesPath} belongs to another installation`),
      ...ownershipChecks];
  }
  if (unreadable) return [check('rules', 'fail', rulesPath), ...ownershipChecks];
  if (fingerprint === null) {
    return [check('rules', 'warn', `${rulesPath} (no rules file; the index still lists references)`), ...ownershipChecks];
  }
  // Plan_83 D8: only a retained baseline for this path can prove integrity after departure.
  const retained = index?.retained?.some((entry) => rulesPathIdentity(entry.path) === rulesPathIdentity(rulesPath));
  const verdict = matchesRulesFingerprint(index, rulesPath, null, fingerprint)
    ? 'matches retained installation fingerprint'
    : retained ? 'modified after installation' : 'integrity since installation cannot be proven';
  return [check('rules', 'warn', `${rulesPath} (${verdict}); run llm-bridge uninstall --host "${host.root}" in a terminal`),
    ...ownershipChecks];
}
