/**
 * One responsibility: recognise reversible UTF-8 mis-decoding in text.
 * OW-089: Python read UTF-8 as cp1252 and wrote it back, corrupting three comment
 * dashes while tests stayed green. D1 keeps candidates separate from proof of an
 * existing line's corruption; this module supplies evidence, never a verdict.
 */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// The 27 defined, non-identity Windows-1252 mappings in 80-9F. The other five
// bytes are undefined, and C1 controls must never stand in for this punctuation.
const cp1252 = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function pageByte(scalar, page) {
  if (page === 'cp1252' && cp1252.has(scalar)) return cp1252.get(scalar);
  if (scalar <= 0xff && (page === 'latin1' || scalar < 0x80 || scalar >= 0xa0)) return scalar;
  return undefined;
}

function sequenceLength(lead) {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

function validSequence(bytes, start, length) {
  if (!length || start + length > bytes.length) return false;
  const lead = bytes[start];
  for (let offset = 1; offset < length; offset += 1) {
    const byte = bytes[start + offset];
    let minimum = 0x80;
    let maximum = 0xbf;
    if (offset === 1) {
      if (lead === 0xe0) minimum = 0xa0;
      if (lead === 0xed) maximum = 0x9f;
      if (lead === 0xf0) minimum = 0x90;
      if (lead === 0xf4) maximum = 0x8f;
    }
    if (byte === undefined || byte < minimum || byte > maximum) return false;
  }
  return true;
}

// TextDecoder reports no position. Locate the first ill-formed sequence's lead
// (or a standalone invalid byte), including when a sequence ends prematurely.
export function validateUtf8(buffer) {
  try {
    return utf8.decode(buffer);
  } catch (error) {
    for (let byteOffset = 0; byteOffset < buffer.length;) {
      if (buffer[byteOffset] <= 0x7f) {
        byteOffset += 1;
        continue;
      }
      const length = sequenceLength(buffer[byteOffset]);
      if (!validSequence(buffer, byteOffset, length)) return { kind: 'malformed-utf8', byteOffset };
      byteOffset += length;
    }
    throw error;
  }
}

function candidateAt(text, start, page) {
  const lead = pageByte(text.codePointAt(start), page);
  const length = sequenceLength(lead);
  if (!length) return null;
  const bytes = [];
  let end = start;
  for (let offset = 0; offset < length; offset += 1) {
    if (end >= text.length) return null;
    const scalar = text.codePointAt(end);
    const byte = pageByte(scalar, page);
    if (byte === undefined) return null;
    bytes.push(byte);
    end += scalar > 0xffff ? 2 : 1;
  }
  if (!validSequence(bytes, 0, length)) return null;
  const original = text.slice(start, end);
  const repaired = utf8.decode(Uint8Array.from(bytes));
  if ([...repaired].length !== 1 || repaired === original) return null;
  return { start, end, text: original, repaired, pages: [page] };
}

/** Returns { candidates, findings }; all positions are UTF-16 string indices. */
export function mojibakeCandidates(text) {
  const candidates = [];
  const findings = [];
  for (let start = 0; start < text.length;) {
    const scalar = text.codePointAt(start);
    if (scalar === 0xfffd) findings.push({ kind: 'replacement-char', index: start });
    let candidate = null;
    for (const page of ['cp1252', 'latin1']) {
      const found = candidateAt(text, start, page);
      if (!found) continue;
      if (candidate) candidate.pages.push(page);
      else candidate = found;
    }
    if (candidate) candidates.push(candidate);
    start += scalar > 0xffff ? 2 : 1;
  }
  return { candidates, findings };
}

export function repairCandidates(text) {
  const pieces = [];
  let end = 0;
  for (const candidate of mojibakeCandidates(text).candidates) {
    if (candidate.start < end) continue;
    pieces.push(text.slice(end, candidate.start), candidate.repaired);
    end = candidate.end;
  }
  pieces.push(text.slice(end));
  return pieces.join('');
}

// D1 tier A requires an exact pre-existing line, not just suspicious typography.
export function isMojibakeImageOf(startLine, endLine) {
  return mojibakeCandidates(endLine).candidates.length > 0
    && repairCandidates(endLine) === startLine;
}
