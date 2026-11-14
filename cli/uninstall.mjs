/**
 * Uninstalls one host: its side from an inspection of the package's marks, the shared image only from
 * the record and only once the host is detached, preserving host data and foreign files (Plan_65 D10).
 */
import { readInstallRecord } from './manifest.mjs';
import { imageRemoval } from './install-owners.mjs';
import { buildHomeRemovalPlan } from './home-removal-plan.mjs';
import { asFormat2, readInstallRecordFile } from './install-record.mjs';
import { hasOwnPending } from './install-pending.mjs';
import { pendingUninstallView, pendingImageLine, imageOwnershipUnknown,
  pendingRemovalPlan, pendingDepartureLine } from './uninstall-pending.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { removePermissionRules } from './permissions.mjs';
import { inspectHost, hasPackageMarks } from './host-inspection.mjs';
import { removeHostSide } from './host-removal.mjs';
import { askRemoval, removalHint } from './inventory-removal.mjs';
import { withSettingsRun } from './settings-merge.mjs';
import { withLifecycle } from './lifecycle-transaction.mjs';
import { withRulesDirLock } from './rules-dir-lock.mjs';
import { readRulesRegistry } from './rules-owners.mjs';
import { readRulesIndex } from './rules-index.mjs';
import { rulesOwnerHints } from './rules-ownership.mjs';
import { rulesDryRunLines, removeRulesForHost, remainingOwnersText, preflightRulesRemoval } from './uninstall-rules.mjs';
import { confirmRulesRetirement } from './rules-retirement.mjs';
import { preflightRulesReentry, runRulesReentry } from './uninstall-rules-reentry.mjs';
import { removeEmpty } from './remove-layout.mjs';
import { recordHomeWriter } from './record-removal.mjs';
import { executeHomePlan } from './home-plan-execute.mjs';
import { outcomeLines, outcomeExitCode, planLines, planExitCode } from './removal-outcomes.mjs';

function permissionOutput(host, removed, dryRun) {
  const verb = dryRun ? 'Would remove' : 'Removed';
  const plural = removed === 1 ? 'string' : 'strings';
  return `${verb} ${removed} permission rule ${plural} from ${host.settingsPath}.`;
}

// Permission strings live in the same settings.json as the hooks; an unreadable file is left untouched
// and named rather than rewritten, like the hooks themselves (Plan_65 D10 item 4).
export async function removePermissions(host, inspection, dryRun) {
  if (inspection.settingsError !== null) {
    return `Left permission rules in ${host.settingsPath} because \
settings could not be read: ${inspection.settingsError}`;
  }
  const { removed } = await removePermissionRules(host.settingsPath, { dryRun });
  return permissionOutput(host, removed, dryRun);
}

export function stillAttachedLine(host) {
  return `Did not finish uninstalling llm-bridge: ${host.root} still has its hooks; fix \
${host.settingsPath} and run uninstall again.`;
}

// Plan_65 D6: uninstalling one host removed the shared image from under every other host of the
// home. Only a record at the old per-host path (no home record at all) keeps the old behavior.
function imageDecision(rawRecord, host) {
  if (rawRecord === null) return { removeImage: true };
  return imageRemoval(asFormat2(rawRecord, host), host);
}

// Plan_65 D12: only a detached last owner permits the plan to remove the shared image.
function imagePolicyFor(decision, hostSide) {
  if (!decision.removeImage) return { remove: false, reason: decision.reason };
  return hostSide.detached
    ? { remove: true, reason: 'last owner' }
    : { remove: false, reason: 'this host is still attached' };
}

function imageDispositionLine(host, decision, dryRun) {
  if (decision.removeImage) return null;
  const pendingLine = pendingImageLine(host, decision, dryRun);
  if (pendingLine) return pendingLine;
  const verb = dryRun ? 'Would leave' : 'Left';
  if (decision.reason === 'no-record') {
    return `${verb} the shared image in ${host.brandRoot} because \
this host has no installation record; its members are unknown.`;
  }
  if (decision.reason === 'other-owners') {
    return `${verb} the shared image in ${host.brandRoot} because ${remainingOwnersText(decision.remaining)}.`;
  }
  return `${verb} the shared image in ${host.brandRoot} because \
the installation inventory is incomplete: other installations may use this home.`;
}

