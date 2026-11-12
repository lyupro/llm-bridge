import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passOutputOf } from '../../src/home/lib/meta/pass-output.mjs';
import { eventLines } from '../../src/home/lib/meta/events.mjs';

const turn = { type: 'turn.started' };
const item = (type, text) => ({ type: 'item.completed', item: { type, text } });
const stream = (...events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

const cases = [
  ['output message', stream(turn, item('agent_message', 'Answer')), 'present', 'model-output'],
  ['reasoning only', stream(turn, item('reasoning', 'Thinking')), 'present', 'model-output'],
  ['commands only', stream(turn, item('command_execution', 'stdout')), 'absent', 'no-model-output'],
  ['turn only', stream(turn), 'absent', 'no-model-output'],
  ['no turn start', stream(item('agent_message', 'Warning')), 'unknown', 'missing-turn-started'],
  ['malformed middle', stream(turn) + 'broken\n{}\n', 'unknown', 'malformed-line:2'],
  ['damage after output', stream(turn, item('agent_message', 'Answer')) + 'broken\n{}\n',
    'unknown', 'malformed-line:3'],
  ['damage before turn', 'broken\n' + stream(turn), 'unknown', 'malformed-line:1'],
  ['cut message', stream(turn) + '{"type":"item.completed","item":{"type":"agent_message","text":"cut',
    'present', 'truncated-output-item'],
  ['cut reasoning', stream(turn) + '{"type":"item.completed","item":{"type":"reasoning","text":"cut',
    'present', 'truncated-output-item'],
  ['cut command', stream(turn) + '{"type":"item.completed","item":{"type":"command_execution","command":"cut',
    'absent', 'no-model-output'],
  ['cut other event', stream(turn) + '{"type":"item.started","item":{"type":"agent_message"',
    'absent', 'no-model-output'],
  ['cut output without turn', '{"type":"item.completed","item":{"type":"agent_message"',
    'unknown', 'missing-turn-started'],
  ['cut output with newline', stream(turn) + '{"type":"item.completed","item":{"type":"agent_message"\n',
    'present', 'truncated-output-item'],
  ['missing file', null, 'unknown', 'missing-events'],
  ['undefined file', undefined, 'unknown', 'missing-events'],
  ['empty file', '', 'unknown', 'empty-events'],
  ['whitespace file', ' \n\t\n', 'unknown', 'empty-events'],
  ['warning before turn', stream(item('agent_message', 'CLI warning'), turn), 'absent', 'no-model-output'],
  ['reasoning before turn', stream(item('reasoning', 'CLI warning'), turn), 'absent', 'no-model-output'],
  ['empty output', stream(turn, item('agent_message', ''), item('reasoning', ' \t')),
    'absent', 'no-model-output'],
  ['missing text', stream(turn, item('agent_message')), 'absent', 'no-model-output'],
  ['non-string text', stream(turn, item('reasoning', 42)), 'absent', 'no-model-output'],
  ['unfinished item', stream(turn, { type: 'item.started', item: { type: 'agent_message', text: 'Answer' } }),
    'absent', 'no-model-output'],
  ['other parsed values', stream(null, [], 42, turn), 'absent', 'no-model-output'],
  // A blank line is not damage: the shared parse skips it for every reader.
  ['blank middle line', stream(turn) + '\n{}\n', 'absent', 'no-model-output'],
  ['CRLF stream', stream(turn, item('reasoning', 'Thinking')).replaceAll('\n', '\r\n'),
    'present', 'model-output'],
  ['BOM stream', '\uFEFF' + stream(turn, item('agent_message', 'Answer')), 'present', 'model-output'],
  ['no trailing newline', stream(turn, item('agent_message', 'Answer')).trimEnd(), 'present', 'model-output'],
];

for (const [name, text, state, reason] of cases) {
  test(`pass output: ${name}`, () => {
    // A missing file reaches passOutputOf as null or undefined, never as parsed lines.
    const lines = text === null || text === undefined ? text : eventLines(text);
    assert.deepEqual(passOutputOf(lines), { state, reason });
  });
}
