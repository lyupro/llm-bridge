/** Checks raw advice values in one read-only place so preflight and the future command share Plan_68 D4/D10's contract. */
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonText } from './json-file.mjs';
import { retiredPathRefusal, runsRootResolution } from './runner/runs-root.mjs';

export function checkAdvice(value, { resolution } = {}) {
  const result = {
    schema_version: 1, ok: null, kind: null, reason: 'invalid-call',
    run: null, project: null, phase: null, verdict: null,
  };
  if (typeof value !== 'string' || value.length === 0) return result;
  if (['mechanical', 'revert', 'docs-only', 'test-only'].includes(value)) {
    return { ...result, ok: true, kind: 'label', reason: 'bridge-label' };
  }
  if (!path.isAbsolute(value)) {
    return { ...result, ok: false, kind: 'unknown', reason: 'not-bridge-value' };
  }
  result.kind = 'run';
  result.run = value;
  result.project = path.basename(path.dirname(value));
  try {
    // Plan_77 D6: preflight.mjs:46-58 swallowed the old-path read failure as missing advice.
    // Diagnose before stat/read so neither existing nor absent retired evidence is opened.
    if (retiredPathRefusal(value, resolution ?? runsRootResolution())) {
      return { ...result, ok: false, reason: 'retired-root' };
    }
  } catch {
    return { ...result, reason: 'unreadable' };
  }
  try {
    if (!fs.statSync(value).isDirectory()) {
      return { ...result, ok: false, reason: 'not-directory' };
    }
  } catch (error) {
    return { ...result, ok: error.code === 'ENOENT' ? false : null,
      reason: error.code === 'ENOENT' ? 'not-found' : 'unreadable' };
  }
  const file = path.join(value, 'meta.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ...result, ok: error.code === 'ENOENT' ? false : null,
      reason: error.code === 'ENOENT' ? 'meta-missing' : 'unreadable' };
  }
  let meta;
  try {
    meta = parseJsonText(file, raw);
  } catch {
    return { ...result, ok: false, reason: 'meta-invalid' };
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { ...result, ok: false, reason: 'meta-invalid' };
  }
  result.phase = meta.phase ?? null;
  result.verdict = meta.status ?? null;
  // Plan_59 D26: only a judged advice authorizes a construction. On 2026-09-24 the gate took
  // any codex-advisor folder, so a scope run or a FAIL advice would have passed as a second opinion.
  if (meta.agent !== 'codex-advisor') return { ...result, ok: false, reason: 'wrong-agent' };
  if (meta.phase !== 'advise') return { ...result, ok: false, reason: 'wrong-phase' };
  if (meta.status !== 'OK') return { ...result, ok: false, reason: 'wrong-verdict' };
  // Plan_68 D4: retention keeps meta.json, so transport presence and run age cannot change validity.
  return { ...result, ok: true, reason: 'valid-run' };
}

export function adviceCheckExitCode(result) {
  return result.ok === true ? 0 : result.ok === false ? 1 : 2;
}
