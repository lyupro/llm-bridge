/** Guards Plan_71 B1's exact-shape help contract so parser refusals cannot become help. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpRequest, withCommandHelp, renderCommandHelp } from '../../cli/command-help.mjs';

test('helpRequest recognizes only exact command or declared-action help shapes', () => {
  assert.deepEqual(helpRequest(['-h']), { action: null });
  assert.deepEqual(helpRequest(['--help']), { action: null });
  assert.deepEqual(helpRequest(['-h'], ['set']), { action: null });
  assert.deepEqual(helpRequest(['--help'], ['set']), { action: null });
  assert.deepEqual(helpRequest(['set', '-h'], ['set']), { action: 'set' });
  assert.deepEqual(helpRequest(['set', '--help'], ['set']), { action: 'set' });
  assert.equal(helpRequest(['set', '-h']), null);
  assert.equal(helpRequest(['set', '--help']), null);
  assert.equal(helpRequest(['--host', '--help']), null);
  assert.equal(helpRequest(['--model', '--help']), null);
  assert.equal(helpRequest(['--older-than', '--help']), null);
  assert.equal(helpRequest(['--older-than=--help']), null);
  assert.equal(helpRequest(['--', '--help']), null);
  assert.equal(helpRequest(['-h', 'x']), null);
  assert.equal(helpRequest(['--help', 'x']), null);
  assert.equal(helpRequest(['x', '-h']), null);
  assert.equal(helpRequest(['x', '--help'], ['set']), null);
  assert.equal(helpRequest(['-H']), null);
  assert.equal(helpRequest(['help']), null);
  assert.equal(helpRequest([]), null);
  assert.equal(helpRequest(['set', '-h', 'x'], ['set']), null);
  assert.equal(helpRequest(['set', 'x', '--help'], ['set']), null);
  assert.equal(helpRequest(['-h', '--help']), null);
});

test('withCommandHelp appends exactly one hint and is idempotent', () => {
  const message = 'Unknown model option.';
  const expected = 'Unknown model option.\nRun llm-bridge model -h for usage.';
  assert.equal(withCommandHelp('model', message), expected);
  assert.equal(withCommandHelp('model', expected), expected);
  assert.equal(withCommandHelp('model', withCommandHelp('model', message)), expected);
  assert.equal(withCommandHelp('model', 'Run llm-bridge model -h for usage.'), 'Run llm-bridge model -h for usage.');
  assert.equal(withCommandHelp('model', 'Prefix Run llm-bridge model -h for usage.'), 'Prefix Run llm-bridge model -h for usage.\nRun llm-bridge model -h for usage.');
});

const entry = {
  name: 'model',
  summary: 'Read or change the model.',
  usage: ['llm-bridge model', 'llm-bridge model <action>'],
};
const entryWithActions = {
  ...entry,
  actions: {
    set: { summary: 'Choose a model.', usage: ['llm-bridge model set <name>', 'llm-bridge model set <name> --project <path>'] },
    show: { summary: 'Show the model.', usage: ['llm-bridge model show'] },
  },
};

test('renderCommandHelp renders a command without actions', () => {
  assert.equal(renderCommandHelp(entry), 'Usage:\n  llm-bridge model\n  llm-bridge model <action>\n\nRead or change the model.');
});

test('renderCommandHelp lists actions and the one-action hint', () => {
  assert.equal(renderCommandHelp(entryWithActions), 'Usage:\n  llm-bridge model\n  llm-bridge model <action>\n\nRead or change the model.\n\nActions:\n  set   Choose a model.\n  show  Show the model.\nRun llm-bridge model <action> -h for one action.');
});

test('renderCommandHelp renders only the requested action usage and summary', () => {
  assert.equal(renderCommandHelp(entryWithActions, 'set'), 'Usage:\n  llm-bridge model set <name>\n  llm-bridge model set <name> --project <path>\n\nChoose a model.');
  assert.equal(renderCommandHelp(entryWithActions, 'show'), 'Usage:\n  llm-bridge model show\n\nShow the model.');
  assert.throws(() => renderCommandHelp(entryWithActions, 'missing'), /Unknown help action/);
});

test('renderCommandHelp fails loudly for every malformed usage prefix', () => {
  assert.throws(() => renderCommandHelp({ ...entry, usage: ['llm-bridge doctor'] }), /Help usage must start with "llm-bridge model"/);
  assert.throws(() => renderCommandHelp({ ...entry, usage: ['llm-bridge model-extra'] }), /Help usage must start/);
  assert.throws(() => renderCommandHelp({ ...entry, usage: ['llm-bridge model', 'model set <name>'] }), /Help usage must start/);
  const malformedAction = { ...entryWithActions, actions: { ...entryWithActions.actions, typo: { summary: 'Invalid.', usage: ['llm-bridge models typo'] } } };
  assert.throws(() => renderCommandHelp(malformedAction), /Help usage must start/);
  assert.throws(() => renderCommandHelp(malformedAction, 'set'), /Help usage must start/);
  assert.throws(() => renderCommandHelp(malformedAction, 'typo'), /Help usage must start/);
});
