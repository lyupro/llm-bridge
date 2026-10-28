/**
 * Plan_82 D4: ratchet the old package name before the rename to llm-bridge starts.
 *
 * Each rename slice must lower its files' baseline, so a removed spelling cannot quietly return.
 * Comments and strings count too: the rename covers what people read as well as what code runs.
 * Plan_82 D1 keeps Codex dispatcher names and CODEX_HOME, so the bare codex- prefix is not a match.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCANNED = ['bin', 'cli', 'src', 'scripts'];

// Keep the counter pure so examples can prove which spellings a later slice must remove.
export function countPackageNameLiterals(source) {
  return [...source.matchAll(/codex-bridge|\bcodexb\b|CODEX_BRIDGE_|CODEX_RUNS_ROOT/g)].length;
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    // Messages in non-module files are part of the rename too; do not filter by extension.
    return entry.isFile() ? [file] : [];
  }).sort();
}

function repositoryCounts() {
  const counts = {};
  for (const directory of SCANNED) {
    for (const file of sourceFiles(path.join(ROOT, directory))) {
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      counts[relative] = countPackageNameLiterals(fs.readFileSync(file, 'utf8'));
    }
  }
  return counts;
}

function baselineFailures(counts, baseline) {
  const failures = [];
  const files = [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort();
  for (const file of files) {
    const actual = counts[file] ?? 0;
    const expected = baseline[file] ?? 0;
    const detail = `${file}: actual ${actual}, baseline ${expected}`;
    if (Object.hasOwn(baseline, file) && !Object.hasOwn(counts, file)) {
      failures.push(`${detail}; file no longer exists in the scan; delete its baseline entry.`);
    } else if (actual > expected) {
      failures.push(`${detail}; old package-name literals increased; remove the added spellings.`);
    } else if (actual < expected) {
      failures.push(`${detail}; lower or delete its baseline entry to lock in the removal.`);
    }
  }
  return failures;
}

test('Plan_82 D4 ratchets old package-name literals across package files', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, '.package-name-literals.json'), 'utf8'));
  const failures = baselineFailures(repositoryCounts(), baseline.files);
  assert.deepEqual(failures, [], failures.join('\n'));
});

// A gate that cannot fail is decoration: fix both the spelling rules and every ratchet direction.
test('the package-name counter and ratchet detect old spellings and baseline drift', () => {
  const examples = [
    ['codex-bridge codex-bridge', 2],
    ['codexb hook x', 1],
    ['CODEX_RUNS_ROOT', 1],
    ['CODEX_BRIDGE_HOME CODEX_BRIDGE_TEST_TMP', 2],
    ['// codex-bridge\n/* codexb */\nconst name = "CODEX_RUNS_ROOT";', 3],
    ['codex-build codex-scout codex-review codex-advisor codex-home.mjs', 0],
    ['CODEX_HOME codexbridge codexbSuffix prefixcodexb codexb_name', 0],
    ['"codexb" (codexb) codexb-hook', 3],
    ['', 0],
  ];
  for (const [source, expected] of examples) {
    assert.equal(countPackageNameLiterals(source), expected, source);
  }

  assert.deepEqual(baselineFailures({ 'src/a.mjs': 2, 'bin/clean': 0 }, { 'src/a.mjs': 2 }), []);
  const failures = baselineFailures({
    'src/increased.mjs': 3,
    'src/new.txt': 1,
    'src/reduced.mjs': 1,
    'src/cleared.mjs': 0,
  }, {
    'src/increased.mjs': 2,
    'src/reduced.mjs': 2,
    'src/cleared.mjs': 1,
    'src/deleted.mjs': 2,
  });
  assert.equal(failures.length, 5);
  assert.match(failures[0], /src\/cleared\.mjs: actual 0, baseline 1; lower or delete/);
  assert.match(failures[1], /src\/deleted\.mjs: actual 0, baseline 2; .*delete its baseline entry/);
  assert.match(failures[2], /src\/increased\.mjs: actual 3, baseline 2; .*increased/);
  assert.match(failures[3], /src\/new\.txt: actual 1, baseline 0; .*increased/);
  assert.match(failures[4], /src\/reduced\.mjs: actual 1, baseline 2; lower or delete/);
});
