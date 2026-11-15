/** OW-089 D1: reversible transcoding is evidence, not a verdict on intentional text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateUtf8, mojibakeCandidates, repairCandidates, isMojibakeImageOf,
} from '../../src/home/lib/runner/text-integrity.mjs';

const candidates = (text) => mojibakeCandidates(text).candidates;
const latin1Image = (bytes) => Buffer.from(bytes).toString('latin1');

// Non-ASCII fixtures use escapes so a future repository encoding guard stays clean.
test('the three-dash comment incident is an exact mojibake image', () => {
  const dash = '\u2014';
  const corrupted = '\u00e2\u20ac\u201d';
  assert.deepEqual([...Buffer.from(dash)], [0xe2, 0x80, 0x94]);
  assert.deepEqual(candidates(corrupted), [{
    start: 0, end: 3, text: corrupted, repaired: dash, pages: ['cp1252'],
  }]);
  assert.equal(repairCandidates(corrupted), dash);
  const originalLine = `// first ${dash} second ${dash} third ${dash}`;
  const corruptedLine = originalLine.replaceAll(dash, corrupted);
  assert.equal(candidates(corruptedLine).length, 3);
  assert.equal(isMojibakeImageOf(originalLine, corruptedLine), true);
});

test('accented letters, euro, Cyrillic and emoji reverse their cp1252 images', () => {
  const examples = [
    ['\u00e9', '\u00c3\u00a9', 1, ['cp1252', 'latin1']],
    ['\u00fc', '\u00c3\u00bc', 1, ['cp1252', 'latin1']],
    ['\u20ac', '\u00e2\u201a\u00ac', 1, ['cp1252']],
    ['\u041f\u0440\u0438\u0432\u0435\u0442',
      '\u00d0\u0178\u00d1\u20ac\u00d0\u00b8\u00d0\u00b2\u00d0\u00b5\u00d1\u201a', 6, null],
    ['\ud83d\ude42', '\u00f0\u0178\u2122\u201a', 1, ['cp1252']],
  ];
  for (const [original, image, count, pages] of examples) {
    const found = candidates(image);
    assert.equal(found.length, count);
    assert.equal(repairCandidates(image), original);
    assert.equal(isMojibakeImageOf(original, image), true);
    if (pages) assert.deepEqual(found[0].pages, pages);
  }
});

test('true Latin-1 maps bytes left undefined by cp1252 without substituting', () => {
  for (const byte of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) {
    const image = latin1Image([0xc2, byte]);
    assert.deepEqual(candidates(image), [{
      start: 0, end: 2, text: image, repaired: String.fromCodePoint(byte), pages: ['latin1'],
    }]);
  }
});

test('all 27 Windows-1252 punctuation mappings invert exactly', () => {
  const punctuation = [
    [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e],
    [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6],
    [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152],
    [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c],
    [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
    [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a],
    [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
  ];
  assert.equal(punctuation.length, 27);
  for (const [byte, scalar] of punctuation) {
    const image = `\u00c2${String.fromCodePoint(scalar)}`;
    assert.deepEqual(candidates(image), [{
      start: 0, end: 2, text: image, repaired: String.fromCodePoint(byte), pages: ['cp1252'],
    }]);
    assert.deepEqual(candidates(latin1Image([0xc2, byte]))[0].pages, ['latin1']);
  }
});

test('corruption adjacent to legitimate accented text is found in either direction', () => {
  const broken = '\u00e2\u20ac\u201d';
  for (const [image, start, original] of [
    [`\u00e9${broken}`, 1, '\u00e9\u2014'],
    [`${broken}\u00e9`, 0, '\u2014\u00e9'],
  ]) {
    assert.deepEqual(candidates(image), [{
      start, end: start + 3, text: broken, repaired: '\u2014', pages: ['cp1252'],
    }]);
    assert.equal(repairCandidates(image), original);
  }
  assert.deepEqual(candidates('\u00e9'), []);
});

test('legitimate languages, emoji and ASCII contain no candidates', () => {
  for (const text of [
    'JO\u00c3O', 'S\u00c3O PAULO', 'a\u00e7\u00e3o',
    '\u00c9l\u00e8ve', 'd\u00e9j\u00e0', 'Stra\u00dfe', 'M\u00fcller',
    '\u041f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440',
    '\u65e5\u672c\u8a9e', '\ud83d\ude42', 'plain ASCII\n123', '',
  ]) {
    assert.deepEqual(mojibakeCandidates(text), { candidates: [], findings: [] });
    assert.equal(repairCandidates(text), text);
  }
});

test('typography can satisfy the rule: this is why D1 tier B is advisory', () => {
  // These measured two-scalar candidates are why tier B is advisory: reversibility
  // alone cannot establish the intent of German or French typography.
  const examples = [
    ['\u00df\u201c', '\u07d3', ['cp1252']],
    ['\u00df\u2026', '\u07c5', ['cp1252']],
    ['\u00c9\u00bb', '\u027b', ['cp1252', 'latin1']],
    ['\u00d3\u00bb', '\u04fb', ['cp1252', 'latin1']],
    ['\u00c3\u00bb', '\u00fb', ['cp1252', 'latin1']],
  ];
  for (const [image, repaired, pages] of examples) {
    assert.deepEqual(candidates(image), [{ start: 0, end: 2, text: image, repaired, pages }]);
    assert.equal(repairCandidates(image), repaired);
    assert.equal(isMojibakeImageOf(`Quoted ${image}`, image), false);
  }
});

test('tier A requires at least one candidate and exact equality without trimming', () => {
  const image = '\u00e2\u20ac\u201d';
  assert.equal(isMojibakeImageOf('same', 'same'), false);
  assert.equal(isMojibakeImageOf(image, image), false);
  assert.equal(isMojibakeImageOf('// old \u2014', `// edited ${image}`), false);
  assert.equal(isMojibakeImageOf('\u2014 ', image), false);
  assert.equal(isMojibakeImageOf('\u2014', ` ${image}`), false);
  assert.equal(isMojibakeImageOf('original', '\ufffd'), false);
  assert.equal(isMojibakeImageOf('\ufffd', '\ufffd'), false);
});

test('literal replacement characters are separate findings at string indices', () => {
  const text = '\ud83d\ude42\ufffdx\ufffd';
  assert.deepEqual(mojibakeCandidates(text), {
    candidates: [],
    findings: [{ kind: 'replacement-char', index: 2 }, { kind: 'replacement-char', index: 4 }],
  });
  assert.equal(validateUtf8(Buffer.from(text)), text);
});

test('UTF-16 indices preserve surrounding astral scalars and adjacent matches', () => {
  const text = '\ud83d\ude42\u00c3\u00a9\u00e2\u20ac\u201d\ud83d\ude42';
  assert.deepEqual(candidates(text).map(({ start, end }) => [start, end]), [[2, 4], [4, 7]]);
  assert.equal(repairCandidates(text), '\ud83d\ude42\u00e9\u2014\ud83d\ude42');
});

test('no bridging ASCII, newline, unmappable scalars, or mixed pages; no normalization', () => {
  for (const text of [
    '\u00c3x\u00a9', '\u00c3\n\u00a9', '\u00c3\u65e5\u00a9',
    '\u00c3\ud83d\ude42\u00a9', '\u00c3\ud800\u00a9',
    '\u00e2\u20ac\u0081', '\u00e2\u0081\u20ac',
    'A\u0303\u00a9', '\u00c3', '\u00e2\u20ac', '\u00f0\u0178\u2122',
  ]) assert.deepEqual(candidates(text), []);
  assert.equal(repairCandidates('e\u0301\u00c3\u00a9'), 'e\u0301\u00e9');
});

test('valid UTF-8 boundary shapes yield exactly one repaired scalar', () => {
  for (const bytes of [
    [0xc2, 0x80], [0xdf, 0xbf], [0xe0, 0xa0, 0x80], [0xe0, 0xbf, 0xbf],
    [0xe1, 0x80, 0x80], [0xec, 0xbf, 0xbf], [0xed, 0x80, 0x80], [0xed, 0x9f, 0xbf],
    [0xee, 0x80, 0x80], [0xef, 0xbf, 0xbf], [0xf0, 0x90, 0x80, 0x80],
    [0xf0, 0xbf, 0xbf, 0xbf], [0xf1, 0x80, 0x80, 0x80], [0xf3, 0xbf, 0xbf, 0xbf],
    [0xf4, 0x80, 0x80, 0x80], [0xf4, 0x8f, 0xbf, 0xbf],
  ]) {
    const image = latin1Image(bytes);
    const found = candidates(image);
    const repaired = Buffer.from(bytes).toString('utf8');
    assert.equal(found.length, 1);
    assert.equal(found[0].repaired, repaired);
    assert.equal([...found[0].repaired].length, 1);
    assert.equal(validateUtf8(Buffer.from(bytes)), repaired);
  }
});

test('invalid, overlong, surrogate, out-of-range and truncated sequences are rejected', () => {
  for (const bytes of [
    [0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xc2, 0x7f], [0xdf, 0xc0],
    [0xe0, 0x9f, 0xbf], [0xed, 0xa0, 0x80], [0xef, 0xbf, 0xc0],
    [0xf0, 0x8f, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80],
    [0xfe], [0xff], [0xc2], [0xe0, 0xa0], [0xf0, 0x90, 0x80],
  ]) {
    assert.deepEqual(candidates(latin1Image(bytes)), []);
    assert.deepEqual(validateUtf8(Buffer.from([0x61, ...bytes])), {
      kind: 'malformed-utf8', byteOffset: 1,
    });
  }
});

test('strict UTF-8 preserves a leading BOM and reports byte rather than string offsets', () => {
  assert.equal(validateUtf8(Buffer.alloc(0)), '');
  assert.equal(validateUtf8(Buffer.from('valid \u2014\ud83d\ude42')), 'valid \u2014\ud83d\ude42');
  assert.equal(validateUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), '\ufeffa');
  assert.deepEqual(validateUtf8(Buffer.from([0xff])), { kind: 'malformed-utf8', byteOffset: 0 });
  assert.deepEqual(validateUtf8(Buffer.from([0xc3, 0xa9, 0x80])), {
    kind: 'malformed-utf8', byteOffset: 2,
  });
  assert.deepEqual(validateUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0xff])), {
    kind: 'malformed-utf8', byteOffset: 3,
  });
});
