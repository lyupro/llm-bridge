/** Guards installed-home guidance routing and refusals (Plan_64 B4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guidance } from '../../cli/guidance.mjs';
import { GUIDANCE_TOPICS } from '../../src/home/lib/guidance-topics.mjs';
import { COMMANDS } from '../../cli/command-registry.mjs';
import { main } from '../../bin/llm-bridge.mjs';
import { makeHomeImage } from '../home-image.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function writeRegistry(root, source = `export const GUIDANCE_TOPICS = ${JSON.stringify(GUIDANCE_TOPICS)};`) {
  const registryPath = path.join(root, 'lib', 'guidance-topics.mjs');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, source, 'utf8');
}

function homeFixture(t, { installRegistry = true } = {}) {
  const home = makeTempTree('guidance-');
  t.after(() => removeTempTree(home));
  if (installRegistry) writeRegistry(home);
  return { home, env: { LLM_BRIDGE_HOME: home } };
}

function useMainHome(t, home) {
  const previous = process.env.LLM_BRIDGE_HOME;
  process.env.LLM_BRIDGE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.LLM_BRIDGE_HOME;
    else process.env.LLM_BRIDGE_HOME = previous;
  });
}

function assertTopics(output) {
  for (const [topic, summary] of Object.entries(GUIDANCE_TOPICS)) {
    assert.ok(output.includes(`  ${topic} — ${summary}`), topic);
  }
  assert.ok(output.includes('Usage: llm-bridge guidance [<topic>]'));
}

test('guidance always returns a Promise for usage, read errors and rendering', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.writeFileSync(path.join(home, 'guidance', 'order.md'), 'Installed rules');
  fs.writeFileSync(path.join(home, 'guidance', 'records.md'), '{{unknown-field}}');
  for (const [argv, exitCode] of [
    [[], 0], [['unknown'], 2], [['order', 'records'], 2],
    [['budget'], 1], [['order'], 0], [['records'], 1],
  ]) {
    await guidance(argv, { env }).then((result) => assert.equal(result.exitCode, exitCode));
  }
});

test('guidance lists the finite topics in order with summaries and usage', async (t) => {
  const { env } = homeFixture(t);
  const result = await guidance([], { env });
  assert.equal(result.exitCode, 0);
  const expectedTopics = ['order', 'advisor', 'arbiter', 'budget', 'records', 'concurrency', 'troubleshooting'];
  assert.deepEqual(Object.keys(GUIDANCE_TOPICS), expectedTopics);
  assertTopics(result.output);
  assert.deepEqual(result.output.split('\n').slice(1, 1 + expectedTopics.length),
    Object.entries(GUIDANCE_TOPICS).map(([topic, summary]) => `  ${topic} — ${summary}`));
});

test('guidance advertises and renders a topic added by the installed home', async (t) => {
  // The 2026-11-20 incident had package 0.8.2 on PATH and newer topics installed from the clone.
  const { home } = homeFixture(t, { installRegistry: false });
  const root = path.join(home, 'installed home # Unicode-漢');
  const env = { LLM_BRIDGE_HOME: root };
  const topic = 'installed-only';
  const summary = 'Only in the installed registry.';
  assert.equal(Object.hasOwn(GUIDANCE_TOPICS, topic), false);
  writeRegistry(root, `export const GUIDANCE_TOPICS = Object.freeze(${JSON.stringify({
    ...GUIDANCE_TOPICS, [topic]: summary,
  })});`);
  fs.mkdirSync(path.join(root, 'guidance'));
  fs.writeFileSync(path.join(root, 'guidance', `${topic}.md`), '{{order-rules:installed-only}}', 'utf8');
  fs.writeFileSync(path.join(root, 'lib', 'order-rules.mjs'), `export const ORDER_RULES = {
    'installed-rule': { topic: 'installed-only', rule: 'Rules from the installed home.' },
  };`, 'utf8');

  for (const [argv, exitCode] of [[[], 0], [['unknown'], 2], [['order', 'advisor'], 2]]) {
    const result = await guidance(argv, { env });
    assert.equal(result.exitCode, exitCode);
    assert.ok(result.output.includes(`  ${topic} — ${summary}`));
  }
  assert.deepEqual(await guidance([topic], { env }),
    { exitCode: 0, output: '- `installed-rule`: Rules from the installed home.' });
});

test('guidance refuses a clone topic omitted from the installed registry', async (t) => {
  const { home, env } = homeFixture(t, { installRegistry: false });
  assert.ok(Object.hasOwn(GUIDANCE_TOPICS, 'arbiter'));
  writeRegistry(home, 'export const GUIDANCE_TOPICS = { order: "Installed order summary." };');
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.writeFileSync(path.join(home, 'guidance', 'arbiter.md'), 'Stale guidance file.', 'utf8');

  const result = await guidance(['arbiter'], { env });
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /^Unknown guidance topic "arbiter"\./);
  assert.match(result.output, /^  order — Installed order summary\.$/m);
  assert.doesNotMatch(result.output, /^  arbiter /m);
});

test('missing installed registry names its path and asks for update before processing topics', async (t) => {
  const { home, env } = homeFixture(t, { installRegistry: false });
  for (const argv of [[], ['order'], ['order', 'advisor']]) {
    const result = await guidance(argv, { env });
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes(path.join(home, 'lib', 'guidance-topics.mjs')));
    assert.ok(result.output.endsWith('\nrun llm-bridge update'));
  }
});

test('failed installed registry import names its path and asks for update', async (t) => {
  const { home, env } = homeFixture(t, { installRegistry: false });
  writeRegistry(home, 'throw new Error("installed registry import failed");');
  const result = await guidance([], { env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(path.join(home, 'lib', 'guidance-topics.mjs')));
  assert.match(result.output, /installed registry import failed\nrun llm-bridge update$/);
});

test('invalid installed registry exports name their path and ask for update', async (t) => {
  for (const source of [
    'export const unrelated = {};',
    'export const GUIDANCE_TOPICS = Object.freeze([]);',
    'export const GUIDANCE_TOPICS = { "Bad-key": "Summary." };',
    'export const GUIDANCE_TOPICS = { all: "Reserved." };',
    'export const GUIDANCE_TOPICS = { order: 1 };',
    'export const GUIDANCE_TOPICS = { order: "" };',
    'export const GUIDANCE_TOPICS = { order: "  " };',
  ]) {
    const { home, env } = homeFixture(t, { installRegistry: false });
    writeRegistry(home, source);
    const result = await guidance([], { env });
    assert.equal(result.exitCode, 1, source);
    assert.ok(result.output.includes(path.join(home, 'lib', 'guidance-topics.mjs')));
    assert.match(result.output, /Invalid GUIDANCE_TOPICS export\nrun llm-bridge update$/);
  }
});

test('guidance prints each installed topic verbatim from the injected home', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  for (const topic of Object.keys(GUIDANCE_TOPICS)) {
    const text = `\uFEFF# ${topic}\r\n\r\nDetailed rules — naïve.  \r\n\n`;
    fs.writeFileSync(path.join(home, 'guidance', `${topic}.md`), text);
    assert.deepEqual(await guidance([topic], { env }), { exitCode: 0, output: text });
  }
});

test('guidance also resolves the default brand home from an injected homedir', async (t) => {
  const { home } = homeFixture(t, { installRegistry: false });
  const root = path.join(home, '.lyupro', '.llm-bridge');
  writeRegistry(root);
  const dir = path.join(root, 'guidance');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'order.md'), 'Default home rules');
  assert.deepEqual(await guidance(['order'], { env: {}, homedir: home }),
    { exitCode: 0, output: 'Default home rules' });
});

test('guidance refuses unknown topics, including inherited names and traversal', async (t) => {
  const { env } = homeFixture(t);
  for (const topic of ['unknown', 'toString', '__proto__', '../order']) {
    const result = await guidance([topic], { env });
    assert.equal(result.exitCode, 2);
    assert.ok(result.output.includes(`Unknown guidance topic "${topic}"`));
    assertTopics(result.output);
  }
});

test('guidance refuses two arguments and lists the topics', async (t) => {
  const { env } = homeFixture(t);
  const result = await guidance(['order', 'advisor'], { env });
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /at most one topic/);
  assertTopics(result.output);
});

test('missing guidance names the absolute home path and the update command', async (t) => {
  const { home, env } = homeFixture(t);
  const result = await guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(path.join(home, 'guidance', 'order.md')));
  assert.match(result.output, /run llm-bridge update/);
});

test('unreadable guidance names the home path and asks for update', async (t) => {
  const { home, env } = homeFixture(t);
  const file = path.join(home, 'guidance', 'order.md');
  const readFileSync = fs.readFileSync;
  // Permission bits do not reliably refuse reads on Windows; inject the filesystem refusal.
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return readFileSync(target, ...args);
  });
  const result = await guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(file));
  assert.match(result.output, /permission denied/);
  assert.match(result.output, /run llm-bridge update/);
});

test('missing installed guidance never falls back to a readable clone seed', async (t) => {
  const { home, env } = homeFixture(t);
  const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const cloneFile = path.join(root, 'src', 'home', 'guidance', 'order.md');
  const reads = [];
  const readFileSync = fs.readFileSync;
  // The 2026-08-26 incident requires a readable seed to remain irrelevant when home is missing.
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    const file = target instanceof URL ? fileURLToPath(target) : target;
    reads.push(file);
    if (file === cloneFile) return 'Clone seed must never be printed';
    return readFileSync(target, ...args);
  });
  const result = await guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  const registryPath = path.join(home, 'lib', 'guidance-topics.mjs');
  assert.deepEqual(reads.filter((file) => file !== registryPath), [path.join(home, 'guidance', 'order.md')]);
  assert.doesNotMatch(result.output, /Clone seed/);
});

test('guidance is public and reachable through main, with usage errors on io.error', async (t) => {
  const entry = COMMANDS.find((command) => command.name === 'guidance');
  assert.equal(entry.section, 'public');
  assert.equal(entry.summary, "Print the package's detailed rules for one topic");
  assert.deepEqual(entry.usage, ['llm-bridge guidance [<topic>]']);
  useMainHome(t, homeFixture(t).home);
  const logs = [];
  const errors = [];
  const io = { log: (text) => logs.push(text), error: (text) => errors.push(text) };
  assert.equal(await main(['guidance'], io), 0);
  assertTopics(logs[0]);
  assert.deepEqual(errors, []);
  for (const args of [['unknown'], ['order', 'advisor']]) {
    assert.equal(await main(['guidance', ...args], io), 2);
  }
  assert.equal(logs.length, 1);
  assert.equal(errors.length, 2);
  for (const output of errors) assertTopics(output);
});

test('main awaits installed rendering and preserves existing output routing', async (t) => {
  const { home } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.writeFileSync(path.join(home, 'lib', 'shell-unsafe.mjs'),
    'export const SHELL_UNSAFE_SEQUENCES = ["installed-only"];');
  fs.writeFileSync(path.join(home, 'guidance', 'order.md'), 'Forbidden: {{shell-unsafe-sequences}}');
  useMainHome(t, home);
  const logs = [];
  const errors = [];
  const io = { log: (text) => logs.push(text), error: (text) => errors.push(text) };
  assert.equal(await main(['guidance', 'order'], io), 0);
  assert.deepEqual(logs, ['Forbidden: `installed-only`']);
  fs.writeFileSync(path.join(home, 'guidance', 'records.md'), '{{unknown-field}}');
  assert.equal(await main(['guidance', 'records'], io), 1);
  assert.equal(logs.length, 2);
  assert.deepEqual(errors, []);
  assert.match(logs[1], /topic "records"/);
  assert.ok(logs[1].includes('{{unknown-field}}'));
  assert.ok(logs[1].endsWith('run llm-bridge update'));
});

test('unknown installed placeholders return exit 1 naming the topic and placeholder', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.writeFileSync(path.join(home, 'guidance', 'order.md'), '{{unknown-field}}');
  const result = await guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /topic "order"/);
  assert.ok(result.output.includes('{{unknown-field}}'));
  assert.ok(result.output.endsWith('run llm-bridge update'));
});

test('unresolved installed templates return exit 1 with the update remedy', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.writeFileSync(path.join(home, 'guidance', 'records.md'), 'Fields: {{unfinished');
  const result = await guidance(['records'], { env });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /topic "records"/);
  assert.ok(result.output.includes('{{unfinished'));
  assert.ok(result.output.endsWith('run llm-bridge update'));
});

test('missing installed value modules return exit 1 for each placeholder', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  for (const [topic, placeholder] of [
    ['order', '{{shell-unsafe-sequences}}'], ['records', '{{review-required-fields}}'],
    ['budget', '{{agent-budgets}}'],
  ]) {
    fs.writeFileSync(path.join(home, 'guidance', `${topic}.md`), placeholder);
    const result = await guidance([topic], { env });
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes(`topic "${topic}"`));
    assert.ok(result.output.includes(placeholder));
    assert.match(result.output, /Cannot find module/);
    assert.ok(result.output.endsWith('run llm-bridge update'));
  }
});

test('advisor guidance distinguishes failed-pass repairs from phase grants (Plan_80 E4)', () => {
  // Facts, not wording: a topic that names only retry: sends the orchestrator to a fresh thread.
  const text = fs.readFileSync(new URL('../../src/home/guidance/advisor.md', import.meta.url), 'utf8');
  assert.match(text, /`retry: <run folder> — <reason>`[^.]*fresh thread/);
  assert.match(text, /`resume: <run folder> — <reason>`[^.]*own Codex thread/);
  assert.match(text, /`resume-grant-usable`/);
  assert.match(text, /Neither `retry:` nor `resume:` authorizes the next phase/);
});

test('installed order guidance lists the OW-097 arbitration rules', async (t) => {
  const home = await makeHomeImage(t);
  const result = await guidance(['order'], { env: { LLM_BRIDGE_HOME: home } });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /- `advisor-task-arbiter-input`:.*Trigger, Position or Prior runs.*codex-arbiter/);
  assert.match(result.output, /- `arbiter-task-shape`:.*## Trigger.*## Position.*## Prior runs/);
  assert.match(result.output, /- `arbiter-prior-run`:.*OK codex-advisor advise runs.*different option/);
});

test('records guidance follows the newest resumed run and preserves the review template (Plan_80 E4)', () => {
  const text = fs.readFileSync(new URL('../../src/home/guidance/records.md', import.meta.url), 'utf8');
  assert.match(text, /`resumed_from`/);
  assert.match(text, /`resume-note\.md`/);
  assert.match(text, /newest run of the chain/);
  assert.ok(text.includes('{{review-required-fields}}'));
});

test('invalid host config names the file without recommending update', async (t) => {
  const { home, env } = homeFixture(t);
  const configPath = path.join(home, 'config.json');
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.writeFileSync(path.join(home, 'guidance', 'budget.md'), '{{agent-budgets}}');
  fs.writeFileSync(configPath, '{"budgets":');
  for (const file of ['agents.mjs', 'run-config.mjs', 'config-validate.mjs', 'budgets.mjs', 'brand-home.mjs', 'package-identity.mjs']) {
    let source = fs.readFileSync(new URL('../../src/home/lib/' + file, import.meta.url), 'utf8');
    for (const dependency of ['json-file.mjs', 'config-edit.mjs']) {
      source = source.replace("'./" + dependency + "'",
        JSON.stringify(new URL('../../src/home/lib/' + dependency, import.meta.url).href));
    }
    fs.writeFileSync(path.join(home, 'lib', file), source);
  }
  const result = await guidance(['budget'], { env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(configPath));
  assert.match(result.output, /cannot be parsed as JSON/);
  assert.match(result.output, /Fix or delete the file/);
  assert.doesNotMatch(result.output, /run llm-bridge update/);
});

test('budget guidance passes the resolved config path for overridden and default homes', async (t) => {
  for (const overridden of [true, false]) {
    const { home } = homeFixture(t, { installRegistry: false });
    const root = overridden ? home : path.join(home, '.lyupro', '.llm-bridge');
    const configPath = path.join(root, 'config.json');
    fs.mkdirSync(path.join(root, 'guidance'), { recursive: true });
    writeRegistry(root);
    fs.writeFileSync(path.join(root, 'guidance', 'budget.md'), '{{agent-budgets}}');
    fs.writeFileSync(configPath, JSON.stringify({ minutes: 6.25 }));
    fs.writeFileSync(path.join(root, 'lib', 'agents.mjs'),
      'export const AGENTS = { "installed-budget-agent": { role: "custom-role" } };');
    fs.writeFileSync(path.join(root, 'lib', 'run-config.mjs'), `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      export function readRunConfig(file, options) {
        assert.equal(file, ${JSON.stringify(configPath)});
        assert.deepEqual(options, { provenance: true });
        return {
          config: { budgets: { 'custom-role': { default: JSON.parse(fs.readFileSync(file, 'utf8')).minutes } } },
          budgetSources: { 'custom-role': new Set(['default']) },
        };
      }
    `);
    const result = await guidance(['budget'],
      { env: overridden ? { LLM_BRIDGE_HOME: root } : {}, homedir: home });
    assert.equal(result.exitCode, 0, result.output);
    assert.ok(result.output.includes(`values come from ${configPath}.`));
    assert.ok(result.output.includes('| installed-budget-agent | \u2014 | 6.25 | host config |'));
  }
});
