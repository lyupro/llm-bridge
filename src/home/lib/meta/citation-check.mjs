/** Checks answer text and repository citations consistently for the OW-097 design chosen by the advise run named in `advice:`. */
import fs from 'node:fs';
import path from 'node:path';

const ADDRESS_TOKEN = /(?<![\p{L}\p{N}_./\\:~-])(?:[a-zA-Z]:)?[\p{L}\p{N}_@!$~.%+/\\-]+:\d+(?:-\d+)?(?![\p{L}\p{N}_:\d-])/gu;
const QUOTED_ADDRESS = /`([^`\r\n]+:\d+(?:-\d+)?)`|"([^"\r\n]+:\d+(?:-\d+)?)"|'([^'\r\n]+:\d+(?:-\d+)?)'/u;
const ADDRESS = new RegExp(`${QUOTED_ADDRESS.source}|(${ADDRESS_TOKEN.source})`, 'gu');

export function* strings(value, field = '') {
  if (typeof value === 'string') yield { field, value };
  else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* strings(item, `${field}[${index}]`);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield* strings(item, field ? `${field}.${key}` : key);
    }
  }
}

function isInside(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function entryInRepo(root, raw) {
  const normalized = raw.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return null;
  const absolute = path.resolve(root, normalized);
  if (!isInside(root, absolute)) return null;
  try {
    // Plan_59 D3 requires real containment: a repository symlink cannot authorize outside evidence.
    if (!isInside(fs.realpathSync(root), fs.realpathSync(absolute))) return null;
    const stat = fs.statSync(absolute);
    return {
      absolute,
      relative: path.relative(root, absolute).replace(/\\/g, '/'),
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
    };
  } catch {
    return null;
  }
}

export function lineCount(absolute) {
  const text = fs.readFileSync(absolute, 'utf8');
  if (!text) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

function* addressesIn(value, root) {
  for (const match of value.matchAll(ADDRESS)) {
    const address = match.slice(1).find(Boolean);
    if (!match[4]) {
      // Plan_59 D3 must distinguish a quoted path with spaces from prose quoting several citations.
      const embedded = [...address.matchAll(ADDRESS_TOKEN)].map((token) => token[0]);
      const file = address.match(/^(.+):\d+(?:-\d+)?$/)[1];
      if (embedded.length && !entryInRepo(root, file)?.isFile &&
        (embedded.length > 1 || !/^[^\s]*[/\\]/.test(address))) {
        yield* embedded;
        continue;
      }
    }
    yield address;
  }
}

// Plan_68 D7: `<anything>:<digits>` is not evidence of intent. On 2026-09-28 the prose "so 00:05 under
// yesterday's log" failed a complete advise run as file `00`, line 5 — a lost pass of the quota. A left side
// with a directory is always a claim and stays strict; a bare name is one only when that root file exists,
// so times, ratios and host:port pass while package.json and Makefile keep the read boundary. No extension
// test: `api.example.com:443` would fail as a file. The accepted cost — an invented bare name is not caught.
function isCitationInProse(address, root) {
  const file = address.match(/^(.+):\d+(?:-\d+)?$/)?.[1];
  return file !== undefined && (/[\\/]/.test(file) || entryInRepo(root, file)?.isFile === true);
}

function citationProblem(file, start, end, root, allowed) {
  if (typeof file !== 'string' || !file) return { key: 'citation-path', values: {} };
  const entry = entryInRepo(root, file);
  if (!entry?.isFile) return { key: 'citation-existing-file', values: {} };
  let count;
  try {
    count = lineCount(entry.absolute);
  } catch {
    return { key: 'citation-readable-file', values: {} };
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > count) {
    return { key: 'citation-line-range', values: { count } };
  }
  if (!allowed.some((scope) => entry.relative === scope.relative ||
    (scope.isDirectory && (!scope.relative || entry.relative.startsWith(`${scope.relative}/`))))) {
    return { key: 'citation-allowed-path', values: {} };
  }
  return null;
}

export function createCitationCheck({ repoRoot, allowedPaths, reportProblem }) {
  const root = path.resolve(repoRoot);
  const allowed = allowedPaths.map((raw) => entryInRepo(root, raw)).filter(Boolean);
  const locationLabel = ({ file, line_start, line_end }) =>
    `${file}:${line_start}${line_end === line_start ? '' : `-${line_end}`}`;
  const checkLocation = (field, location) => {
    const { file, line_start: start, line_end: end } = location;
    const label = locationLabel(location);
    const problem = citationProblem(file, start, end, root, allowed);
    if (problem) reportProblem(problem.key, { field, label, ...problem.values });
  };
  const checkAddress = (field, raw) => {
    const match = raw.match(/^(.+):(\d+)(?:-(\d+))?$/);
    if (!match) {
      reportProblem('prose-address', { field, label: raw });
      return;
    }
    const start = Number(match[2]);
    checkLocation(field, {
      file: match[1],
      line_start: start,
      line_end: match[3] === undefined ? start : Number(match[3]),
    });
  };
  return {
    allowFile(raw) {
      const entry = entryInRepo(root, raw);
      if (entry?.isFile) allowed.push(entry);
    },
    checkProse(field, value) {
      for (const address of addressesIn(value, root)) {
        if (isCitationInProse(address, root)) checkAddress(field, address);
      }
    },
    checkEvidence(field, evidence) {
      for (const [index, location] of evidence.entries()) checkLocation(`${field}[${index}]`, location);
    },
  };
}

// Plan_68 D6: on 2026-09-27 an advise answer cut by the schema ended in U+0000 and passed as OK.
// This is integrity, not completeness: a cut that ends on a whole character is not detectable here,
// which is why the cause — the hidden length cap — was removed from the schema instead.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const codePoint = (char) => `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

export function checkTextIntegrity(result, reportProblem) {
  for (const { field, value } of strings(result)) {
    const control = value.match(CONTROL)?.[0];
    const surrogate = value.match(LONE_SURROGATE)?.[0];
    if (control) reportProblem('control-character', { field, codePoint: codePoint(control) });
    else if (surrogate) reportProblem('lone-surrogate', { field, codePoint: codePoint(surrogate) });
  }
}
