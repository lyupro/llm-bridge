/** Re-enters the shared rules decision without an owner view (Plan_83 D7 (8) / D8). */
import path from 'node:path';
import { RULES_NAME } from './install-record.mjs';
import { preflightRulesRemoval, rulesDryRunLines, removeRulesForHost } from './uninstall-rules.mjs';
import { recordHomeWriter } from './record-removal.mjs';

export async function preflightRulesReentry(host, inspection, { registryError, ownHomeAttested }) {
  if (inspection.settingsError != null) return null;
  // D8: null means only retained evidence for this rules path can prove integrity.
  const plan = await preflightRulesRemoval(path.join(host.codexRulesDir, RULES_NAME), null,
    { host, registryError, ownHomeAttested });
  return plan.exists || plan.index || plan.registryError ? plan : null;
}

export async function runRulesReentry(options, plan, { detached, answer, registryError }) {
  const input = { host: options.host, record: null, registry: null, registryError, detached, plan };
  if (options.dryRun) return rulesDryRunLines(input);
  // D7 (8): outside-home removal requires the same boundary guard as an owned file.
  return removeRulesForHost({ ...input, answer, writer: recordHomeWriter(options.host, []) });
}
