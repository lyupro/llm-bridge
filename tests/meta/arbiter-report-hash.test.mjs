/** Verifies the report bytes that an OK arbiter verdict attests to under OW-097 D4. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { arbiterReportMismatch } from '../../src/home/lib/meta/arbiter-report-hash.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const report = Buffer.from('# Arbitration\r\nRésumé\r\n', 'utf8');
const meta = { agent: 'codex-arbiter', status: 'OK', report_sha256: createHash('sha256').update(report).digest('hex') };

test('an OK arbiter verdict requires the exact report bytes', (t) => {
  const runDir = makeTempTree('arbiter-report-hash-');
  t.after(() => removeTempTree(runDir));
  const file = path.join(runDir, 'report.md');

  assert.equal(arbiterReportMismatch({ runDir, meta }), 'report.md is missing or unreadable');
  fs.writeFileSync(file, report);
  assert.equal(arbiterReportMismatch({ runDir, meta }), null);
  fs.writeFileSync(file, report.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
  assert.equal(arbiterReportMismatch({ runDir, meta }), 'report.md no longer matches meta.json#report_sha256');
});

test('an OK arbiter verdict requires a lowercase SHA-256 in meta.json', () => {
  for (const report_sha256 of [undefined, 123, 'g'.repeat(64), 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}\n`]) {
    assert.equal(arbiterReportMismatch({ meta: { ...meta, report_sha256 } }), 'meta.json has no report_sha256');
  }
});

test('other agents and non-OK arbiter verdicts do not require a report', () => {
  assert.equal(arbiterReportMismatch({ meta: { agent: 'codex-build', status: 'OK' } }), null);
  assert.equal(arbiterReportMismatch({ meta: { agent: 'codex-arbiter', status: 'FAIL' } }), null);
});
