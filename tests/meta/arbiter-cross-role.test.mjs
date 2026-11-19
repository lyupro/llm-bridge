/** Guards advisor blindness when an OW-097 arbitration brief reaches the advisor task reader. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { advisorTaskRefusal } from '../../src/home/lib/meta/advisor-task.mjs';
import { orderRuleMessage } from '../../src/home/lib/order-rules.mjs';

const BODY = `## Question
Which design fits the module boundary?
## Options
- keep: Preserve the existing boundary
- split: Introduce a second module
## Paths
- src/home/lib
`;

for (const heading of ['tRiGgEr', 'pOsItIoN', 'pRiOr RuNs']) {
  for (const hashes of ['##', '######']) {
    test(`refuses ${hashes} ${heading} anywhere in the advisor body`, () => {
      const line = `${hashes} ${heading} ${hashes}`;
      for (const [text, lineNo] of [
        [`${line}\r\nEvidence\r\n${BODY}`, 1],
        [BODY.replace('## Paths', `${line}\nEvidence\n## Paths`), 6],
        [`${BODY}${line}\nEvidence`, 8],
      ]) {
        assert.equal(advisorTaskRefusal(text),
          orderRuleMessage('advisor-task-arbiter-input', { heading, lineNo, line }));
      }
    });
  }
}

test('refuses a Setext arbitration heading and identifies its text line', () => {
  assert.match(advisorTaskRefusal(`${BODY}\nPrior runs\n----------\n- earlier`),
    /Prior runs line 9 "Prior runs".*belongs to codex-arbiter/);
});

test('ordinary advisor scope and advise bodies are accepted', () => {
  assert.equal(advisorTaskRefusal(BODY), null);
  assert.equal(advisorTaskRefusal(`${BODY}\n## Notes\nTrigger the read-only checks.\n` +
    'Prior runs can be consulted for context.\n### Positioning constraints\nReview the module seams.'), null);
});
