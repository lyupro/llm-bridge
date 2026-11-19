/** Judges arbiter results against the OW-097 brief and frozen evidence as chosen by the advise run named in `advice:`. */
import { checkTextIntegrity, createCitationCheck, strings } from './citation-check.mjs';

function checkCoverage(field, actual, expected, reasons) {
  const remaining = new Set(expected);
  for (const id of actual) {
    if (!remaining.delete(id)) {
      const problem = expected.has(id) ? 'duplicate entry' : 'unexpected entry';
      reasons.push(`${field} ${JSON.stringify(id)}: ${problem}.`);
    }
  }
  for (const id of remaining) reasons.push(`${field}: missing ${JSON.stringify(id)}.`);
}

function citationReason(key, { field, label, count }) {
  const location = `${field} ${JSON.stringify(label)}`;
  switch (key) {
    case 'citation-existing-file': return `${location}: cite an existing file under repoRoot.`;
    case 'citation-readable-file': return `${location}: cite a readable file under repoRoot.`;
    case 'citation-line-range': return `${location}: use an ascending line range within this file's ${count} lines.`;
    case 'citation-allowed-path': return `${location}: cite a file allowed by task.paths.`;
    case 'citation-path':
    case 'prose-address': return `${location}: use a repository-relative path:line or path:line-line address.`;
    default: throw new RangeError(`Unknown citation problem ${JSON.stringify(key)}.`);
  }
}

export function judgeArbitration({ result, task, evidence, repoRoot }) {
  if (!result || !Array.isArray(task?.options) || !Array.isArray(task?.paths)) {
    throw new TypeError('result and a parsed arbiter task are required.');
  }
  if (!Array.isArray(evidence)) throw new TypeError('evidence must be the arbiter snapshot runs array.');
  if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('repoRoot must be a non-empty path.');

  const reasons = [];
  checkTextIntegrity(result, (key, { field, codePoint }) => {
    const problem = key === 'control-character' ? 'control character' : 'lone surrogate';
    reasons.push(`integrity ${field}: remove ${problem} ${codePoint}.`);
  });

  const optionIds = new Set(task.options.map(({ id }) => id));
  const { option_ids: recommended, mix_rationale: mixRationale } = result.recommendation;
  const chosen = new Set();
  if (!recommended.length) reasons.push('recommendation.option_ids: recommend at least one task option.');
  for (const id of recommended) {
    const entry = `recommendation.option_ids ${JSON.stringify(id)}`;
    if (!optionIds.has(id)) reasons.push(`${entry}: unknown task option.`);
    if (chosen.has(id)) reasons.push(`${entry}: duplicate entry.`);
    chosen.add(id);
  }
  if (recommended.length > 1 && !mixRationale.trim()) {
    reasons.push('recommendation.mix_rationale: explain what each recommended option contributes.');
  }

  const rejectedIds = new Set([...optionIds].filter((id) => !chosen.has(id)));
  checkCoverage('rejected', result.rejected.map(({ option_id }) => option_id), rejectedIds, reasons);
  checkCoverage('residual_gaps', result.residual_gaps.map(({ option_id }) => option_id), optionIds, reasons);
  if (!Array.isArray(result.pre_mortem) || result.pre_mortem.length < 1 || result.pre_mortem.length > 5) {
    reasons.push('pre_mortem: provide between 1 and 5 scenarios.');
  }
  const runNames = new Set(evidence.map(({ run }) => run));
  checkCoverage('prior_advice_review', result.prior_advice_review.map(({ run }) => run), runNames, reasons);

  const { checkProse, checkEvidence } = createCitationCheck({
    repoRoot,
    allowedPaths: task.paths,
    reportProblem: (key, values) => reasons.push(citationReason(key, values)),
  });
  for (const { field, value } of strings(result)) {
    // Run names identify frozen snapshots, and evidence paths are checked with their structured line ranges.
    if (/^prior_advice_review\[\d+\]\.run$|^checks\[\d+\]\.evidence\[\d+\]\.file$/.test(field)) continue;
    checkProse(field, value);
  }
  for (const [index, check] of result.checks.entries()) {
    checkEvidence(`checks[${index}].evidence`, check.evidence);
  }

  return { ok: reasons.length === 0, reasons };
}
