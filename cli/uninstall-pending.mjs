/** Resolves only the explicitly departing host's unfinished installation evidence (Plan_83 D1/D5). */
import { withoutOwner } from './install-owners.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { hasOwnPending, withoutPending } from './install-pending.mjs';

export function recordAfterDeparture(record, host) {
  // Plan_83 D5: the owner row and its intent disappear in one publication, never a neighbour's intent.
  // Plan_65 D12: retaining an ownerless image cannot retain a claim of complete ownership.
  const lastOwner = Object.keys(record.owners).length === 1
    && Object.hasOwn(record.owners, normalizeRepoPath(host.root));
  const source = lastOwner && record.inventory === 'complete' ? { ...record, inventory: 'incomplete' } : record;
  return withoutPending(withoutOwner(source, host), host);
}

export function pendingUninstallView(record, host, view) {
  // Plan_65 D10: unfinished hosts have no fabricated fingerprints or created-hook-group evidence.
  return view ?? (hasOwnPending(record, host) ? { files: record.image.files } : null);
}

export function pendingImageLine(host, decision, dryRun) {
  if (decision.reason !== 'other-pending-hosts') return null;
  const recovery = decision.pendingHosts.map((root) => `${root}: complete that host's install`
    + ` (llm-bridge install --host "${root}") or run llm-bridge uninstall --host "${root}"`).join('; ');
  return `${dryRun ? 'Would leave' : 'Left'} the shared image in ${host.brandRoot} because other hosts`
    + ` have pending installations: ${recovery}.`;
}

export function imageOwnershipUnknown(decision) {
  return decision.reason === 'incomplete-inventory' || decision.reason === 'other-pending-hosts';
}

export function pendingRemovalPlan(plan, host) {
  // Plan_65 D12 / Plan_83 D5: the existing executor must publish even without an owner row.
  if (plan.record.operation === 'retain' && plan.recordState === 'valid'
    && hasOwnPending(plan.format2, host)) {
    plan.record = { operation: 'remove-current-owner', reason: 'this host pending entry removed',
      dependsOnDetach: true, blocked: false };
  }
  return plan;
}

export function pendingDepartureLine(record, host, detached, dryRun) {
  if (!hasOwnPending(record, host)) return null;
  return `${dryRun ? 'Would' : 'Did'} ${detached ? 'remove' : 'keep'} the pending entry for ${host.root}`
    + `${detached ? ' with its owner row (if present)' : ' because this host is still attached'}.`;
}
