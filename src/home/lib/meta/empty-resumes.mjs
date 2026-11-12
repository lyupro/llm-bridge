/** OW-066: only consecutive resumed passes with proven absent output exhaust a thread. */
import fs from 'node:fs';
import path from 'node:path';
import { eventLines } from './events.mjs';
import { passOutputOf } from './pass-output.mjs';
import { readJson } from './paths.mjs';
import { resumeOrigin } from './sandbox-witness.mjs';

const canonicalKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;

function outputState(runDir) {
  const recorded = readJson(path.join(runDir, 'meta.json'))?.pass_output?.state;
  if (recorded !== undefined) return recorded;
  let lines = null;
  try {
    lines = eventLines(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'));
  } catch {
    // Missing or unreadable events cannot prove an empty pass (OW-066).
  }
  return passOutputOf(lines).state;
}

export function consecutiveEmptyResumes({ runsRoot, run }) {
  let rootReal;
  try {
    rootReal = canonicalKey(fs.realpathSync(runsRoot));
  } catch {
    return 0;
  }
  const visited = new Set();
  let count = 0;
  let name = resumeOrigin({ resumed_from: run });
  while (name !== null) {
    const runDir = path.join(runsRoot, name);
    try {
      if (!fs.statSync(runDir).isDirectory()) break;
      const real = fs.realpathSync(runDir);
      const key = canonicalKey(real);
      if (canonicalKey(path.dirname(real)) !== rootReal || visited.has(key)) break;
      visited.add(key);
    } catch {
      break;
    }
    const parent = resumeOrigin(readJson(path.join(runDir, 'status.json')));
    if (parent === null || outputState(runDir) !== 'absent') break;
    count += 1;
    name = parent;
  }
  return count;
}
