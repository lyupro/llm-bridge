/** Classifies rules ownership from read-only installation-record evidence and unresolved legacy hints. */
import { readJsonFile } from '../src/home/lib/json-file.mjs';
import { validateFormat2 } from './install-owners.mjs';
import { pendingEntries, withoutPending } from './install-pending.mjs';
import { installRecordPath, asFormat2 } from './install-record.mjs';
import { normalizedRulesOwner, rulesPathIdentity as identity } from './rules-owners.mjs';

async function readRecord(recordPath, currentHost) {
  let record;
  try {
    record = await readJsonFile(recordPath);
  } catch (err) {
    return { kind: err.code === 'ENOENT' ? 'missing' : 'unreadable',
      reason: err.code === 'ENOENT' ? 'installation record does not exist (ENOENT)'
      : `cannot read installation record: ${err.code ? `${err.code}: ` : ''}${err.message}` };
  }
  // Plan_83 D6: only our own valid old record has the same inventory doubt as last-owner.
  if (record?.format !== 2 && currentHost) {
    try { record = asFormat2(record, currentHost); }
    catch { return { kind: 'invalid', reason: 'installation record is not format 2' }; }
  }
  if (record?.format !== 2) return { kind: 'invalid', reason: 'installation record is not format 2' };
  try {
    validateFormat2(record);
  } catch (err) {
    return { kind: 'invalid', reason: `invalid installation record: ${err.message}` };
  }
  return { record };
}

// Plan_83 D7: eligibility follows evidence, never the wording of a diagnostic reason.
export function offerableUnknown(reference) {
  return reference.kind === 'legacy' || reference.kind === 'missing';
}

function incompleteEvidence(record) {
  return Object.hasOwn(record, 'pending')
    ? { kind: 'pending', pendingHosts: pendingEntries(record).map(({ root, command }) => ({ root, command })) }
    : { kind: 'inventory' };
}

export async function rulesOwnerHints(index) {
  if (index === undefined) throw new Error('rules index is required; use null for an absent index');
  const hints = new Set(index?.legacy ?? []);
  // OW-086 / Plan_83 B3a: hints name hosts, even when their readable record cannot prove live ownership.
  for (const recordPath of index?.records ?? []) {
    const { record } = await readRecord(recordPath);
    if (record) for (const key of Object.keys(record.owners)) hints.add(key);
  }
  return [...hints];
}

function incompleteReason(record) {
  if (Object.hasOwn(record, 'pending')) {
    // Plan_83 D1/D5: name unresolved hosts without treating their intent as completed ownership.
    return `installation record has pending hosts: ${pendingEntries(record)
      .map(({ root, command }) => `${root} (${command})`).join(', ')}`;
  }
  if (Object.hasOwn(record, 'legacy')) return 'installation record has legacy inventory';
  if (record.inventory !== 'complete') {
    return 'installation record inventory is incomplete; run llm-bridge inventory confirm';
  }
  return null;
}

export async function classifyRulesOwnership(index, rulesPath, currentRecordPath, departingHost) {
  if (index === undefined) throw new Error('rules index is required; use null for an absent index');
  if (typeof rulesPath !== 'string' || !rulesPath) throw new Error('rules path is required');
  if (typeof currentRecordPath !== 'string' || !currentRecordPath) {
    throw new Error('current installation-record path is required');
  }
  const target = identity(rulesPath);
  const result = { live: [], unknown: [], detached: [] };
  const reads = new Map();
  const load = (recordPath) => {
    const key = identity(recordPath);
    if (!reads.has(key)) reads.set(key, readRecord(recordPath,
      key === identity(currentRecordPath) ? departingHost : undefined).then((loaded) => {
      // Plan_83 D5: classify after this departure; every foreign entry stays unknown.
      return loaded.record && departingHost && key === identity(currentRecordPath)
        ? { record: withoutPending(loaded.record, departingHost) } : loaded;
    }));
    return reads.get(key);
  };
  const matches = (owner) => owner.rules !== undefined && identity(owner.rules.path) === target;
  const addLive = (recordPath, owners) => {
    let live = result.live.find((item) => identity(item.recordPath) === identity(recordPath));
    if (!live) {
      live = { recordPath, owners: [] };
      result.live.push(live);
    }
    live.owners = [...new Set([...live.owners, ...owners])];
  };

  for (const recordPath of index?.records ?? []) {
    const loaded = await load(recordPath);
    const reason = loaded.reason ?? incompleteReason(loaded.record);
    if (reason) {
      result.unknown.push({ recordPath, reason,
        ...(loaded.kind ? { kind: loaded.kind } : incompleteEvidence(loaded.record)) });
      continue;
    }
    const owners = Object.entries(loaded.record.owners)
      .filter(([, owner]) => matches(owner)).map(([key]) => key);
    if (owners.length) addLive(recordPath, owners);
    else result.detached.push({ recordPath });
  }

  for (const legacy of index?.legacy ?? []) {
    const loaded = await load(currentRecordPath);
    if (loaded.reason) {
      // Plan_83 D7 (8) / D8: ENOENT leaves no record that could ever confirm this legacy hint.
      result.unknown.push({ legacy, recordPath: currentRecordPath, reason: loaded.reason,
        kind: loaded.kind === 'missing' ? 'legacy' : 'legacy-unverified' });
      continue;
    }
    // OW-086 / Plan_65 D5: a vanished folder proves nothing; only this exact recorded key can help.
    const owner = Object.hasOwn(loaded.record.owners, legacy) ? loaded.record.owners[legacy] : null;
    if (owner && matches(owner)) addLive(currentRecordPath, [legacy]);
    else result.unknown.push({ legacy, recordPath: currentRecordPath, kind: 'legacy',
      reason: owner ? 'recorded owner does not reference this rules file'
        : 'legacy owner is not in the current installation record' });
  }
  // Plan_83 D1/D5: an old or missing index cannot erase foreign intent in our readable record.
  if (departingHost) {
    const loaded = await load(currentRecordPath);
    if (loaded.record && incompleteReason(loaded.record) && !result.unknown.some((ref) => ref.legacy === undefined
      && identity(ref.recordPath) === identity(currentRecordPath))) {
      result.unknown.push({ recordPath: currentRecordPath, reason: incompleteReason(loaded.record),
        ...incompleteEvidence(loaded.record) });
    }
  }
  return result;
}

export async function remainingRulesOwnership(index, host, record, { ownHomeAttested = false } = {}) {
  const recordPath = installRecordPath(host);
  const result = await classifyRulesOwnership(index, record.rules.path, recordPath, host);
  if (index === null && !result.unknown.length) return null;
  const key = normalizedRulesOwner(host);
  // OW-086 / Plan_65 D5: departure proves only this host gone, never an unverified neighbour.
  return {
    ...result,
    live: result.live.map((live) => identity(live.recordPath) === identity(recordPath)
      ? { ...live, owners: live.owners.filter((owner) => owner !== key) } : live)
      .filter((live) => live.owners.length),
    // Plan_83 D6/D7: home consent resolves only our inventory, never another host's pending intent.
    unknown: result.unknown.filter((reference) => reference.legacy !== key
      && !(ownHomeAttested && reference.legacy === undefined && reference.kind === 'inventory'
        && identity(reference.recordPath) === identity(recordPath))),
  };
}
