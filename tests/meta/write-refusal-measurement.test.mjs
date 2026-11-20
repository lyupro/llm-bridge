/** OW-092 D4: refusal measurement selects only in-scope parents and preserves the raw facts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFolderAcls } from '../../src/home/lib/meta/write-refusal-acl-level.mjs';
import { measureWriteRefusal } from '../../src/home/lib/meta/write-refusal-measurement.mjs';

const repoRoot = 'C:\\Work\\Repo';
const writeRefusal = {
  paths: [
    { path: 'Src/blocked.mjs', inScope: true },
    { path: 'C:/outside/blocked.mjs', inScope: false },
    { path: 'c:/work/repo/src/other.mjs', inScope: true },
    { path: 'tests/nested/../blocked.mjs', inScope: true },
  ],
};

test('measures distinct in-scope Windows parents in first-seen order', async () => {
  const folders = ['C:\\Work\\Repo\\Src', 'C:\\Work\\Repo\\tests'];
  const raw = {
    status: 'measured',
    root: { path: repoRoot, error: 'Get-Acl failed' },
    folders: folders.map((path) => ({ path, error: 'Get-Acl failed' })),
  };
  const requests = [];
  const result = await measureWriteRefusal({
    writeRefusal, repoRoot,
    measure: async (request) => {
      requests.push(request);
      return raw;
    },
  });
  assert.deepEqual(requests, [{ repoRoot, folders }]);
  assert.strictEqual(result.raw, raw);
  assert.deepEqual(result.classification, classifyFolderAcls(raw));
});

for (const [name, refusal, root] of [
  ['empty path list', { paths: [] }, repoRoot],
  ['out-of-scope paths only', { paths: [writeRefusal.paths[1]] }, repoRoot],
  ['empty repository root', writeRefusal, ''],
  ['non-string repository root', writeRefusal, null],
]) {
  test(name + ' yields no-folders without measuring', async () => {
    let calls = 0;
    const raw = { status: 'not-measured', reason: 'no-folders' };
    const result = await measureWriteRefusal({
      writeRefusal: refusal, repoRoot: root, measure: () => { calls += 1; },
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, { raw, classification: classifyFolderAcls(raw) });
  });
}

for (const [name, measure] of [
  ['throws', () => { throw new Error('spawn failed'); }],
  ['rejects', () => Promise.reject(new Error('spawn failed'))],
]) {
  test('a measurement that ' + name + ' yields spawn-error and is classified', async () => {
    const raw = { status: 'not-measured', reason: 'spawn-error' };
    const inputs = [];
    const result = await measureWriteRefusal({
      writeRefusal, repoRoot, measure,
      classify: (measurement) => {
        inputs.push(measurement);
        return classifyFolderAcls(measurement);
      },
    });
    assert.deepEqual(inputs, [raw]);
    assert.strictEqual(inputs[0], result.raw);
    assert.deepEqual(result, { raw, classification: classifyFolderAcls(raw) });
  });
}
