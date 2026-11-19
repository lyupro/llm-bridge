/** Decides from one read of events.jsonl whether an arbiter run's event capture is complete. */
import { readLines } from './events.mjs';

export function arbiterCaptureFacts({ runDir, status } = {}) {
  if (runDir == null || runDir === '') throw new TypeError('runDir is required');
  if (status === null || typeof status !== 'object' || Array.isArray(status)) {
    throw new TypeError('status must be an object');
  }

  // OW-097 D4 requires the verdict's records and all stream checks to use the same read.
  const { exists, events, lines, text } = readLines(runDir);
  const receipts = status.stop?.receipts;
  const expectedLines = receipts?.lines;
  const hasCount = Number.isInteger(expectedLines) && expectedLines >= 0;
  const reasons = [];

  if (!exists) reasons.push('events-unreadable');
  if (status.stdio_drained !== true) reasons.push('drain-unconfirmed');
  if (!hasCount) reasons.push('receipts-missing');
  if (receipts?.truncated === true) reasons.push('stream-cut');
  if (receipts?.incomplete === true || (exists && !text.endsWith('\n'))) reasons.push('stream-fragment');
  // OW-097 D4 compares the receipt count with physical lines because the parser drops blanks.
  if (exists && hasCount && (text.match(/\n/g)?.length ?? 0) !== expectedLines) {
    reasons.push('line-count-mismatch');
  }
  if (lines?.some((line) => line.malformed)) reasons.push('malformed-line');

  return { events, captureComplete: reasons.length === 0, reasons };
}
