/** Guards the Plan_60 D1 / OW-084 R1 orderer-only markers and ordered question-kind transport. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_ONLY_MARKER, QUESTION_KIND, QUESTION_KINDS, questionMarker, questionKindRefusal, questionsFromTexts,
  questionListLines,
} from '../../src/home/lib/runner/question-kind.mjs';

import { orderRuleMessage, ORDER_RULES } from '../../src/home/lib/order-rules.mjs';

const refused = [
  '[Context-Only] x',
  '[context only] x',
  '[context_only] x',
  'x [context-only]',
  '[context-only] a [context-only] b',
  '[context-only]x',
  '[context-only]',
  '[context-only]   ',
  '[ context--__ only ] x',
  ' [context-only] x',
  '[context-only] a [Context Only] b',
  '[context-only]\t\n',
  '[web-reserch] x',
  '[ web-research ] x',
  '[Web-Research] x',
  '[another_kind] x',
  'x [web-research] y',
  ' [web-research] x',
  '[web-research] a [web-research] b',
  '[context-only] a [web-research] b',
  '[web-research] a [context-only] b',
  '[web-research]x',
  '[web-research]',
  '[web-research]   ',
  '[web-research]\t\n',
];

for (const text of refused) {
  test(`refuses ${JSON.stringify(text)} with its question number and quoted text`, () => {
    const reason = questionKindRefusal(['An ordinary question.', text]);
    assert.equal(reason, orderRuleMessage('question-kind-marker', { index: 1, text }));
    assert.match(reason, /Q2/);
    assert.ok(reason.includes(JSON.stringify(text)));
    assert.doesNotMatch(reason, /[\r\n]/);
    assert.throws(() => questionsFromTexts(['An ordinary question.', text]), { message: reason });
  });
}

test('an exact prefix strips its marker and following whitespace while retaining the question', () => {
  const text = `${CONTEXT_ONLY_MARKER} \t\nWhat were you handed?  `;
  assert.equal(questionKindRefusal([text]), null);
  assert.deepEqual(questionsFromTexts([text]), [
    { id: 'Q1', text: 'What were you handed?  ', kind: QUESTION_KIND.STARTUP_CONTEXT },
  ]);
});

test('an unmarked question is retained byte for byte', () => {
  const text = ' \tWhere is the code?\n  ';
  assert.equal(questionKindRefusal([text]), null);
  assert.deepEqual(questionsFromTexts([text]), [
    { id: 'Q1', text, kind: QUESTION_KIND.CODE_REQUIRED },
  ]);
});

test('mixed question kinds preserve order and consecutive ids', () => {
  assert.deepEqual(questionsFromTexts(['First?', '[context-only] Second?', 'Third?', '[web-research] Fourth?']), [
    { id: 'Q1', text: 'First?', kind: 'code-required' },
    { id: 'Q2', text: 'Second?', kind: 'startup-context' },
    { id: 'Q3', text: 'Third?', kind: 'code-required' },
    { id: 'Q4', text: 'Fourth?', kind: 'web-research' },
  ]);
});

test('empty input is accepted and the kind vocabulary is frozen', () => {
  assert.equal(questionKindRefusal(), null);
  assert.deepEqual(questionsFromTexts(), []);
  assert.equal(CONTEXT_ONLY_MARKER, '[context-only]');
  assert.deepEqual(QUESTION_KIND, {
    STARTUP_CONTEXT: 'startup-context', WEB_RESEARCH: 'web-research', CODE_REQUIRED: 'code-required',
  });
  assert.ok(Object.isFrozen(QUESTION_KIND));
});

test('a web research prefix strips only its marker and following whitespace', () => {
  const text = '[web-research] \t\nWhat changed outside the repository?  ';
  assert.equal(questionKindRefusal([text]), null);
  assert.deepEqual(questionsFromTexts([text]), [
    { id: 'Q1', text: 'What changed outside the repository?  ', kind: QUESTION_KIND.WEB_RESEARCH },
  ]);
});

for (const text of ['[OW-084] Explain the order.', '[1] Explain the item.', '[question?] Explain.',
  '[a.b] Explain.', '[web/research] Explain.']) {
  test(`a leading bracket token with other characters is ordinary text: ${text}`, () => {
    assert.equal(questionKindRefusal([text]), null);
    assert.deepEqual(questionsFromTexts([text]), [{ id: 'Q1', text, kind: QUESTION_KIND.CODE_REQUIRED }]);
  });
}

test('the frozen table supplies every kind and its prompt marker', () => {
  assert.deepEqual(QUESTION_KINDS, [
    { marker: '[context-only]', kind: 'startup-context' },
    { marker: '[web-research]', kind: 'web-research' },
    { marker: null, kind: 'code-required' },
  ]);
  assert.ok(Object.isFrozen(QUESTION_KINDS));
  for (const entry of QUESTION_KINDS) {
    assert.ok(Object.isFrozen(entry));
    assert.equal(questionMarker(entry.kind), entry.marker);
    if (entry.marker) assert.ok(ORDER_RULES['question-kind-marker'].rule.includes(entry.marker));
  }
  assert.throws(() => questionMarker('unknown'), /Unknown question kind: unknown/);
});

test('the sub-question rows handed to Codex carry each orderer marker from the table', () => {
  // OW-084: dropping the marker here would hide the question kind from the scout without any refusal.
  const questions = questionsFromTexts([
    '[context-only] What was handed at startup?',
    '[web-research] Which providers sell news history?',
    'What does the source export?',
  ]);
  assert.deepEqual(questionListLines(questions), [
    'Q1 [context-only]: What was handed at startup?',
    'Q2 [web-research]: Which providers sell news history?',
    'Q3: What does the source export?',
  ]);
});
