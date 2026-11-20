/** Plan_79 B1: installed modules own guidance values and broken templates fail loudly. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { guidance } from '../../cli/guidance.mjs';
import { AGENTS } from '../../src/home/lib/agents.mjs';
import { renderGuidance as renderCloneGuidance } from '../../src/home/lib/guidance-render.mjs';
import { GUIDANCE_TOPICS } from '../../src/home/lib/guidance-topics.mjs';
import { ORDER_RULES } from '../../src/home/lib/order-rules.mjs';
import { SHELL_UNSAFE_SEQUENCES } from '../../src/home/lib/shell-unsafe.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function homeFixture(t, { installRenderer = true } = {}) {
  const tree = makeTempTree('guidance-render-');
  t.after(() => removeTempTree(tree));
  const root = path.join(tree, 'installed home # Unicode-漢');
  fs.mkdirSync(root);
  if (installRenderer) {
    fs.mkdirSync(path.join(root, 'lib'));
    fs.copyFileSync(new URL('../../src/home/lib/guidance-render.mjs', import.meta.url),
      path.join(root, 'lib', 'guidance-render.mjs'));
  }
  return root;
}

async function loadRenderer(root) {
  const { renderGuidance } = await import(pathToFileURL(path.join(root, 'lib', 'guidance-render.mjs')).href);
  return renderGuidance;
}

function writeModule(root, file, source) {
  const target = path.join(root, 'lib', file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, 'utf8');
}

function budgetFixture(t, extra = {}) {
  const root = homeFixture(t);
  for (const file of ['run-config.mjs', 'config-validate.mjs', 'budgets.mjs', 'brand-home.mjs', 'package-identity.mjs']) {
    let source = fs.readFileSync(new URL(`../../src/home/lib/${file}`, import.meta.url), 'utf8');
    // Plan_80 E39: keep the real reader and validator against the isolated installed registry.
    for (const dependency of ['json-file.mjs', 'config-edit.mjs']) {
      source = source.replace(`'./${dependency}'`,
        JSON.stringify(new URL(`../../src/home/lib/${dependency}`, import.meta.url).href));
    }
    writeModule(root, file, source);
  }
  const registry = { ...AGENTS, ...extra };
  writeModule(root, 'agents.mjs', `export const AGENTS = ${JSON.stringify(registry)};`);
  return { root, registry, configPath: path.join(path.dirname(root), 'isolated-config.json') };
}

async function assertRenderFailure(text, root, topic, placeholder, reason, topics = GUIDANCE_TOPICS) {
  const renderGuidance = await loadRenderer(root);
  await assert.rejects(renderGuidance(text, { topic, topics }), (error) => {
    assert.ok(error.message.includes(`topic "${topic}"`));
    assert.ok(error.message.includes(`placeholder "${placeholder}"`));
    assert.match(error.message, reason);
    return true;
  });
}

const codeList = (values) => values.map((value) =>
  value.includes('`') ? '`` ' + value + ' ``' : '`' + value + '`').join(', ');

test('plain text preserves BOM, whitespace and line endings without loading modules', async (t) => {
  const renderGuidance = await loadRenderer(homeFixture(t));
  const text = '\uFEFF# plain\r\n\r\nDetailed rules — naïve.  \r\n';
  assert.equal(await renderGuidance(text, { topic: 'advisor', topics: GUIDANCE_TOPICS }), text);
});

test('guidance rendering requires the topic registry even for plain text', async (t) => {
  const renderGuidance = await loadRenderer(homeFixture(t));
  await assert.rejects(renderGuidance('# plain', { topic: 'order', topics: undefined }),
    /topics is required/);
});

test('every occurrence of a known placeholder uses the owned list', async (t) => {
  const root = homeFixture(t);
  const target = path.join(root, 'lib', 'shell-unsafe.mjs');
  fs.copyFileSync(new URL('../../src/home/lib/shell-unsafe.mjs', import.meta.url), target);
  const renderGuidance = await loadRenderer(root);
  const text = '{{shell-unsafe-sequences}}\n{{shell-unsafe-sequences}}';
  const expected = codeList(SHELL_UNSAFE_SEQUENCES);
  assert.equal(await renderGuidance(text, { topic: 'order', topics: GUIDANCE_TOPICS }), `${expected}\n${expected}`);
});

test('shell values come from the given installed root rather than the clone', async (t) => {
  const root = homeFixture(t);
  const values = ['installed-second', 'installed-first'];
  writeModule(root, 'shell-unsafe.mjs', `export const SHELL_UNSAFE_SEQUENCES = ${JSON.stringify(values)};`);
  assert.notDeepEqual(values, SHELL_UNSAFE_SEQUENCES);
  const renderGuidance = await loadRenderer(root);
  assert.equal(await renderGuidance('{{shell-unsafe-sequences}}', { topic: 'order', topics: GUIDANCE_TOPICS }),
    codeList(values));
});

test('backtick values use spaced double delimiters without opening a code fence', async (t) => {
  const root = homeFixture(t);
  const values = ['`', 'before`after', '&&'];
  writeModule(root, 'shell-unsafe.mjs', `export const SHELL_UNSAFE_SEQUENCES = ${JSON.stringify(values)};`);
  const renderGuidance = await loadRenderer(root);
  const output = await renderGuidance('{{shell-unsafe-sequences}}', { topic: 'order', topics: GUIDANCE_TOPICS });
  assert.equal(output, '`` ` ``, `` before`after ``, `&&`');
  assert.doesNotMatch(output, /`{3}/);
});

test('both review field lists come from the given installed schema', async (t) => {
  const root = homeFixture(t);
  const fields = ['installed-summary', 'installed-verdict'];
  const finding = ['installed-body', 'installed-title'];
  const schema = { required: fields, properties: { findings: { items: { required: finding } } } };
  writeModule(root, 'runner/schemas.mjs', `export const SCHEMAS = ${JSON.stringify({ 'codex-review': schema })};`);
  const renderGuidance = await loadRenderer(root);
  assert.equal(await renderGuidance('{{review-required-fields}}', { topic: 'records', topics: GUIDANCE_TOPICS }),
    `Top-level fields: ${codeList(fields)}; finding fields: ${codeList(finding)}`);
});

test('unknown placeholders including inherited names fail with their topic and token', async (t) => {
  const root = homeFixture(t);
  for (const name of ['unknown', 'constructor', '__proto__', '']) {
    const placeholder = `{{${name}}}`;
    await assertRenderFailure(placeholder, root, 'order', placeholder, /unknown placeholder/);
  }
});

test('unclosed and nested placeholders fail rather than leaking template syntax', async (t) => {
  const root = homeFixture(t);
  for (const placeholder of ['{{', '{{shell-unsafe-sequences}', '{{nested{value}}']) {
    await assertRenderFailure(`Rules: ${placeholder}\nEnd`, root, 'order', placeholder, /unresolved placeholder/);
  }
});

test('a missing installed shell module fails without a clone fallback', async (t) => {
  await assertRenderFailure('{{shell-unsafe-sequences}}', homeFixture(t), 'order',
    '{{shell-unsafe-sequences}}', /Cannot find module/);
});

test('a failed installed schema import names the review placeholder', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'runner/schemas.mjs', "throw new Error('installed schema import failed');");
  await assertRenderFailure('{{review-required-fields}}', root, 'records',
    '{{review-required-fields}}', /installed schema import failed/);
});

test('missing owned exports fail instead of supplying a default list', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'shell-unsafe.mjs', 'export const unrelated = [];');
  await assertRenderFailure('{{shell-unsafe-sequences}}', root, 'order',
    '{{shell-unsafe-sequences}}', /map/);
});

test('template syntax introduced by an installed value also fails', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'shell-unsafe.mjs', 'export const SHELL_UNSAFE_SEQUENCES = ["{{installed-value}}"]');
  await assertRenderFailure('{{shell-unsafe-sequences}}', root, 'order',
    '{{installed-value}}`', /unresolved placeholder/);
});

test('order rule placeholders use the installed root and preserve registry order within a topic', async (t) => {
  const root = homeFixture(t);
  const rules = {
    'installed-second': { topic: 'advisor', rule: 'Second by name, first in the registry.' },
    'other-topic': { topic: 'order', rule: 'Only in the all block.' },
    'installed-first': { topic: 'advisor', rule: 'First by name, second in the registry.' },
  };
  writeModule(root, 'order-rules.mjs', `export const ORDER_RULES = ${JSON.stringify(rules)};`);
  assert.notDeepEqual(rules, ORDER_RULES);
  const expected = '- `installed-second`: Second by name, first in the registry.\n' +
    '- `installed-first`: First by name, second in the registry.';
  const renderGuidance = await loadRenderer(root);
  assert.equal(await renderGuidance('{{order-rules:advisor}}\n{{order-rules:advisor}}',
    { topic: 'advisor', topics: GUIDANCE_TOPICS }),
    `${expected}\n${expected}`);
  assert.equal(await renderGuidance('{{order-rules:all}}', { topic: 'order', topics: GUIDANCE_TOPICS }),
    'Topic `order`:\n- `other-topic`: Only in the all block.\n\nTopic `advisor`:\n' + expected);
});

test('all order rules follow the guidance topic order and omit topics without rules', async (t) => {
  const root = homeFixture(t);
  const rules = {
    'concurrency-rule': { topic: 'concurrency', rule: 'Concurrency rule.' },
    'records-rule': { topic: 'records', rule: 'Records rule.' },
    'budget-rule': { topic: 'budget', rule: 'Budget rule.' },
    'advisor-rule': { topic: 'advisor', rule: 'Advisor rule.' },
    'order-rule': { topic: 'order', rule: 'Order rule.' },
  };
  writeModule(root, 'order-rules.mjs', `export const ORDER_RULES = ${JSON.stringify(rules)};`);
  const topicOrder = ['order', 'records', 'advisor', 'arbiter', 'concurrency', 'budget'];
  const topics = Object.fromEntries(topicOrder.map((topic) => [topic, GUIDANCE_TOPICS[topic]]));
  const renderGuidance = await loadRenderer(root);
  assert.equal(await renderGuidance('{{order-rules:all}}', { topic: 'order', topics }),
    topicOrder.filter((topic) => topic !== 'arbiter').map((topic) =>
      `Topic \`${topic}\`:\n- \`${topic}-rule\`: ${rules[`${topic}-rule`].rule}`).join('\n\n'));
});

test('all order rules fail with the key of a rule whose owner is absent from the topic registry', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'order-rules.mjs', `export const ORDER_RULES = {
    'order-rule': { topic: 'order', rule: 'An included rule.' },
    'arbiter-rule': { topic: 'arbiter', rule: 'A rule with an unregistered owner.' },
  };`);
  const topics = { order: GUIDANCE_TOPICS.order };
  await assertRenderFailure('{{order-rules:all}}', root, 'order', '{{order-rules:all}}',
    /order rule "arbiter-rule" uses unregistered topic "arbiter"/, topics);
  await assertRenderFailure('{{order-rules:arbiter}}', root, 'order', '{{order-rules:arbiter}}',
    /unknown order rule topic "arbiter"/, topics);
});

test('unknown order rule topics including inherited names fail with their topic and token', async (t) => {
  const root = homeFixture(t);
  for (const name of ['unknown', 'constructor', '__proto__', '']) {
    const placeholder = `{{order-rules:${name}}}`;
    await assertRenderFailure(placeholder, root, 'order', placeholder, /unknown order rule topic/);
  }
});

test('a known topic with no order rules fails instead of printing an empty block', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'order-rules.mjs', 'export const ORDER_RULES = { "order-rule": { topic: "order", rule: "Order rule." } };');
  await assertRenderFailure('{{order-rules:budget}}', root, 'budget', '{{order-rules:budget}}', /no order rules/);
});

test('an empty order registry fails for both all and topic placeholders', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'order-rules.mjs', 'export const ORDER_RULES = {};');
  for (const placeholder of ['{{order-rules:all}}', '{{order-rules:order}}']) {
    await assertRenderFailure(placeholder, root, 'order', placeholder, /no order rules/);
  }
});

test('a missing installed order registry fails without a clone fallback', async (t) => {
  await assertRenderFailure('{{order-rules:all}}', homeFixture(t), 'order',
    '{{order-rules:all}}', /Cannot find module/);
});

test('missing order rule exports fail instead of supplying a default registry', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'order-rules.mjs', 'export const unrelated = {};');
  await assertRenderFailure('{{order-rules:all}}', root, 'order',
    '{{order-rules:all}}', /undefined|null/);
});

test('budget rows follow the installed registry and effective host phase sources', async (t) => {
  const { root, configPath } = budgetFixture(t, {
    'installed-extra-agent': { role: 'unrelated-role', budget: { prepare: 4, finish: 9 } },
    'installed-single-phase': { role: 'named-role', budget: { only: 6 } },
  });
  fs.writeFileSync(configPath, JSON.stringify({ budgets: {
    scout: AGENTS['codex-scout'].budget, build: 7.5, review: {}, advisor: { advise: 12 },
    'unrelated-role': { prepare: 3 },
  } }));
  const renderGuidance = await loadRenderer(root);
  const output = await renderGuidance('{{agent-budgets}}', { topic: 'budget', configPath, topics: GUIDANCE_TOPICS });
  assert.equal(output, [
    `Budgets the runner enforces on this host. \`host config\` values come from ${configPath}.`,
    '', '| Agent | Phase | Minutes | Source |', '| --- | --- | --- | --- |',
    `| codex-scout | \u2014 | ${AGENTS['codex-scout'].budget} | host config |`,
    '| codex-build | \u2014 | 7.5 | host config |',
    `| codex-review | \u2014 | ${AGENTS['codex-review'].budget} | package |`,
    `| codex-advisor | scope | ${AGENTS['codex-advisor'].budget.scope} | package |`,
    '| codex-advisor | advise | 12 | host config |',
    '| codex-arbiter | \u2014 | 35 | package |',
    '| installed-extra-agent | prepare | 3 | host config |',
    '| installed-extra-agent | finish | 9 | package |',
    '| installed-single-phase | \u2014 | 6 | package |',
  ].join('\n'));
  assert.equal(await renderGuidance('{{agent-budgets}}\n{{agent-budgets}}',
    { topic: 'budget', configPath, topics: GUIDANCE_TOPICS }), `${output}\n${output}`);
});

test('a missing config renders every package budget from the installed registry', async (t) => {
  const { root, registry, configPath } = budgetFixture(t, {
    'extra-budget-agent': { role: 'extra-budget-role', budget: 8 },
  });
  const renderGuidance = await loadRenderer(root);
  const output = await renderGuidance('{{agent-budgets}}', { topic: 'budget', configPath, topics: GUIDANCE_TOPICS });
  const rows = [];
  for (const [agent, { budget }] of Object.entries(registry)) {
    const phases = typeof budget === 'number' ? { default: budget } : budget;
    for (const [phase, minutes] of Object.entries(phases)) {
      rows.push(`| ${agent} | ${Object.keys(phases).length === 1 ? '\u2014' : phase} | ${minutes} | package |`);
    }
  }
  assert.deepEqual(output.split('\n').slice(4), rows);
  assert.doesNotMatch(output, /\| host config \|/);
});

test('broken configs fail with budget topic and placeholder context instead of defaults', async (t) => {
  for (const content of ['{"budgets":', '{"budgets":{"advisor":7}}']) {
    const { root, configPath } = budgetFixture(t);
    fs.writeFileSync(configPath, content);
    const renderGuidance = await loadRenderer(root);
    await assert.rejects(renderGuidance('{{agent-budgets}}', { topic: 'budget', configPath, topics: GUIDANCE_TOPICS }),
      (error) => {
        assert.equal(Object.hasOwn(error, 'hostConfig'), true);
        assert.equal(error.hostConfig, true);
        assert.ok(error.message.startsWith('Cannot render guidance topic "budget" placeholder "{{agent-budgets}}": '));
        assert.ok(error.message.includes(configPath));
        assert.match(error.message, /cannot be parsed as JSON|must be a phase map/);
        assert.doesNotMatch(error.message, /\| package \|/);
        return true;
      });
  }
});

test('a missing installed agent module is not a host config failure', async (t) => {
  const root = homeFixture(t);
  const configPath = path.join(root, 'config.json');
  const renderGuidance = await loadRenderer(root);
  await assert.rejects(renderGuidance('{{agent-budgets}}', { topic: 'budget', configPath, topics: GUIDANCE_TOPICS }),
    (error) => {
      assert.equal(Object.hasOwn(error, 'hostConfig'), false);
      assert.equal(error.hostConfig, undefined);
      assert.match(error.message, /Cannot find module/);
      assert.ok(error.message.includes('placeholder "{{agent-budgets}}"'));
      return true;
    });
});

test('budget rendering requires configPath instead of using the real host config', async (t) => {
  await assertRenderFailure('{{agent-budgets}}', homeFixture(t), 'budget',
    '{{agent-budgets}}', /configPath is required/);
});

test('budget guidance owns no handwritten budget values', () => {
  const text = fs.readFileSync(new URL('../../src/home/guidance/budget.md', import.meta.url), 'utf8');
  assert.ok(text.includes('{{agent-budgets}}'));
  assert.doesNotMatch(text, /\| Agent \||\d+(?:\.\d+)?\s*minutes/);
  assert.match(text, /within the same build budget shown above/);
});

function orderHome(t, text) {
  const root = homeFixture(t, { installRenderer: false });
  writeModule(root, 'guidance-topics.mjs', `export const GUIDANCE_TOPICS = ${JSON.stringify(GUIDANCE_TOPICS)};`);
  fs.mkdirSync(path.join(root, 'guidance'));
  fs.writeFileSync(path.join(root, 'guidance', 'order.md'), text, 'utf8');
  return { root, env: { LLM_BRIDGE_HOME: root } };
}

test('a missing installed renderer only prevents rendering a topic', async (t) => {
  const { root, env } = orderHome(t, 'Order guidance');
  const listing = await guidance([], { env });
  assert.equal(listing.exitCode, 0);
  assert.ok(listing.output.includes(`  order — ${GUIDANCE_TOPICS.order}`));
  const result = await guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(path.join(root, 'lib', 'guidance-render.mjs')));
  assert.match(result.output, /Cannot find module.*\nrun llm-bridge update$/);
});

test('failed renderer imports and invalid exports name the installed path and update command', async (t) => {
  for (const [source, reason] of [
    ['throw new Error("installed renderer import failed");', /installed renderer import failed/],
    ['export const unrelated = true;', /Invalid renderGuidance export/],
    ['export const renderGuidance = true;', /Invalid renderGuidance export/],
  ]) {
    const { root, env } = orderHome(t, 'Order guidance');
    writeModule(root, 'guidance-render.mjs', source);
    const result = await guidance(['order'], { env });
    assert.equal(result.exitCode, 1, source);
    assert.ok(result.output.includes(path.join(root, 'lib', 'guidance-render.mjs')));
    assert.match(result.output, reason);
    assert.ok(result.output.endsWith('\nrun llm-bridge update'));
  }
});

test('guidance expands a placeholder that only the installed renderer knows', async (t) => {
  // Package 0.6.19 rejected the budget placeholder shipped by a newer home.
  const text = 'Rules: {{installed-only}}';
  await assert.rejects(renderCloneGuidance(text, { topic: 'order', topics: GUIDANCE_TOPICS }), /unknown placeholder/);
  const { root, env } = orderHome(t, text);
  writeModule(root, 'guidance-render.mjs', `export function renderGuidance(text) {
    return text.replace('{{installed-only}}', 'expanded in the installed home');
  }`);
  assert.deepEqual(await guidance(['order'], { env }),
    { exitCode: 0, output: 'Rules: expanded in the installed home' });
});
