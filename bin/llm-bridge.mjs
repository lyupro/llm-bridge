#!/usr/bin/env node
/** Dispatches llm-bridge CLI arguments through the command registry (Plan_71 D1). */
import { isInvokedDirectly } from '../cli/invoked-directly.mjs';
import { packageInfo } from '../cli/manifest.mjs';
import { COMMANDS } from '../cli/command-registry.mjs';
import { helpRequest, renderCommandHelp } from '../cli/command-help.mjs';
import { CLI_NAMES } from '../src/home/lib/cli-names.mjs';

export { commandOptions } from '../cli/command-registry.mjs';

const CLI_NAME = CLI_NAMES[0];
const publicCommands = COMMANDS.filter((entry) => entry.section === 'public');
const commandWidth = Math.max(...publicCommands.map((entry) => entry.name.length));
export const HELP = [
  `${CLI_NAME} — Claude Code dispatchers for Codex`,
  '',
  'Usage:',
  // OW-062: a command and its only action can share a usage line.
  ...new Set(publicCommands.flatMap((entry) => [entry, ...Object.values(entry.actions ?? {})]
    .flatMap((section) => section.usage.map((line) => `  ${line}`)))),
  ...CLI_NAMES.slice(1).map((alias) => `  ${alias} <same command forms as ${CLI_NAME}>`),
  `  ${CLI_NAME} --help`,
  `  ${CLI_NAME} --version`,
  '',
  'Commands:',
  ...publicCommands.map((entry) => `  ${entry.name.padEnd(commandWidth)}  ${entry.summary}`),
  '',
  'Hook dispatch:',
  ...COMMANDS.filter((entry) => entry.section === 'machine')
    .flatMap((entry) => entry.usage.map((line) => `  ${line}  ${entry.summary}`)),
  '',
  `Run ${CLI_NAME} <command> -h for one command.`,
].join('\n');

export async function main(argv, io = console) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    io.log(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    io.log((await packageInfo()).version);
    return 0;
  }
  const entry = COMMANDS.find((candidate) => candidate.name === command);
  if (!entry) {
    io.error(`${CLI_NAME}: unknown command "${command}"\nRun ${CLI_NAME} --help for usage.`);
    return 2;
  }
  const asked = helpRequest(rest, Object.keys(entry.actions ?? {}));
  if (asked) {
    io.log(renderCommandHelp(entry, asked.action));
    return 0;
  }
  return entry.handler(rest, io);
}

if (isInvokedDirectly(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((err) => {
      console.error(`${CLI_NAME}: ${err.message}`);
      process.exitCode = 2;
    });
}
