/** Checks that an OK arbiter verdict still matches its report bytes. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// OW-097 D4 binds re-delivery and export to the bytes verified at publication.
export function arbiterReportMismatch({ runDir, meta, reportBytes } = {}) {
  if (meta?.agent !== 'codex-arbiter' || meta.status !== 'OK') return null;
  const expected = meta.report_sha256;
  if (typeof expected !== 'string' || expected.length !== 64 || /[^0-9a-f]/.test(expected)) {
    return 'meta.json has no report_sha256';
  }

  try {
    // Export supplies its own buffer so a later disk read cannot certify different bytes.
    const bytes = reportBytes ?? fs.readFileSync(path.join(runDir, 'report.md'));
    return createHash('sha256').update(bytes).digest('hex') === expected
      ? null : 'report.md no longer matches meta.json#report_sha256';
  } catch {
    return 'report.md is missing or unreadable';
  }
}
