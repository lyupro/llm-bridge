/** Verifies the one-time inventory transition question and its prompt outcomes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { detectTransition, askTransition, registryHintLines } from '../../cli/inventory-transition.mjs';
import { installRecordPath } from '../../cli/install-record.mjs';
import { withOwner } from '../../cli/install-owners.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import {
  normalizedRulesOwner,
  rulesRegistryPath,
} from '../../cli/rules-owners.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

async function fixture(t) {
  const root = makeTempTree('bridge-inventory-transition-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  return { root, host };
}

async function writeRawRecord(host, record) {
  await fs.mkdir(path.dirname(installRecordPath(host)), { recursive: true });
  await fs.writeFile(installRecordPath(host), JSON.stringify(record) + '\n');
}

test('detects a format-1 record as a transition', async (t) => {
  const { host } = await fixture(t);
  await writeRawRecord(host, {
    name: '@lyupro/llm-bridge',
    version: '0.1.0',
    installedAt: '2026-08-10T20:00:00.000Z',
    mode: 'copy',
    files: [{ root: 'brand', path: 'lib/runner.mjs' }],
    hooks: [{ event: 'SubagentStop', root: 'brand', path: 'hooks/reply-guard.mjs', command: 'llm-bridge hook reply-guard' }],
  });

  assert.deepEqual(await detectTransition(host), { transition: true, homeHadImage: false });
});

test('detects a pre-existing image without a record as a transition', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(path.join(host.brandRoot, 'lib'), { recursive: true });

  assert.deepEqual(await detectTransition(host), { transition: true, homeHadImage: true });
});

test('does not detect a transition for a fresh home', async (t) => {
  const { host } = await fixture(t);

  assert.deepEqual(await detectTransition(host), { transition: false, homeHadImage: false });
});

test('does not detect a transition for a format-2 record', async (t) => {
  const { host } = await fixture(t);
  await writeRawRecord(host, { format: 2 });

  assert.deepEqual(await detectTransition(host), { transition: false, homeHadImage: false });
});

test('asks with newline-separated text and omits this host from registry candidates', async (t) => {
  const { root, host } = await fixture(t);
  const ownRoot = normalizedRulesOwner(host);
  const otherRoot = normalizedRulesOwner({ root: path.join(root, 'other-host') });
  await fs.mkdir(otherRoot, { recursive: true });
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({
    version: 1,
    owners: [ownRoot, otherRoot],
  }) + '\n');
  let question;

  assert.equal(await askTransition(host, {
    isTTY: true,
    prompt: async (value) => {
      question = value;
      return 'yes';
    },
  }), 'complete');

  assert.ok(question.includes('\n'));
  assert.ok(!question.includes('\\n'));
  assert.ok(question.includes('Home: ' + host.brandRoot));
  assert.ok(question.includes('Known owners: none yet besides this host (' + host.root + ').'));
  assert.ok(question.includes('The old installation record did not name every host that used this home.'));
  assert.ok(question.includes('hint only; they may be stale or belong to another home'));
  const candidates = question.split('Codex rules registry host roots are a hint only; they may be stale or belong to another home:\n')[1]
    .split('\nIs ' + host.root + ' the only host using this home?')[0];
  assert.equal(candidates, '  ' + otherRoot);
});

test('returns incomplete without prompting when the host is not interactive', async (t) => {
  const { host } = await fixture(t);
  let calls = 0;

  assert.equal(await askTransition(host, {
    isTTY: false,
    prompt: async () => {
      calls += 1;
      return 'yes';
    },
  }), 'incomplete');
  assert.equal(calls, 0);
});

test('maps prompt yes, no, and cancel to their inventory outcomes', async (t) => {
  const { host } = await fixture(t);
  for (const [answer, expected] of [
    ['yes', 'complete'],
    ['no', 'incomplete'],
    ['cancel', 'cancel'],
  ]) {
    assert.equal(await askTransition(host, {
      isTTY: true,
      candidates: [],
      prompt: async () => answer,
    }), expected);
  }
});

test('marks registry hints whose folders do not exist', async (t) => {
  const { root, host } = await fixture(t);
  const missingRoot = normalizedRulesOwner({ root: path.join(root, 'missing-host') });

  assert.deepEqual(registryHintLines(host, [missingRoot]).slice(1), [
    `  ${missingRoot} (folder does not exist)`,
  ]);
});

// OW-086 / Plan_83 B3a: transition hints must survive the next slice's version-2 writer.
test('transition renders a version-2 record-only host and honors explicit candidates', async (t) => {
  const { root, host } = await fixture(t);
  const hintHost = resolveHost({ host: path.join(root, 'record-only-host'),
    brandRoot: path.join(root, 'other-home'), codexHome: host.codexHome });
  const legacy = { name: '@lyupro/llm-bridge', version: '0.1.0',
    installedAt: '2026-08-10T20:00:00.000Z', mode: 'copy',
    files: [{ root: 'brand', path: 'hooks/reply-guard.mjs' }],
    hooks: [{ event: 'SubagentStop', root: 'brand', path: 'hooks/reply-guard.mjs',
      command: 'llm-bridge hook reply-guard' }] };
  await writeRawRecord(hintHost, withOwner(null, hintHost, legacy));
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({
    version: 2, records: [installRecordPath(hintHost)], legacy: [],
  }));
  for (const candidates of [undefined, []]) {
    let question;
    assert.equal(await askTransition(host, { isTTY: true, candidates,
      prompt: async (value) => { question = value; return 'no'; } }), 'incomplete');
    const line = `  ${normalizedRulesOwner(hintHost)} (folder does not exist)`;
    assert.equal(question.split('\n').includes(line), candidates === undefined);
    if (candidates) assert.ok(question.split('\n').includes('  none found'));
  }
});

test('transition propagates invalid registries unless explicit candidates bypass the read', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(rulesRegistryPath(host), '{');
  await assert.rejects(askTransition(host, { isTTY: true,
    prompt: () => assert.fail('invalid registry must precede prompting') }), /invalid rules ownership registry JSON/);
  assert.equal(await askTransition(host, { isTTY: true, candidates: [], prompt: async () => 'no' }), 'incomplete');
});
