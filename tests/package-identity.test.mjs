/** Guards Plan_82 D4: centralizing identity must preserve today's names until the rename. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ENV_KEYS, HOME_DIR_NAME, PACKAGE_NAME } from '../src/home/lib/package-identity.mjs';
import { CLI_NAMES } from '../src/home/lib/cli-names.mjs';
import { claudePaths } from '../src/home/lib/claude-layout.mjs';
import { RULES_NAME } from '../cli/install-record.mjs';
import { RULES_REGISTRY_NAME } from '../cli/rules-owners.mjs';

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

test('host folders and Codex rules names derive from the current package name', () => {
  const root = path.resolve('identity-test-root');
  const paths = claudePaths(root);
  for (const [key, folder] of [
    ['agentsDir', 'agents'],
    ['commandsDir', 'commands'],
    ['rulesDir', 'rules'],
  ]) {
    assert.equal(paths[key], path.join(root, folder, 'codex-bridge'));
    assert.equal(path.basename(paths[key]), PACKAGE_NAME);
  }
  assert.equal(RULES_NAME, 'codex-bridge.rules');
  assert.equal(RULES_NAME, `${PACKAGE_NAME}.rules`);
  assert.equal(RULES_REGISTRY_NAME, '.codex-bridge-rules.json');
  assert.equal(RULES_REGISTRY_NAME, `.${PACKAGE_NAME}-rules.json`);
});
