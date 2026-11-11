/** OW-083 R1: admit one owning-plan ledger before any advisor run can spend quota. */
import fs from 'node:fs';
import path from 'node:path';
import { decisionsPathRefusal } from '../order-values.mjs';
import { orderRuleMessage } from '../order-rules.mjs';

function contains(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function decisionsLedgerRefusal(repo, value) {
  const shapeReason = decisionsPathRefusal(value);
  if (shapeReason) return shapeReason;
  const root = path.resolve(repo);
  const file = path.resolve(root, value);
  if (!contains(root, file)) return orderRuleMessage('decisions-path', { violation: 'outside-repository', value });
  try {
    if (!contains(fs.realpathSync(root), fs.realpathSync(file))) {
      return orderRuleMessage('decisions-path', { violation: 'outside-repository', value });
    }
    if (!fs.statSync(file).isFile()) {
      return orderRuleMessage('decisions-path', { violation: 'not-file', value });
    }
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    return orderRuleMessage('decisions-path', { violation: 'unreadable', value });
  }
  return null;
}
