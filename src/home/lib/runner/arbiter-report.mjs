/** Renders the validated OW-097 arbitration and its receipts as deterministic Markdown. */

function lf(text) {
  if (typeof text !== 'string') throw new TypeError('Expected report text to be a string.');
  return text.replace(/\r\n?/g, '\n');
}

// OW-097 D1 leaves the report structure to the runner, so every line of supplied prose stays quoted.
function quote(text, indent = '') {
  return lf(text).split('\n').map((line) => `${indent}> ${line}`).join('\n');
}

function field(label, value) {
  return `${label}\n\n${quote(value)}`;
}

function codeSpan(value) {
  if (typeof value !== 'string' || /[\r\n\u2028\u2029]/.test(value)) {
    throw new TypeError('Expected a single-line report identifier.');
  }
  let length = 1;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const delimiter = '`'.repeat(length);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

function fenced(text) {
  const content = lf(text);
  let length = 3;
  for (const match of content.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  const separator = content && !content.endsWith('\n') ? '\n' : '';
  return `${fence}\n${content}${separator}${fence}`;
}

function yesNo(value) {
  if (typeof value !== 'boolean') throw new TypeError('Expected a report flag to be a boolean.');
  return value ? 'yes' : 'no';
}

function integer(value) {
  if (!Number.isInteger(value)) throw new TypeError('Expected a report count or index to be an integer.');
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function renderProbes(probes, receipts) {
  if (!Array.isArray(probes)) throw new TypeError('Expected result.probes to be an array.');
  const remaining = new Map();
  for (const receipt of receipts) {
    const tag = receipt?.probe_tag;
    if (typeof tag !== 'string') throw new TypeError('Expected a receipt with a probe_tag string.');
    if (remaining.has(tag)) throw new TypeError(`Duplicate receipt for probe ${tag}.`);
    remaining.set(tag, receipt);
  }

  // OW-097 D3 requires one receipt per probe so the interpretation stays beside its execution evidence.
  const blocks = probes.map(({ probe_tag: tag, purpose, finding }) => {
    const receipt = remaining.get(tag);
    if (!remaining.delete(tag)) throw new TypeError(`Missing receipt for probe ${tag}.`);
    const { status, output_truncated: truncated } = receipt;
    if ((status !== 'completed' && status !== 'failed') || typeof truncated !== 'boolean') {
      throw new TypeError('Expected a terminal receipt status and an output_truncated boolean.');
    }
    return [
      `### Probe ${codeSpan(tag)}`,
      field('Purpose:', purpose),
      field('Finding:', finding),
      `Receipt: item ${codeSpan(receipt.item_id)}, event ${integer(receipt.event_index)}, ` +
        `status ${codeSpan(status)}, exit code ${integer(receipt.exit_code)}, succeeded: ${yesNo(receipt.succeeded)}.`,
      `Command:\n\n${fenced(receipt.command)}`,
      `Output excerpt (${integer(receipt.output_bytes)} bytes in full${truncated ? ', truncated' : ''}):` +
        `\n\n${fenced(receipt.output_excerpt)}`,
    ].join('\n\n');
  });
  if (remaining.size) throw new TypeError(`Receipt has no matching probe: ${remaining.keys().next().value}.`);
  return blocks.length ? blocks : ['No probes were run.'];
}

export function renderArbiterReport({ run, revision, task, evidence, result, receipts }) {
  if (typeof run !== 'string' || !run.trim() || /[\r\n]/.test(run)) {
    throw new TypeError('Expected run to be a non-empty run folder name.');
  }
  if (revision !== null && (typeof revision !== 'string' || !/^[0-9a-f]{40}$/i.test(revision))) {
    throw new TypeError('Expected revision to be a 40-hex commit or null.');
  }
  if (!isRecord(task) || !isRecord(result) || !Array.isArray(evidence) || !Array.isArray(receipts)) {
    throw new TypeError('Expected task and result objects and evidence and receipts arrays.');
  }

  const probes = renderProbes(result.probes, receipts);
  const snapshots = new Map(evidence.map(({ run: priorRun, result_sha256: sha }) =>
    [codeSpan(priorRun), codeSpan(sha)]));
  const { option_ids: optionIds, text, mix_rationale: mixRationale } = result.recommendation;

  return [
    '# Arbiter report',
    [
      `- Run: ${codeSpan(run)}`,
      `- Source revision: ${revision === null ? 'not recorded' : codeSpan(revision)}`,
      `- Trigger: ${codeSpan(task.trigger)}`,
      `- Orchestrator position: ${codeSpan(task.position.option)}`,
    ].join('\n'),
    '## Question',
    quote(task.question),
    '## Options',
    ...task.options.map(({ id, description }) =>
      `- ${codeSpan(id)}\n\n${quote(description, '  ')}`),
    '## Orchestrator position',
    `Option: ${codeSpan(task.position.option)}`,
    quote(task.position.rationale),
    '## Recommendation',
    `Recommended: ${optionIds.map(codeSpan).join(', ')}`,
    quote(text),
    ...(lf(mixRationale).length ? [field('Mix rationale:', mixRationale)] : []),
    '## Rejected options',
    ...result.rejected.map(({ option_id: id, cost }) =>
      `- ${codeSpan(id)}\n\n${quote(cost, '  ')}`),
    '## Residual gaps',
    ...result.residual_gaps.map(({ option_id: id, gap }) =>
      `- ${codeSpan(id)}\n\n${quote(gap, '  ')}`),
    '## Strongest counterargument',
    quote(result.strongest_counterargument),
    '## Pre-mortem',
    ...result.pre_mortem.map(({ scenario, early_check: earlyCheck }, index) =>
      [`${index + 1}. Scenario:`, quote(scenario, '   '), '   Early check:', quote(earlyCheck, '   ')].join('\n\n')),
    '## Prior advice review',
    ...result.prior_advice_review.map(({ run: priorRun, stance, note }) => {
      const runSpan = codeSpan(priorRun);
      const sha = snapshots.get(runSpan);
      if (sha === undefined) throw new TypeError('Expected a matching prior advice snapshot.');
      return `- ${runSpan} — stance ${codeSpan(stance)}, result SHA-256 ${sha}\n\n${quote(note, '  ')}`;
    }),
    '## Checks',
    ...result.checks.map(({ claim, verified, evidence: locations }) => {
      const citations = locations.map(({ file, line_start: start, line_end: end }) =>
        codeSpan(`${lf(file)}:${integer(start)}-${integer(end)}`));
      return [
        `- Verified: ${yesNo(verified)}`,
        quote(claim, '  '),
        `  Evidence: ${citations.join(', ') || 'none'}`,
      ].join('\n\n');
    }),
    '## Probes',
    ...probes,
  ].join('\n\n') + '\n';
}
