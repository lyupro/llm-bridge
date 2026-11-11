/** Prints, read-only, the settings.json entries this package's installer would write on this host. */
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';
import { hookTargets } from './hook-targets.mjs';
import { packageInfo } from './manifest.mjs';
import { PERMISSION_RULES, declaredHook } from './settings-declarations.mjs';

export async function settingsExport({ host, env = process.env }) {
  const { name, version } = await packageInfo();
  const { root, source } = resolveBrandHome({ env });
  const targets = hookTargets(host, env);
  const { form, reason } = targets[0].registration;
  // OW-081 R1: derive spellings from declarations rather than maintaining another list.
  const recognizedCommands = [...new Set(PERMISSION_RULES.allow
    .filter((rule) => !rule.endsWith(':*)'))
    .map((rule) => rule.slice(rule.indexOf('(') + 1, -1)))];
  return JSON.stringify({
    schema: 1,
    package: name,
    version,
    platform: process.platform,
    host: { root: host.root, scope: host.scope },
    home: { root, source },
    launcher: { proven: form === 'short', reason, form },
    recognizedCommands,
    permissions: PERMISSION_RULES,
    hooks: targets.map(({ definition, registration, spec }) => ({
      id: definition.name,
      event: spec.event,
      matcher: spec.matcher,
      hook: declaredHook(registration.command),
      alternateCommands: spec.alternateCommands,
    })),
    retired: {
      entries: [],
      boundary: 'Entries of the predecessor package are removed by its own uninstall and are not listed here.',
    },
  }, null, 2);
}
