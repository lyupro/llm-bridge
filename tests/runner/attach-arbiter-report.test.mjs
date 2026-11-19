/** Guards OW-097 D4: a re-delivered arbiter OK is checked against its recorded report hash. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../../src/home/lib/runner/exit-codes.mjs';
import { attaching, fixture, order, run, running } from './attach-fixtures.mjs';

for (const hasReply of [true, false]) {
  for (const edited of [true, false]) {
    test(`attach checks an ${edited ? 'edited' : 'untouched'} arbiter report with ${hasReply ? 'a saved reply' : 'a verdict only'}`, async (t) => {
      const runsRoot = fixture(t);
      const repo = path.join(runsRoot, 'repo');
      const agent = 'codex-arbiter';
      const report = '# Judged report\n';
      const report_sha256 = createHash('sha256').update(report, 'utf8').digest('hex');
      const dir = run(runsRoot, '2026-08-04_090000_async-start', running(repo, { agent }), {
        'meta.json': JSON.stringify({ agent, status: 'OK', reason: 'arbiter verdict', report_sha256 }),
        'report.md': report,
        ...(hasReply ? { 'reply.txt': 'OK — arbiter verdict\n' } : {}),
      });
      if (edited) fs.appendFileSync(path.join(dir, 'report.md'), 'Edited.\n', 'utf8');

      // The worker was live when selected and then died after recording meta.json.
      const beforeWait = () => {
        const kill = process.kill;
        t.mock.method(process, 'kill', (pid, signal) => {
          if (pid === process.pid && signal === 0) throw Object.assign(new Error('Process gone'), { code: 'ESRCH' });
          return kill.call(process, pid, signal);
        });
      };
      const { code, lines } = await attaching(order(runsRoot, repo, { beforeWait }));

      const rejection = `FAIL — arbiter report check failed: report.md no longer matches meta.json#report_sha256\nRun: ${dir}`;
      assert.equal(code, edited ? EXIT.FAIL : 0);
      assert.equal(lines.at(-1), edited ? rejection : `OK — arbiter verdict${hasReply ? '' : `\nRun: ${dir}`}`);
      if (edited) assert.doesNotMatch(lines.join('\n'), /OK — arbiter verdict/);
    });
  }
}
