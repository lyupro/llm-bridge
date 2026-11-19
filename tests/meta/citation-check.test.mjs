/** Guards shared citation checking for OW-097, chosen by the advise run named in `advice:`. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createCitationCheck } from '../../src/home/lib/meta/citation-check.mjs';
import { makeTempTree } from '../temp-tree.mjs';

const repoRoot = makeTempTree('citation-check-');
fs.mkdirSync(path.join(repoRoot, 'src'));
fs.writeFileSync(path.join(repoRoot, 'src', 'with spaces.mjs'), 'first\r\nsecond\r\n', 'utf8');
fs.writeFileSync(path.join(repoRoot, 'outside.mjs'), 'first\n', 'utf8');

const cases = [
  ['an allowed file', 'src/with spaces.mjs', 1, 2, null],
  ['an existing file outside the allowlist', 'outside.mjs', 1, 1, 'citation-allowed-path'],
  ['a range past the end', 'src/with spaces.mjs', 1, 3, 'citation-line-range'],
  ['a missing file', 'src/missing.mjs', 1, 1, 'citation-existing-file'],
];

for (const [name, file, line_start, line_end, problem] of cases) {
  test(`checks ${name} in prose and in structured evidence`, () => {
    const problems = [];
    const { checkProse, checkEvidence } = createCitationCheck({
      repoRoot, allowedPaths: ['src'], reportProblem: (key, values) => problems.push({ key, ...values }),
    });
    const label = `${file}:${line_start}${line_start === line_end ? '' : `-${line_end}`}`;
    checkProse('notes', `See \`${label}\`.`);
    checkEvidence('evidence', [{ file, line_start, line_end }]);
    const data = problem === 'citation-line-range' ? { count: 2 } : {};
    assert.deepEqual(problems, problem === null ? [] : [
      { key: problem, field: 'notes', label, ...data },
      { key: problem, field: 'evidence[0]', label, ...data },
    ]);
  });
}
