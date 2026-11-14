/** Two-pass guards for record-free rules decisions (Plan_83 D7 (8) / D8). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { purge } from '../../cli/uninstall-purge.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { installRecordPath, readInstallRecordFile } from '../../cli/install-record.mjs';
import { readInstallRecord } from '../../cli/manifest.mjs';
import { rulesRegistryPath } from '../../cli/rules-owners.mjs';
import { withPending } from '../../cli/install-pending.mjs';
import { fixture } from './host-fixture.mjs';

const clear = () => ({ verdict: 'clear', blocked: [], unknown: [] });
const forbiddenPrompt = () => assert.fail('Rules must not be offered without eligible historical evidence');
const absent = (file) => assert.rejects(fs.access(file), { code: 'ENOENT' });

async function snapshot(root) {
  const entries = [];
  async function walk(relative) {
    const file = path.join(root, relative);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) {
      entries.push([relative, 'directory']);
      for (const name of (await fs.readdir(file)).sort()) await walk(path.join(relative, name));
    } else entries.push([relative, await fs.readFile(file, 'base64')]);
  }
  await walk('');
  return entries;
}

async function firstPass(t, state) {
  const f = await fixture(t);
  assert.equal((await install({ host: f.host })).exitCode, 0);
  const view = await readInstallRecord(f.host);
  const raw = await readInstallRecordFile(f.host);
  const recordPath = installRecordPath(f.host);
  if (state === 'orphan') {
    await fs.writeFile(recordPath, JSON.stringify({ ...raw, inventory: 'incomplete' }));
  }
  const indexPath = rulesRegistryPath(f.host);
  const missing = path.join(f.root, 'abandoned-home', '.installed.json');
  await fs.writeFile(indexPath, JSON.stringify({ version: 2,
    records: [recordPath, missing], legacy: ['abandoned-legacy-host'] }));
  const result = await uninstall({ host: f.host, isTTY: false, prompt: forbiddenPrompt });
  assert.equal(result.exitCode, 1, result.output);
  const rulesBytes = await fs.readFile(view.rules.path);
  assert.deepEqual(rulesBytes, await fs.readFile('src/codex/rules/llm-bridge.rules'));
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  assert.deepEqual(index.retained, [view.rules]);
  if (state === 'orphan') {
    assert.deepEqual((await readInstallRecordFile(f.host)).owners, {});
  } else {
    await absent(recordPath);
    assert.ok(!index.records.includes(recordPath), 'D7 (8): deletion cannot manufacture an ENOENT reference');
  }
  return { ...f, view, raw, recordPath, indexPath, rulesBytes, state };
}

function promptFor(f, answer = 'yes') {
  const questions = [];
  return { questions, isTTY: true, prompt(question) {
    questions.push(question);
    if (f.state === 'orphan' && questions.length === 1) {
      assert.match(question, /shared image/);
      return 'yes';
    }
    assert.match(question, /Rules file:/);
    assert.ok(question.includes(f.view.rules.path));
    assert.match(question, /abandoned-legacy-host/);
    return answer;
  } };
}

for (const state of ['orphan', 'absent']) {
  test(state + ': second pass removes rules, retained evidence, and empty index', async (t) => {
    const f = await firstPass(t, state);
    const prompt = promptFor(f);
    const result = await uninstall({ host: f.host, ...prompt });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(prompt.questions.length, state === 'orphan' ? 2 : 1);
    await absent(f.view.rules.path);
    await absent(f.indexPath);
    await absent(f.recordPath);
    for (const file of f.raw.image.files.filter((entry) => entry.root === 'brand')) {
      await absent(path.join(f.host.brandRoot, file.path));
    }
  });

  for (const scenario of ['changed', 'pending', 'unreadable', 'no-baseline']) {
    test(state + ': ' + scenario + ' never offers rules retirement', async (t) => {
      const f = await firstPass(t, state);
      const index = JSON.parse(await fs.readFile(f.indexPath, 'utf8'));
      if (scenario === 'changed') await fs.appendFile(f.view.rules.path, '\noperator edit\n');
      if (scenario === 'no-baseline') delete index.retained;
      if (scenario === 'pending' || scenario === 'unreadable') {
        const other = resolveHost({ host: path.join(f.root, 'Foreign Host'),
          brandRoot: path.join(f.root, 'foreign-home'), codexHome: path.dirname(f.host.codexRulesDir) });
        await fs.mkdir(other.brandRoot);
        const record = scenario === 'pending'
          ? JSON.stringify(withPending({ ...f.raw, owners: {}, inventory: 'incomplete' }, other,
            'install', '2026-11-14T00:00:00Z')) : '{broken';
        await fs.writeFile(installRecordPath(other), record);
        index.records.push(installRecordPath(other));
      }
      await fs.writeFile(f.indexPath, JSON.stringify(index));
      const before = await fs.readFile(f.view.rules.path);
      let homes = 0;
      const result = await uninstall({ host: f.host, isTTY: true, prompt(question) {
        assert.equal(state, 'orphan');
        assert.match(question, /shared image/);
        assert.equal(++homes, 1);
        return 'yes';
      } });
      assert.equal(result.exitCode, 1, result.output);
      assert.equal(homes, state === 'orphan' ? 1 : 0);
      assert.deepEqual(await fs.readFile(f.view.rules.path), before);
      const after = JSON.parse(await fs.readFile(f.indexPath, 'utf8'));
      assert.deepEqual(after.legacy, index.legacy, 'no foreign hint is retired');
      assert.deepEqual(after.records, index.records.filter((file) => file !== f.recordPath),
        'D7 (8): only the successfully deleted home record may leave the index');
      assert.deepEqual(after.retained, index.retained);
      if (scenario === 'changed') assert.match(result.output, /contents changed after installation/);
      if (scenario === 'no-baseline') assert.match(result.output, /integrity since installation cannot be proven/);
      if (scenario === 'pending') assert.match(result.output, /Pending install.*Foreign Host/);
      if (scenario === 'unreadable') assert.match(result.output, /cannot parse/);
    });
  }

  test(state + ': cancelling the rules question preserves host and index bytes', async (t) => {
    const f = await firstPass(t, state);
    const before = await snapshot(f.root);
    const prompt = promptFor(f, 'cancel');
    const result = await uninstall({ host: f.host, ...prompt });
    assert.deepEqual(result, { exitCode: 130, output: 'Cancelled; nothing was changed.' });
    assert.equal(prompt.questions.length, state === 'orphan' ? 2 : 1);
    assert.deepEqual(await snapshot(f.root), before);
  });

  test(state + ': dry-run prints the rules question without prompting or writing', async (t) => {
    const f = await firstPass(t, state);
    const before = await snapshot(f.root);
    const result = await uninstall({ host: f.host, dryRun: true, isTTY: true, prompt: forbiddenPrompt });
    assert.equal(result.exitCode, 1, result.output);
    assert.match(result.output, /A real run would ask about these rules references/);
    assert.deepEqual(await snapshot(f.root), before);
  });

  test(state + ': another host sharing the Codex directory reaches the same rules decision', async (t) => {
    const f = await firstPass(t, state);
    const other = resolveHost({ host: path.join(f.root, 'another-host'),
      brandRoot: f.host.brandRoot, codexHome: path.dirname(f.host.codexRulesDir) });
    const prompt = promptFor(f);
    const result = await uninstall({ host: other, ...prompt });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(prompt.questions.length, state === 'orphan' ? 2 : 1);
    await absent(f.view.rules.path);
    await absent(f.indexPath);
  });

  for (const answer of ['no', '', undefined]) {
    test(state + ': negative, Enter and EOF answers keep rules: ' + String(answer), async (t) => {
      const f = await firstPass(t, state);
      const prompt = promptFor(f);
      const original = prompt.prompt;
      prompt.prompt = (question) => { original(question); return question.includes('Rules file:') ? answer : 'yes'; };
      const result = await uninstall({ host: f.host, ...prompt });
      assert.equal(result.exitCode, 1, result.output);
      assert.deepEqual(await fs.readFile(f.view.rules.path), f.rulesBytes);
      assert.deepEqual(JSON.parse(await fs.readFile(f.indexPath, 'utf8')).retained, [f.view.rules]);
    });
  }
}

for (const missingHome of [false, true]) {
  test('purge re-enters rules without a record; missing home: ' + missingHome, async (t) => {
    const f = await firstPass(t, 'absent');
    const host = missingHome ? resolveHost({ host: path.join(f.root, 'missing-host'),
      brandRoot: path.join(f.root, 'missing-home'), codexHome: path.dirname(f.host.codexRulesDir) }) : f.host;
    let questions = 0;
    const result = await purge({ host, isTTY: true, liveRunCheck: clear, prompt(question) {
      questions++;
      if (questions === (missingHome ? 1 : 3)) assert.match(question, /Rules file:/);
      return 'yes';
    } });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(questions, missingHome ? 1 : 3);
    await absent(f.view.rules.path);
    await absent(f.indexPath);
  });
}

test('purge dry-run without a record previews rules and preserves every byte', async (t) => {
  const f = await firstPass(t, 'absent');
  const before = await snapshot(f.root);
  const result = await purge({ host: f.host, dryRun: true, isTTY: true,
    liveRunCheck: clear, prompt: forbiddenPrompt });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /A real run would ask about these rules references/);
  assert.deepEqual(await snapshot(f.root), before);
});

// D8: record-free recovery must restore historical evidence, never a null or fresh baseline.
test('failed record-free rules removal restores retained evidence without inventing a fingerprint', async (t) => {
  const f = await firstPass(t, 'absent');
  const rm = fs.rm;
  t.mock.method(fs, 'rm', async (file, options) => {
    if (file === f.view.rules.path) throw Object.assign(new Error('rules removal denied'), { code: 'EPERM' });
    return rm(file, options);
  });
  const prompt = promptFor(f);
  const result = await uninstall({ host: f.host, ...prompt });
  assert.equal(result.exitCode, 1, result.output);
  assert.deepEqual(await fs.readFile(f.view.rules.path), f.rulesBytes);
  assert.deepEqual(JSON.parse(await fs.readFile(f.indexPath, 'utf8')),
    { version: 2, records: [], legacy: [], retained: [f.view.rules] });
});

test('record-free stale consent retires no foreign references', async (t) => {
  const f = await firstPass(t, 'absent');
  const before = JSON.parse(await fs.readFile(f.indexPath, 'utf8'));
  const fresh = { ...before, legacy: [...before.legacy, 'new-reference'] };
  const result = await uninstall({ host: f.host, isTTY: true, prompt: async (question) => {
    assert.match(question, /Rules file:/);
    await fs.writeFile(f.indexPath, JSON.stringify(fresh));
    return 'yes';
  } });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /references changed; nothing was retired/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.indexPath, 'utf8')), fresh);
  assert.deepEqual(await fs.readFile(f.view.rules.path), f.rulesBytes);
});

for (const state of ['orphan', 'absent']) {
  test(state + ': a repeat without a terminal keeps rules without asking', async (t) => {
    const f = await firstPass(t, state);
    const index = await fs.readFile(f.indexPath);
    const result = await uninstall({ host: f.host, isTTY: false, prompt: forbiddenPrompt });
    assert.equal(result.exitCode, 1, result.output);
    assert.deepEqual(await fs.readFile(f.view.rules.path), f.rulesBytes);
    assert.deepEqual(await fs.readFile(f.indexPath), index);
  });
}

test('a record-free retained-only index needs no ownership question', async (t) => {
  const f = await firstPass(t, 'absent');
  await fs.writeFile(f.indexPath, JSON.stringify({ version: 2, records: [], legacy: [], retained: [f.view.rules] }));
  const result = await uninstall({ host: f.host, isTTY: true, prompt: forbiddenPrompt });
  assert.equal(result.exitCode, 0, result.output);
  await absent(f.view.rules.path);
  await absent(f.indexPath);
});

test('a retained baseline for another path cannot prove record-free file integrity', async (t) => {
  const f = await firstPass(t, 'absent');
  const index = JSON.parse(await fs.readFile(f.indexPath, 'utf8'));
  index.retained[0].path = path.join(f.root, 'other-rules', 'llm-bridge.rules');
  await fs.writeFile(f.indexPath, JSON.stringify(index));
  const before = await fs.readFile(f.indexPath);
  const result = await uninstall({ host: f.host, isTTY: true, prompt: forbiddenPrompt });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /integrity since installation cannot be proven/);
  assert.deepEqual(await fs.readFile(f.view.rules.path), f.rulesBytes);
  assert.deepEqual(await fs.readFile(f.indexPath), before);
});
