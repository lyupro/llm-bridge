/**
 * Reads encoding evidence for the build verdict and reply, without changing the worktree.
 * OW-089 D1: three existing comment dashes became mojibake while verification stayed green;
 * only witnessed replacements fail a run, and absent or unusable evidence never accuses it.
 */
import path from 'node:path';
import { readJson } from './paths.mjs';
import { answerRuleMessage } from '../answer-rules.mjs';

const buildReason = (key, values) => ({ reason: answerRuleMessage('codex-build', key, values), key });

const countValid = (value) => Number.isSafeInteger(value) && value >= 0;
const locationValid = (entry) => typeof entry?.path === 'string' && entry.path.length > 0
  && Number.isSafeInteger(entry.line) && entry.line > 0;
const suspicionValid = (entry) => {
  if (entry?.kind === 'malformed-utf8') {
    return typeof entry.path === 'string' && entry.path.length > 0 && countValid(entry.byteOffset);
  }
  if (!locationValid(entry)) return false;
  if (entry.kind === 'replacement-char') return true;
  return ['candidate', 'inherited'].includes(entry.kind)
    && typeof entry.text === 'string' && typeof entry.repaired === 'string';
};

/** Totals are uncapped; the reply and reason need only the first three recorded locations. */
export function readEncodingEvidence(runDir) {
  const report = readJson(path.join(runDir, 'encoding.json'));
  if (report?.version !== 1) return null;
  for (const tier of ['proven', 'suspected']) {
    if (!countValid(report.counts?.[tier]) || !Array.isArray(report[tier])
      || report[tier].length > report.counts[tier]
      || (report.counts[tier] > 0 && !report[tier].length)) return null;
  }
  if (!report.proven.every((entry) => locationValid(entry) && typeof entry.text === 'string')
    || !report.suspected.every(suspicionValid)) return null;
  return {
    counts: report.counts,
    proven: report.proven.slice(0, 3),
    suspected: report.suspected.slice(0, 3),
  };
}

export function encodingGap(runDir) {
  const evidence = readEncodingEvidence(runDir);
  if (!evidence?.counts.proven) return null;
  const locations = evidence.proven.map((entry) => `${entry.path}:${entry.line}`).join(', ');
  return buildReason('build-encoding-corrupted', { count: evidence.counts.proven, locations });
}
