/** Checks OW-097 catalog registration and message inputs because both prompt and judge rely on them. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ANSWER_RULES, answerRuleMessage, answerRuleStatements, validateAnswerRules } from '../src/home/lib/answer-rules.mjs';
import { RULES } from '../src/home/lib/answer-rules/arbiter.mjs';

const AGENT = 'codex-arbiter';

test('registers a valid arbiter catalog with unconditional default-phase rules', () => {
  assert.equal(ANSWER_RULES[AGENT], RULES);
  assert.doesNotThrow(() => validateAnswerRules({ [AGENT]: RULES }));
  for (const [key, rule] of Object.entries(RULES)) {
    assert.match(key, /^arbiter-/);
    assert.deepEqual(rule.phases, ['default']);
    assert.equal(rule.when, 'always');
  }
  assert.deepEqual(answerRuleStatements(AGENT, 'default'), Object.values(RULES).map(({ rule }) => rule));
  assert.deepEqual(answerRuleStatements(AGENT, 'advise'), []);
});

test('every arbiter judge rule produces a message through the catalog with its declared inputs', () => {
  const fixtures = { field: 'checks[0].evidence[0]', label: 'src/gate.mjs:2', count: 1, codePoint: 'U+0000', id: 'gate' };
  for (const [key, entry] of Object.entries(RULES)) {
    const values = Object.fromEntries(entry.data.map((name) => {
      assert.ok(Object.hasOwn(fixtures, name), `${key} has no fixture for ${name}`);
      return [name, fixtures[name]];
    }));
    const message = answerRuleMessage(AGENT, key, values);
    assert.ok(message.trim(), key);
    for (const value of Object.values(values)) assert.ok(message.includes(String(value)), key);
  }
  assert.throws(() => answerRuleMessage(AGENT, 'arbiter-citation-line-range', {
    field: fixtures.field, label: fixtures.label,
  }), /invalid answer rule values/);
});
