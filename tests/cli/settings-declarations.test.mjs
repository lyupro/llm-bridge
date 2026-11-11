/** Verifies the shared settings declarations required by OW-081. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { PERMISSION_RULES, declaredHook } from '../../cli/settings-declarations.mjs';

test('permission declarations contain the complete three-category shell matrix', () => {
  assert.deepEqual(Object.keys(PERMISSION_RULES), ['allow', 'deny', 'ask']);
  assert.ok(Object.isFrozen(PERMISSION_RULES));
  for (const [category, suffix] of [['allow', ''], ['deny', ' prune'], ['ask', ' model speed']]) {
    const expected = ['Bash', 'PowerShell'].flatMap((tool) =>
      ['llm-bridge', 'node bin/llm-bridge.mjs'].flatMap((command) =>
        [`${tool}(${command}${suffix})`, `${tool}(${command}${suffix}:*)`]));
    assert.equal(PERMISSION_RULES[category].length, 8);
    assert.deepEqual(PERMISSION_RULES[category], expected);
    assert.ok(Object.isFrozen(PERMISSION_RULES[category]));
  }
});

test('deny rules end in the exact prune forms', () => {
  for (const rule of PERMISSION_RULES.deny) {
    assert.match(rule, / prune(?::\*)?\)$/);
  }
});

test('ask rules end in the exact model speed forms', () => {
  for (const rule of PERMISSION_RULES.ask) {
    assert.match(rule, / model speed(?::\*)?\)$/);
  }
});

test('declaredHook preserves the hook fields and key order in a fresh object', () => {
  const first = declaredHook('x');
  const second = declaredHook('x');
  assert.deepEqual(first, { type: 'command', command: 'x', timeout: 10 });
  assert.deepEqual(second, first);
  assert.deepEqual(Object.keys(first), ['type', 'command', 'timeout']);
  assert.notStrictEqual(first, second);
  first.timeout = 1;
  assert.equal(second.timeout, 10);
});

test('declarations do not import their settings writer or permission consumer', async () => {
  const source = await fs.readFile(new URL('../../cli/settings-declarations.mjs', import.meta.url), 'utf8');
  // OW-081 keeps the declaration independent so installer and export consumers cannot form a cycle.
  assert.doesNotMatch(source, /['"]\.\/(?:settings-merge|permissions)\.mjs['"]/);
});
