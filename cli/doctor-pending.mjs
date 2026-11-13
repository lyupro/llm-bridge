/** Reports unfinished installations from the raw home record independently of ownership (Plan_83 D4/D5). */
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { check } from './doctor-format.mjs';
import { readInstallRecordFile } from './install-record.mjs';
import { pendingEntries, pendingRecoveryText } from './install-pending.mjs';

export async function pendingInstallChecks(host) {
  let record;
  try {
    record = await readInstallRecordFile(host);
  } catch {
    // Plan_83 D4: other doctor checks own unreadable records; only parsed pending evidence belongs here.
    return [];
  }
  if (record === null) return [];

  let entries;
  try {
    entries = pendingEntries(record);
  } catch (err) {
    return [check('pending install', 'warn', err.message)];
  }
  const ownKey = normalizeRepoPath(host.root);
  // Plan_83 D5 pre-mortem 5: recovery commands use the stored root, never the normalized key.
  return entries.map(({ hostKey, root, command, startedAt }) => check('pending install', 'warn',
    `Unfinished ${command} for ${root}${hostKey === ownKey ? ' (this host)' : ''}; started at ${startedAt};`
      + ` ${pendingRecoveryText({ root, command })}`));
}
