import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { arbiterCaptureFacts } from '../../src/home/lib/meta/arbiter-capture.mjs';
import { readEvents } from '../../src/home/lib/meta/events.mjs';
import { makeRun } from './test-fixtures.mjs';

const record = '{"type":"turn.started"}';
const confirmed = (receipts = {}) => ({
  stdio_drained: true,
  stop: { receipts: { lines: 1, incomplete: false, truncated: false, write_error: null, ...receipts } },
});

test('OW-097 D4 uses one read for the events and the physical line count', (t) => {
  const runDir = makeRun({ events: `\uFEFF${record}\r\n\r\n42\r\n` });
  const events = readEvents(runDir).events;
  const expectedPath = path.join(runDir, 'events.jsonl');
  const readFileSync = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === expectedPath) reads += 1;
    return readFileSync(file, ...args);
  });

  assert.deepEqual(arbiterCaptureFacts({ runDir, status: confirmed({ lines: 3 }) }), {
    events,
    captureComplete: true,
    reasons: [],
  });
  assert.equal(reads, 1);
});

const cases = [
  ['events-unreadable', 'missing stream', undefined, confirmed()],
  ['drain-unconfirmed', 'missing drain confirmation', `${record}\n`, { stop: confirmed().stop }],
  ['drain-unconfirmed', 'false drain confirmation', `${record}\n`, { ...confirmed(), stdio_drained: false }],
  ['receipts-missing', 'missing receipts', `${record}\n`, { stdio_drained: true }],
  ...[undefined, null, -1, 1.5, '1'].map((lines) => [
    'receipts-missing', `invalid receipt count ${JSON.stringify(lines)}`, `${record}\n`, confirmed({ lines }),
  ]),
  ['stream-cut', 'stored truncation', `${record}\n`, confirmed({ truncated: true })],
  ['stream-fragment', 'stored fragment', `${record}\n`, confirmed({ incomplete: true })],
  ['stream-fragment', 'unterminated final record', `${record}\n${record}`, confirmed()],
  ['stream-fragment', 'empty stream without a newline', '', confirmed({ lines: 0 })],
  ['line-count-mismatch', 'unaccounted blank line', `${record}\n\n`, confirmed()],
  ['malformed-line', 'invalid JSON', `${record}\n{\n`, confirmed({ lines: 2 })],
];

for (const [reason, description, eventsText, status] of cases) {
  test(`${description} produces only ${reason}`, () => {
    const runDir = makeRun({ events: eventsText });

    assert.deepEqual(arbiterCaptureFacts({ runDir, status }), {
      events: readEvents(runDir).events,
      captureComplete: false,
      reasons: [reason],
    });
  });
}

test('reports simultaneous failures in stable order', () => {
  const runDir = makeRun({ events: `${record}\n{` });
  const status = { ...confirmed({ lines: 2, incomplete: true, truncated: true }), stdio_drained: false };

  assert.deepEqual(arbiterCaptureFacts({ runDir, status }).reasons, [
    'drain-unconfirmed', 'stream-cut', 'stream-fragment', 'line-count-mismatch', 'malformed-line',
  ]);
});

test('requires a run directory and an object status', () => {
  const runDir = makeRun({ events: `${record}\n` });

  assert.throws(() => arbiterCaptureFacts(), TypeError);
  assert.throws(() => arbiterCaptureFacts({ status: confirmed() }), TypeError);
  for (const status of [undefined, null, false, 'status', 42, []]) {
    assert.throws(() => arbiterCaptureFacts({ runDir, status }), TypeError);
  }
});
