import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ANSWER_RULES, answerRuleStatements } from '../../src/home/lib/answer-rules.mjs';
import { INSTRUCTIONS } from '../../src/home/lib/runner/prompts.mjs';
import { QUESTION_KIND, questionMarker } from '../../src/home/lib/runner/question-kind.mjs';

const AGENT = 'codex-scout';
const question = (kind, id = 'Q1') => ({ id, text: 'Explain the source.', kind });
const paragraphLines = [
  `- A sub-question marked ${questionMarker(QUESTION_KIND.WEB_RESEARCH)} asks about sources outside the repository.`,
  '  Answer it from web searches made in this run. In its evidence, cite the absolute HTTP(S) URL',
  '  of each page a fact comes from, taken from what those searches returned.',
  '  A URL from memory whose site no search returned fails the run.',
  '  Never cite a repository `path:line` for it unless a command read that file.',
];
const webGrounding = 'grounded in the code, or for web-research sub-questions in the cited pages';
const orders = [
  ['all-web', [question(QUESTION_KIND.WEB_RESEARCH), question(QUESTION_KIND.WEB_RESEARCH, 'Q2')], true],
  ['mixed', [question(QUESTION_KIND.CODE_REQUIRED), question(QUESTION_KIND.WEB_RESEARCH, 'Q2'),
    question(QUESTION_KIND.STARTUP_CONTEXT, 'Q3')], true],
  ['code-only', [question(QUESTION_KIND.CODE_REQUIRED)], false],
  ['startup-only', [question(QUESTION_KIND.STARTUP_CONTEXT)], false],
  ['no sub-questions', [], false],
  ['archived', [{ id: 'Q1', text: 'Explain the source.' }], false],
];

for (const [name, questions, hasWeb] of orders) {
  test(`${name} scout prompt renders web guidance only for web-research questions`, () => {
    const prompt = INSTRUCTIONS[AGENT]({}, undefined, questions);
    if (hasWeb) {
      assert.equal(prompt.split(paragraphLines.join('\n')).length - 1, 1);
      assert.ok(prompt.includes(`${webGrounding}),`));
    } else {
      for (const sentence of paragraphLines) assert.ok(!prompt.includes(sentence), sentence);
      assert.ok(!prompt.includes(webGrounding));
      assert.ok(prompt.includes('grounded in the code),'));
    }
    assert.ok(prompt.includes('support every fact about the code with a `path:line` reference in where.'));
    if (name === 'mixed') {
      assert.ok(prompt.includes(`marked ${questionMarker(QUESTION_KIND.STARTUP_CONTEXT)} asks about what this run was handed at startup`));
    }
  });

  test(`${name} scout rule statements include W3 web rules only for web-research questions`, () => {
    const statements = answerRuleStatements(AGENT, 'default', { questions });
    const prompt = INSTRUCTIONS[AGENT]({}, undefined, questions);
    const rendered = prompt.split('Rules checked after the run (a filled answer that breaks any one is rejected whole):\n')[1];
    for (const key of ['scout-web-searches', 'scout-web-reference']) {
      const { rule } = ANSWER_RULES[AGENT][key];
      assert.equal(statements.includes(rule), hasWeb, key);
      assert.equal(rendered.split(`- ${rule}\n`).length - 1, hasWeb ? 1 : 0, key);
    }
  });
}

// OW-084 W4: non-web orders must retain their pre-change prompt bytes. Normalize only
// the configured answer language so this regression guard is independent of host settings.
for (const [kind, baseline] of [
  [QUESTION_KIND.CODE_REQUIRED, 'cdf817cc89c6476eb04ac2c679fa3a584c09173e5b3eede4b9235416bdefe6a1'],
  [QUESTION_KIND.STARTUP_CONTEXT, '389aaf2b7d533b41665d08c826b4f743d31a2c83c9895c08f4f15539fe2994a3'],
]) {
  test(`${kind} scout prompt is byte-identical to the pre-W4 baseline`, () => {
    const prompt = INSTRUCTIONS[AGENT]({}, undefined, [question(kind)]);
    const normalized = prompt.replace(
      /(- Write the answer, report_markdown and every text field of result\.json in )[^\n]+(, whatever language the task is written in\.)/,
      '$1English$2',
    );
    assert.equal(createHash('sha256').update(normalized).digest('hex'), baseline);
  });
}
