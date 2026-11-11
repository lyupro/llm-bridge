/** The single declaration of every entry this package writes into the host settings.json. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_NAMES } from '../src/home/lib/cli-names.mjs';
import { SHELL_TOOLS } from '../src/home/lib/hook-definitions.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = fileURLToPath(new URL('../bin/llm-bridge.mjs', import.meta.url));
const nodeCommand = `node ${path.relative(packageRoot, entryPoint).split(path.sep).join('/')}`;
const commandNames = Object.freeze([...CLI_NAMES, nodeCommand]);
const formsFor = (command) => [command, `${command}:*`];

function buildRules(commandTransform) {
  return Object.freeze(SHELL_TOOLS.flatMap((tool) => commandNames.flatMap((command) =>
    formsFor(commandTransform(command)).map((form) => `${tool}(${form})`))));
}

/**
 * The executable names stay owned by cli-names.mjs; only the clone entry point is derived here.
 * Plan_22 records the incident because repeating the node spelling in CLI_NAMES would make the
 * source list answer two different questions and let a future alias bypass one of them.
 *
 * The deny half subtracts `prune` from the allow half rather than guarding it: `Bash(llm-bridge:*)`
 * would otherwise hand out the deletion this package refuses to give an agent. Plan_56's
 * 2026-09-07 reconnaissance established deny, ask, allow ordering before PreToolUse hooks:
 * the narrow speed ask therefore wins over the broad allow, and no hook can waive it.
 */
export const PERMISSION_RULES = Object.freeze({
  allow: buildRules((command) => command),
  deny: buildRules((command) => `${command} prune`),
  ask: buildRules((command) => `${command} model speed`),
});

export function declaredHook(command) {
  return { type: 'command', command, timeout: 10 };
}
