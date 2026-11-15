/**
 * Judges added lines against start bytes because Plan_60 D3a must not blame earlier dirty work or TODO test data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFlagBaseline, removeFlagBaselineCopies, FLAG_BASELINE_DIR } from './flag-baseline.mjs';
import { runSnapshotChanges } from '../meta/run-snapshots.mjs';
import { scanFileEncoding, mergeEncodingFindings } from './encoding-scan.mjs';

const STUB = /test\.(skip|only)|it\.(skip|only)|describe\.(skip|only)|NotImplemented/;
const MARKER_PREFIX = /(?:^[ \t]*|\/\/[ \t]*|\/\*+[ \t]*|#[ \t]*|<!--[ \t]*|--[ \t]*|^[ \t]*\*[ \t]*)$/;
const LIST_PREFIX = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?$/;

export function isFlagLine(text) {
  if (STUB.test(text)) return true;
  for (const match of text.matchAll(/(?:TODO|FIXME)(?![A-Za-z0-9_])/g)) {
    const prefix = text.slice(0, match.index);
    if (MARKER_PREFIX.test(prefix) || LIST_PREFIX.test(prefix)) return true;
  }
  return false;
}

function parseHunks(diff) {
  const hunks = [];
  let current;
  let oldNumber = 0;
  let number = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff ')) {
      current = undefined;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      current = { removed: [], added: [] };
      hunks.push(current);
      oldNumber = Number(hunk[1]);
      number = Number(hunk[2]);
    } else if (current && line.startsWith('+')) {
      current.added.push({ number, text: line.slice(1) });
      number += 1;
    } else if (current && line.startsWith('-')) {
      current.removed.push({ number: oldNumber, text: line.slice(1) });
      oldNumber += 1;
    } else if (current && line.startsWith(' ')) {
      number += 1;
      oldNumber += 1;
    }
  }
  return hunks;
}

function compareFile(baseFile, currentFile) {
  const result = spawnSync('git', [
    '-c', 'core.quotepath=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv',
    '--ignore-cr-at-eol', '--diff-algorithm=myers', '-U0', '--', baseFile, currentFile,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) return null;
  return result.status === 0 ? [] : parseHunks(result.stdout.toString('utf8'));
}

// `git show <head>:<path>` exits non-zero both for a path the start commit lacks (a new file: every line is added)
// and for a start commit nobody can read; only a readable commit lets the first case accuse anyone.
function headReadable(repoRoot, head) {
  const result = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${head}^{commit}`], {
    windowsHide: true, timeout: 30_000,
  });
  return !result.error && result.status === 0;
}

function scanPath({ name, entry, baseline, headKnown, runDir, repoRoot, gaps, classify }) {
  const currentFile = path.join(repoRoot, name);
  let current;
  try {
    const stat = fs.lstatSync(currentFile);
    if (!stat.isFile()) return [];
    if (stat.size > baseline.limits.perFileBytes) {
      gaps.push(`${name}: end content over the limit`);
      return [];
    }
    current = fs.readFileSync(currentFile);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') gaps.push(`${name}: end content unreadable`);
    return [];
  }
  if (current.length > baseline.limits.perFileBytes) {
    gaps.push(`${name}: end content over the limit`);
    return [];
  }
  if (current.subarray(0, 8000).includes(0)) return [];

  let base = Buffer.alloc(0);
  let baseFile;
  let temporary = false;
  if (entry) {
    if (entry.state === 'copied') {
      baseFile = path.join(runDir, FLAG_BASELINE_DIR, entry.copy);
      try {
        base = fs.readFileSync(baseFile);
      } catch {
        gaps.push(`${name}: start content unreadable`);
        return [];
      }
    } else if (!['deleted', 'absent'].includes(entry.state)) {
      gaps.push(`${name}: start content ${entry.state}`);
      return [];
    }
  } else if (!headKnown) {
    gaps.push(`${name}: start commit unreadable`);
    return [];
  } else {
    const result = spawnSync('git', ['-C', repoRoot, 'show', `${baseline.head}:${name}`], {
      windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status === null) {
      gaps.push(`${name}: start content unreadable`);
      return [];
    }
    if (result.status === 0) base = result.stdout;
    if (base.length) {
      const copyDir = path.join(runDir, FLAG_BASELINE_DIR);
      fs.mkdirSync(copyDir, { recursive: true });
      baseFile = path.join(copyDir, `head-${randomUUID()}.bin`);
      fs.writeFileSync(baseFile, base, { flag: 'wx' });
      temporary = true;
    }
  }

  if (!base.length) {
    const added = current.toString('utf8').split('\n').map((text, index) => ({ number: index + 1, text }));
    classify?.({ name, entry, current, base, hunks: [{ removed: [], added }] });
    return added;
  }
  let hunks;
  try {
    hunks = compareFile(baseFile, currentFile);
  } finally {
    if (temporary) fs.unlinkSync(baseFile);
  }
  if (hunks === null) {
    gaps.push(`${name}: diff failed`);
    return [];
  }
  classify?.({ name, entry, current, base, hunks });
  return hunks.flatMap((hunk) => hunk.added);
}

export function scanRunFlags({ runDir, repoRoot, encoding }) {
  const gaps = [];
  const encodingGaps = [];
  const hits = [];
  try {
    const baseline = readFlagBaseline(runDir);
    if (!baseline) {
      gaps.push('no flag baseline');
    } else if (!baseline.complete && baseline.files.length === 0) {
      gaps.push(`flag baseline incomplete: ${baseline.reason}`);
    } else {
      const entries = new Map(baseline.files.map((entry) => [entry.path, entry]));
      const comparison = runSnapshotChanges(runDir);
      if (!comparison.ok) gaps.push('snapshots not comparable');
      const names = [...new Set([...entries.keys(), ...(comparison.ok ? comparison.changed : [])])].sort();
      const headKnown = headReadable(repoRoot, baseline.head);
      // OW-089 pass 2b is evidence only; encoding failures cannot interrupt the existing flags scan.
      const classify = encoding && comparison.ok ? ({ name, entry, current, base, hunks }) => {
        try {
          let commit;
          if (entry?.state === 'copied') {
            if (!headKnown) throw new Error('start commit unreadable');
            const result = spawnSync('git', ['-C', repoRoot, 'show', `${baseline.head}:${name}`], {
              windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
            });
            if (result.error || result.status === null) throw new Error('start commit content unreadable');
            commit = result.status === 0 ? result.stdout : Buffer.alloc(0);
          }
          mergeEncodingFindings(encoding, scanFileEncoding({ path: name, end: current, start: base, hunks, commit }));
        } catch {
          encodingGaps.push(`${name}: encoding classification failed`);
        }
      } : undefined;
      for (const name of names) {
        const added = scanPath({ name, entry: entries.get(name), baseline, headKnown, runDir, repoRoot, gaps, classify });
        for (const line of added) {
          if (hits.length < 20 && isFlagLine(line.text)) hits.push(`${name}:${line.number}: ${line.text.trim()}\n`);
        }
      }
    }
  } finally {
    removeFlagBaselineCopies(runDir);
  }
  if (encoding) {
    encoding.coverage.gaps = [...gaps, ...encodingGaps];
    encoding.coverage.complete = encoding.coverage.gaps.length === 0;
  }
  return { text: hits.join(''), coverage: { complete: gaps.length === 0, gaps } };
}
