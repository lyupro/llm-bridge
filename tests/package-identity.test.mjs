/** Guards Plan_82 D4: centralizing identity must preserve today's names until the rename. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENV_KEYS, HOME_DIR_NAME, PACKAGE_NAME } from '../src/home/lib/package-identity.mjs';
import { CLI_NAMES } from '../src/home/lib/cli-names.mjs';

test('package identity keeps the current package and derived home directory names', () => {
  assert.equal(PACKAGE_NAME, 'codex-bridge');
  assert.equal(HOME_DIR_NAME, '.codex-bridge');
  assert.equal(HOME_DIR_NAME, `.${PACKAGE_NAME}`);
});

test('environment identity contains only the current home and runs keys and is frozen', () => {
  assert.deepEqual(ENV_KEYS, { home: 'CODEX_BRIDGE_HOME', runsRoot: 'CODEX_RUNS_ROOT' });
  assert.ok(Object.isFrozen(ENV_KEYS));
  assert.throws(() => { ENV_KEYS.home = 'LLM_BRIDGE_HOME'; }, TypeError);
});

test('CLI names keep the current frozen aliases with the package name first', () => {
  assert.deepEqual(CLI_NAMES, ['codex-bridge', 'codexb']);
  assert.equal(CLI_NAMES[0], PACKAGE_NAME);
  assert.ok(Object.isFrozen(CLI_NAMES));
});
