/**
 * Tells apart what a run changed from what the tooling around it changed.
 *
 * Every verdict about a build run rests on the worktree either side of it, and that
 * comparison assumes the run is the only writer. In a repository under OMC and Claude Code it
 * never is: on 2026-08-02 a run that touched exactly its three scoped files was failed for
 * “out-of-scope changes: .omc/project-memory.json”, written by the orchestrator's own tooling
 * while Codex worked.
 *
 * The patterns are read from the run's own env.json, not from the config, so recomputing an
 * old run's verdict gives the answer it gave then — the config may have changed since.
 */
import path from 'node:path';
import { displayPath, globToRegExp, normalizePath, readJson, readText } from './paths.mjs';
import { decodeSnapshot } from './snapshot-format.mjs';

/** Empty for runs made before the list existed: absence means "the run was the only writer". */
export function environmentPatterns(runDir) {
  const configured = readJson(path.join(runDir, 'env.json'))?.environmentPaths;
  return Array.isArray(configured) ? configured.map((row) => String(row).trim()).filter(Boolean) : [];
}

/** Old runs never inherit today's new-file defaults. */
export function environmentNewFilePatterns(runDir) {
  const configured = readJson(path.join(runDir, 'env.json'))?.environmentNewFilePaths;
  return Array.isArray(configured) ? configured.map((row) => String(row).trim()).filter(Boolean) : [];
}

/** Touched paths, normalized and sorted into the run's own work and the environment's. */
export function splitEnvironment(paths, patterns) {
  const matchers = (patterns || []).filter(Boolean).map(globToRegExp);
  const work = [];
  const environment = [];
  for (const raw of paths || []) {
    const file = displayPath(raw);
    if (!normalizePath(file)) continue;
    (matchers.some((re) => re.test(file)) ? environment : work).push(file);
  }
  return { work, environment };
}

/** The same split for a run on disk, using the patterns that were in force when it started. */
export function splitRunChanges(runDir, paths, snapshots) {
  const patterns = environmentPatterns(runDir);
  const split = splitEnvironment(paths, patterns);
  if (!snapshots) return split;
  const before = decodeSnapshot(snapshots.before);
  const after = decodeSnapshot(snapshots.after);
  if (!before.ok || !after.ok) return split;
  const newFiles = environmentNewFilePatterns(runDir).map(globToRegExp);
  const scope = readText(path.join(runDir, 'scope.txt')).split(/\r?\n/)
    .map((row) => row.trim()).filter(Boolean).map(globToRegExp);
  // Eleven honest runs from 2026-10-21 to 2026-11-04 failed only because a letter
  // arrived during the run. Excuse only a proven new hashed file: edits and deletions
  // of existing letters remain work. Scope wins so deliberately creating a letter
  // still matches a truthful report naming only that file instead of implying no change.
  const excused = new Set(split.work.filter((file) =>
    newFiles.some((re) => re.test(file)) && !before.rows.has(file) &&
    /^U\t\d+:[0-9a-fA-F]{64}$/.test(after.rows.get(file) || '') &&
    !scope.some((re) => re.test(file))));
  if (!excused.size) return split;
  const environment = new Set([...split.environment, ...excused]);
  return {
    work: split.work.filter((file) => !excused.has(file)),
    environment: (paths || []).map(displayPath).filter((file) => environment.has(file)),
  };
}
