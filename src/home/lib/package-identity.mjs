/**
 * Names the package, its home directory, and its environment keys.
 * Plan_82 D4 centralizes these spellings so the rename to llm-bridge changes one identity module.
 */
export const PACKAGE_NAME = 'llm-bridge';
export const HOME_DIR_NAME = `.${PACKAGE_NAME}`;

const ENV_PREFIX = 'LLM_BRIDGE_';
export const ENV_KEYS = Object.freeze({
  home: `${ENV_PREFIX}HOME`,
  runsRoot: 'LLM_BRIDGE_RUNS_ROOT',
});
