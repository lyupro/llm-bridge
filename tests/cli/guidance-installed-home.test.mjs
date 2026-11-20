/** Guards agreement between installed rules and public guidance after the 2026-11-20 arbiter topic failure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { install } from '../../cli/install.mjs';
import { hostFixture } from './doctor-fixtures.mjs';

const BIN = fileURLToPath(new URL('../../bin/llm-bridge.mjs', import.meta.url));

async function installedHost(t) {
  const host = await hostFixture(t);
  const result = await install({ host });
  assert.equal(result.exitCode, 0, result.output);
  return host;
}

function runGuidance(host, ...args) {
  const result = spawnSync(process.execPath, [BIN, 'guidance', ...args], {
    env: { ...process.env, LLM_BRIDGE_HOME: host.brandRoot },
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

function listedTopics(output) {
  const listing = output.match(/^Topics:\r?\n([\s\S]*?)\r?\n\r?\nUsage:/m);
  assert.ok(listing, 'guidance must print a topic list');
  return listing[1].split(/\r?\n/).map((line) => {
    const entry = line.match(/^  ([a-z][a-z-]*) — .+$/);
    assert.ok(entry, `invalid guidance topic row: ${line}`);
    return entry[1];
  });
}

function rulesTopics(core) {
  const topics = new Set([...core.matchAll(/`llm-bridge guidance ([a-z][a-z-]*)`/g)]
    .map((match) => match[1]));
  // The core saves space by listing bare topic names after the generic invocation.
  const shorthand = core.match(/`llm-bridge guidance <topic>`([\s\S]*?)`llm-bridge guidance`/);
  if (shorthand) {
    for (const [, topic] of shorthand[1].matchAll(/`([a-z][a-z-]*)`/g)) topics.add(topic);
  }
  return topics;
}

function headerTableAgents(output) {
  const table = output.match(/^\| Agent \| Required labels \| Conditional labels \| Optional labels \|\r?\n\| --- \| --- \| --- \| --- \|((?:\r?\n\|[^\r\n]*)+)/m);
  assert.ok(table, 'order guidance must print the header-label table');
  return table[1].trimStart().split(/\r?\n/).map((line) => {
    const row = line.match(/^\|\s*([^|]+?)\s*\|[^|]+\|[^|]+\|[^|]+\|$/);
    assert.ok(row, `invalid header-label row: ${line}`);
    return row[1];
  });
}

test('installed guidance serves exactly the topics named by the installed rules core', async (t) => {
  const host = await installedHost(t);
  const listing = runGuidance(host);
  assert.equal(listing.status, 0, listing.stderr || listing.stdout);
  assert.equal(listing.stderr, '');
  const topics = listedTopics(listing.stdout);
  const core = await fs.readFile(path.join(host.rulesDir, 'core.md'), 'utf8');
  assert.deepEqual(new Set(topics), rulesTopics(core));

  const schemaPath = path.join(host.brandRoot, 'lib', 'order-schema.mjs');
  const { ORDER_AGENTS } = await import(pathToFileURL(schemaPath).href);
  assert.ok(topics.includes('order'), 'the topic list must include order');
  for (const topic of topics) {
    const result = runGuidance(host, topic);
    assert.equal(result.status, 0, `${topic}: ${result.stderr || result.stdout}`);
    assert.equal(result.stderr, '', topic);
    assert.doesNotMatch(result.stdout, /\{\{/, topic);
    if (topic === 'order') {
      const agents = headerTableAgents(result.stdout);
      assert.ok(agents.includes('codex-arbiter'), 'the table must include codex-arbiter');
      assert.deepEqual(agents.sort(), [...ORDER_AGENTS].sort());
    }
  }
});

test('guidance names the missing installed registry and exits 1', async (t) => {
  const host = await installedHost(t);
  const registryPath = path.join(host.brandRoot, 'lib', 'guidance-topics.mjs');
  await fs.unlink(registryPath);
  const result = runGuidance(host);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.ok(result.stdout.includes(registryPath), result.stdout);
});

test('guidance names the missing installed renderer for order and still lists topics', async (t) => {
  const host = await installedHost(t);
  const rendererPath = path.join(host.brandRoot, 'lib', 'guidance-render.mjs');
  await fs.unlink(rendererPath);
  const result = runGuidance(host, 'order');
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.ok(result.stdout.includes(rendererPath), result.stdout);
  const listing = runGuidance(host);
  assert.equal(listing.status, 0, listing.stderr || listing.stdout);
  assert.ok(listedTopics(listing.stdout).includes('order'));
});
