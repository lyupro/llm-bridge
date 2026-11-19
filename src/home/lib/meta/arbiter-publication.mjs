/** Publishes the arbiter report and returns its verified SHA-256 for collection. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeRunBytesAtomic } from '../atomic-json.mjs';
import { renderArbiterReport } from '../runner/arbiter-report.mjs';
import { arbiterCaptureFacts } from './arbiter-capture.mjs';
import { bindArbiterProbes } from './arbiter-probe-receipts.mjs';
import { readJson, safeSlice } from './paths.mjs';

function publicationFailure(stage, error) {
  const detail = String(error?.message ?? error).replace(/[\r\n\u2028\u2029]+/g, ' ');
  const message = `arbiter report ${stage} failed: ${detail}`;
  return { ok: false, reason: message.length <= 200 ? message : `${safeSlice(message, 197)}...` };
}

export function publishArbiterReport({ runDir, result }) {
  let file;
  let bytes;
  try {
    file = path.join(runDir, 'report.md');
    const status = readJson(path.join(runDir, 'status.json'));
    const input = readJson(path.join(runDir, 'arbiter-input.json'));
    if (!input) throw new TypeError('arbiter-input.json is missing or unreadable');
    // OW-097 D4 binds the report to frozen inputs and the same capture rules as the verdict.
    const { events, captureComplete } = arbiterCaptureFacts({ runDir, status });
    const { receipts, problems } = bindArbiterProbes({ probes: result?.probes, events, captureComplete });
    if (problems.length) throw new Error(`could not bind probe receipts (${problems[0].key})`);
    bytes = Buffer.from(renderArbiterReport({
      run: path.basename(runDir), revision: status.source_revision, task: input.task,
      evidence: input.evidence, result, receipts,
    }), 'utf8');
  } catch (error) {
    return publicationFailure('render', error);
  }

  try {
    writeRunBytesAtomic(file, bytes);
  } catch (error) {
    return publicationFailure('write', error);
  }

  // OW-097 D4 allows an OK verdict to attest only to the bytes actually read back from disk.
  try {
    if (bytes.equals(fs.readFileSync(file))) {
      return { ok: true, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  } catch {
    // An unreadable target cannot establish a byte match.
  }
  return publicationFailure('verification', 'bytes differ');
}
