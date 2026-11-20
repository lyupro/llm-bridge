/** OW-092 D4: attach preserves the stored folder check when the worker leaves no reply. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { EXIT } from '../../src/home/lib/runner/exit-codes.mjs';
import { attaching, fixture, order, run, running } from './attach-fixtures.mjs';

for (const [name, classification, variant, folderRow] of [
  ['confirmed', { level: 'confirmed', reason: null, folders: [
    { path: 'src', level: 'confirmed', reason: null },
    { path: 'src/other', level: 'not-confirmed', reason: 'inheritance-intact' },
  ] }, 'fail-build-write-refusal-confirmed', 'Folder check: T01 confirmed for 1 of 2 folder(s)'],
  ['not confirmed', { level: 'not-confirmed', reason: 'inheritance-intact', folders: [
    { path: 'src', level: 'not-confirmed', reason: 'inheritance-intact' },
  ] }, 'fail-build-write-refusal-not-confirmed', 'Folder check: T01 not confirmed (inheritance-intact)'],
  ['not measured', { level: 'not-measured', reason: 'timeout', folders: [] },
    'fail-build-write-refusal-unmeasured', 'Folder check: not measured (timeout)'],
  ['without a measurement', null, 'fail-build-write-refusal', null],
]) {
  test(`attach renders a recorded write refusal ${name} when the worker dies`, async (t) => {
    const runsRoot = fixture(t);
    const repo = path.join(runsRoot, 'repo');
    const agent = 'codex-build';
    const reason = 'sandbox refused to write an in-scope file (src/blocked.mjs)';
    const dir = run(runsRoot, '2026-08-04_090000_async-start', running(repo, { agent }), {
      'meta.json': JSON.stringify({
        agent, status: 'FAIL', reason, reason_rule: 'build-scope-write-refused',
        write_refusal: {
          paths: [{ path: 'src/blocked.mjs', inScope: true, failedChange: true }],
          ...(classification ? { measurement: { classification } } : {}),
        },
      }),
    });

    // The worker must be live when selected and dead when attach waits for its reply.
    const beforeWait = () => {
      const kill = process.kill;
      t.mock.method(process, 'kill', (pid, signal) => {
        if (pid === process.pid && signal === 0) throw Object.assign(new Error('Process gone'), { code: 'ESRCH' });
        return kill.call(process, pid, signal);
      });
    };
    const { code, lines } = await attaching(order(runsRoot, repo, { beforeWait }));

    assert.equal(code, EXIT.FAIL);
    assert.equal(lines.at(-1), [
      `FAIL — ${reason}`,
      orderDiagnosticMessage('next-action', { variant }),
      ...(folderRow ? [folderRow] : []),
      `Run: ${dir}`,
    ].join('\n'));
  });
}
