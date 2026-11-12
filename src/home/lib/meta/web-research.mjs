/** OW-084 R1: bind web-research answers to the searches in their proven resume chain. */
import { QUESTION_KIND } from '../runner/question-kind.mjs';
import { answerRuleMessage } from '../answer-rules.mjs';

const scoutReason = (key, values) => answerRuleMessage('codex-scout', key, values);
const webQuestions = (questions) => (Array.isArray(questions) ? questions : [])
  .filter((question) => question?.kind === QUESTION_KIND.WEB_RESEARCH);
const questionId = (value) => String(value || '').trim().toUpperCase();

export function webResearchBinding(questions, web) {
  if (!webQuestions(questions).length || !web?.chain) return null;
  if (web.chain.with_urls > 0) return 'host';
  // R1 deliberately tolerates CLI shape changes, but still requires an absolute HTTP(S) URL.
  return web.chain.completed > 0 && web.chain.with_urls === 0 ? 'unavailable' : null;
}

export function webResearchGap({ questions, result, web }) {
  const ordered = webQuestions(questions);
  if (!ordered.length) return null;
  // Fail closed: the marker postdates `--json`, so a web-research run without a known chain value
  // (no stream, pruned evidence, or no web fact at all) has nothing that proves a search ran.
  if (!web?.chain || web.chain.completed === 0) {
    return scoutReason('scout-web-searches', {
      questions: ordered.map((question) => question.id).join(', '), gap: web?.gap,
    });
  }
  const binding = webResearchBinding(questions, web);
  if (binding === null) return null;
  const answers = new Map();
  for (const answer of Array.isArray(result?.answers) ? result.answers : []) {
    const id = questionId(answer?.question_id);
    if (id && !answers.has(id)) answers.set(id, answer);
  }
  const unsourced = ordered.filter((question) => {
    const evidence = answers.get(questionId(question.id))?.evidence;
    return !Array.isArray(evidence) || !evidence.some((item) => {
      if (typeof item !== 'string') return false;
      try {
        const url = new URL(item);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        return binding === 'unavailable'
          || web.chain.hosts.includes(url.hostname.toLowerCase().replace(/^www\./, ''));
      } catch { return false; }
    });
  }).map((question) => question.id);
  if (unsourced.length) {
    return scoutReason('scout-web-reference', { questions: unsourced.join(', ') });
  }
  return null;
}
