/** Guards the OW-097 arbitration document grammar selected by the advise run named in `advice:`. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { arbiterTaskRefusal, parseArbiterTask } from '../../src/home/lib/meta/arbiter-task.mjs';
import { checkOutgoingRefusal } from '../../src/home/lib/order-text-record.mjs';

const TASK = `## Question
Which design should we keep?
What is the cost of changing it?

## Options
- keep: ★ Preferred by the orchestrator
- split-2: Split the boundary: two modules

## Trigger
disagreement

## Position
keep: The migration cost is high.

  Keep the existing integration until the next release.

## Prior runs
- 2026-11-18_110000_split
- 2026-11-18_120000_keep

## Paths
- src/home/lib
- .\\docs\\architecture.md
`;

test('parses the arbitration brief, including preference and the full rationale', () => {
  const text = TASK.replaceAll('\n', '\r\n');
  assert.equal(arbiterTaskRefusal(text), null);
  assert.deepEqual(parseArbiterTask(text), {
    question: 'Which design should we keep?\nWhat is the cost of changing it?',
    options: [
      { id: 'keep', description: '★ Preferred by the orchestrator' },
      { id: 'split-2', description: 'Split the boundary: two modules' },
    ],
    trigger: 'disagreement',
    position: {
      option: 'keep',
      rationale: 'The migration cost is high.\n\n  Keep the existing integration until the next release.',
    },
    priorRuns: ['2026-11-18_110000_split', '2026-11-18_120000_keep'],
    paths: ['src/home/lib', '.\\docs\\architecture.md'],
  });
});

test('irreversible orders may omit prior runs or supply valid ones', () => {
  const irreversible = TASK.replace('\ndisagreement\n', '\nirreversible\n');
  assert.equal(arbiterTaskRefusal(irreversible), null);
  assert.equal(parseArbiterTask(irreversible).priorRuns.length, 2);
  const empty = irreversible.replace(/^- 2026.*\n/gm, '');
  for (const text of [empty, empty.replace('## Prior runs\n', '')]) {
    assert.equal(arbiterTaskRefusal(text), null);
    assert.deepEqual(parseArbiterTask(text).priorRuns, []);
  }
  assert.match(arbiterTaskRefusal(irreversible.replace('2026-11-18_110000_split', '../split')), /bare run-folder/);
});

test('required headings name their section and the start of the document when absent', () => {
  for (const section of ['Question', 'Options', 'Trigger', 'Position', 'Prior runs', 'Paths']) {
    const text = TASK.replace(`## ${section}\n`, '## Other\n');
    const firstLine = text.split('\n')[0];
    assert.equal(arbiterTaskRefusal(text),
      `${section} line 1 ${JSON.stringify(firstLine)}: add a "## ${section}" section.`);
  }
  assert.match(arbiterTaskRefusal(''), /Question line 1 "".*## Question/);
});

const cases = [
  ['empty Question', TASK.replace(/^Which.*\nWhat.*\n/m, ''), 'Question', 1, /non-empty question/],
  ['one option', TASK.replace(/^- split-2:.*\n/m, ''), 'Options', 5, /two distinct options/],
  ['option id grammar', TASK.replace('- split-2:', '- split_2:'), 'Options', 7, /option-id.*\[a-z0-9\]/],
  ['option marker', TASK.replace('- split-2:', '* split-2:'), 'Options', 7, /option-id/],
  ['duplicate option', TASK.replace('- split-2:', '- keep:'), 'Options', 7, /duplicate option/],
  ['empty Trigger', TASK.replace('\ndisagreement\n', '\n\n'), 'Trigger', 9, /write one line/],
  ['unknown trigger', TASK.replace('\ndisagreement\n', '\nDisagreement\n'), 'Trigger', 10, /disagreement.*irreversible/],
  ['two trigger lines', TASK.replace('\ndisagreement\n', '\ndisagreement\nirreversible\n'), 'Trigger', 11, /exactly one/],
  ['empty Position', TASK.replace(/^keep:.*\n\n.*integration.*\n/m, ''), 'Position', 12, /first non-empty line/],
  ['position without id', TASK.replace('keep: The migration cost is high.', 'Keep the existing design.'), 'Position', 13, /option-id: rationale/],
  ['position without first-line rationale', TASK.replace('keep: The migration cost is high.', 'keep:  '), 'Position', 13, /non-empty rationale/],
  ['unlisted position option', TASK.replace('keep: The migration', 'other: The migration'), 'Position', 13, /option id from Options/],
  ['no prior runs', TASK.replace(/^- 2026.*\n/gm, ''), 'Prior runs', 17, /at least one prior run/],
  ['non-list prior run', TASK.replace('- 2026-11-18_110000_split', '2026-11-18_110000_split'), 'Prior runs', 18, /own "- run-folder" line/],
  ['empty prior run item', TASK.replace('- 2026-11-18_110000_split', '-  '), 'Prior runs', 18, /own "- run-folder" line/],
  ['duplicate prior run', TASK.replace('2026-11-18_120000_keep', '2026-11-18_110000_split'), 'Prior runs', 19, /only once/],
  ['empty Paths', TASK.slice(0, TASK.indexOf('- src/home/lib')), 'Paths', 21, /at least one repository-relative path/],
  ['empty path item', TASK.replace('- src/home/lib', '-  '), 'Paths', 22, /repository-relative-path/],
];

for (const value of ['.', '..', 'one/two', 'one\\two', 'C:one']) {
  cases.push([`non-bare run ${value}`, TASK.replace('2026-11-18_110000_split', value), 'Prior runs', 18, /bare run-folder/]);
}
for (const value of ['/src/home', 'C:\\src', 'C:src', '\\\\host\\share', '../other', 'src/../../other']) {
  cases.push([`non-repository path ${value}`, TASK.replace('src/home/lib', value), 'Paths', 22, /inside the repository/]);
}

for (const [name, text, section, lineNo, detail] of cases) {
  test(`refuses ${name} with the exact source location`, () => {
    const refusal = arbiterTaskRefusal(text);
    assert.ok(refusal.startsWith(`${section} line ${lineNo} ${JSON.stringify(text.split('\n')[lineNo - 1])}: `), refusal);
    assert.match(refusal, detail);
    assert.equal(checkOutgoingRefusal(refusal, 'arbiter-task-test'), refusal);
    assert.throws(() => parseArbiterTask(text), { message: refusal });
  });
}

test('arbitration task input requires text', () => {
  for (const parse of [parseArbiterTask, arbiterTaskRefusal]) {
    assert.throws(() => parse(null), { name: 'TypeError', message: 'Arbiter task text must be a string.' });
  }
});
