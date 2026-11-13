/** Preserves each host's unfinished installation evidence in the shared record (Plan_83 D4/D5). */
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { INSTALL_METHOD_COPY, INSTALL_METHOD_KEY, publishInstallRecordOnly, readInstallRecordFile } from './install-record.mjs';
import { validateFormat2 } from './install-owners.mjs';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function invalid(reason) {
  throw new Error(`installation record pending field is invalid: ${reason}`);
}

function validateEntry(key, entry) {
  if (!isObject(entry)) invalid(`entry ${key} must be an object`);
  if (typeof entry.root !== 'string' || !entry.root) invalid(`entry ${key} must have a root`);
  if (normalizeRepoPath(entry.root) !== key) invalid(`entry root must normalize to its key: ${key}`);
  if (entry.command !== 'install' && entry.command !== 'update') {
    invalid(`entry ${key} command must be install or update`);
  }
  const time = entry.startedAt;
  if (typeof time !== 'string'
    || !time.endsWith('Z')
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(time)
    || !Number.isFinite(Date.parse(time))
    || new Date(time).toISOString().slice(0, 19) !== time.slice(0, 19)) {
    invalid(`entry ${key} startedAt must be an ISO UTC string`);
  }
}

export function validatePending(record) {
  if (!isObject(record)) invalid('record must be an object');
  if (!Object.hasOwn(record, 'pending')) return record;
  if (!isObject(record.pending)) invalid('must be a non-empty object');
  const entries = Object.entries(record.pending);
  // Plan_83 D1/D5: presence means unresolved evidence, so an empty map cannot stand for completion.
  if (!entries.length) invalid('must be absent when there are no entries');
  for (const [key, entry] of entries) validateEntry(key, entry);
  return record;
}

export function withPending(record, host, command, startedAt) {
  validatePending(record);
  const key = normalizeRepoPath(host.root);
  const entry = { command, root: host.root, startedAt };
  validateEntry(key, entry);
  // Plan_83 D5: replacing this host's intent never certifies another host's unfinished work.
  return { ...record, pending: { ...record.pending, [key]: entry } };
}

export function withoutPending(record, host) {
  validatePending(record);
  const key = normalizeRepoPath(host.root);
  if (!Object.hasOwn(record, 'pending') || !Object.hasOwn(record.pending, key)) return record;
  const pending = { ...record.pending };
  delete pending[key];
  const { pending: _removed, ...rest } = record;
  return Object.keys(pending).length ? { ...rest, pending } : rest;
}

export function pendingEntries(record) {
  validatePending(record);
  return Object.entries(record.pending ?? {}).map(([hostKey, entry]) => ({ ...entry, hostKey }));
}

// Plan_83 D7 / D5 pre-mortem 5: doctor and rules recovery must preserve the same stored root.
export function pendingRecoveryText({ root, command }) {
  return `complete it: llm-bridge ${command} --host "${root}";`
    + ` or remove it: llm-bridge uninstall --host "${root}".`;
}

export function otherPendingEntries(record, host) {
  const key = normalizeRepoPath(host.root);
  return pendingEntries(record).filter((entry) => entry.hostKey !== key);
}

export function hasOwnPending(record, host) {
  return pendingEntries(record ?? {}).some((entry) => entry.hostKey === normalizeRepoPath(host.root));
}

/** Plan_83 D4/D5: publish intent before side effects, without inventing an owner row. */
export async function publishPending(host, command, currentPackage) {
  const existing = await readInstallRecordFile(host);
  const startedAt = new Date().toISOString();
  const scaffold = existing ?? validateFormat2({
    format: 2, name: currentPackage.name, [INSTALL_METHOD_KEY]: INSTALL_METHOD_COPY,
    inventory: 'incomplete', owners: {},
    image: { version: currentPackage.version, installedAt: startedAt, files: [] },
  });
  await publishInstallRecordOnly(host, withPending(scaffold, host, command, startedAt));
}

/** Plan_83 D5: foreign evidence informs the operator without changing this host's result. */
export async function pendingOutput(host, result) {
  const record = await readInstallRecordFile(host);
  const lines = otherPendingEntries(record ?? {}, host).map(({ root, command }) =>
    `Pending ${command} for ${root}; complete that host's install (llm-bridge install --host "${root}")`
      + ` or run llm-bridge uninstall --host "${root}".`);
  return lines.length ? { ...result, output: [result.output, ...lines].join('\n') } : result;
}
