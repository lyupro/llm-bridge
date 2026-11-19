import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bindArbiterProbes, isProbeTag, PROBE_LIMITS, PROBE_TAG_PREFIX,
} from '../../src/home/lib/meta/arbiter-probe-receipts.mjs';
import { COMPLETED_COMMAND } from './test-fixtures.mjs';

const tag = 'ARBITER_PROBE_0123456789abcdef';
const otherTag = 'ARBITER_PROBE_fedcba9876543210';
const wrapper = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command`;

// OW-097 D3 rejected normalization because the B3 sample shows both proxy and here-string quoting.
const gitRead = (marker) => String.raw`${wrapper} "& 'C:\Tools\rtk.exe' proxy git show HEAD:package.json # ${marker}"`;
const nodeRead = `${wrapper} '$script = @'"'
// ${tag}
const fs = require('node:fs');
console.log(fs.readFileSync('package.json', 'utf8'));
'@
node -e "'$script'`;

const probe = (probe_tag) => ({ probe_tag, purpose: 'Read package metadata.', finding: 'The file is present.' });

function commandEvent(command, item = {}, type = COMPLETED_COMMAND.type) {
  return { ...COMPLETED_COMMAND, type, item: { ...COMPLETED_COMMAND.item, command, ...item } };
}

function bind(probes, events, captureComplete = true) {
  return bindArbiterProbes({ probes, events, captureComplete });
}

test('exports the frozen limits and accepts only exact lowercase probe tags', () => {
  assert.equal(PROBE_TAG_PREFIX, 'ARBITER_PROBE_');
  assert.deepEqual(PROBE_LIMITS, { maxProbes: 8, outputExcerptBytes: 4096, commandBytes: 16384 });
  assert.ok(Object.isFrozen(PROBE_LIMITS));
  assert.equal(isProbeTag(tag), true);
  for (const value of [
    null, undefined, 123, [tag], '', tag.toLowerCase(), tag.toUpperCase(),
    `${tag.slice(0, -1)}g`, tag.slice(0, -1), `${tag}0`, ` ${tag}`, `${tag}\n`,
  ]) {
    assert.equal(isProbeTag(value), false, JSON.stringify(value));
  }
});

test('requires each binding input', () => {
  for (const args of [
    { events: [], captureComplete: true },
    { probes: [], captureComplete: true },
    { probes: [], events: [] },
  ]) {
    assert.throws(() => bindArbiterProbes(args), TypeError);
  }
});

test('binds wrapped commands in probe order and preserves their raw commands and event indexes', () => {
  const gitCommand = gitRead(otherTag);
  const events = [
    { type: 'turn.started' },
    commandEvent(gitCommand, { id: 'item_4', aggregated_output: 'git output' }),
    commandEvent(nodeRead, { status: 'in_progress', exit_code: null }, 'item.started'),
    commandEvent(nodeRead, { aggregated_output: 'node output' }),
  ];
  const result = bind([probe(tag), probe(otherTag)], events);
  assert.deepEqual(result, {
    receipts: [
      {
        probe_tag: tag,
        event_index: 3,
        item_id: 'item_3',
        command: nodeRead,
        status: 'completed',
        exit_code: 0,
        succeeded: true,
        output_excerpt: 'node output',
        output_bytes: 11,
        output_truncated: false,
      },
      {
        probe_tag: otherTag,
        event_index: 1,
        item_id: 'item_4',
        command: gitCommand,
        status: 'completed',
        exit_code: 0,
        succeeded: true,
        output_excerpt: 'git output',
        output_bytes: 10,
        output_truncated: false,
      },
    ],
    problems: [],
  });
  assert.ok(result.receipts.every(Object.isFrozen));
});

test('accepts an empty output string', () => {
  const { receipts, problems } = bind([probe(tag)], [commandEvent(nodeRead, { aggregated_output: '' })]);
  assert.deepEqual(problems, []);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].output_excerpt, '');
  assert.equal(receipts[0].output_bytes, 0);
  assert.equal(receipts[0].output_truncated, false);
});

for (const [status, exit_code] of [['completed', 1], ['failed', 0], ['failed', 1]]) {
  test(`accepts status ${status} and exit ${exit_code} as an unsuccessful receipt`, () => {
    const { receipts, problems } = bind([probe(tag)], [commandEvent(nodeRead, { status, exit_code })]);
    assert.deepEqual(problems, []);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, status);
    assert.equal(receipts[0].exit_code, exit_code);
    assert.equal(receipts[0].succeeded, false);
  });
}

test('excludes a code point crossing the 4 KiB cut and keeps a code point ending at the cut', () => {
  const prefix = `${'x'.repeat(4091)}😀`;
  const atLimit = `${'x'.repeat(4092)}😀`;
  for (const [output, excerpt, bytes, truncated] of [
    [`${prefix}éend`, prefix, 4100, true],
    [`${atLimit}x`, atLimit, 4097, true],
    [atLimit, atLimit, 4096, false],
  ]) {
    const { receipts, problems } = bind([probe(tag)], [commandEvent(nodeRead, { aggregated_output: output })]);
    assert.deepEqual(problems, []);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].output_excerpt, excerpt);
    assert.equal(receipts[0].output_bytes, bytes);
    assert.equal(receipts[0].output_truncated, truncated);
  }
});

test('reports the probe count first and still checks every claim', () => {
  const tags = Array.from({ length: 8 }, (_, index) => `${PROBE_TAG_PREFIX}${String(index).padStart(16, '0')}`);
  const { receipts, problems } = bind([...tags, tag].map(probe), tags.map((value) => commandEvent(gitRead(value))));
  assert.deepEqual(problems, [
    { key: 'probe-count', values: { count: 9, max: 8 } },
    { key: 'probe-unmatched', values: { index: 8, tag } },
  ]);
  assert.deepEqual(receipts.map(({ probe_tag }) => probe_tag), tags);
});