// Plan_65 D9 item 3 as amended by D10 item 4: after the last known owner answered "no", a repeat uninstall
// of ANY host of the home promised a question and printed "not installed" instead. The branch decides from
// the raw record and the inspection only — `legacy` is nobody's host view (D10 item 5) — removes the named
// host's side either way, and removes the image only on "yes" for a detached host.
async function uninstallOrphan(options, inspection, candidates, format2, registryError) {
  const { host, dryRun = false } = options;
  const decision = imageRemoval(format2, host);
  const foreignPending = decision.reason === 'other-pending-hosts';
  const promptOptions = { ...options, candidates: options.candidates ?? candidates };
  if (dryRun) {
    const permissionLine = await removePermissions(host, inspection, true);
    const hostSide = await removeHostSide(host, inspection, { owner: null, dryRun: true });
    const imagePolicy = { remove: hostSide.detached && !foreignPending,
      reason: hostSide.detached ? 'operator confirmed' : 'this host is still attached' };
    const plan = pendingRemovalPlan(await buildHomeRemovalPlan({ command: 'uninstall', host, packageRoot: options.packageRoot,
      imagePolicy }), host);
    const rulesPlan = await preflightRulesReentry(host, inspection, { registryError, ownHomeAttested: true });
    const rules = await runRulesReentry(options, rulesPlan, { detached: hostSide.detached, registryError });
    return {
      exitCode: 1,
      output: [permissionLine, ...hostSide.lines, ...[pendingImageLine(host, decision, true)].filter(Boolean),
        `A real run would ask whether to remove the shared image of ${host.brandRoot}: \
no host is recorded as using it.`,
        'If the answer is yes:', ...planLines(plan, { host, detached: hostSide.detached }), ...rules.lines].join('\n'),
    };
  }

  const answer = await askRemoval(host, 'orphan', promptOptions);
  if (answer === 'cancel') return { exitCode: 130, output: 'Cancelled; nothing was changed.' };

  // Plan_83 D7 (7), (8): home consent comes first; either cancel precedes every host write.
  const rulesPlan = await preflightRulesReentry(host, inspection,
    { registryError, ownHomeAttested: answer === 'remove' });
  const rulesAnswer = await confirmRulesRetirement(rulesPlan, options);
  if (rulesAnswer === 'cancel') return { exitCode: 130, output: 'Cancelled; nothing was changed.' };
  const permissionLine = await removePermissions(host, inspection, false);
  const hostSide = await removeHostSide(host, inspection, { owner: null });
  const imagePolicy = answer === 'remove' && !foreignPending
    ? { remove: hostSide.detached,
      reason: hostSide.detached ? 'operator confirmed' : 'this host is still attached' }
    : { remove: false, reason: 'no host is recorded as using it' };
  const plan = pendingRemovalPlan(await buildHomeRemovalPlan({ command: 'uninstall', host, packageRoot: options.packageRoot,
    imagePolicy }), host);
  const rules = await runRulesReentry(options, rulesPlan,
    { detached: hostSide.detached, answer: rulesAnswer, registryError });
  await removeEmpty(host.commandsDir);
  await removeEmpty(host.rulesDir);
  await removeEmpty(host.agentsDir);
  const { outcomes } = await executeHomePlan(host, plan,
    { detached: hostSide.detached, imageMembers: plan.imageMembers });

  let imageLine = null;
  let hint = null;
  if (foreignPending) {
    imageLine = pendingImageLine(host, decision, false);
  } else if (answer === 'remove' && !hostSide.detached) {
    imageLine = `Left the shared image in ${host.brandRoot} because this host's hooks could not be removed.`;
  } else if (answer !== 'remove') {
    imageLine = `Left the shared image in ${host.brandRoot} because no host is recorded as using it \
and the inventory is incomplete.`;
    hint = removalHint(host);
  }

  const hasMarks = hasPackageMarks(inspection);
  const heading = !hostSide.detached
    ? stillAttachedLine(host)
    : hasMarks ? 'Uninstalled llm-bridge.'
      : `No llm-bridge files or hooks were found in ${host.root}.`;
  return {
    exitCode: answer === 'remove' && hostSide.detached && !foreignPending && !rules.rulesUnresolved
      ? outcomeExitCode(outcomes) : 1,
    output: [heading, permissionLine, ...hostSide.lines, ...rules.lines, imageLine, hint, ...outcomeLines(outcomes, { host })]
      .filter(Boolean).join('\n'),
  };
}

