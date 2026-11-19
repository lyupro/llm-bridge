/** Converts a finished arbiter run's frozen inputs and capture facts into a collection verdict reason. */
import fs from 'node:fs';
import path from 'node:path';
import { arbiterCaptureFacts } from './arbiter-capture.mjs';
import { judgeArbitration } from './arbiter-verdict.mjs';
import { readJson, safeSlice } from './paths.mjs';

function contractReason(reasons) {
  const message = `arbiter contract broken (${reasons.length}): ${reasons.slice(0, 2).join('; ')}`;
  return message.length <= 200 ? message : `${safeSlice(message, 197)}...`;
}

export function arbitrationGap(runDir, result) {
  // OW-097 D4 grades the frozen launch inputs only after earlier run failures have had precedence.
  const status = readJson(path.join(runDir, 'status.json'));
  const inputFile = path.join(runDir, 'arbiter-input.json');
  const input = readJson(inputFile);
  const task = input?.task;
  const reasons = [];

  if (typeof status?.repo !== 'string' || !status.repo.trim()) reasons.push('status.json#repo is missing');
  if (!fs.existsSync(inputFile)) reasons.push('arbiter-input.json is missing');
  else if (input?.version !== 1 || !task || typeof task !== 'object' || Array.isArray(task) ||
      !Array.isArray(task.options) || !Array.isArray(task.paths) || !Array.isArray(input.evidence)) {
    reasons.push('arbiter-input.json is malformed (expected version 1, parsed task options and paths, and evidence)');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) reasons.push('result.json is missing or is not an object');
  if (reasons.length) return contractReason(reasons);

  // OW-097 D4 gives the judge both facts from one read so only claimed probes depend on completeness.
  const { events, captureComplete } = arbiterCaptureFacts({ runDir, status });
  try {
    const verdict = judgeArbitration({
      result, task, evidence: input.evidence, repoRoot: status.repo, events, captureComplete,
    });
    return verdict.ok ? null : contractReason(verdict.reasons);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return contractReason([`result.json is missing required fields or has an unexpected shape (${error.message})`]);
  }
}
