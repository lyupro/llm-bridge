/** Proves that `llm-bridge guidance` takes its topic registry from the installed brand home (OW-097 D8, package 0.8.2 vs a home installed from the clone, 2026-11-20). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { guidance } from '../../cli/guidance.mjs';
import { GUIDANCE_TOPICS } from '../../src/home/lib/guidance-topics.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function writeRegistry(root, source = `export const GUIDANCE_TOPICS = ${JSON.stringify(GUIDANCE_TOPICS)};`) {
  const registryPath = path.join(root, 'lib', 'guidance-topics.mjs');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, source, 'utf8');
}

function installRenderer(root) {
  fs.copyFileSync(new URL('../../src/home/lib/guidance-render.mjs', import.meta.url),
    path.join(root, 'lib', 'guidance-render.mjs'));
}

function homeFixture(t, { installRegistry = true } = {}) {
  const home = makeTempTree('guidance-');
  t.after(() => removeTempTree(home));
  if (installRegistry) writeRegistry(home);
  return { home, env: { LLM_BRIDGE_HOME: home } };
}

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
  installRenderer(root);
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
