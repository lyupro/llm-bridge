/** Verifies that update dry runs name the recorded hook registrations they would remove. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { update } from '../../cli/update.mjs';
import { installRecordPath } from '../../cli/manifest.mjs';
import { formatOneRecord } from './host-fixture.mjs';

async function fixture(t) {
  const root = makeTempTree('bridge-legacy-');
  t.after(() => removeTempTree(root));
  return resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
}

test('the dry run names the registrations it would take away', async (t) => {
  // It printed "the previous undefined hook registration" five times during the real Plan_25
  // migration — on the one run whose whole purpose is telling the operator what is about to go.
  const host = await fixture(t);
  await install({ host });
  const recordPath = installRecordPath(host);
  const record = await formatOneRecord(host);
  // A hook entry is only valid when the record's file list names the same path, so both move.
  const moved = new Map(record.hooks.map((hook) => [
    `${hook.root}:${hook.path}`,
    { root: 'claude', path: `agents/codex/hooks/${path.basename(hook.path)}` },
  ]));
  record.files = record.files.map((file) => moved.get(`${file.root}:${file.path}`) ?? file);
  record.hooks = record.hooks.map((hook) => ({ ...hook, ...moved.get(`${hook.root}:${hook.path}`) }));
  for (const [key, target] of moved) {
    const [fromRoot, fromPath] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const fingerprint = record.fingerprints?.[fromRoot]?.[fromPath];
    if (fingerprint === undefined) continue;
    delete record.fingerprints[fromRoot][fromPath];
    record.fingerprints[target.root] = { ...record.fingerprints[target.root], [target.path]: fingerprint };
  }
  await fs.writeFile(recordPath, `${JSON.stringify(record)}\n`);
  const result = await update({ host, dryRun: true });
  assert.equal(result.output.includes('undefined'), false, result.output);
  assert.match(result.output, /Would remove the previous SubagentStop hook registration reply-guard for matcher \*\./);
});
