# troubleshooting

Match the symptom, run the check to confirm the case, and repair it only after confirmation. Case ids are stable, and an `Action:` row may name one.

## T01 — Sandbox refuses to write a file inside scope

**Symptom**

A build ends `FAIL` and the work looks unfinished even though the executor tried to write the file. The run folder's `stderr.log` contains `Failed to write file <absolute path>` for a path inside the order's scope, and `events.jsonl` records a failed `file_change` for the same path.

**Check**

On Windows, inspect the folder holding the file with `icacls "<folder>"` and check its owner with `(Get-Acl -LiteralPath '<folder>').Owner`. This case is confirmed when `CodexSandboxOffline` owns the folder and the ACL lacks the sandbox write entry inherited from the repository root. Require both ACL findings. The write error has also appeared with an unidentified cause.

**Cause**

An earlier Codex run created the folder, so its sandbox account owns it. When Codex later added a new sandbox write identity at the repository root, inheritance could not rewrite the folder's permissions.

**Repair**

In PowerShell run as administrator, run `icacls "<folder>" /setowner <user> /T /C` and then `icacls "<folder>" /reset /T /C` for each affected folder. Without administrator rights, `/reset` fails with `Access is denied`. Re-run the same order afterward.

## T02 — Every run fails with `apply deny-read ACLs` after a crash

**Symptom**

Every run fails, and `codex sandbox -- cmd /c echo sandbox-ok` also fails with `windows sandbox failed: helper_unknown_error: apply deny-read ACLs`.

**Check**

In the Codex home's `.sandbox/sandbox.<date>.log`, look for `parse deny-read ACL state` naming `deny_read_acl_state.json` with `expected value at line 1 column 1`. The log entry and an empty state file together confirm this case. The Windows System log often records an unexpected shutdown (`Kernel-Power 41`) shortly before the failure.

**Cause**

An abrupt shutdown interrupted Codex while it rewrote the state file, leaving it empty. Every later sandbox setup fails while reading it.

**Repair**

With the operator's consent, rename `.sandbox/deny_read_acl_state.json` in the Codex home to preserve the original file. Run `codex sandbox -- cmd /c echo sandbox-ok` again so Codex recreates the file. Keep the current Codex installation.

## T03 — A Windows administrator prompt appears during a check or run

**Symptom**

Windows asks whether to allow a `codex-...-windows-...exe` to make changes while `llm-bridge doctor` or a run uses a fresh or temporary Codex home.

**Check**

Read the Codex sandbox log for that home. `sandbox setup required: sandbox setup marker missing or incompatible` confirms this case.

**Cause**

Codex performs a one-time elevated sandbox setup for each new Codex home.

**Repair**

Expect this prompt once per Codex home. Answering “No” is safe and leaves the sandbox unavailable in that home. Warn the operator before pointing a probe at an empty Codex home.

## T04 — An advise pass hits its deadline after going silent early

**Symptom**

A `codex-advisor` advise pass ends `FAIL` at its deadline.

**Check**

In the run folder's `events.jsonl`, compare the last event's timestamp with the start and the deadline. This case is confirmed when the last event occurred within the first few minutes of the pass and no events followed before the deadline.

**Cause**

Codex stalled early in the pass. In November 2026, all 17 measured advise deadline failures went silent within their first three minutes. None was still working at the deadline.

**Repair**

Repeat the same pass if the failed run's `Action:` row allows it. Keep the same deadline because the pass spent the remaining time stalled.
