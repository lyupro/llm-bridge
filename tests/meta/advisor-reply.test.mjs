/**
 * Plan_59 D4/D6: what an advisor run prints and records. An insufficient scope is an OK run whose
 * outcome is a field in meta.json and the first thing after the status word — never a LIMIT, whose
 * meaning (quota gone, stop delegating) calls for the opposite reaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, collect, renderReply } from '../../src/home/lib/write-meta.mjs';
import { validAdvice, validScope } from './advisor-fixtures.mjs';
import { makeRun } from './test-fixtures.mjs';

const reply = (result, runDir = path.join('runs', 'advisor-run')) => {
  return AGENTS['codex-advisor'].reply({
    runDir,
    result,
    resultPath: path.join(runDir, 'result.json'),
    file: (name) => path.join(runDir, name),
  });
};

test('either phase result counts as filled, an empty one does not', () => {
  const { filled } = AGENTS['codex-advisor'];
  assert.equal(filled(validScope()), true);
  assert.equal(filled({ ...validScope(), sufficient: false }), true);
  assert.equal(filled(validAdvice()), true);
  assert.equal(filled({}), false);
  assert.equal(filled({ recommendation: { option_id: ' ' } }), false);
});

test('a sufficient scope says so and points to the advise phase', () => {
  const rows = reply(validScope());
  assert.equal(rows[0], 'OK — scope: sufficient; continue this run with `phase:` advise');
  assert.equal(rows.some((row) => row.startsWith('Missing:')), false);
  assert.match(rows.at(-1), /^Report: .*result\.json · Log: llm-bridge read /);
});

test('an insufficient scope names its outcome and the paths it needs', () => {
  const rows = reply({ ...validScope(), sufficient: false, missing_paths: ['src/a.mjs', 'src/b.mjs'] });
  assert.equal(rows[0], 'OK — scope: insufficient; 2 paths named');
  assert.equal(rows[1], 'Missing: src/a.mjs, src/b.mjs');
  assert.match(rows[2], /^Predicted risks: 3 — r1 /);
});

test('advice leads with the recommended option and counts the settled risks', () => {
  const rows = reply(validAdvice());
  assert.equal(rows[0], 'OK — recommend keep: Already decided: not-checked (no ledger supplied) · Keep the current boundary.');
  assert.match(rows[1], /^Rejected: split \(Requires a coordinated caller migration\.\)$/);
  assert.match(rows[2], /^Counter: The existing boundary/);
  assert.equal(rows[3], 'Risks: 2 confirmed · 1 refuted · open questions 2 · confidence medium');
  assert.ok(rows.length <= 5);
});

test('multiline advice keeps both paragraphs on one recommendation reply line', () => {
  const result = validAdvice();
  result.recommendation.text = 'Keep the current boundary.\nPreserve both paragraphs.';
  const rows = reply(result);
  assert.equal(rows[0], 'OK — recommend keep: Already decided: not-checked (no ledger supplied) · Keep the current boundary. Preserve both paragraphs.');
  assert.doesNotMatch(rows[0], /[\r\n\u2028\u2029]/u);
});

for (const [answer, state] of [
  [{ status: 'found', address: 'docs/decisions.md:42' }, 'found docs/decisions.md:42'],
  [{ status: 'not-found', address: null }, 'not-found (not found in the ledger)'],
  [{ status: 'not-checked', address: null }, 'not-checked (no ledger supplied)'],
  [{ status: 'future-status', address: null }, 'future-status'],
]) {
  test(`advice first row displays ${answer.status}`, () => {
    const rows = reply({ ...validAdvice(), already_decided: answer });
    assert.equal(rows[0], `OK — recommend keep: Already decided: ${state} · Keep the current boundary.`);
  });
}

for (const [schema, state] of [
  [JSON.stringify({ required: ['recommendation'] }), 'legacy result; field absent'],
  ['{broken', 'unreadable schema; field not checked'],
  [JSON.stringify({ required: ['already_decided'] }), 'field absent'],
]) {
  test(`archived advice re-renders from its saved schema: ${state}`, () => {
    const { already_decided, ...result } = validAdvice();
    const runDir = makeRun({ result });
    fs.writeFileSync(path.join(runDir, 'schema.json'), schema);
    const expected = `OK — recommend keep: Already decided: ${state} · Keep the current boundary.`;
    assert.equal(reply(result, runDir)[0], expected);
    const rendered = renderReply(runDir, 'codex-advisor', { status: 'OK' });
    assert.equal(rendered.split('\n')[0], expected);
    assert.deepEqual(rendered.split('\n'), reply(result, runDir));
  });
}

test('a ledger address longer than the row budget stays whole with a short recommendation', () => {
  const address = `docs/${'decision-'.repeat(30)}ledger.md:123`;
  assert.ok(address.length > 200);
  const result = { ...validAdvice(), already_decided: { status: 'found', address } };
  result.recommendation.text = 'Keep it.';
  assert.equal(reply(result)[0], `OK — recommend keep: Already decided: found ${address} · Keep it.`);
});

for (const address of ['docs/decisions.md:42', `docs/${'decision-'.repeat(30)}ledger.md:123`]) {
  test(`long recommendation yields space to the ${address.length > 200 ? 'oversized' : 'normal'} address`, () => {
    const result = { ...validAdvice(), already_decided: { status: 'found', address } };
    result.recommendation.text = 'Keep the current boundary. '.repeat(30);
    const prefix = `OK — recommend keep: Already decided: found ${address} · `;
    const row = reply(result)[0];
    assert.ok(row.startsWith(prefix));
    const text = row.slice(prefix.length);
    assert.ok(text.length <= Math.max(20, 200 - prefix.length));
    assert.ok(text.length >= 3);
    assert.ok(text.endsWith('...'));
    assert.ok(text.length < result.recommendation.text.length);
    if (address.length < 200) assert.ok(row.length <= 200);
  });
}

test('scope replies ignore ledger display fields and saved schema damage', () => {
  const result = validScope();
  const runDir = makeRun({ result });
  fs.writeFileSync(path.join(runDir, 'schema.json'), '{broken');
  assert.deepEqual(reply({ ...result, already_decided: { status: 'found', address: 'docs/ledger.md:1' } }, runDir),
    reply(result, runDir));
});

test('meta.json records the scope outcome for advisors and the named advice for builds', () => {
  const scope = collect(makeRun({ result: { ...validScope(), sufficient: false, missing_paths: ['src/a.mjs'] } }),
    'codex-advisor', 0).meta;
  assert.equal(scope.sufficient, false);
  assert.deepEqual(scope.missing_paths, ['src/a.mjs']);
  assert.equal(Object.hasOwn(scope, 'advice'), false);

  const empty = collect(makeRun({ result: {} }), 'codex-advisor', 0).meta;
  assert.equal(empty.sufficient, null);
  assert.equal(empty.missing_paths, null);

  const build = collect(makeRun({ result: { summary: 'done', changes: [] }, status: { advice: 'mechanical' } }),
    'codex-build', 0).meta;
  assert.equal(build.advice, 'mechanical');
  assert.equal(Object.hasOwn(build, 'sufficient'), false);
  assert.equal(collect(makeRun({ result: { summary: 'done', changes: [] } }), 'codex-build', 0).meta.advice, null);
});
