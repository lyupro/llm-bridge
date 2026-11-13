/** Classifies rules ownership from read-only installation-record evidence and unresolved legacy hints. */
import { readJsonFile } from '../src/home/lib/json-file.mjs';
import { validateFormat2 } from './install-owners.mjs';
import { pendingEntries } from './install-pending.mjs';
import { installRecordPath } from './install-record.mjs';
import { normalizedRulesOwner, rulesPathIdentity as identity } from './rules-owners.mjs';

async function readRecord(recordPath) {
  let record;
  try {
    record = await readJsonFile(recordPath);
  } catch (err) {
    return { reason: err.code === 'ENOENT' ? 'installation record does not exist (ENOENT)'
      : `cannot read installation record: ${err.code ? `${err.code}: ` : ''}${err.message}` };
  }
  if (record?.format !== 2) return { reason: 'installation record is not format 2' };
  try {
    validateFormat2(record);
  } catch (err) {
    return { reason: `invalid installation record: ${err.message}` };
  }
  return { record };
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

export async function classifyRulesOwnership(index, rulesPath, currentRecordPath) {
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
    if (!reads.has(key)) reads.set(key, readRecord(recordPath));
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
      result.unknown.push({ recordPath, reason });
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
      result.unknown.push({ legacy, recordPath: currentRecordPath, reason: loaded.reason });
      continue;
    }
    // OW-086 / Plan_65 D5: a vanished folder proves nothing; only this exact recorded key can help.
    const owner = Object.hasOwn(loaded.record.owners, legacy) ? loaded.record.owners[legacy] : null;
    if (owner && matches(owner)) addLive(currentRecordPath, [legacy]);
    else result.unknown.push({ legacy, recordPath: currentRecordPath,
      reason: owner ? 'recorded owner does not reference this rules file'
        : 'legacy owner is not in the current installation record' });
  }
  return result;
}

export async function remainingRulesOwnership(index, host, record) {
  const recordPath = installRecordPath(host);
  const result = await classifyRulesOwnership(index, record.rules.path, recordPath);
  if (index === null) return null;
  const key = normalizedRulesOwner(host);
  // OW-086 / Plan_65 D5: departure proves only this host gone, never an unverified neighbour.
  return {
    ...result,
    live: result.live.map((live) => identity(live.recordPath) === identity(recordPath)
      ? { ...live, owners: live.owners.filter((owner) => owner !== key) } : live)
      .filter((live) => live.owners.length),
    unknown: result.unknown.filter((reference) => reference.legacy !== key),
  };
}
