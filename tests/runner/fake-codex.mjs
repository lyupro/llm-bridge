/** Installs a temporary Codex CLI fixture for tests that exercise the real runner. */
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function installFakeCodex(root, source) {
  const bin = path.join(root, 'bin');
  const script = path.join(root, 'fake-codex.mjs');
  fs.mkdirSync(bin);
  fs.writeFileSync(script, source);
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(bin, 'codex.cmd'),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
  } else {
    const wrapper = path.join(bin, 'codex');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
  }
  return bin;
}

export async function withFakeCodex(source, work) {
  const root = makeTempTree('codex-deadline-');
  const bin = installFakeCodex(root, source);
  const previousPath = process.env.PATH;
  const previousCwd = process.cwd();
  process.env.PATH = [bin, previousPath].filter(Boolean).join(path.delimiter);
  if (process.platform === 'win32') process.chdir(bin);
  try {
    return await work(root);
  } finally {
    if (process.platform === 'win32') process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await removeTempTree(root);
  }
}
