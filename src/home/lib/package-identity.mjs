/**
 * Names the package, its home directory, and its environment keys.
 * Plan_82 D4 centralizes these spellings so the rename to llm-bridge changes one identity module.
 */
export const PACKAGE_NAME = 'codex-bridge';
export const HOME_DIR_NAME = `.${PACKAGE_NAME}`;

const ENV_PREFIX = 'CODEX_BRIDGE_';
export const ENV_KEYS = Object.freeze({
  home: `${ENV_PREFIX}HOME`,
  runsRoot: 'CODEX_RUNS_ROOT',
});
