/** Expands guidance placeholders using modules from the same installed home. */

const codeList = (values) => values.map((value) =>
  value.includes('`') ? '`` ' + value + ' ``' : '`' + value + '`').join(', ');

function renderError(topic, placeholder, message) {
  return new Error(`Cannot render guidance topic "${topic}" placeholder "${placeholder}": ${message}`);
}

export async function renderGuidance(text, { topic, configPath, topics }) {
  if (!topics) throw new Error('topics is required');
  const values = new Map();
  for (const [placeholder, name] of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    if (values.has(placeholder)) continue;
    try {
      // Resolve siblings lazily so a broken module only affects the placeholder that needs it.
      if (name === 'shell-unsafe-sequences') {
        const { SHELL_UNSAFE_SEQUENCES } = await import(new URL('./shell-unsafe.mjs', import.meta.url).href);
        values.set(placeholder, codeList(SHELL_UNSAFE_SEQUENCES));
      } else if (name === 'review-required-fields') {
        const { SCHEMAS } = await import(new URL('./runner/schemas.mjs', import.meta.url).href);
        const review = SCHEMAS['codex-review'];
        values.set(placeholder, `Top-level fields: ${codeList(review.required)}; finding fields: ${codeList(review.properties.findings.items.required)}`);
      } else if (name === 'agent-budgets') {
        if (!configPath) throw new Error('configPath is required');
        const { AGENTS } = await import(new URL('./agents.mjs', import.meta.url).href);
        const { readRunConfig } = await import(new URL('./run-config.mjs', import.meta.url).href);
        let runConfig;
        try {
          runConfig = readRunConfig(configPath, { provenance: true });
        } catch (error) {
          // Plan_80 E39: the seeded host config is never rewritten by update.
          throw Object.assign(renderError(topic, placeholder, error.message), { hostConfig: true });
        }
        const { config, budgetSources } = runConfig;
        const rows = Object.entries(AGENTS).flatMap(([agent, { role }]) => {
          const phases = Object.entries(config.budgets[role]);
          return phases.map(([phase, minutes]) =>
            `| ${agent} | ${phases.length === 1 ? '—' : phase} | ${minutes} | ${budgetSources[role].has(phase) ? 'host config' : 'package'} |`);
        });
        values.set(placeholder, [
          `Budgets the runner enforces on this host. \`host config\` values come from ${configPath}.`,
          '', '| Agent | Phase | Minutes | Source |', '| --- | --- | --- | --- |', ...rows,
        ].join('\n'));
      } else if (name === 'order-header-labels') {
        // OW-097 D8: the handwritten table missed codex-arbiter when it became the fifth dispatcher on 2026-11-20.
        const { ORDER_AGENTS, orderLabelsFor } = await import(new URL('./order-schema.mjs', import.meta.url).href);
        const rows = ORDER_AGENTS.map((agent) => {
          const labels = orderLabelsFor(agent);
          const columns = ['required', 'conditional', 'optional'].map((flag) =>
            codeList(labels.filter((entry) => entry[flag]).map(({ label }) => label)) || '—');
          return `| ${agent} | ${columns.join(' | ')} |`;
        });
        values.set(placeholder, [
          '| Agent | Required labels | Conditional labels | Optional labels |',
          '| --- | --- | --- | --- |', ...rows,
        ].join('\n'));
      } else if (name.startsWith('order-rules:')) {
        const ruleTopic = name.slice('order-rules:'.length);
        if (ruleTopic !== 'all' && !Object.hasOwn(topics, ruleTopic)) {
          throw new Error(`unknown order rule topic "${ruleTopic}"`);
        }
        const { ORDER_RULES } = await import(new URL('./order-rules.mjs', import.meta.url).href);
        const rules = Object.entries(ORDER_RULES);
        const items = (owner) => rules.filter(([, rule]) => rule.topic === owner)
          .map(([key, rule]) => `- \`${key}\`: ${rule.rule}`).join('\n');
        let block;
        if (ruleTopic === 'all') {
          // The 2026-11-20 package 0.8.2 mismatch would hide clone-installed rules owned by arbiter.
          const unregistered = rules.find(([, rule]) => !Object.hasOwn(topics, rule.topic));
          if (unregistered) {
            const [key, rule] = unregistered;
            throw new Error(`order rule "${key}" uses unregistered topic "${rule.topic}"`);
          }
          block = Object.keys(topics).map((owner) => {
            const list = items(owner);
            return list ? `Topic \`${owner}\`:\n${list}` : '';
          }).filter(Boolean).join('\n\n');
        } else {
          block = items(ruleTopic);
        }
        if (!block) throw new Error('no order rules to render');
        values.set(placeholder, block);
      } else {
        throw new Error('unknown placeholder');
      }
    } catch (error) {
      if (error.hostConfig === true) throw error;
      throw renderError(topic, placeholder, error.message);
    }
  }
  const rendered = text.replace(/\{\{([^{}]*)\}\}/g, (placeholder) => values.get(placeholder));
  const unresolved = rendered.indexOf('{{');
  if (unresolved !== -1) {
    const placeholder = rendered.slice(unresolved).split(/\r?\n/, 1)[0];
    throw renderError(topic, placeholder, 'unresolved placeholder');
  }
  return rendered;
}
