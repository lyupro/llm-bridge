/**
 * Renders the reply rows that explain why a run ended without a usable result.
 * Plan_80 A5: render only stored assessments so the reply says what meta.json says;
 * re-deriving them here could disagree with the frozen evidence used at collection.
 */
import path from 'node:path';
import { readJson } from './paths.mjs';
import { orderRuleMessage } from '../order-rules.mjs';

export function stopRows(meta, runDir) {
  if (!meta.situation) return [];
  const { kind, silence_ms: silence, threshold_ms: threshold, commands } = meta.situation;
  const { automatic, grant } = meta.continuation_eligibility;
  const eligibility = (assessment) =>
    assessment.allowed ? 'allowed' : `blocked (${assessment.blocking_reasons.join(', ')})`;
  const retryEmptyResumes = grant.allowed === false && grant.blocking_reasons.length === 1 &&
    grant.blocking_reasons[0] === 'empty-resumes-exhausted';
  const orderId = grant.allowed === true || retryEmptyResumes
    ? readJson(path.join(runDir, 'status.json'))?.order_id : null;
  return [
    `Situation: ${kind} · silence=${silence === null ? 'unknown' : `${silence} ms`} · threshold=${threshold === null ? 'unconfigured' : `${threshold} ms`} · command=${commands.state === null ? 'unknown' : commands.state}`,
    `Continuation: automatic ${eligibility(automatic)} · grant ${eligibility(grant)}`,
    ...(typeof orderId === 'string' && orderId.trim() ? retryEmptyResumes ? [
      'The last two resume passes of this thread produced no model output, so resume: is no longer offered; ' +
        'repeat the pass on a fresh thread by sending the original order file again with the ready retry line ' +
        '(same question, options, paths and decisions:; the original rendered task is kept in task-original.md).',
      orderRuleMessage('ready-grant-line', {
        variant: 'retry', run: path.basename(runDir), reason: 'repeat after two empty resumes', orderId,
      }),
    ] : [orderRuleMessage('ready-grant-line', {
      variant: 'resume', run: path.basename(runDir), reason: `continue after ${kind}`, orderId,
    })] : []),
    `Treatment: ${meta.treatment.action} · diagnostic only, nothing runs it`,
  ];
}
