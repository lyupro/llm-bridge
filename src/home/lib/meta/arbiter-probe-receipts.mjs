/** Binds claimed arbiter probes to receipts from the current run's completed command events. */
import { Buffer } from 'node:buffer';

export const PROBE_TAG_PREFIX = 'ARBITER_PROBE_';
export const PROBE_LIMITS = Object.freeze({ maxProbes: 8, outputExcerptBytes: 4096, commandBytes: 16384 });

const TAG_PATTERN = `${PROBE_TAG_PREFIX}[0-9a-f]{16}`;
const PROBE_TAG = new RegExp(`^${TAG_PATTERN}$`);
// OW-097 D3 chose raw markers because the B3 command-event sample shows incompatible wrapper quoting.
const COMMAND_TAG = new RegExp(`(?<![A-Za-z0-9_])${TAG_PATTERN}(?![A-Za-z0-9_])`, 'g');

export function isProbeTag(value) {
  return typeof value === 'string' && PROBE_TAG.test(value);
}

function commandMatches(events) {
  const matches = new Map();
  for (const [eventIndex, event] of events.entries()) {
    const item = event?.item;
    if (item?.type !== 'command_execution' || typeof item.command !== 'string') continue;

    const tags = new Set(item.command.match(COMMAND_TAG));
    for (const tag of tags) {
      if (!matches.has(tag)) matches.set(tag, []);
      // D3 treats retries as separate evidence even when a terminal item failed or is malformed.
      if (event.type === 'item.completed') matches.get(tag).push({ eventIndex, item, tags });
    }
  }
  return matches;
}

function validTerminal(item) {
  return typeof item.id === 'string' &&
    (item.status === 'completed' || item.status === 'failed') &&
    Number.isInteger(item.exit_code) && typeof item.aggregated_output === 'string';
}

function excerptOf(output, maxBytes) {
  let bytes = 0;
  let end = 0;
  for (const codePoint of output) {
    bytes += Buffer.byteLength(codePoint, 'utf8');
    if (bytes > maxBytes) break;
    end += codePoint.length;
  }
  return output.slice(0, end);
}

function makeReceipt(tag, eventIndex, item) {
  const { id, command, status, exit_code, aggregated_output: output } = item;
  const outputBytes = Buffer.byteLength(output, 'utf8');
  const truncated = outputBytes > PROBE_LIMITS.outputExcerptBytes;
  return Object.freeze({
    probe_tag: tag,
    event_index: eventIndex,
    item_id: id,
    command,
    status,
    exit_code,
    succeeded: status === 'completed' && exit_code === 0,
    output_excerpt: truncated ? excerptOf(output, PROBE_LIMITS.outputExcerptBytes) : output,
    output_bytes: outputBytes,
    output_truncated: truncated,
  });
}

export function bindArbiterProbes({ probes, events, captureComplete }) {
  if (!Array.isArray(probes) || !Array.isArray(events) || typeof captureComplete !== 'boolean') {
    throw new TypeError('Expected probes and events arrays and a captureComplete boolean.');
  }

  const receipts = [];
  const problems = [];
  if (!probes.length) return { receipts, problems };

  const { maxProbes, commandBytes } = PROBE_LIMITS;
  if (probes.length > maxProbes) {
    problems.push({ key: 'probe-count', values: { count: probes.length, max: maxProbes } });
  }
  // D3 requires unique evidence, and a lost part of the stream could hide another completed match.
  if (!captureComplete) problems.push({ key: 'probe-capture-incomplete', values: {} });

  const matches = commandMatches(events);
  const seen = new Set();
  for (const [index, probe] of probes.entries()) {
    const tag = probe.probe_tag;
    const values = { index, tag };
    const validTag = isProbeTag(tag);
    const duplicate = seen.has(tag);
    seen.add(tag);
    if (!validTag) problems.push({ key: 'probe-tag-shape', values });
    if (duplicate) problems.push({ key: 'probe-tag-duplicate', values });
    if (!validTag || duplicate) continue;

    const completed = matches.get(tag);
    if (!completed) {
      problems.push({ key: 'probe-unmatched', values });
      continue;
    }
    if (!completed.length) {
      problems.push({ key: 'probe-incomplete', values });
      continue;
    }
    if (completed.length > 1) {
      problems.push({ key: 'probe-ambiguous', values: { ...values, count: completed.length } });
      continue;
    }

    const [{ eventIndex, item, tags }] = completed;
    const before = problems.length;
    if (tags.size > 1) problems.push({ key: 'probe-multiple-markers', values });
    const bytes = Buffer.byteLength(item.command, 'utf8');
    if (bytes > commandBytes) {
      problems.push({ key: 'probe-command-too-long', values: { ...values, bytes, max: commandBytes } });
    }
    if (!validTerminal(item)) problems.push({ key: 'probe-terminal-invalid', values });
    if (captureComplete && problems.length === before) receipts.push(makeReceipt(tag, eventIndex, item));
  }

  return { receipts, problems };
}
