/**
 * OW-089: a build rewrote three comment dashes as their Windows-1252 image
 * while every test stayed green. D1 makes findings hard failures in this
 * repository, including untracked non-ignored files, with exact exceptions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUtf8, mojibakeCandidates } from '../src/home/lib/runner/text-integrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exceptions = [
  {
    path: 'tests/runner/flag-scan.test.mjs',
    line: 285,
    kind: 'replacement-char',
    why: 'Intentional fixture checks the replacement character produced for invalid diff bytes.',
  },
];

function repositoryFiles() {
  const files = new Set();
  for (const args of [['ls-files', '-z'], ['ls-files', '-z', '--others', '--exclude-standard']]) {
    const listed = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(listed.status, 0, `git ${args.join(' ')} failed: ${listed.stderr}`);
    for (const file of listed.stdout.split('\0').filter(Boolean)) files.add(file);
  }
  return [...files].filter((file) => fs.existsSync(path.join(root, file)));
}

function checkFile(file, bytes) {
  if (bytes.includes(0)) return [];
  const decoded = validateUtf8(bytes);
  if (typeof decoded !== 'string') {
    const line = bytes.subarray(0, decoded.byteOffset).filter((byte) => byte === 0x0a).length + 1;
    return [{ path: file, line, kind: 'malformed-utf8', detail: `byte offset ${decoded.byteOffset}` }];
  }
  const findings = [];
  for (const [index, text] of decoded.split(/\r\n|\n|\r/).entries()) {
    const { candidates, findings: replacements } = mojibakeCandidates(text);
    for (const replacement of replacements) {
      findings.push({ path: file, line: index + 1, kind: replacement.kind, detail: 'literal U+FFFD' });
    }
    for (const candidate of candidates) {
      findings.push({
        path: file,
        line: index + 1,
        kind: 'candidate',
        detail: `${JSON.stringify(candidate.text)} -> ${JSON.stringify(candidate.repaired)}`,
      });
    }
  }
  return findings;
}

function matchesException(finding, exception) {
  return finding.path === exception.path
    && finding.line === exception.line
    && finding.kind === exception.kind;
}

function describe(finding) {
  return `${finding.path}:${finding.line} ${finding.kind} ${finding.detail}`;
}

// Both tests inspect the same snapshot so exceptions cannot outlive their finding.
const files = repositoryFiles();
const findings = files.flatMap((file) => checkFile(file, fs.readFileSync(path.join(root, file))));

test('repository text has no malformed UTF-8, replacement characters, or mojibake candidates', () => {
  assert.ok(files.length > 100, `expected the repository's files, got ${files.length}`);
  const unexpected = findings.filter((finding) => !exceptions.some((entry) => matchesException(finding, entry)));
  assert.deepEqual(unexpected.map(describe), []);
});

test('every exact mojibake exception still matches a real finding', () => {
  const stale = exceptions.filter((entry) => !findings.some((finding) => matchesException(finding, entry)));
  assert.deepEqual(stale, []);
});

test('in-memory probes reject corrupt text and accept clean multilingual text', () => {
  assert.deepEqual(checkFile('probe.txt', Buffer.from('clean\n\u00e2\u20ac\u201d\n\ufffd')), [
    { path: 'probe.txt', line: 2, kind: 'candidate', detail: '"\u00e2\u20ac\u201d" -> "\u2014"' },
    { path: 'probe.txt', line: 3, kind: 'replacement-char', detail: 'literal U+FFFD' },
  ]);
  assert.deepEqual(checkFile('probe.txt', Buffer.from([0x61, 0x0a, 0xff, 0xef, 0xbf, 0xbd])), [
    { path: 'probe.txt', line: 2, kind: 'malformed-utf8', detail: 'byte offset 2' },
  ]);
  assert.deepEqual(checkFile('binary.bin', Buffer.from([0, 0xff])), []);
  const clean = [
    'English: a clean line.',
    'Russian: \u041f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440.',
    'German: Gr\u00fc\u00dfe, Stra\u00dfe.',
    'French: Fran\u00e7ais, d\u00e9j\u00e0 vu.',
    'Portuguese: JO\u00c3O, S\u00c3O.',
    'Japanese: \u3053\u3093\u306b\u3061\u306f\u4e16\u754c\u3002',
  ];
  assert.deepEqual(checkFile('clean.txt', Buffer.from(clean.join('\n'))), []);
});
