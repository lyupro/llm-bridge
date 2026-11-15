/**
 * OW-089 D3: observe the shell policy inside the sandbox, without repairing it in the witness.
 * On 2026-11-15 the elevated Windows sandbox dropped spawn's PYTHONUTF8=1 (utf8_mode=0),
 * while the shell policy reached Python (utf8_mode=1). A bridge-side Python check missed it.
 */
import { performance } from 'node:perf_hooks';
import { sandboxModeFor } from './codex-args.mjs';
import { codexSpawnSpec, spawnCaptured, unsafeForCmd } from './codex-cmd.mjs';
import { runSandboxArgs } from './sandbox-flags.mjs';

const MARKER = 'llm-bridge-sandbox-pythonutf8=';
const NO_PYTHON = 'llm-bridge-sandbox-no-python';
// Bare python failed with CreateProcessAsUserW error 2 in the measured sandbox. PowerShell
// resolves it there; the observation must neither set the variable nor force Python's mode.
const SCRIPT = `Write-Output ('${MARKER}' + $env:PYTHONUTF8); `
  + "if (Get-Command python -ErrorAction SilentlyContinue) { "
  + "python -c 'import sys; print(sys.flags.utf8_mode); print(sys.executable)' "
  + `} else { Write-Output '${NO_PYTHON}' }`;

export async function witnessSandboxUtf8({
  agent, repo, platform = process.platform, run = spawnCaptured, timeoutMs = 15_000,
}) {
  // Only Windows has live evidence for this defect; other platforms are not judged.
  if (platform !== 'win32') return { status: 'skipped' };
  const started = performance.now();
  const observation = { status: 'malformed', pythonutf8: null, utf8_mode: null,
    interpreter: null, ms: 0, stderrTail: '' };
  try {
    const args = ['sandbox', ...runSandboxArgs(platform), '-c', `sandbox_mode=${sandboxModeFor(agent)}`,
      '--', 'powershell.exe', '-NoProfile', '-Command', SCRIPT];
    if (unsafeForCmd(args)) return observation;
    const spec = codexSpawnSpec(args, platform);
    const result = await run(spec.command, spec.args, {
      ...spec.options, cwd: repo, encoding: 'utf8', timeout: timeoutMs,
    });
    observation.stderrTail = String(result.stderr ?? '').slice(-300);
    if (result.error || result.signal) {
      observation.status = result.error?.code === 'ETIMEDOUT' ? 'timeout' : 'malformed';
      return observation;
    }
    const lines = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const markers = lines.filter((line) => line.startsWith(MARKER));
    if (markers.length !== 1) return observation;
    observation.pythonutf8 = markers[0].slice(MARKER.length);
    const output = lines.slice(lines.indexOf(markers[0]) + 1);
    if (!output.length || output.includes(NO_PYTHON)) {
      observation.status = 'no-python';
      return observation;
    }
    if (output.length !== 2 || !/^-?\d+$/.test(output[0])) return observation;
    const utf8Flag = Number(output[0]);
    if (!Number.isSafeInteger(utf8Flag)) return observation;
    observation.utf8_mode = utf8Flag;
    observation.interpreter = output[1];
    observation.status = utf8Flag === 1 && observation.pythonutf8 === '1' ? 'observed' : 'mismatch';
  } catch (error) {
    observation.status = error?.code === 'ETIMEDOUT' ? 'timeout' : 'malformed';
    observation.stderrTail = String(error?.stderr ?? '').slice(-300);
  } finally {
    observation.ms = Math.round(performance.now() - started);
  }
  return observation;
}
