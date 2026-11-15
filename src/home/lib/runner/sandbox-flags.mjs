/**
 * Flags a delegated run needs to execute sandboxed commands with the required environment.
 *
 * codex-cli 0.149.0 on Windows runs sandboxed commands under a restricted token, and which token
 * it builds is `windows.sandbox` — `elevated` or `unelevated`. The unelevated form refuses
 * CreateProcess outright: every command the model tries comes back as
 * `Rejected("… rejected: blocked by policy")` before the process exists. That setting lives in the
 * operator's own config.toml, which `--ignore-user-config` deliberately drops, so on 2026-08-23
 * every codex-scout and codex-review run died without reading a single file while codex-build
 * kept working — not because writing is exempt, but because it is the one agent that does not pass
 * `--ignore-user-config` and so inherited the operator's key by luck. Four probes on the installed
 * CLI, differing by this flag alone, separate the two: with the key a run prints its command output
 * and exits 0, without it both read-only AND workspace-write are refused.
 *
 * Naming the flag here keeps the isolation intact — a run still ignores the operator's config —
 * and stops the package from depending on a line in a personal file it does not own.
 *
 * The value carries no quotes on purpose: unsafeForCmd() refuses any argument containing `"`,
 * because the whole command line goes through cmd.exe. Codex parses `elevated` as a bare TOML
 * literal, and rejects an unknown variant loudly, so the unquoted form is checked, not assumed.
 *
 * OW-089 D3 (2026-11-15): the elevated Windows sandbox rebuilt the command environment and
 * dropped spawn's PYTHONUTF8=1 (Python utf8_mode=0); the shell policy override reached it
 * (utf8_mode=1). Every platform gets this pair so readers and writers share the UTF-8 policy.
 * Single quotes preserve the TOML string without double quotes, percent signs or whitespace
 * that would be refused or rewritten by the cmd.exe transport.
 */
export const WINDOWS_SANDBOX = ['-c', 'windows.sandbox=elevated'];

export const UTF8_SHELL_POLICY = Object.freeze(['-c', "shell_environment_policy.set.PYTHONUTF8='1'"]);

/** Empty off Windows: no other platform has this setting, and passing it would be an error. */
export function platformSandboxArgs(platform = process.platform) {
  return platform === 'win32' ? [...WINDOWS_SANDBOX] : [];
}

/** Shared run policy: platform sandbox flags first, then the platform-independent UTF-8 pair. */
export function runSandboxArgs(platform = process.platform) {
  return [...platformSandboxArgs(platform), ...UTF8_SHELL_POLICY];
}
