/**
 * Presents advice checks without owning acceptance rules (Plan_68 D4/D10).
 * Plan_62 D17 makes the installed brand home authoritative: a missing or broken
 * installation must fail visibly rather than silently use the package's rules.
 */
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';

function errorResult(reason) {
  return {
    schema_version: 1, ok: null, kind: null, reason,
    run: null, project: null, phase: null, verdict: null,
  };
}

export async function advice(argv, io = console) {
  const json = argv.includes('--json');
  const values = argv.slice(1).filter((arg) => arg !== '--json');
  const invalid = argv[0] !== 'check' || values.length !== 1
    || !values[0] || values[0].startsWith('-')
    || argv.filter((arg) => arg === '--json').length > 1;
  let result;
  let exitCode = 2;
  if (invalid) {
    result = errorResult('invalid-call');
    io.error('llm-bridge advice: invalid-call; usage: llm-bridge advice check <value> [--json]');
  } else {
    try {
      const home = resolveBrandHome({ homedir: os.homedir(), env: process.env });
      const entry = path.join(home.root, 'lib', 'advice-check.mjs');
      const { checkAdvice, adviceCheckExitCode } = await import(pathToFileURL(entry).href);
      result = await checkAdvice(values[0]);
      exitCode = adviceCheckExitCode(result);
    } catch {
      // D4: loading and checking failures have the same public environment-error contract.
      result = errorResult('environment-error');
      io.error('llm-bridge advice: environment-error; check the installed home with llm-bridge doctor.');
    }
  }
  const verdict = result.ok === true ? 'VALID' : result.ok === false ? 'INVALID' : 'ERROR';
  io.log(json ? JSON.stringify(result)
    : `${verdict}: ${result.reason}${result.run ? ` (${result.run})` : ''}`);
  return exitCode;
}
