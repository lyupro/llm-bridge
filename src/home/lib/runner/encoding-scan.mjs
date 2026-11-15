/**
 * Classifies per-file encoding evidence without deciding a run's status.
 * OW-089: three comment dashes were rewritten through cp1252 while tests stayed green;
 * D1 requires an exact removed-line witness for proof, keeping new-text candidates advisory.
 */
import { validateUtf8, mojibakeCandidates, repairCandidates, isMojibakeImageOf } from './text-integrity.mjs';

export const ENCODING_FINDING_LIMIT = 50;

export function createEncodingReport() {
  return {
    version: 1, proven: [], suspected: [], counts: { proven: 0, suspected: 0 },
    truncated: false, coverage: { complete: true, gaps: [] },
  };
}

export function mergeEncodingFindings(report, findings) {
  for (const tier of ['proven', 'suspected']) {
    report.counts[tier] += findings.counts[tier];
    report[tier].push(...findings[tier].slice(0, ENCODING_FINDING_LIMIT - report[tier].length));
    if (report.counts[tier] > report[tier].length) report.truncated = true;
  }
}

const withoutCR = (text) => text.endsWith('\r') ? text.slice(0, -1) : text;

export function scanFileEncoding({ path, end, start, hunks, commit }) {
  const report = createEncodingReport();
  const add = (tier, finding) => {
    report.counts[tier] += 1;
    if (report[tier].length < ENCODING_FINDING_LIMIT) report[tier].push({ path, ...finding });
    else report.truncated = true;
  };
  const endText = validateUtf8(end);
  const startText = start === undefined ? '' : validateUtf8(start);
  if (typeof endText !== 'string') {
    if (typeof startText === 'string') add('suspected', endText);
    return report;
  }
  for (const hunk of hunks) {
    const removed = new Set(hunk.removed.map((line) => withoutCR(line.text)));
    for (const line of hunk.added) {
      // OW-089 pre-mortem 1: normalize only the encoding witness, never the flag scanner's text.
      const text = withoutCR(line.text);
      const { candidates, findings } = mojibakeCandidates(text);
      const original = candidates.length ? repairCandidates(text) : text;
      if (typeof startText === 'string' && removed.has(original) && isMojibakeImageOf(original, text)) {
        add('proven', { line: line.number, text });
      } else {
        for (const candidate of candidates) {
          add('suspected', {
            line: line.number, kind: 'candidate', index: candidate.start,
            text: candidate.text, repaired: candidate.repaired,
          });
        }
      }
      for (const finding of findings) {
        add('suspected', { line: line.number, ...finding });
      }
    }
  }
  // D1 item 3: a blind repeat must still expose candidates carried in dirty-start copies.
  // Compare occurrences, not line positions, so moving committed typography is not inherited corruption.
  if (commit !== undefined && typeof startText === 'string') {
    const commitText = validateUtf8(commit);
    if (typeof commitText !== 'string') throw new Error('start commit content is not UTF-8');
    const remaining = new Map();
    for (const candidate of mojibakeCandidates(commitText).candidates) {
      remaining.set(candidate.text, (remaining.get(candidate.text) || 0) + 1);
    }
    for (const [index, line] of startText.split('\n').entries()) {
      for (const candidate of mojibakeCandidates(withoutCR(line)).candidates) {
        const count = remaining.get(candidate.text) || 0;
        if (count) remaining.set(candidate.text, count - 1);
        else add('suspected', {
          line: index + 1, kind: 'inherited', index: candidate.start,
          text: candidate.text, repaired: candidate.repaired,
        });
      }
    }
  }
  return report;
}
