/** OW-092 D1: only a refused path inside the build's scope can explain its failure. */
import { answerRuleMessage } from '../answer-rules.mjs';
import { requiresOutcome } from './outcome.mjs';

const buildReason = (key, values) => ({ reason: answerRuleMessage('codex-build', key, values), key });

export function writeRefusalGap(refusal, { resultOk, exit, result, runDir }) {
  if (!refusal) return null;
  const failed = !resultOk || exit !== 0 || result?.verify_passed === false
    || (result?.outcome === 'fail' && requiresOutcome(runDir));
  if (!failed) return null;
  const files = refusal.paths.filter(({ inScope }) => inScope === true).map(({ path }) => path);
  if (!files.length) return null;
  return buildReason('build-scope-write-refused', { files });
}
