/** OW-084 W5: preserve the scout rule's identity without parsing its diagnostic prose. */
import { answerRuleMessage } from '../answer-rules.mjs';

export function scoutAnswerRuleGap(key, values = {}) {
  return { key, reason: answerRuleMessage('codex-scout', key, values) };
}
