/** OW-083 R1: a recorded decision is evidence only in the declared, readable ledger. */
export function alreadyDecidedProblem({ answer, task, repoRoot, entryInRepo, lineCount }) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) ||
    !['found', 'not-found', 'not-checked'].includes(answer.status) ||
    !Object.hasOwn(answer, 'address') ||
    (answer.address !== null && typeof answer.address !== 'string') ||
    Object.keys(answer).some((key) => !['status', 'address'].includes(key))) {
    return { key: 'advisor-already-decided-shape', values: {} };
  }
  const ledger = typeof task.decisions === 'string' ? task.decisions : null;
  if (ledger === null) {
    if (answer.status !== 'not-checked') return { key: 'advisor-already-decided-no-ledger', values: {} };
    return answer.address === null ? null : { key: 'advisor-already-decided-null-address', values: {} };
  }
  const entry = entryInRepo(repoRoot, ledger);
  if (!entry?.isFile) return { key: 'advisor-already-decided-readable-ledger', values: {} };
  let count;
  try {
    count = lineCount(entry.absolute);
  } catch {
    return { key: 'advisor-already-decided-readable-ledger', values: {} };
  }
  if (answer.status === 'not-checked') return { key: 'advisor-already-decided-check-owed', values: {} };
  if (answer.status === 'not-found') {
    return answer.address === null ? null : { key: 'advisor-already-decided-null-address', values: {} };
  }
  const prefix = `${ledger}:`;
  if (ledger !== entry.relative || typeof answer.address !== 'string' ||
    !answer.address.startsWith(prefix) || !/^[1-9]\d*$/.test(answer.address.slice(prefix.length))) {
    return { key: 'advisor-already-decided-address', values: {} };
  }
  const line = Number(answer.address.slice(prefix.length));
  return Number.isSafeInteger(line) && line <= count ? null : { key: 'advisor-already-decided-line', values: {} };
}
