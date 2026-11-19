/** Freezes the inputs shared by an arbiter launch and its saved run record. */
import { orderDiagnosticMessage } from '../order-diagnostics.mjs';
import { orderRuleMessage } from '../order-rules.mjs';
import { parseArbiterTask } from '../meta/arbiter-task.mjs';
import { die } from './args.mjs';
import { arbiterEvidence, arbiterEvidenceSection } from './arbiter-evidence.mjs';
import { EXIT } from './exit-codes.mjs';
import { git } from './git-state.mjs';

function revisionError(error) {
  return new Error(orderRuleMessage('repository-source', {
    violation: 'discovery-failed', error: `arbiter source revision: ${error}`,
  }));
}

function gitFailure(command, result) {
  const detail = result.error?.message || result.stderr?.trim() || result.signal || `exit status ${result.status}`;
  return revisionError(`git ${command} failed: ${detail}`);
}

function unbornHead(runGit) {
  const target = runGit('symbolic-ref', '--quiet', 'HEAD');
  if (!target.error && target.status === 1 && !target.stderr?.trim()) return false;
  if (target.error || target.status !== 0) throw gitFailure('symbolic-ref HEAD', target);
  const ref = target.stdout.trim();
  if (!ref.startsWith('refs/heads/')) return false;

  // OW-097 D4: a ref that exists but cannot resolve to a commit is a Git failure.
  const refs = runGit('for-each-ref', '--format=%(refname)', ref);
  if (refs.error || refs.status !== 0 || refs.stderr?.trim()) throw gitFailure('for-each-ref', refs);
  return !refs.stdout.trim().split(/\r?\n/).includes(ref);
}

export function sourceRevision(repoRoot) {
  // OW-097 D4: only a confirmed absence may be recorded as null.
  const env = { ...process.env, LC_ALL: 'C' };
  const runGit = (...args) => git(repoRoot, args, env);
  const tree = runGit('rev-parse', '--is-inside-work-tree');
  if (!tree.error && tree.status === 128 &&
      /^fatal: not a git repository \(or any /.test(tree.stderr?.trim())) {
    return { revision: null };
  }
  if (tree.error || tree.status !== 0) throw gitFailure('rev-parse --is-inside-work-tree', tree);
  const inside = tree.stdout.trim();
  if (inside === 'false') return { revision: null };
  if (inside !== 'true') throw revisionError(`unexpected Git work tree response ${JSON.stringify(inside)}`);

  // headSha is intentionally best-effort for build bookkeeping. D4 needs Git's outcome too.
  const head = runGit('rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
  if (!head.error && head.status === 1 && !head.stderr?.trim() && unbornHead(runGit)) return { revision: null };
  if (head.error || head.status !== 0) throw gitFailure('rev-parse HEAD^{commit}', head);
  const revision = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw revisionError(`unsupported HEAD commit hash ${JSON.stringify(revision)}`);
  return { revision };
}

export function arbiterInputOrRefuse({ taskText, projectRunsRoot, repoRoot }) {
  // OW-097 D4: snapshot once before the paid probe so rejected input leaves no run.
  let input;
  try {
    const task = parseArbiterTask(taskText);
    const { priorRuns, position, trigger } = task;
    const evidence = arbiterEvidence({ projectRunsRoot, priorRuns, position, trigger });
    if (!evidence.ok) throw new Error(evidence.refusal);
    input = { version: 1, task, evidence: evidence.runs };
  } catch (error) {
    return die([error.message, orderDiagnosticMessage('run-not-created')].join(' '), { action: 'usage', exit: EXIT.FAIL });
  }
  try {
    return { input, ...sourceRevision(repoRoot) };
  } catch (error) {
    return die([error.message, orderDiagnosticMessage('run-not-created')].join(' '), { action: 'runner-fault', exit: EXIT.FAIL });
  }
}

export function arbiterInputSection(input) {
  return arbiterEvidenceSection(input.evidence);
}

export function arbiterStatusFields({ arbiterInput, resumeInputs }) {
  // OW-097 D4: the parent revision remains authoritative even when it recorded no commit.
  if (arbiterInput) return { source_revision: arbiterInput.revision };
  if (resumeInputs?.agent === 'codex-arbiter') return { source_revision: resumeInputs.source_revision };
  return {};
}
