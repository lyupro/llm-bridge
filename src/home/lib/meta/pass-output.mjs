/**
 * Per-pass evidence for OW-066: whether this run's own stream shows any model output.
 * Damaged or thread-wide evidence cannot prove emptiness, so it is `unknown`, never `absent`.
 * Input is the parsed line list from `eventLines` (events.mjs owns the one parse), or null
 * when the run left no stream.
 */
const OUTPUT_ITEMS = ['agent_message', 'reasoning'];

export function passOutputOf(lines) {
  if (lines === null || lines === undefined) return { state: 'unknown', reason: 'missing-events' };
  if (!lines.length) return { state: 'unknown', reason: 'empty-events' };

  let started = false;
  let output = false;
  let truncatedOutput = false;
  for (const [index, line] of lines.entries()) {
    if (line.malformed) {
      // OW-066 permits only the final stream fragment: earlier damage hides pass evidence.
      if (index !== lines.length - 1) {
        return { state: 'unknown', reason: `malformed-line:${index + 1}` };
      }
      truncatedOutput = started && /"item\.completed"/.test(line.raw) &&
        /"(?:agent_message|reasoning)"/.test(line.raw);
      continue;
    }
    const event = line.event;
    if (event?.type === 'turn.started') started = true;
    if (started && event?.type === 'item.completed' &&
        OUTPUT_ITEMS.includes(event.item?.type) &&
        typeof event.item.text === 'string' && event.item.text.trim()) output = true;
  }

  if (!started) return { state: 'unknown', reason: 'missing-turn-started' };
  if (output) return { state: 'present', reason: 'model-output' };
  if (truncatedOutput) return { state: 'present', reason: 'truncated-output-item' };
  return { state: 'absent', reason: 'no-model-output' };
}
