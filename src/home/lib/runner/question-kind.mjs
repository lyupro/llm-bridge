/**
 * Classifies orderer-marked scout questions and refuses malformed markers before quota is spent.
 * Plan_60 D1 / OW-084 R1: only the orderer chooses startup context, web research or code;
 * the scout cannot choose its own kind.
 */
import { orderRuleMessage } from '../order-rules.mjs';

export const QUESTION_KIND = Object.freeze({
  STARTUP_CONTEXT: 'startup-context',
  WEB_RESEARCH: 'web-research',
  CODE_REQUIRED: 'code-required',
});

export const QUESTION_KINDS = Object.freeze([
  Object.freeze({ marker: '[context-only]', kind: QUESTION_KIND.STARTUP_CONTEXT }),
  Object.freeze({ marker: '[web-research]', kind: QUESTION_KIND.WEB_RESEARCH }),
  Object.freeze({ marker: null, kind: QUESTION_KIND.CODE_REQUIRED }),
]);

export const CONTEXT_ONLY_MARKER = QUESTION_KINDS.find(
  ({ kind }) => kind === QUESTION_KIND.STARTUP_CONTEXT,
).marker;

export function questionMarker(kind) {
  const entry = QUESTION_KINDS.find((entry) => entry.kind === kind);
  if (!entry) throw new RangeError(`Unknown question kind: ${kind}`);
  return entry.marker;
}

/** The sub-question rows Codex is handed: each carries its orderer's marker, read from the same table. */
export function questionListLines(questions = []) {
  return questions.map((q) => `${q.id}${questionMarker(q.kind) ? ` ${questionMarker(q.kind)}` : ''}: ${q.text}`);
}

export function questionKindRefusal(texts = []) {
  for (const [index, text] of texts.entries()) {
    const tokens = text.matchAll(/\[[a-z\s_-]+\]/gi);
    for (const token of tokens) {
      // Plan_60 D1: keep refusing misplaced spelling variants of registered markers too.
      const normalized = token[0].toLowerCase().replace(/[\s_-]/g, '');
      const entry = QUESTION_KINDS.find(({ marker }) => marker
        && marker.replace(/[\s_-]/g, '') === normalized);
      if ((token.index === 0 && /^\[[a-z _-]+\]$/i.test(token[0]) && !entry)
          || (entry && (token.index !== 0 || token[0] !== entry.marker))) {
        return orderRuleMessage('question-kind-marker', { index, text });
      }
    }
    const entry = QUESTION_KINDS.find(({ marker }) => marker && text.startsWith(marker));
    if (entry) {
      const question = text.slice(entry.marker.length);
      if (!/^\s/.test(question) || !question.trim()) {
        return orderRuleMessage('question-kind-marker', { index, text });
      }
    }
  }
  return null;
}

export function questionsFromTexts(texts = []) {
  const refusal = questionKindRefusal(texts);
  if (refusal) throw new Error(refusal);
  return texts.map((text, index) => {
    const entry = QUESTION_KINDS.find(({ marker }) => marker === null || text.startsWith(marker));
    return {
      id: `Q${index + 1}`,
      text: entry.marker ? text.slice(entry.marker.length).replace(/^\s+/, '') : text,
      kind: entry.kind,
    };
  });
}
