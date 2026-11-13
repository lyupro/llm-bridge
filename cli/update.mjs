/** Updates a recorded installation without overwriting unapproved host changes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { packageSource, sourceAt, checkoutAt } from './package-source.mjs';
import { install } from './install.mjs';
import { syncOtherOwners } from './owner-sync-apply.mjs';
import {
  buildInstallPlan,
  fileFingerprint,
  HOOK_DEFINITIONS,
  installedHookPath,
  packageInfo,
  recordFileKey,
  readInstallRecord,
  recordMatchesPackage,
  recordTarget,
  rulesPlan,
} from './manifest.mjs';
import { targetMatches } from './copy.mjs';
import { hookTargets, recordHasHooks } from './hook-targets.mjs';
import { definitionForRecordedHook, fileEntry, fingerprintFor, readInstallRecordFile, writeInstallRecord } from './install-record.mjs';
import { hasOwnPending, pendingOutput, publishPending } from './install-pending.mjs';
import { ownImageStampCurrent } from './install-owners.mjs';
import {
  commandFor,
  inspectHook,
  removeHook,
  withSettingsRun,
} from './settings-merge.mjs';
import { withLifecycle } from './lifecycle-transaction.mjs';
import { withRulesDirLock } from './rules-dir-lock.mjs';
import { addRulesOwner, readRulesRegistry } from './rules-owners.mjs';
import { recordHomeWriter, removeRecordedFile } from './record-removal.mjs';
import { askTransition, detectTransition, transitionOutcome } from './inventory-transition.mjs';
import { hasPackageMarks, inspectHost } from './host-inspection.mjs';

async function exists(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

function displayFile(file) {
  const entry = fileEntry(file);
  return `${entry.root}/${entry.path}`;
}

function classifyPlanned(state, { adoptUnrecorded = false } = {}) {
  // A planned path the record does not name but someone already filled is not ours to overwrite:
  // install refuses it without --force, and update used to call it 'new' and copy over it — for
  // the host rules file (Plan_64 B2c) that would silently replace the operator's own text.
  if (!state.recorded) return state.exists && !state.matchesPackage && !adoptUnrecorded ? 'unowned' : 'new';
  if (!state.exists) return 'missing';
  if (state.matchesPackage) return 'up-to-date';
  if (state.recordedFingerprint === state.fingerprint) return 'outdated';
  return 'modified';
}

function classifyOrphan(state) {
  if (!state.exists) return 'orphaned';
  if (state.recordedFingerprint === state.fingerprint) return 'orphaned';
  return 'modified';
}

function appliedOutput(states) {
  const count = (status) => states.filter((state) => state.status === status).length;
  const parts = [
    [count('outdated'), 'updated'],
    [count('new'), 'added'],
    [count('missing'), 'restored'],
    [states.filter((state) => ['modified', 'unowned'].includes(state.status) && state.item).length, 'overwritten'],
    [states.filter((state) => state.status === 'orphaned' && state.exists).length, 'removed'],
  ].filter(([total]) => total > 0).map(([total, label]) => `${total} ${label}`);
  return parts.length ? `Updated llm-bridge: ${parts.join(', ')}.` : 'Updated llm-bridge.';
}

function conflictOutput(conflicts, legacy, dryRun) {
  const heading = dryRun ? 'Update would stop for these paths:' : 'Update stopped for these paths:';
  const lines = conflicts.map((state) => `  ${state.relative} (${state.status})`);
  if (legacy) lines.push('Installation record has no fingerprints; differing files are treated as modified.');
  lines.push('Run update again with --force to overwrite modified or unowned files and restore missing files.');
  return [heading, ...lines].join('\n');
}

function dryRunOutput(states, hookStates, legacy, oldHooks) {
  const lines = [];
  for (const state of states) {
    if (state.status === 'outdated') lines.push(`Would update ${state.relative}.`);
    if (state.status === 'new') lines.push(`Would create ${state.relative}.`);
    if (['modified', 'unowned'].includes(state.status) && state.item) lines.push(`Would overwrite ${state.relative}.`);
    if (state.status === 'missing') lines.push(`Would restore ${state.relative}.`);
    if (state.status === 'orphaned' && state.exists) lines.push(`Would remove ${state.relative}.`);
    if (state.status === 'modified' && !state.item) lines.push(`Would preserve modified orphan ${state.relative}.`);
  }
  // previousHooks() returns {hook, definition, spec}, and reading .event off that wrapper printed
  // "the previous undefined hook registration" five times during the Plan_25 migration — the one
  // dry run where the operator most needed to see which registrations were about to be taken away.
  oldHooks.forEach(({ hook, definition }) => lines.push(
    `Would remove the previous ${hook.event} hook registration ${definition.name} for matcher ${definition.matcher}.`,
  ));
  hookStates.forEach(({ state, target }) => {
    const { definition, registration } = target;
    if (state.present && !state.current) {
      lines.push(`Would rewrite ${definition.event} hook ${definition.name} for matcher ${definition.matcher} to ${registration.form} command: ${registration.reason}.`);
    } else if (!state.present) {
      lines.push(`Would register ${definition.event} hook ${definition.name} for matcher ${definition.matcher} with ${registration.form} command.`);
    }
  });
  lines.push('Would write installation record with new fingerprints in both roots.');
  if (legacy && states.some((state) => state.status === 'modified')) {
    lines.push('Installation record has no fingerprints; differing files are treated as modified.');
  }
  return lines.join('\n');
}

function previousHooks(host, record, targets) {
  return record.hooks.filter((hook) => {
    const current = targets.find(({ definition, relative }) =>
      definition.event === hook.event && hook.root === 'brand' && relative === hook.path);
    return !current;
  }).map((hook) => {
    const definition = definitionForRecordedHook(hook);
    const target = recordTarget(host, hook);
    return {
      hook,
      definition,
      spec: {
        event: hook.event,
        matcher: definition.matcher,
        command: hook.command || commandFor(target),
        alternateCommands: [commandFor(target), `llm-bridge hook ${definition.name}`],
      },
    };
  });
}

async function updateInRun({
  host,
  dryRun = false,
  force = false,
  packageRoot,
  env = process.env,
  lifecycleTicket,
  rulesTicket,
  isTTY,
  prompt,
  stdin,
  promptOutput,
} = {}) {
  await readRulesRegistry(host);
  const record = await readInstallRecord(host);
  const rawRecord = await readInstallRecordFile(host);
  if (!record) {
    // Plan_65 D10 item 6: a host that carries our files or hooks but has no row (legacy is nobody's view
    // since H5) is recorded by what is actually there. Install owns that — conflicts for edited files, the
    // transition question — and update has changed nothing yet, so the question still precedes any change.
    const inspection = await inspectHost(host);
    if (!hasPackageMarks(inspection)) {
      return { exitCode: 1, output: 'llm-bridge is not installed. Run llm-bridge install first.' };
    }
    const installed = await install({
      host,
      pendingCommand: 'update',
      dryRun,
      force,
      packageRoot,
      env,
      lifecycleTicket,
      rulesTicket,
      isTTY,
      prompt,
      stdin,
      promptOutput,
    });
    if (!dryRun && (installed.exitCode === 0 || installed.ownerSync?.complete === false)) {
      await writeInstallRecord(host, await readInstallRecord(host), { completes: true });
    }
    return {
      exitCode: installed.exitCode,
      output: `No installation record names ${host.root}; recording what is installed.\n${installed.output}`,
    };
  }
  const writer = recordHomeWriter(host, record.files);

  const plan = await buildInstallPlan(host, packageRoot);
  const rule = { ...rulesPlan(host, packageRoot), processing: 'copy' };
  const planned = new Map(plan.map((item) => [recordFileKey(item), item]));
  const plannedStates = await Promise.all(plan.map(async (item) => {
    const relative = displayFile(item);
    const targetExists = await exists(item.target);
    const state = {
      relative,
      item,
      recorded: record.files.some((file) => recordFileKey(file) === recordFileKey(item)),
      recordedFingerprint: fingerprintFor(record, item),
      exists: targetExists,
      matchesPackage: targetExists && await targetMatches(item, host.brandRoot),
      fingerprint: targetExists ? await fileFingerprint(item.target) : null,
    };
    return { ...state, status: classifyPlanned(state) };
  }));
  const ruleExists = await exists(rule.target);
  const ruleState = {
    relative: rule.target,
    item: rule,
    recorded: Boolean(record.rules),
    recordedFingerprint: record.rules?.fingerprint,
    exists: ruleExists,
    matchesPackage: ruleExists && await targetMatches(rule, host.brandRoot),
    fingerprint: ruleExists ? await fileFingerprint(rule.target) : null,
  };
  // Records written before the Codex rules file was recorded name no rules, yet the file under the
  // package's own name was written by this package: adopting it is the migration, not a collision.
  ruleState.status = classifyPlanned(ruleState, { adoptUnrecorded: true });
  const orphanStates = await Promise.all(record.files
    .filter((file) => !planned.has(recordFileKey(file)))
    .map(async (file) => {
      const target = recordTarget(host, file);
      const targetExists = await exists(target);
      const state = {
        relative: displayFile(file),
        entry: fileEntry(file),
        item: null,
        exists: targetExists,
        recordedFingerprint: fingerprintFor(record, file),
        fingerprint: targetExists ? await fileFingerprint(target) : null,
      };
      return { ...state, status: classifyOrphan(state) };
    }));
  const states = [...plannedStates, ruleState, ...orphanStates];
  const conflicts = states.filter((state) => ['modified', 'unowned', 'missing'].includes(state.status));
  const legacy = !record.fingerprints;
  if (conflicts.length && !force) {
    return { exitCode: 1, output: conflictOutput(conflicts, legacy, dryRun) };
  }

  // Plan_65 D9: ask before the first change (orphans, hooks) and hand install the one
  // answer: after that cleanup the nested run could neither ask honestly nor recount homeHadImage.
  const { transition, homeHadImage } = await detectTransition(host);
  let inventory;
  if (transition && !dryRun) {
    inventory = await askTransition(host, { isTTY, prompt, stdin, promptOutput });
    if (inventory === 'cancel') {
      return { exitCode: 130, output: 'Cancelled; nothing was changed.' };
    }
  }

  const currentPackage = await packageInfo(packageRoot);
  // The 2026-09-07, 0.6.0 install incident hid which package's files update actually compared.
  const resolved = packageRoot ? sourceAt(packageRoot) : packageSource();
  const source = `${currentPackage.name}@${currentPackage.version} from ${resolved.root}`
    + ` (${resolved.kind === 'installed copy' ? 'installed package' : resolved.kind})`;
  // Standing in one checkout while another copy answers is how that install went wrong: the reply
  // was true about the package that ran and silent about the one the operator had on screen.
  const elsewhere = checkoutAt(env.LLM_BRIDGE_CWD ?? process.cwd(), resolved);
  const mismatch = elsewhere && elsewhere.version !== currentPackage.version
    ? `\nRun from ${currentPackage.version}; the checkout at ${elsewhere.root} is ${elsewhere.version}.`
      + ' The home was updated from the copy that answered, not from that checkout'
      + ` (npm i -g ${currentPackage.name}@${elsewhere.version} changes which one that is).`
    : '';
  const targets = hookTargets(host, env);
  const inspectedHooks = await Promise.all(targets.map(async (target) => ({
    target,
    state: await inspectHook(host.settingsPath, target.spec),
  })));
  const oldHooks = previousHooks(host, record, targets);
  const recordCurrent = recordMatchesPackage(record, plan, currentPackage,
    new Map(plannedStates.map((state) => [recordFileKey(state.item), state.fingerprint])),
    { path: rule.target, fingerprint: ruleState.fingerprint });
  // Plan_65 D9: a format-1 migration remains work when every installed file is current.
  const changed = transition || states.some((state) => state.status !== 'up-to-date') || oldHooks.length > 0;
  // D11: the command doctor recommends must clear its warning about this host's image stamp.
  if (!hasOwnPending(rawRecord, host) && !changed && inspectedHooks.every(({ state }) => state.current)
    && recordHasHooks(record, targets) && recordCurrent && ownImageStampCurrent(rawRecord, host)) {
    if (!dryRun) {
      await addRulesOwner(host);
    }
    const ownerSync = await syncOtherOwners(host, { packageRoot, env, dryRun });
    return {
      exitCode: ownerSync.complete ? 0 : 1,
      output: [`llm-bridge is up to date with ${source}${mismatch}`, ...ownerSync.lines]
        .filter(Boolean).join('\n'),
    };
  }
  if (dryRun) {
    const ownerSync = await syncOtherOwners(host, { packageRoot, env, dryRun });
    return {
      exitCode: 0,
      output: [`Would update llm-bridge with ${source}.${mismatch}`,
        ...(transition ? [`A real run would ask whether this host is the only one using ${host.brandRoot}.`] : []),
        dryRunOutput(states, inspectedHooks, legacy, oldHooks), ...ownerSync.lines]
        .filter(Boolean).join('\n'),
    };
  }

  await publishPending(host, 'update', currentPackage);
  for (const state of orphanStates) {
    if (state.status !== 'orphaned' || !state.exists) continue;
    await removeRecordedFile(host, writer, state.entry);
  }
  for (const { spec, hook } of oldHooks) {
    await removeHook(host.settingsPath, spec, { createdGroup: hook.createdGroup === true });
  }
  const installed = await install({
    host,
    pendingCommand: 'update',
    force: true,
    packageRoot,
    env,
    lifecycleTicket,
    rulesTicket,
    isTTY,
    prompt,
    stdin,
    promptOutput,
    inventoryTransition: { transition, homeHadImage, inventory },
  });
  // Plan_65 D7: another owner left behind must not prevent this host's retirement and summary.
  if (installed.exitCode !== 0 && installed.ownerSync?.complete !== false) return installed;
  await writeInstallRecord(host, await readInstallRecord(host), { completes: true });
  const outcome = transition ? transitionOutcome(host, inventory) : null;
  return {
    exitCode: installed.exitCode,
    output: [`${appliedOutput(states)}\nSource: ${source}${mismatch}`, outcome,
      ...installed.ownerSync.lines]
      .filter(Boolean).join('\n'),
  };
}

export async function update(options = {}) {
  const host = options?.host;
  if (!host?.settingsPath) return updateInRun(options);
  // A dry run only reads; like install's, it must not wait on or create anything.
  const run = async (runOptions) => pendingOutput(host, await updateInRun(runOptions));
  if (options.dryRun === true) return withSettingsRun(host.settingsPath, () => run(options));
  // Plan_83 D2 / OW-086, risk r2: home before rules, reverse release; no other home's lock inside.
  return withLifecycle(
    host,
    'update',
    (ticket) => withRulesDirLock(host, 'update', (rulesTicket) =>
      withSettingsRun(host.settingsPath, () => run({ ...options, lifecycleTicket: ticket, rulesTicket })),
    { ticket: options.rulesTicket }),
    { ticket: options.lifecycleTicket, waitMs: options.lifecycleWaitMs },
  );
}
