/** Judges advisor decisions under Plan_59 while sharing evidence checks for OW-097, chosen by the advise run named in `advice:`. */
import { answerRuleMessage } from '../answer-rules.mjs';
import { BACKSTOPS, UNLISTED_OPTION_MIN_CHARS } from '../answer-rules/advisor.mjs';
import { alreadyDecidedProblem } from './already-decided.mjs';
import { checkTextIntegrity, createCitationCheck, entryInRepo, lineCount, strings } from './citation-check.mjs';

const reason = (key, values = {}) => answerRuleMessage('codex-advisor', key, values);

function backstopPattern(phrase) {
  // Plan_59 D5 ignores punctuation within words as well as between words, without matching word prefixes.
  const words = phrase.split(' ').map((word) => [...word].join('[\\p{P}\\p{S}]*'));
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join('[\\s\\p{P}\\p{S}]+')}(?![\\p{L}\\p{N}])`, 'iu');
}

function checkAdvisorCitations({ phase, result, task, repoRoot, scopeResult }, reasons, reportProblem) {
  const allowedPaths = [...task.paths, ...(phase === 'scope' ? result.missing_paths : scopeResult?.missing_paths ?? [])];
  const { allowFile, checkProse, checkEvidence } = createCitationCheck({ repoRoot, allowedPaths, reportProblem });
  if (typeof task.decisions === 'string') allowFile(task.decisions);
  // D3 covers every address anywhere in the answer. A list of prose fields had to be edited by
  // hand when `falsifier` became `pre_mortem`, and each new field would have joined it unchecked.
  // OW-083 R1 gives already_decided.address its stricter ledger-only judge instead of duplicate citation reasons.
  // Structured evidence and the free-text early_check.target are handled separately below.
  for (const { field, value } of strings(result)) {
    if (field === 'already_decided.address') continue;
    if (/(?:^|\.)evidence(?:\[|\.|$)|\.early_check\.target$/.test(field)) continue;
    checkProse(field, value);
  }
  if (result.independent_checks) {
    for (const [index, item] of result.independent_checks.entries()) {
      checkEvidence(`independent_checks[${index}].evidence`, item.evidence);
    }
  }
  if (phase === 'advise') {
    for (const [index, item] of result.assumptions.entries()) {
      if (item.rating === 'VERIFIED' && item.evidence.length === 0) {
        reasons.push(reason('advisor-verified-evidence', { index }));
      }
      checkEvidence(`assumptions[${index}].evidence`, item.evidence);
    }
    for (const [index, item] of result.pre_mortem.entries()) {
      const { early_check: earlyCheck } = item;
      if (earlyCheck.kind === 'inspect' && earlyCheck.evidence.length === 0) {
        reasons.push(reason('advisor-inspect-evidence', { index }));
      }
      checkEvidence(`pre_mortem[${index}].early_check.evidence`, earlyCheck.evidence);
    }
    // A risk outcome's locations are evidence whether or not the phase-1 answer is at hand.
    for (const [index, item] of result.risk_outcomes.entries()) {
      checkEvidence(`risk_outcomes[${index}].evidence`, item.evidence);
    }
  }
}


export function judgeAdvice({ phase, result, task, repoRoot, commandsRun, language, scopeResult, ledgerContract }) {
  if (phase !== 'scope' && phase !== 'advise') throw new RangeError('phase must be "scope" or "advise".');
  if (!Number.isInteger(commandsRun) || commandsRun < 0) {
    throw new TypeError('commandsRun must be a non-negative integer.');
  }
  if (typeof language !== 'string') throw new TypeError('language must be a string.');
  if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('repoRoot must be a non-empty path.');
  if (!result || !Array.isArray(task?.options) || !Array.isArray(task?.paths)) {
    throw new TypeError('result and a parsed advisor task are required.');
  }
  const reasons = [];
  const reportProblem = (key, values) => {
    // OW-097: use literal catalog keys so the advisor producer guard can verify each shared check's reason.
    switch (key) {
      case 'citation-path':
        return reasons.push(reason('advisor-citation-path', values));
      case 'citation-existing-file':
        return reasons.push(reason('advisor-citation-existing-file', values));
      case 'citation-readable-file':
        return reasons.push(reason('advisor-citation-readable-file', values));
      case 'citation-line-range':
        return reasons.push(reason('advisor-citation-line-range', values));
      case 'citation-allowed-path':
        return reasons.push(reason('advisor-citation-allowed-path', values));
      case 'prose-address':
        return reasons.push(reason('advisor-prose-address', values));
      case 'control-character':
        return reasons.push(reason('advisor-control-character', values));
      case 'lone-surrogate':
        return reasons.push(reason('advisor-lone-surrogate', values));
      default:
        throw new Error(`unknown advisor check problem: ${key}`);
    }
  };
  checkTextIntegrity(result, reportProblem);
  if (commandsRun === 0) reasons.push(reason('advisor-commands-run'));
  if (phase === 'scope') {
    if (!result.taken_on_trust.length) {
      reasons.push(reason('advisor-taken-on-trust'));
    }
    if (result.sufficient === false && !result.missing_paths.length) {
      reasons.push(reason('advisor-insufficient-missing-paths'));
    }
    if (result.sufficient === true && result.missing_paths.length) {
      reasons.push(reason('advisor-sufficient-missing-paths', { missingPaths: result.missing_paths }));
    }
    const riskIds = new Set();
    for (const [index, item] of result.predicted_risks.entries()) {
      if (riskIds.has(item.id)) {
        reasons.push(reason('advisor-unique-risk-id', { index, id: item.id }));
      }
      riskIds.add(item.id);
    }
  } else {
    if (ledgerContract === 'required' && !Object.hasOwn(result, 'already_decided')) {
      reasons.push(reason('advisor-already-decided-missing'));
    }
    if (Object.hasOwn(result, 'already_decided')) {
      const problem = alreadyDecidedProblem({
        answer: result.already_decided, task, repoRoot, entryInRepo, lineCount,
      });
      if (problem) reasons.push(reason(problem.key, problem.values));
    }
    const ids = new Set(task.options.map(({ id }) => id));
    const chosen = result.recommendation.option_id;
    if (!ids.has(chosen) && chosen !== 'none-of-these') {
      reasons.push(reason('advisor-recommendation-option-id', { optionId: chosen }));
    }
    if (chosen === 'none-of-these') {
      if (result.unlisted_option === 'none' || [...result.unlisted_option.trim()].length < UNLISTED_OPTION_MIN_CHARS) {
        reasons.push(reason('advisor-unlisted-option-length', { unlistedOption: result.unlisted_option }));
      }
      const rejected = new Set(result.rejected.map(({ option_id }) => option_id));
      const missing = [...ids].filter((id) => !rejected.has(id));
      if (missing.length) {
        reasons.push(reason('advisor-reject-all-options', { missing }));
      }
    } else if (ids.has(chosen) && result.unlisted_option !== 'none') {
      reasons.push(reason('advisor-listed-option-none', { unlistedOption: result.unlisted_option }));
    }
    for (const [index, item] of result.rejected.entries()) {
      if (!ids.has(item.option_id)) {
        reasons.push(reason('advisor-rejected-option-id', { index, optionId: item.option_id }));
      }
      if (item.option_id === chosen) {
        reasons.push(reason('advisor-reject-recommended-option', { index, optionId: chosen }));
      }
    }
    if (scopeResult !== undefined) {
      const riskIds = new Set(scopeResult.predicted_risks.map(({ id }) => id));
      for (const [index, item] of result.risk_outcomes.entries()) {
        if (!riskIds.has(item.risk_id)) {
          reasons.push(reason('advisor-risk-outcome-id', { index, riskId: item.risk_id }));
        }
      }
      for (const id of riskIds) {
        const count = result.risk_outcomes.filter(({ risk_id }) => risk_id === id).length;
        if (count !== 1) {
          reasons.push(reason('advisor-one-outcome-per-risk', { riskId: id, count }));
        }
      }
    }
  }
  checkAdvisorCitations({ phase, result, task, repoRoot, scopeResult }, reasons, reportProblem);
  const phrases = Object.hasOwn(BACKSTOPS, language) ? BACKSTOPS[language] : Object.values(BACKSTOPS).flat();
  const patterns = phrases.map((phrase) => [phrase, backstopPattern(phrase)]);
  for (const { field, value } of strings(result)) {
    for (const [phrase, pattern] of patterns) {
      const match = value.normalize('NFKC').match(pattern);
      if (match) {
        reasons.push(reason('advisor-backstop-phrase', { field, match: match[0], phrase }));
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}
