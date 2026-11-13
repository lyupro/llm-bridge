/** Reads the rules ownership index without migrating or writing its on-disk representation. */
import path from 'node:path';
import { readJsonFile } from '../src/home/lib/json-file.mjs';
import { INSTALL_RECORD_NAME } from './install-record.mjs';
import { rulesRegistryPath } from './rules-owners.mjs';

function stringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`rules ownership registry ${label} must be a list of non-empty strings`);
  }
  return [...value];
}

export function validateIndex(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('rules ownership registry must be an object');
  }
  if (parsed.version === 1) {
    // OW-086: even duplicate or vanished hints must survive until an operator resolves them.
    return { version: 2, records: [], legacy: stringList(parsed.owners, 'owners') };
  }
  if (parsed.version !== 2) throw new Error('rules ownership registry version must be 1 or 2');
  const records = stringList(parsed.records, 'records');
  if (records.some((file) => !path.isAbsolute(file) || path.basename(file) !== INSTALL_RECORD_NAME)) {
    throw new Error(`rules ownership registry records must be absolute paths to ${INSTALL_RECORD_NAME}`);
  }
  const index = { version: 2, records, legacy: stringList(parsed.legacy, 'legacy') };
  // Plan_83 D8: retained entries prove installation history, never ownership or today's contents.
  if (Object.hasOwn(parsed, 'retained')) {
    const seen = new Set();
    if (!Array.isArray(parsed.retained) || !parsed.retained.length) {
      throw new Error('rules ownership registry retained must be a non-empty list');
    }
    index.retained = parsed.retained.map((entry) => {
      if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)
        || typeof entry.fingerprint !== 'string' || !/^[a-fA-F0-9]{64}$/.test(entry.fingerprint)) {
        throw new Error('rules ownership registry retained requires absolute paths and SHA-256 fingerprints');
      }
      const key = JSON.stringify([entry.path, entry.fingerprint]);
      if (seen.has(key)) throw new Error('rules ownership registry retained contains a duplicate pair');
      seen.add(key);
      return { path: entry.path, fingerprint: entry.fingerprint };
    });
  }
  return index;
}

export async function readRulesIndex(host) {
  const file = rulesRegistryPath(host);
  try {
    return validateIndex(await readJsonFile(file));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    const message = err.cause instanceof SyntaxError
      ? `invalid rules ownership registry JSON: ${err.cause.message}` : err.message;
    throw new Error(`${file}: ${message}`, { cause: err });
  }
}
