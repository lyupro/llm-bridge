/** OW-083 R1: display the missing ledger state of archived advise replies without rewriting them. */
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { alreadyDecidedRow } from '../meta/already-decided-row.mjs';

export function savedAdviseReply(reply, runDir, status) {
  if (status.agent !== 'codex-advisor' || status.phase !== 'advise') return reply;
  const prefix = reply.match(/^OK — recommend [^:\r\n]+: /)?.[0];
  if (!prefix || reply.startsWith('Already decided:', prefix.length)) return reply;
  let result;
  try {
    result = readJsonFileSync(path.join(runDir, 'result.json'));
  } catch {
    return reply;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return reply;
  return `${prefix}Already decided: ${alreadyDecidedRow(result, runDir)} · ${reply.slice(prefix.length)}`;
}
