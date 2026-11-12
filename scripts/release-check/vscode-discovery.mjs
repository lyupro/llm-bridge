/** Finds the VS Code extension's Claude binary only when exactly one registered candidate exists, because OW-085 D1 ranks an honest inconclusive above verifying an unintended installation. */
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { homedir as hostHomedir } from 'node:os';
import path from 'node:path';

const EXTENSION_ID = 'anthropic.claude-code';
const SUPPORTED = new Set(['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

/** OW-085 D1: ambiguity must remain inconclusive rather than verify a different installation. */
export function discoverVsCodeExecutable({
  env, extensionsDir, readFile = readFileSync, stat = statSync, realpath = realpathSync,
  homedir = hostHomedir, platform = process.platform, arch = process.arch, cwd = () => process.cwd(),
}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const targetPlatform = `${platform}-${arch}`;
  const selection = {
    source: 'discovery', roots: [], root: null, folder: null, version: null,
    targetPlatform, reason: '', candidates: [], rejected: [], uncertainRoots: [],
  };
  const key = (file) => platform === 'win32' ? file.toLowerCase() : file;
  const absolute = (file) => paths.isAbsolute(file) ? paths.normalize(file) : paths.resolve(cwd(), file);
  const inside = (parent, child) => {
    const relative = paths.relative(parent, child);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`)
      && !paths.isAbsolute(relative);
  };
  const fail = (reason) => {
    selection.reason = reason;
    const candidates = selection.candidates.map(({ executable }) => executable);
    return {
      error: `${reason} Candidates: ${candidates.length ? candidates.join('; ') : '(none)'}. `
        + 'Use --vscode-executable to select a binary explicitly or --extensions-dir to restrict discovery.',
      selection,
    };
  };
  const uncertain = (root, reason, registry) => {
    root.status = 'uncertain';
    root.reason = reason;
    selection.uncertainRoots.push({ root: root.canonicalPath ?? root.path, reason });
    selection.rejected.push({ root: root.canonicalPath ?? root.path, ...(registry ? { registry } : {}), reason });
  };
  if (!SUPPORTED.has(targetPlatform)) return fail(`Unsupported VS Code target platform: ${targetPlatform}.`);
  if (!env || typeof env !== 'object') return fail('An environment object is required for VS Code discovery.');

  let requestedRoots;
  try {
    if (extensionsDir !== undefined) {
      if (!nonempty(extensionsDir)) return fail('--extensions-dir must be a non-empty path.');
      requestedRoots = [{ path: absolute(extensionsDir), source: 'flag' }];
    } else if (nonempty(env.VSCODE_EXTENSIONS)) {
      requestedRoots = [{ path: absolute(env.VSCODE_EXTENSIONS), source: 'env:VSCODE_EXTENSIONS' }];
    } else {
      const windowsHome = nonempty(env.USERPROFILE) ? env.USERPROFILE
        : nonempty(env.HOMEDRIVE) && nonempty(env.HOMEPATH) ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined;
      const home = (platform === 'win32' && windowsHome) || (nonempty(env.HOME) && env.HOME) || homedir();
      if (!nonempty(home)) return fail('Cannot determine the home directory for VS Code discovery.');
      requestedRoots = ['.vscode', '.vscode-insiders', '.vscode-server', '.vscode-server-insiders']
        .map((directory) => ({ path: absolute(paths.join(home, directory, 'extensions')), source: 'default' }));
      if (platform !== 'win32') {
        const dataHome = nonempty(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : paths.join(home, '.local', 'share');
        requestedRoots.push({ path: absolute(paths.join(dataHome, 'code-server', 'extensions')), source: 'default' });
      }
    }
  } catch (error) {
    return fail(`Cannot determine VS Code extension roots: ${error.message}`);
  }

  const rootsSeen = new Set();
  const candidates = new Map();
  for (const requested of requestedRoots) {
    const root = { ...requested, canonicalPath: null, status: 'consulted', reason: '' };
    selection.roots.push(root);
    try {
      root.canonicalPath = absolute(realpath(root.path));
      if (!stat(root.canonicalPath).isDirectory()) throw new Error('Extension root is not a directory');
    } catch (error) {
      if (root.source === 'default' && error.code === 'ENOENT') {
        root.status = 'missing';
        root.reason = 'Default root does not exist; skipped.';
      } else {
        uncertain(root, `Cannot read extension root ${root.path}: ${error.message}`);
      }
      continue;
    }
    if (rootsSeen.has(key(root.canonicalPath))) {
      root.status = 'duplicate';
      root.reason = 'Canonical root already consulted.';
      continue;
    }
    rootsSeen.add(key(root.canonicalPath));

    const registry = paths.join(root.canonicalPath, 'extensions.json');
    const obsoleteFile = paths.join(root.canonicalPath, '.obsolete');
    let entries;
    let obsolete;
    try {
      entries = JSON.parse(readFile(registry, 'utf8'));
      if (!Array.isArray(entries)) throw new Error('extensions.json must contain an array');
    } catch (error) {
      uncertain(root, `Cannot trust extensions.json at ${registry}: ${error.message}`, registry);
    }
    try {
      try {
        obsolete = JSON.parse(readFile(obsoleteFile, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        obsolete = {};
      }
      if (obsolete === null || typeof obsolete !== 'object' || Array.isArray(obsolete)) {
        throw new Error('.obsolete must contain an object');
      }
    } catch (error) {
      uncertain(root, `Cannot trust .obsolete at ${obsoleteFile}: ${error.message}`, obsoleteFile);
    }
    if (root.status === 'uncertain') continue;

    let matchingEntries = 0;
    for (const entry of entries) {
      // Other extensions cannot supply evidence for OW-085, even if their location resembles Claude.
      if (typeof entry?.identifier?.id !== 'string' || entry.identifier.id.toLowerCase() !== EXTENSION_ID) continue;
      matchingEntries += 1;
      const rejected = { root: root.canonicalPath, folder: entry.relativeLocation ?? null, version: entry.version ?? null };
      const reject = (reason) => selection.rejected.push({ ...rejected, reason });
      if (!nonempty(entry.version)) {
        reject('Extension version must be a non-empty string.');
        continue;
      }
      if (entry.metadata?.targetPlatform !== targetPlatform) {
        reject(`Extension target platform must equal ${targetPlatform}.`);
        continue;
      }
      const folderName = entry.relativeLocation;
      if (!nonempty(folderName) || /[\\/]/.test(folderName) || folderName === '.' || folderName === '..'
        || folderName !== `${EXTENSION_ID}-${entry.version}-${targetPlatform}`) {
        reject('relativeLocation must be the single expected extension folder name without separators or traversal.');
        continue;
      }
      if (Object.hasOwn(obsolete, folderName) && obsolete[folderName] === true) {
        reject('Extension folder is marked true in .obsolete.');
        continue;
      }
      try {
        const folder = absolute(realpath(paths.join(root.canonicalPath, folderName)));
        if (!inside(root.canonicalPath, folder)) {
          reject('Extension folder resolves outside the extension root.');
          continue;
        }
        if (!stat(folder).isDirectory()) {
          reject('Extension folder is not a directory.');
          continue;
        }
        const binary = paths.join(folder, 'resources', 'native-binary', platform === 'win32' ? 'claude.exe' : 'claude');
        let executable;
        try {
          executable = absolute(realpath(binary));
          if (!inside(folder, executable)) {
            reject('Claude binary resolves outside the extension folder.');
            continue;
          }
          if (!stat(executable).isFile()) {
            reject('Claude binary is not a regular file.');
            continue;
          }
        } catch (error) {
          reject(`Cannot read Claude binary ${binary}: ${error.message}`);
          continue;
        }
        candidates.set(key(executable), { executable, root: root.canonicalPath, folder, version: entry.version, targetPlatform });
      } catch (error) {
        reject(`Cannot read extension folder: ${error.message}`);
      }
    }
    root.reason = matchingEntries ? 'Claude registry entries inspected.' : `No ${EXTENSION_ID} entries in extensions.json.`;
  }
  selection.candidates = [...candidates.values()].sort((a, b) => a.executable.localeCompare(b.executable));
  // OW-085 D1 forbids both version ranking and trying binaries to break an installation tie.
  if (selection.uncertainRoots.length) {
    return fail(`VS Code discovery has uncertain roots: ${selection.uncertainRoots.map(({ reason }) => reason).join('; ')}`);
  }
  if (selection.candidates.length !== 1) {
    return fail(`VS Code discovery requires exactly one candidate; found ${selection.candidates.length}.`);
  }
  const chosen = selection.candidates[0];
  Object.assign(selection, { root: chosen.root, folder: chosen.folder, version: chosen.version,
    reason: 'Exactly one registered, platform-matching candidate and no uncertain roots.' });
  return { executable: chosen.executable, selection };
}
