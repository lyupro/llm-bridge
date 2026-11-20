/** Renders the five-line chat summary for an OW-097 arbiter result. */
import { line } from './paths.mjs';
import { readCommand } from './read-command.mjs';

export function arbiterFilled(result) {
  const ids = result?.recommendation?.option_ids;
  return Array.isArray(ids) && typeof ids[0] === 'string' && ids[0].trim().length > 0;
}

export function arbiterReply(ctx) {
  const r = ctx.result;
  const ids = r.recommendation.option_ids.join(' + ');
  const rejected = r.rejected.map((option) => `${option.option_id} (${line(option.cost, 60)})`);
  return [
    line(`OK — recommend ${ids}: ${r.recommendation.text}`, 200),
    `Rejected: ${rejected.length ? line(rejected.join('; '), 180) : 'none'}`,
    `Counter: ${line(r.strongest_counterargument, 180)}`,
    `Gaps: ${r.residual_gaps.length} · pre-mortem ${r.pre_mortem.length} · probes ${r.probes.length} · checks ${r.checks.length}`,
    // OW-097 D4 directs readers to the published report whose hash is checked on re-delivery.
    `Report: ${ctx.file('report.md')} · Log: ${readCommand(ctx.runDir)}`,
  ];
}
