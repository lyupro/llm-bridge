/** Classifies measured folder ACLs against the repository root. */
import { win32 } from 'node:path';
import { normalizePath } from './paths.mjs';

export const FOLDER_ACL_LEVELS = Object.freeze(['confirmed', 'not-confirmed', 'not-measured']);

// The measurement appends the actual exit status to this prefix.
export const FOLDER_ACL_EXIT_REASON_PREFIX = 'exit-';

export const FOLDER_ACL_REASONS = Object.freeze([
  'not-windows', 'too-many-folders', 'timeout', 'spawn-error', 'malformed-output',
  'root-unreadable', 'root-missing', 'root-reparse-point', 'no-sandbox-account', 'root-not-inheritable',
  'folder-unreadable', 'folder-missing', 'folder-reparse-point', 'outside-root',
  'owner-not-sandbox', 'inheritance-intact', 'mixed', 'no-folders', 'partial',
]);

function isStrictlyInside(rootPath, folderPath) {
  // OW-092 D3 limits the comparison to descendants, including when a path contains .. segments.
  const root = win32.normalize(normalizePath(rootPath)).replace(/\\+$/, '');
  const folder = win32.normalize(normalizePath(folderPath)).replace(/\\+$/, '');
  return folder.startsWith(`${root}\\`);
}

function classifyFolder(folder, root, inheritableRules) {
  const { path } = folder;
  if (root.error) return { path, level: 'not-measured', reason: 'root-unreadable' };
  if (!root.exists) return { path, level: 'not-measured', reason: 'root-missing' };
  if (root.isReparsePoint) return { path, level: 'not-measured', reason: 'root-reparse-point' };
  if (root.sandboxSid === null) return { path, level: 'not-measured', reason: 'no-sandbox-account' };
  if (inheritableRules.length === 0) return { path, level: 'not-measured', reason: 'root-not-inheritable' };
  if (folder.error) return { path, level: 'not-measured', reason: 'folder-unreadable' };
  if (!folder.exists) return { path, level: 'not-measured', reason: 'folder-missing' };
  if (folder.isReparsePoint) return { path, level: 'not-measured', reason: 'folder-reparse-point' };
  if (!isStrictlyInside(root.path, path)) return { path, level: 'not-measured', reason: 'outside-root' };
  if (folder.ownerSid !== root.sandboxSid) return { path, level: 'not-confirmed', reason: 'owner-not-sandbox' };

  // OW-092 D3 matches SID and Allow type because Windows maps generic rights during inheritance.
  // A root right of 268435456 can appear as FullControl on a healthy child.
  const inheritanceIntact = inheritableRules.every((rootRule) => folder.rules.some((rule) =>
    rule.inherited && rule.sid === rootRule.sid && rule.type === rootRule.type));
  if (inheritanceIntact) return { path, level: 'not-confirmed', reason: 'inheritance-intact' };
  return { path, level: 'confirmed', reason: null };
}

export function classifyFolderAcls(measurement) {
  if (measurement.status === 'not-measured') {
    const { reason } = measurement;
    const level = 'not-measured';
    const folders = (measurement.folders ?? []).map(({ path }) => ({ path, level, reason }));
    return { level, reason, folders };
  }

  const { root } = measurement;
  const inheritableRules = root.rules?.filter((rule) => rule.type === 'Allow' && rule.containerInherit);
  const folders = measurement.folders.map((folder) => classifyFolder(folder, root, inheritableRules));
  if (folders.some((folder) => folder.level === 'confirmed')) return { level: 'confirmed', reason: null, folders };
  if (folders.length === 0) return { level: 'not-measured', reason: 'no-folders', folders };
  if (folders.every((folder) => folder.level === 'not-confirmed')) {
    const sharedReason = folders[0].reason;
    const reason = folders.every((folder) => folder.reason === sharedReason) ? sharedReason : 'mixed';
    return { level: 'not-confirmed', reason, folders };
  }
  return { level: 'not-measured', reason: 'partial', folders };
}
