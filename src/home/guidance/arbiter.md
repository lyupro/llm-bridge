# arbiter

Use `codex-arbiter` for a single read-only third opinion on one design fork. Call it when the
advisor and the orchestrator chose different options and the operator is unsure, or when the
decision is irreversible or expensive. Arbitration runs under its own order, outside the advisor
chain.

## Task file

The lowercase header requires `order id:`. Optional labels are `repository:`, `slug:`, and
`effort:`. Use `retry:` or `resume:` only to repeat a failed pass under the same order id. A retry
starts a fresh thread, while a resume continues the failed pass's own thread. Omit `continue:`
and `phase:`. Give a new arbitration of the same question a new order id.

After a blank line, use these exact headings.

- `## Question` holds the design question.
- `## Options` lists at least two `- option-id: description` items with distinct ids matching
  `[a-z0-9][a-z0-9-]*`.
- `## Trigger` contains exactly one line, either `disagreement` or `irreversible`. Use
  `irreversible` for an irreversible or expensive decision.
- `## Position` gives the orchestrator's choice as `option-id: rationale` on the first non-empty
  line, naming an id from `## Options`.
- `## Paths` lists at least one repository-relative path inside the repository, one per `- path`
  item.
- `## Prior runs` is required for `disagreement`. List at least one completed `OK` `codex-advisor`
  `advise` run from this project with an intact result. Use one `- run-folder` item per bare
  folder name, with no path separators or drive prefix, and list each run at most once. At least
  one must recommend a different option from `## Position`.

The orchestrator's position and earlier advice are inputs to the arbiter. `codex-advisor` stays
blind to them and refuses arbitration orders that carry `## Trigger`, `## Position`, or
`## Prior runs`.

## Report and export

The arbiter gives one recommendation or a reasoned mix, the rejected options and their costs,
the residual gap of every option, the strongest counterargument, a pre-mortem, and probe
receipts. The runner publishes `report.md` in the run folder before the verdict and records its
SHA-256 in `meta.json#report_sha256`.

Use `llm-bridge report export <run> <path>` to copy the report into the repository after the
hash is checked. If the report was edited after the verdict, export is refused and redelivery
of its `OK` verdict returns `FAIL`.

## Model

The operator sets the role's model with `llm-bridge model set arbiter <model> <effort>`. Without
an arbiter model configured, the run uses Codex's default model.
