# concurrency

Run readers in parallel while keeping every writing run exclusive to its working tree.

## Readers and writers

Read-only `codex-scout`, `codex-review` and both `codex-advisor` phases may run in parallel freely, including alongside a writing run.

Only one writing run may be active in a working tree. A second writing run in that tree is refused, even when the two orders name different files. Parallel writers require separate worktrees, each with its own working tree and write boundary.

The writing runner snapshots the tree before and after its run, then compares the actual changes with the reported files and order scope. Another writer's edits enter that same snapshot and appear to belong to this run. Disjoint file lists therefore do not isolate writers in one tree. Keep other file-changing operations out of a live writer's tree as well.

## Two sessions in one repository

Keep one writing session in a working tree from its first edit through its commit or rollback. Treat accepted uncommitted work as still occupying the tree after the run finishes: another writer's snapshot would absorb it.

Give a second window that needs to write its own worktree and branch with `git worktree add`. Keep its task files inside that worktree: the order's repository is the worktree that owns the task file. Account for each checkout's own installs, build output and stand ports as a project cost. Check the combined result when the branches come together: different files can still disagree.

Agree by messages who writes what when sessions stay in one tree. Do not treat silence as consent or a `liveRuns: 0` reading as permission to start: it is only a snapshot.

Do not commit during another session's live run in the same tree. A moved HEAD fails that run whoever moved it.

Treat a snapshot as evidence that a path changed, never of who changed it. Revert only your own edits; leave other changes alone and report them to the operator.

## Stop a live run

Use the run path from its receipt and call `llm-bridge stop <run>` before `TaskStop`. The bridge stop terminates the Codex run and records FAIL. `TaskStop` alone stops the dispatcher task while the Codex process can keep writing.

Inspect the resulting status and working-tree changes before launching another writer. Stopping a run does not undo the files it already changed.
