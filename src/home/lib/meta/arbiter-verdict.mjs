/** Judges OW-097 arbiter results against the brief and frozen evidence using the same answer rules as the prompt. */
import { answerRuleMessage } from '../answer-rules.mjs';
import { bindArbiterProbes } from './arbiter-probe-receipts.mjs';
import { checkTextIntegrity, createCitationCheck, strings } from './citation-check.mjs';

const reason = (key, values) => answerRuleMessage('codex-arbiter', key, values);

function checkCoverage(field, actual, expected, reasons) {
  const remaining = new Set(expected);
  for (const id of actual) {
    if (!remaining.delete(id)) {
      if (expected.has(id)) reasons.push(reason('arbiter-coverage-duplicate', { field, id }));
      else reasons.push(reason('arbiter-coverage-unexpected', { field, id }));
    }
  }
  for (const id of remaining) reasons.push(reason('arbiter-coverage-missing', { field, id }));
}

export function judgeArbitration({ result, task, evidence, repoRoot, events, captureComplete }) {
  if (!result || !Array.isArray(task?.options) || !Array.isArray(task?.paths)) {
    throw new TypeError('result and a parsed arbiter task are required.');
  }
  if (!Array.isArray(evidence)) throw new TypeError('evidence must be the arbiter snapshot runs array.');
  if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('repoRoot must be a non-empty path.');
  if (!Array.isArray(events)) throw new TypeError('events must be the arbiter command event array.');
  if (typeof captureComplete !== 'boolean') throw new TypeError('captureComplete must be a boolean.');

  const reasons = [];
  const reportProblem = (key, values) => {
    // Use literal keys for shared checks so the producer guard can see every reason.
    switch (key) {
      case 'citation-path': return reasons.push(reason('arbiter-citation-path', values));
      case 'citation-existing-file': return reasons.push(reason('arbiter-citation-existing-file', values));
      case 'citation-readable-file': return reasons.push(reason('arbiter-citation-readable-file', values));
      case 'citation-line-range': return reasons.push(reason('arbiter-citation-line-range', values));
      case 'citation-allowed-path': return reasons.push(reason('arbiter-citation-allowed-path', values));
      case 'prose-address': return reasons.push(reason('arbiter-prose-address', values));
      case 'control-character': return reasons.push(reason('arbiter-control-character', values));
      case 'lone-surrogate': return reasons.push(reason('arbiter-lone-surrogate', values));
      default: throw new RangeError(`Unknown arbiter check problem ${JSON.stringify(key)}.`);
    }
  };
  checkTextIntegrity(result, reportProblem);

  const optionIds = new Set(task.options.map(({ id }) => id));
  const { option_ids: recommended, mix_rationale: mixRationale } = result.recommendation;
  const chosen = new Set();
  if (!recommended.length) reasons.push(reason('arbiter-recommendation-required'));
  for (const id of recommended) {
    if (!optionIds.has(id)) reasons.push(reason('arbiter-recommendation-option-id', { id }));
    if (chosen.has(id)) reasons.push(reason('arbiter-recommendation-duplicate', { id }));
    chosen.add(id);
  }
  if (recommended.length > 1 && !mixRationale.trim()) {
    reasons.push(reason('arbiter-mix-rationale'));
  }

  const rejectedIds = new Set([...optionIds].filter((id) => !chosen.has(id)));
  checkCoverage('rejected', result.rejected.map(({ option_id }) => option_id), rejectedIds, reasons);
  checkCoverage('residual_gaps', result.residual_gaps.map(({ option_id }) => option_id), optionIds, reasons);
  if (!Array.isArray(result.pre_mortem) || result.pre_mortem.length < 1 || result.pre_mortem.length > 5) {
    reasons.push(reason('arbiter-pre-mortem-count'));
  }
  const runNames = new Set(evidence.map(({ run }) => run));
  checkCoverage('prior_advice_review', result.prior_advice_review.map(({ run }) => run), runNames, reasons);

  const { checkProse, checkEvidence } = createCitationCheck({
    repoRoot,
    allowedPaths: task.paths,
    reportProblem,
  });
  for (const { field, value } of strings(result)) {
    // Run names identify frozen snapshots, D3 tags identify commands, and evidence paths have structured ranges.
    if (/^(?:prior_advice_review\[\d+\]\.run|probes\[\d+\]\.probe_tag|checks\[\d+\]\.evidence\[\d+\]\.file)$/.test(field)) continue;
    checkProse(field, value);
  }
  for (const [index, check] of result.checks.entries()) {
    checkEvidence(`checks[${index}].evidence`, check.evidence);
  }

  // OW-097 D3 binds claimed probes to command events. Literal keys keep the producer guard on this path.
  const { problems } = bindArbiterProbes({ probes: result.probes, events, captureComplete });
  for (const { key, values } of problems) {
    switch (key) {
      case 'probe-count': reasons.push(reason('arbiter-probe-count', values)); break;
      case 'probe-capture-incomplete': reasons.push(reason('arbiter-probe-capture-incomplete', values)); break;
      case 'probe-tag-shape': reasons.push(reason('arbiter-probe-tag-shape', values)); break;
      case 'probe-tag-duplicate': reasons.push(reason('arbiter-probe-tag-duplicate', values)); break;
      case 'probe-unmatched': reasons.push(reason('arbiter-probe-unmatched', values)); break;
      case 'probe-incomplete': reasons.push(reason('arbiter-probe-incomplete', values)); break;
      case 'probe-ambiguous': reasons.push(reason('arbiter-probe-ambiguous', values)); break;
      case 'probe-multiple-markers': reasons.push(reason('arbiter-probe-multiple-markers', values)); break;
      case 'probe-command-too-long': reasons.push(reason('arbiter-probe-command-too-long', values)); break;
      case 'probe-terminal-invalid': reasons.push(reason('arbiter-probe-terminal-invalid', values)); break;
      default: throw new RangeError(`Unknown arbiter probe problem ${JSON.stringify(key)}.`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
