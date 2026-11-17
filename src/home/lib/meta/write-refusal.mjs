/**
 * Detects sandbox write refusals from a run's artifacts (OW-092 D1).
 * In the 2026-11-15/16 incidents, only stderr carried the refusal text. A failed
 * file_change also occurs when patch context does not match, so it only corroborates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonText } from '../json-file.mjs';
import { globToRegExp, readJson, readText } from './paths.mjs';

function absoluteWindowsPath(value) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value) ||
      path.win32.parse(value).root.length <= 1) return null;
  return path.win32.normalize(value).replaceAll('\\', '/');
}

function failedChangePaths(eventsFile, events) {
  const paths = new Set();
  for (const row of events.split(/\r?\n/)) {
    if (!row.trim()) continue;
    let event;
    try {
      event = parseJsonText(eventsFile, row);
    } catch {
      continue;
    }
    const item = event?.item;
    if (event?.type !== 'item.completed' || item?.type !== 'file_change' ||
        item.status !== 'failed' || !Array.isArray(item.changes)) continue;
    for (const change of item.changes) {
      const absolute = absoluteWindowsPath(change?.path);
      if (absolute) paths.add(absolute.toLowerCase());
    }
  }
  return paths;
}

function scopeMatchers(runDir) {
  let scope;
  try {
    scope = fs.readFileSync(path.join(runDir, 'scope.txt'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return scope.split(/\r?\n/).map((row) => row.trim()).filter(Boolean).map(globToRegExp);
}

export function detectWriteRefusal(runDir) {
  try {
    const stderr = readText(path.join(runDir, 'stderr.log')).replace(/^\uFEFF/, '');
    const refused = new Map();
    for (const match of stderr.matchAll(/^Failed to write file ([^\r\n]+)$/gm)) {
      const absolute = absoluteWindowsPath(match[1]);
      if (!absolute) continue;
      const key = absolute.toLowerCase();
      if (!refused.has(key)) refused.set(key, { absolute, line: match[0] });
    }
    if (!refused.size) return null;

    const status = readJson(path.join(runDir, 'status.json'));
    const root = absoluteWindowsPath(status?.repo);
    if (!root) return null;
    const prefix = root.endsWith('/') ? root : `${root}/`;
    const rootKey = prefix.toLowerCase();
    const eventsFile = path.join(runDir, 'events.jsonl');
    const events = fs.readFileSync(eventsFile, 'utf8');
    const failed = failedChangePaths(eventsFile, events);
    const scope = scopeMatchers(runDir);
    const paths = [];
    const evidence = [];
    for (const [key, { absolute, line }] of refused) {
      const relative = key.startsWith(rootKey) ? absolute.slice(prefix.length) : '';
      paths.push({
        path: relative || absolute,
        inScope: relative !== '' && scope.some((matcher) => matcher.test(relative)),
        failedChange: failed.has(key),
      });
      evidence.push(line);
    }
    return { paths, evidence };
  } catch {
    return null;
  }
}
