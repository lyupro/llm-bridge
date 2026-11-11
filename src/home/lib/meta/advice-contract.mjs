/** OW-083 R1: archived advise verdicts follow the saved schema handed to their run. */
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';

export function adviceLedgerContract(runDir) {
  try {
    const schema = readJsonFileSync(path.join(runDir, 'schema.json'));
    if (!Array.isArray(schema?.required)) return 'unreadable';
    return schema.required.includes('already_decided') ? 'required' : 'legacy';
  } catch (error) {
    return error.code === 'ENOENT' ? 'legacy' : 'unreadable';
  }
}