async function uninstallInRun(options = {}) {
  const { host, dryRun = false } = options;
  // Preflight before removing the hook: package removal on a broken registry left the host without its watchdog.
  let registry = null;
  let registryError = null;
  let candidates = [];
  try {
    registry = await readRulesRegistry(host);
    candidates = options.candidates ?? await rulesOwnerHints(await readRulesIndex(host));
  } catch (err) {
    registryError = err;
  }
  // Plan_65 D9: the question precedes the first change, so the record is read before the permission rules go;
  // a cancel then leaves the host exactly as it was.
  const rawRecord = await readInstallRecordFile(host);
  const ownerKey = normalizeRepoPath(host.root);
  const format2 = rawRecord === null ? null : asFormat2(rawRecord, host);
  const ownPending = hasOwnPending(format2, host);
  const orphaned = format2 !== null && Object.keys(format2.owners).length === 0;
  const owner = format2?.owners[ownerKey] ?? null;
  // Plan_65 D10: inspect marks and content before permission edits or any other host mutation.
  const inspection = await inspectHost(host, { owner });
  if (orphaned && !ownPending) return uninstallOrphan(options, inspection, candidates, format2, registryError);

  const record = pendingUninstallView(format2, host, await readInstallRecord(host));
  let decision = rawRecord === null
    ? (record ? { removeImage: true } : { removeImage: false, reason: 'no-record' })
    : imageDecision(rawRecord, host);
  if (!record && decision.removeImage) decision = { removeImage: false, reason: 'no-record' };
  const lastKnownOwner = decision.reason === 'incomplete-inventory'
    && (Object.hasOwn(format2.owners, ownerKey) || ownPending);
  let lastOwnerHint = null;
  let ownHomeAttested = false;
  if (lastKnownOwner && !dryRun) {
    const answer = await askRemoval(host, 'last-owner', options);
    if (answer === 'cancel') return { exitCode: 130, output: 'Cancelled; nothing was changed.' };
    if (answer === 'remove') { decision = { removeImage: true }; ownHomeAttested = true; }
    else lastOwnerHint = removalHint(host);
  }
  // Plan_83 D6/D7/D8: the home answer feeds one rules decision before any host mutation.
  const rulesPlan = record?.rules && inspection.settingsError == null
    ? await preflightRulesRemoval(record.rules.path, record.rules.fingerprint,
    { host, registryError, ownHomeAttested }) : !record
      ? await preflightRulesReentry(host, inspection, { registryError, ownHomeAttested }) : null;
  const rulesAnswer = await confirmRulesRetirement(rulesPlan, options);
  if (rulesAnswer === 'cancel') return { exitCode: 130, output: 'Cancelled; nothing was changed.' };
  const permissionLine = await removePermissions(host, inspection, dryRun);
  const hostMarks = hasPackageMarks(inspection);
  if (!record && !hostMarks) {
    const rules = await runRulesReentry(options, rulesPlan,
      { detached: inspection.settingsError == null, answer: rulesAnswer, registryError });
    return {
      exitCode: rulesPlan && !rules.rulesUnresolved ? 0 : 1,
      output: [permissionLine, 'llm-bridge is not installed.', ...rules.lines, ...outcomeLines([], { host })].join('\n'),
    };
  }
  const writer = record || rulesPlan ? recordHomeWriter(host, record?.files ?? []) : null;

  if (dryRun) {
    const hostSide = await removeHostSide(host, inspection, { owner, dryRun: true });
    const imagePolicy = imagePolicyFor(decision, hostSide);
    const plan = pendingRemovalPlan(await buildHomeRemovalPlan({ command: 'uninstall', host, packageRoot: options.packageRoot,
      imagePolicy }), host);
    const lines = [permissionLine, ...hostSide.lines];
    if (ownPending) lines.push(pendingDepartureLine(format2, host, hostSide.detached, true));
    const blockedImageLine = decision.removeImage && !hostSide.detached
      ? `Would leave the shared image in ${host.brandRoot} because this host's hooks could not be removed.`
      : null;
    const imageLine = blockedImageLine || (!decision.removeImage
      ? imageDispositionLine(host, decision, true) : null);
    if (imageLine) lines.push(imageLine);
    if (lastKnownOwner) lines.push(`A real run would ask whether ${host.root} is the last host \
using ${host.brandRoot}.`);
    const rules = await rulesDryRunLines({
      host, record, registry, registryError, detached: hostSide.detached, plan: rulesPlan,
    });
    lines.push(...rules.lines);
    lines.push(...planLines(plan, { host, detached: hostSide.detached }));
    return {
      exitCode: rules.rulesUnresolved || imageOwnershipUnknown(decision) || !hostSide.detached ? 1 : planExitCode(plan),
      output: lines.join('\n'),
    };
  }

  const hostSide = await removeHostSide(host, inspection, { owner });
  const imagePolicy = imagePolicyFor(decision, hostSide);
  const plan = pendingRemovalPlan(await buildHomeRemovalPlan({ command: 'uninstall', host, packageRoot: options.packageRoot,
    imagePolicy }), host);
  // Plan_65 D10 item 4: a host still attached keeps everything it shares — its rules ownership, its
  // place in the record — so a repeat run after the fix finds it whole.
  const rulesResult = await removeRulesForHost({
    host, record, registry, registryError, detached: hostSide.detached, writer, plan: rulesPlan, answer: rulesAnswer,
  });
  const rulesOutput = rulesResult.lines;
  registryError = rulesResult.registryError;
  const { outcomes } = await executeHomePlan(host, plan,
    { detached: hostSide.detached, imageMembers: plan.imageMembers });
  await removeEmpty(host.commandsDir);
  await removeEmpty(host.rulesDir);
  await removeEmpty(host.agentsDir);
  const blockedImageLine = decision.removeImage && !hostSide.detached
    ? `Left the shared image in ${host.brandRoot} because this host's hooks could not be removed.`
    : null;
  const imageLine = blockedImageLine || (!decision.removeImage
    ? imageDispositionLine(host, decision, false) : null);
  const heading = hostSide.detached
    ? 'Uninstalled llm-bridge.'
    : stillAttachedLine(host);
  return {
    exitCode: rulesResult.rulesUnresolved || imageOwnershipUnknown(decision) || !hostSide.detached ? 1 : outcomeExitCode(outcomes),
    output: [heading, permissionLine, ...hostSide.lines, ...rulesOutput, imageLine, lastOwnerHint,
      ...outcomeLines(outcomes, { host })].filter(Boolean).join('\n'),
  };
}

export async function uninstall(options = {}) {
  const host = options?.host;
  if (!host?.settingsPath) return uninstallInRun(options);
  // A dry run only reads; like install's, it must not wait on or create anything.
  if (options.dryRun === true) return withSettingsRun(host.settingsPath, () => uninstallInRun(options));
  // Plan_83 D2 / OW-086, risk r5: home lock before rules lock, from preflight through deletion.
  return withLifecycle(
    host,
    'uninstall',
    () => withRulesDirLock(host, 'uninstall',
      () => withSettingsRun(host.settingsPath, () => uninstallInRun(options)),
      { ticket: options.rulesTicket, createDirectory: false }),
    { ticket: options.lifecycleTicket, waitMs: options.lifecycleWaitMs },
  );
}
