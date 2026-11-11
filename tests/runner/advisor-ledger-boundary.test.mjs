/** OW-083 R1: a declared decision ledger expands both phases by exactly one file. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree } from '../temp-tree.mjs';
import { validAdvice, validScope } from '../meta/advisor-fixtures.mjs';
import { judgeAdvice } from '../../src/home/lib/meta/advice-verdict.mjs';
import { decisionLedgerSection } from '../../src/home/lib/runner/advise-carry.mjs';
import { INSTRUCTIONS } from '../../src/home/lib/runner/prompts.mjs';

const repoRoot = makeTempTree('advisor-ledger-boundary-');
for (const file of ['src/entry.mjs', 'docs/decisions.md', 'docs/undeclared.md', 'docs/decisions.md-extra']) {
  fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, file), 'first\nsecond\nthird\n');
}
const ledger = 'docs/decisions.md';

function input(phase, decisions) {
  return {
    phase, result: phase === 'scope' ? validScope() : validAdvice(),
    task: { options: [{ id: 'keep' }, { id: 'split' }], paths: ['src'], ...decisions },
    repoRoot, commandsRun: 1, language: 'English',
  };
}

function cite(value, file) {
  if (value.phase === 'scope') value.result.taken_on_trust[0] = `Check ${file}:1.`;
  else {
    value.result.independent_checks[0].evidence = [{ file, line_start: 1, line_end: 1 }];
    value.result.why[0] = `Check ${file}:1.`;
  }
}

for (const phase of ['scope', 'advise']) {
  test(`${phase} renders the ledger section and read rule only with a declared ledger`, () => {
    const section = decisionLedgerSection({ decisions: ledger });
    assert.equal(section, `## Decision ledger\n\n${ledger}\n\nThis is the owning plan's decision ledger; you may read and cite it.`);
    const prompt = INSTRUCTIONS['codex-advisor']({ phase, decisions: ledger });
    assert.ok(prompt.includes('under `## Decision ledger`'));
    const original = INSTRUCTIONS['codex-advisor']({ phase });
    assert.ok(original.includes('- Read ONLY the paths listed under `## Paths` and, in the advise phase, under `## Scope phase results`, plus `git log` / `git show` on those paths.'));
    for (const artifact of [null, {}, { decisions: null }, { decisions: 42 }]) {
      assert.equal(decisionLedgerSection(artifact), '');
      assert.equal(INSTRUCTIONS['codex-advisor']({ phase, decisions: artifact?.decisions }), original);
    }
  });

  test(`${phase} accepts citations into only the declared ledger`, () => {
    const value = input(phase, { decisions: ledger });
    assert.equal(value.task.paths.includes(ledger), false);
    cite(value, ledger);
    assert.deepEqual(judgeAdvice(value), { ok: true, reasons: [] });
    for (const file of ['docs/undeclared.md', 'docs/decisions.md-extra']) {
      cite(value, file);
      const verdict = judgeAdvice(value);
      assert.equal(verdict.ok, false);
      if (phase === 'advise') {
        assert.ok(verdict.reasons.some((reason) => reason.includes('independent_checks[0].evidence[0]') && reason.includes(file)));
      }
      assert.ok(verdict.reasons.some((reason) => reason.includes(phase === 'scope' ? 'taken_on_trust[0]' : 'why[0]') && reason.includes(file)));
    }
  });

  test(`${phase} old artifacts and null or non-string ledgers retain the existing boundary`, () => {
    const old = input(phase, {});
    assert.equal(Object.hasOwn(old.task, 'decisions'), false);
    assert.deepEqual(judgeAdvice(old), { ok: true, reasons: [] });
    cite(old, ledger);
    const expected = judgeAdvice(old);
    assert.equal(expected.ok, false);
    for (const decisions of [null, 42, ['docs']]) {
      const value = input(phase, { decisions });
      cite(value, ledger);
      assert.deepEqual(judgeAdvice(value), expected);
    }
  });

  test(`${phase} a ledger directory cannot authorize its descendants`, () => {
    const value = input(phase, { decisions: 'docs' });
    cite(value, ledger);
    assert.equal(judgeAdvice(value).ok, false);
  });

  test(`${phase} ledger citations still require valid line bounds`, () => {
    const value = input(phase, { decisions: ledger });
    cite(value, ledger);
    if (phase === 'scope') value.result.taken_on_trust[0] = `Check ${ledger}:4.`;
    else value.result.independent_checks[0].evidence[0].line_end = 4;
    assert.equal(judgeAdvice(value).ok, false);
  });
}
