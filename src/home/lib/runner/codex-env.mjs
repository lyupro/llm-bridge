/**
 * Owns the Codex child's environment so Python text I/O defaults to UTF-8. OW-089:
 * run 2026-11-13_203644_plan83-b3c3c-uninstall-recovers-pending-20261113 read UTF-8
 * as cp1252 and wrote mojibake. Windows folds environment names, so remove every
 * inherited spelling before setting the override without changing the parent.
 */
export function codexEnv(inherited) {
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([key]) => key.toUpperCase() !== 'PYTHONUTF8')),
    PYTHONUTF8: '1',
  };
}
