/** OW-083 R1: display ledger state without repeating the verdict's validation rules. */
import { adviceLedgerContract } from './advice-contract.mjs';

export function alreadyDecidedRow(result, runDir) {
  if (!Object.hasOwn(result, 'already_decided')) {
    const contract = adviceLedgerContract(runDir);
    if (contract === 'legacy') return 'legacy result; field absent';
    if (contract === 'unreadable') return 'unreadable schema; field not checked';
    return 'field absent';
  }
  const answer = result.already_decided;
  switch (answer?.status) {
    case 'found': return `found ${answer.address}`;
    case 'not-found': return 'not-found (not found in the ledger)';
    case 'not-checked': return 'not-checked (no ledger supplied)';
    default: return String(answer?.status);
  }
}
