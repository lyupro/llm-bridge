/** Copies an OK arbiter run's report.md byte for byte to a Markdown path inside its recorded repository. */
// OW-097 D1: plan decisions cite a stable copy; transport pruning keeps report.md, so export works afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { CLI_NAMES } from '../src/home/lib/cli-names.mjs';
import { readJsonFileSync } from '../src/home/lib/json-file.mjs';
import { resolveRunFolder } from './run-lookup.mjs';

const COMMAND = `${CLI_NAMES[0]} report export`;
const USAGE = `${COMMAND} <run> <path>`;
export const REPORT_EXPORT_HELP = {
  summary: 'Export a successful arbiter report into its repository',
  usage: [USAGE],
};

function contains(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function checkLocation(file, repo, runDir) {
  if (!contains(repo, file)) throw new Error('Destination is outside the recorded repository.');
  if (contains(runDir, file)) throw new Error('Destination is inside the run folder.');
}

function entryAt(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function exportDirectory(repo, runDir, segments) {
  let current = repo;
  for (const segment of segments) {
    current = path.join(current, segment);
    checkLocation(current, repo, runDir);
    if (!entryAt(current)) {
      try {
        fs.mkdirSync(current);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    current = fs.realpathSync.native(current);
    checkLocation(current, repo, runDir);
    if (!fs.statSync(current).isDirectory()) throw new Error('A destination parent is not a directory.');
  }
  return current;
}

function existingFile(file, repo, runDir) {
  if (!entryAt(file)) return null;
  const physical = fs.realpathSync.native(file);
  checkLocation(physical, repo, runDir);
  const entry = fs.statSync(physical);
  if (entry.isDirectory()) throw new Error('Destination is a directory.');
  if (!entry.isFile()) throw new Error('Destination must be a regular file.');
  return physical;
}

async function compareExisting(file, repo, runDir, report) {
  const deadline = performance.now() + 2_000;
  for (;;) {
    const existing = existingFile(file, repo, runDir);
    if (!existing) throw new Error('Destination disappeared during export.');
    const bytes = fs.readFileSync(existing);
    if (bytes.equals(report)) return;
    // D1's idempotency also covers an exporter that has claimed the name but is still writing.
    if (bytes.length >= report.length || !report.subarray(0, bytes.length).equals(bytes)
      || performance.now() >= deadline) {
      throw new Error('Destination already exists with different bytes.');
    }
    await delay(20);
  }
}

export async function reportExport({ run, destination, cwd = process.cwd(), runsRootPath }) {
  try {
    const lookup = resolveRunFolder({ command: 'report export', run, cwd, runsRootPath });
    if (lookup.error) return { exitCode: 1, output: lookup.error.replace(/[\r\n]+/g, ' ') };
    const { runDir } = lookup;
    const meta = readJsonFileSync(path.join(runDir, 'meta.json'));
    if (meta?.agent !== 'codex-arbiter') throw new Error('Run must be recorded as codex-arbiter.');
    if (meta.status !== 'OK') throw new Error('Run must have an OK verdict in meta.json.');
    const source = path.join(runDir, 'report.md');
    if (!entryAt(source)?.isFile()) throw new Error('Run must contain report.md as a regular file.');
    const report = fs.readFileSync(source);

    const { repo } = readJsonFileSync(path.join(runDir, 'status.json')) ?? {};
    if (typeof repo !== 'string' || !path.isAbsolute(repo)) {
      throw new Error('Run must record an absolute repository root in status.json.');
    }
    const target = path.resolve(repo, destination);
    if (!contains(repo, target)) throw new Error('Destination is outside the recorded repository.');
    const relative = path.relative(repo, target);
    if (!relative.endsWith('.md') || (process.platform === 'win32' && relative.includes(':'))) {
      throw new Error('Destination must be a Markdown file path ending in .md.');
    }
    const physicalRepo = fs.realpathSync.native(repo);
    const physicalRun = fs.realpathSync.native(runDir);
    const segments = relative.split(path.sep);
    const name = segments.pop();
    const parent = exportDirectory(physicalRepo, physicalRun, segments);
    const file = path.join(parent, name);
    checkLocation(file, physicalRepo, physicalRun);

    const relativePath = relative.split(path.sep).join('/');
    const description = `report.md from ${JSON.stringify(path.basename(runDir))} to ${JSON.stringify(relativePath)}`;
    if (!entryAt(file)) {
      try {
        fs.writeFileSync(file, report, { flag: 'wx' });
        return { exitCode: 0, output: `Exported ${description}.` };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    await compareExisting(file, physicalRepo, physicalRun, report);
    return { exitCode: 0, output: `Already exported ${description}.` };
  } catch (error) {
    return { exitCode: 1, output: `${COMMAND}: ${error.message.replace(/[\r\n]+/g, ' ')}` };
  }
}

export async function handleReport(argv, io) {
  if (argv[0] !== 'export' || argv.length !== 3) {
    io.error(`Usage: ${USAGE}`);
    return 2;
  }
  const result = await reportExport({ run: argv[1], destination: argv[2] });
  if (result.exitCode === 0) io.log(result.output);
  else io.error(result.output);
  return result.exitCode;
}
