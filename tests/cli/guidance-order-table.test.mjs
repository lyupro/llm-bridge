/** Guards installed schema rendering after the 2026-11-20 handwritten table omitted codex-arbiter, the fifth dispatcher. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GUIDANCE_TOPICS } from '../../src/home/lib/guidance-topics.mjs';
import { ORDER_AGENTS, orderLabelsFor } from '../../src/home/lib/order-schema.mjs';
import { withTempTree } from '../temp-tree.mjs';

function renderInstalledTable(entries) {
  return withTempTree('guidance-order-table-', async (home) => {
    const lib = path.join(home, 'lib');
    const rendererPath = path.join(lib, 'guidance-render.mjs');
    fs.mkdirSync(lib);
    fs.copyFileSync(new URL('../../src/home/lib/guidance-render.mjs', import.meta.url), rendererPath);
    fs.writeFileSync(path.join(lib, 'order-schema.mjs'), `
const schemas = new Map(${JSON.stringify(entries)});
export const ORDER_AGENTS = [...schemas.keys()];
export const orderLabelsFor = (agent) => schemas.get(agent);
`, 'utf8');
    const { renderGuidance } = await import(pathToFileURL(rendererPath).href);
    return renderGuidance('{{order-header-labels}}', { topic: 'order', topics: GUIDANCE_TOPICS });
  });
}

test('the header-label table includes an extra agent registered in the installed schema', async () => {
  const table = await renderInstalledTable([
    ...ORDER_AGENTS.map((agent) => [agent, orderLabelsFor(agent)]),
    ['installed-extra-agent', [
      { label: 'second by name', required: true },
      { label: 'first by name', required: true },
      { label: 'continue here', conditional: true },
      { label: 'extra option', optional: true },
    ]],
  ]);
  assert.equal(table.split('\n').at(-1),
    '| installed-extra-agent | `second by name`, `first by name` | `continue here` | `extra option` |');
});

test('the header-label table renders an em dash for empty columns', async () => {
  const table = await renderInstalledTable([
    ['installed-no-labels', []],
  ]);
  assert.equal(table.split('\n')[2], '| installed-no-labels | — | — | — |');
});