test('withholds receipts for an incomplete capture even with one completed match per probe', () => {
  assert.deepEqual(bind([probe(tag), probe(otherTag)], [commandEvent(nodeRead), commandEvent(gitRead(otherTag))], false), {
    receipts: [],
    problems: [{ key: 'probe-capture-incomplete', values: {} }],
  });
});

test('accepts an empty probe list when capture is incomplete', () => {
  assert.deepEqual(bind([], [commandEvent(nodeRead)], false), { receipts: [], problems: [] });
});

test('reports malformed tags and validates duplicate claims by their original index', () => {
  const malformed = `${tag}f`;
  const { receipts, problems } = bind([probe(malformed), probe(tag), probe(tag)], [commandEvent(nodeRead)]);
  assert.deepEqual(problems, [
    { key: 'probe-tag-shape', values: { index: 0, tag: malformed } },
    { key: 'probe-tag-duplicate', values: { index: 2, tag } },
  ]);
  assert.deepEqual(receipts.map(({ probe_tag }) => probe_tag), [tag]);
});

test('ignores output, non-command items, non-string commands, case changes and longer tokens', () => {
  const events = [
    commandEvent(gitRead(`${tag}x`)),
    commandEvent(gitRead(`_${tag}`)),
    commandEvent(gitRead(tag.toUpperCase())),
    commandEvent(gitRead(otherTag), { aggregated_output: tag }),
    commandEvent(nodeRead, { type: 'agent_message' }),
    commandEvent([tag]),
  ];
  assert.deepEqual(bind([probe(tag)], events), {
    receipts: [],
    problems: [{ key: 'probe-unmatched', values: { index: 0, tag } }],
  });
});

test('accepts ASCII token boundaries and repeated occurrences in one completed event', () => {
  const command = gitRead(`é${tag}é / ${tag}`);
  const { receipts, problems } = bind([probe(tag)], [commandEvent(command)]);
  assert.deepEqual(problems, []);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].command, command);
});

test('reports a started-only match as incomplete', () => {
  const started = commandEvent(nodeRead, { status: 'in_progress', exit_code: null }, 'item.started');
  assert.deepEqual(bind([probe(tag)], [started]), {
    receipts: [],
    problems: [{ key: 'probe-incomplete', values: { index: 0, tag } }],
  });
});

test('counts failed or invalid terminal items before checking whether a match is unique', () => {
  const retry = commandEvent(nodeRead, { id: 'item_4' });
  for (const first of [
    commandEvent(nodeRead, { status: 'failed', exit_code: 1 }),
    commandEvent(nodeRead, { status: 'failed', exit_code: null }),
  ]) {
    assert.deepEqual(bind([probe(tag)], [first, retry]), {
      receipts: [],
      problems: [{ key: 'probe-ambiguous', values: { index: 0, tag, count: 2 } }],
    });
  }
});

test('rejects a second distinct marker even when it was never claimed', () => {
  const command = gitRead(`${tag} ${otherTag}`);
  assert.deepEqual(bind([probe(tag)], [commandEvent(command)]), {
    receipts: [],
    problems: [{ key: 'probe-multiple-markers', values: { index: 0, tag } }],
  });
});

test('measures the command limit in UTF-8 and accepts the exact boundary', () => {
  const head = `${gitRead(tag)} # `;
  const atLimit = `${head}${'x'.repeat(16384 - head.length)}`;
  assert.equal(bind([probe(tag)], [commandEvent(atLimit)]).receipts.length, 1);

  const tooLong = `${atLimit.slice(0, -1)}é`;
  assert.deepEqual(bind([probe(tag)], [commandEvent(tooLong)]), {
    receipts: [],
    problems: [{ key: 'probe-command-too-long', values: { index: 0, tag, bytes: 16385, max: 16384 } }],
  });
});

test('rejects invalid terminal fields, including missing output', () => {
  const missingOutput = commandEvent(nodeRead);
  delete missingOutput.item.aggregated_output;
  for (const event of [
    commandEvent(nodeRead, { id: 3 }),
    commandEvent(nodeRead, { status: 'in_progress' }),
    commandEvent(nodeRead, { exit_code: '0' }),
    commandEvent(nodeRead, { exit_code: 0.5 }),
    commandEvent(nodeRead, { aggregated_output: null }),
    missingOutput,
  ]) {
    assert.deepEqual(bind([probe(tag)], [event]), {
      receipts: [],
      problems: [{ key: 'probe-terminal-invalid', values: { index: 0, tag } }],
    });
  }
});

test('reports problems in probe order and then in rule order for one completed match', () => {
  const command = gitRead(`${tag} ${otherTag} ${'x'.repeat(16384)}`);
  const bytes = command.length;
  assert.deepEqual(bind([probe(otherTag), probe(tag)], [commandEvent(command, { exit_code: null })]), {
    receipts: [],
    problems: [
      { key: 'probe-multiple-markers', values: { index: 0, tag: otherTag } },
      { key: 'probe-command-too-long', values: { index: 0, tag: otherTag, bytes, max: 16384 } },
      { key: 'probe-terminal-invalid', values: { index: 0, tag: otherTag } },
      { key: 'probe-multiple-markers', values: { index: 1, tag } },
      { key: 'probe-command-too-long', values: { index: 1, tag, bytes, max: 16384 } },
      { key: 'probe-terminal-invalid', values: { index: 1, tag } },
    ],
  });
});
