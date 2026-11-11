/** OW-083 R1/B4: the declared ledger determines the answer's decision-search contract. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree } from '../temp-tree.mjs';
import { judgeAdvice } from '../../src/home/lib/meta/advice-verdict.mjs';
import { adviceGap } from '../../src/home/lib/meta/advice-status.mjs';
import { advisorSchema } from '../../src/home/lib/runner/schemas.mjs';
import { INSTRUCTIONS } from '../../src/home/lib/runner/prompts.mjs';
import { validAdvice, validScope } from './advisor-fixtures.mjs';

const root = makeTempTree('already-decided-');
const repoRoot = path.join(root, 'repo');
const ledger = 'docs/decisions.md';
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(repoRoot, 'docs'));
fs.writeFileSync(path.join(repoRoot, 'src/entry.mjs'), 'one\ntwo\nthree\n');
fs.writeFileSync(path.join(repoRoot, ledger), '# Decisions\nKeep the boundary.\nThird line.\n');
fs.writeFileSync(path.join(repoRoot, 'docs/other.md'), 'Another decision.\n');

const messages = {
  shape: 'already_decided must contain only a valid status and a string or null address.',
  noLedger: 'already_decided.status must be not-checked when no decision ledger was declared.',
  readable: 'The declared decision ledger must be a readable file inside the repository.',
  owed: 'already_decided.status cannot be not-checked when a decision ledger was declared.',
  nullAddress: 'already_decided.address must be null for not-found or not-checked.',
  address: 'already_decided.address must name exactly the declared normalized ledger path and one positive integer line.',
  line: 'already_decided.address must cite a safe integer line within the decision ledger.',
};

function input(decisions, status, address) {
  return {
    phase: 'advise', repoRoot, commandsRun: 1, language: 'English',
    ledgerContract: 'required', scopeResult: validScope(),
    task: { paths: ['src/entry.mjs'], options: [{ id: 'keep' }, { id: 'split' }], decisions },
    result: { ...validAdvice(), already_decided: { status, address } },
  };
}

function expect(value, problem) {
  assert.deepEqual(judgeAdvice(value), problem
    ? { ok: false, reasons: [messages[problem]] }
    : { ok: true, reasons: [] });
}

for (const [declared, status, address, problem] of [
  [true, 'found', `${ledger}:2`, null],
  [true, 'found', null, 'address'],
  [true, 'not-found', null, null],
  [true, 'not-found', `${ledger}:2`, 'nullAddress'],
  [true, 'not-checked', null, 'owed'],
  [true, 'not-checked', `${ledger}:2`, 'owed'],
  [false, 'found', `${ledger}:2`, 'noLedger'],
  [false, 'found', null, 'noLedger'],
  [false, 'not-found', null, 'noLedger'],
  [false, 'not-found', `${ledger}:2`, 'noLedger'],
  [false, 'not-checked', null, null],
  [false, 'not-checked', `${ledger}:2`, 'nullAddress'],
]) {
  test(`truth table: ledger=${declared}, ${status}, address=${address}`, () => {
    expect(input(declared ? ledger : null, status, address), problem);
  });
}

for (const decisions of [undefined, null, false, 1, {}, []]) {
  test(`only a string declares a ledger: ${JSON.stringify(decisions)}`, () => {
    expect(input(decisions, 'not-checked', null), null);
    expect(input(decisions, 'not-found', null), 'noLedger');
    expect(input(decisions, 'found', `${ledger}:2`), 'noLedger');
  });
}

for (const [address, problem] of [
  ['docs/other.md:1', 'address'],
  [`./${ledger}:2`, 'address'],
  ['docs\\decisions.md:2', 'address'],
  ['docs/../docs/decisions.md:2', 'address'],
  [`${ledger}:3-5`, 'address'],
  [`${ledger}:2, docs/other.md:1`, 'address'],
  [`${ledger}:0`, 'address'],
  [`${ledger}:-1`, 'address'],
  [`${ledger}:4`, 'line'],
  [`${ledger}:1.5`, 'address'],
  [`${ledger}:1e0`, 'address'],
  [`${ledger}:9007199254740992`, 'line'],
  [`${ledger}:2\n`, 'address'],
]) {
  test(`found rejects invalid address ${JSON.stringify(address)}`, () => {
    expect(input(ledger, 'found', address), problem);
  });
}

test('found accepts both the first and last real line, excluding a trailing newline', () => {
  for (const line of [1, 3]) expect(input(ledger, 'found', `${ledger}:${line}`), null);
  const noNewline = 'docs/no-newline.md';
  fs.writeFileSync(path.join(repoRoot, noNewline), 'first\nlast');
  expect(input(noNewline, 'found', `${noNewline}:2`), null);
  expect(input(noNewline, 'found', `${noNewline}:3`), 'line');
});

test('an empty readable ledger permits not-found and has no valid found line', () => {
  const empty = 'docs/empty.md';
  fs.writeFileSync(path.join(repoRoot, empty), '');
  expect(input(empty, 'not-found', null), null);
  expect(input(empty, 'found', `${empty}:1`), 'line');
});

for (const status of ['found', 'not-found', 'not-checked']) {
  test(`a missing or directory ledger refuses ${status}`, () => {
    for (const file of ['docs/missing.md', 'docs', '']) {
      expect(input(file, status, status === 'found' ? `${file}:1` : null), 'readable');
    }
  });
  test(`a ledger unreadable at judge time refuses ${status}`, (t) => {
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function (file, ...args) {
      if (file === path.join(repoRoot, ledger)) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
      return read.call(this, file, ...args);
    });
    expect(input(ledger, status, status === 'found' ? `${ledger}:2` : null), 'readable');
  });
}

test('ledger containment rejects traversal, absolute paths and a symlink escaping the repo', () => {
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'decisions.md'), 'External decision.\n');
  fs.symlinkSync(outside, path.join(repoRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const file of ['../outside/decisions.md', path.join(outside, 'decisions.md'), 'linked/decisions.md']) {
    expect(input(file, 'found', `${file}:1`), 'readable');
    expect(input(file, 'not-found', null), 'readable');
  }
});

test('a normalized ledger path containing spaces is cited exactly', () => {
  const file = 'docs/My Decisions.md';
  fs.writeFileSync(path.join(repoRoot, file), 'Keep the boundary.\n');
  expect(input(file, 'found', `${file}:1`), null);
});

test('present malformed values fail with one catalog reason', () => {
  for (const answer of [null, [], '', false, 0, {}, { status: 'pending', address: null },
    { status: 'found' }, { status: 'found', address: 2 },
    { status: 'not-checked', address: null, extra: true }]) {
    const value = input(null, 'not-checked', null);
    value.result.already_decided = answer;
    expect(value, 'shape');
  }
});

test('archived answers can omit the field but present fields obey the truth table', () => {
  const value = input(ledger, 'not-checked', null);
  value.ledgerContract = 'legacy';
  expect(value, 'owed');
  delete value.result.already_decided;
  expect(value, null);
  value.ledgerContract = 'required';
  assert.deepEqual(judgeAdvice(value), { ok: false, reasons: [
    "The run's contract requires the already_decided field and the answer has none.",
  ] });
});

test('scope never applies the already_decided advise rules', () => {
  const value = input(ledger, 'not-checked', null);
  value.phase = 'scope';
  value.result = { ...validScope(), already_decided: null };
  expect(value, null);
});

test('adviceGap accepts a valid found under the saved required-field schema', () => {
  const dir = path.join(root, 'run');
  fs.mkdirSync(dir);
  const value = input(ledger, 'found', `${ledger}:2`);
  const artifacts = {
    'worker.json': { phase: 'advise' },
    'status.json': { phase: 'advise', repo: repoRoot },
    'env.json': { answerLanguage: 'English' },
    'schema.json': advisorSchema('advise'),
    'advisor-task.json': { ...value.task, scope: { run: 'scope', ...validScope() } },
    'result.json': value.result,
  };
  for (const [name, content] of Object.entries(artifacts)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  assert.ok(artifacts['schema.json'].required.includes('already_decided'));
  assert.equal(adviceGap(dir, value.result, {
    hasStream: true, hasEvents: true, commands_executed: 1, transport_error: null, content_error: null,
  }), null);
});

test('advise prompt requires the ledger search, status/address truth table and an explicit conflict', () => {
  const prompt = INSTRUCTIONS['codex-advisor']({ phase: 'advise', decisions: ledger });
  for (const text of ['search it for an entry that already decides this question',
    'found when such an entry exists or not-found otherwise, never not-checked', 'Without a declared decision ledger',
    'address to null for not-found or not-checked', '<ledger path>:<line>',
    'explain the conflict in `why` instead of hiding the recorded decision']) {
    assert.ok(prompt.includes(text), text);
    assert.equal(INSTRUCTIONS['codex-advisor']({ phase: 'scope', decisions: ledger }).includes(text), false, text);
  }
});
