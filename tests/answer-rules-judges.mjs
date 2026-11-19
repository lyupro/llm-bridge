/** OW-068 / Plan_80 E21: one registry connects catalog agents to their reason producers and branch entries. */
import fs from 'node:fs';
import { ANSWER_RULES } from '../src/home/lib/answer-rules.mjs';

export const JUDGED_AGENTS = [
  {
    agent: 'codex-advisor',
    files: [{ file: 'advice-verdict.mjs' }],
    entries: ['adviceGap'],
    emitter: null,
  },
  {
    agent: 'codex-arbiter',
    files: [{ file: 'arbiter-verdict.mjs' }, { file: 'arbiter-status.mjs' }],
    entries: ['arbitrationGap'],
    emitter: null,
  },
  {
    agent: 'codex-scout',
    files: [
      { file: 'verdict.mjs', functionName: 'scoutCoverageGap' },
      { file: 'context-only.mjs', functionName: 'contextOnlyGap' },
      { file: 'execution-fact.mjs', functionName: 'scoutExecutionGap' },
      { file: 'web-research.mjs', functionName: 'webResearchGap' },
    ],
    entries: ['scoutExecutionGap', 'scoutCoverageGap', 'contextOnlyGap', 'webResearchGap'],
    emitter: 'scoutReason',
  },
  {
    agent: 'codex-build',
    files: [
      { file: 'history-during-run.mjs', functionNames: ['commitDuringRun', 'branchDuringRun'] },
      { file: 'verdict.mjs', functionNames: ['reportVersusWork'] },
      { file: 'outcome.mjs', functionNames: ['outcomeGap'] },
      { file: 'encoding-verdict.mjs', functionNames: ['encodingGap'] },
      { file: 'write-refusal-verdict.mjs', functionNames: ['writeRefusalGap'] },
    ],
    entries: ['commitDuringRun', 'branchDuringRun', 'outcomeGap', 'encodingGap', 'writeRefusalGap', 'reportVersusWork'],
    emitter: 'buildReason',
  },
].map((judge) => ({
  ...judge,
  catalogKeys: Object.keys(ANSWER_RULES[judge.agent]),
  files: judge.files.map((entry) => ({
    ...entry,
    source: fs.readFileSync(new URL(`../src/home/lib/meta/${entry.file}`, import.meta.url), 'utf8'),
  })),
}));

export const HOST_REASON_FUNCTIONS = Object.freeze({
  snapshotRefusal: 'snapshot comparison refusal is host evidence the model cannot satisfy (Plan_80 E21)',
});

export const HOST_REASON_SUFFIXES = Object.freeze({
  hooks: 'the hooks-enabled note appended to the build report reason is host configuration (Plan_80 E21)',
});
