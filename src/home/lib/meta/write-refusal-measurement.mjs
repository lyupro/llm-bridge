/** Measure and classify the parent folders of in-scope write refusals. */
import path from 'node:path';
import { measureFolderAcls } from './write-refusal-acl.mjs';
import { classifyFolderAcls } from './write-refusal-acl-level.mjs';

export async function measureWriteRefusal({
  writeRefusal, repoRoot, measure = measureFolderAcls, classify = classifyFolderAcls,
}) {
  let raw = { status: 'not-measured', reason: 'no-folders' };
  try {
    if (typeof repoRoot === 'string' && repoRoot.length > 0) {
      // OW-092 D4 records one measurement per refused parent so the published facts cover only build scope.
      const folders = new Map();
      for (const entry of writeRefusal?.paths ?? []) {
        if (entry.inScope !== true) continue;
        const folder = path.win32.dirname(path.win32.resolve(repoRoot, entry.path));
        const key = folder.toLowerCase();
        if (!folders.has(key)) folders.set(key, folder);
      }
      if (folders.size > 0) raw = await measure({ repoRoot, folders: [...folders.values()] });
    }
  } catch {
    raw = { status: 'not-measured', reason: 'spawn-error' };
  }
  // The classifier is pure and B3a validates the measured shape strictly, so it needs no guard.
  return { raw, classification: classify(raw) };
}
