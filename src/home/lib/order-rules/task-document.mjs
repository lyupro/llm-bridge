/** Owns task-body order rules under Plan_79 D4, including OW-097's arbitration brief and prior advice. */

// The rule catalog imports nothing from the runner (tests/order-registry-layout.test.mjs copies it alone).
// tests/runner/question-kind.test.mjs fails when this list drifts from the classifier's marker table.
const REGISTERED_MARKERS = '[context-only], [web-research]';

const ARBITER_TASK_DETAILS = {
  'empty-question': 'write a non-empty question.',
  'option-shape': 'use "- option-id: description" with id matching [a-z0-9][a-z0-9-]*.',
  'duplicate-option': 'replace the duplicate option id.',
  'too-few-options': 'provide at least two distinct options.',
  'empty-trigger': 'write one line with "disagreement" or "irreversible".',
  'trigger-value': 'use "disagreement" or "irreversible".',
  'multiple-trigger-lines': 'keep exactly one non-empty line.',
  'empty-position': 'write "option-id: rationale" as the first non-empty line.',
  'position-shape': 'use "option-id: rationale" with a non-empty rationale on the first line.',
  'unknown-position-option': 'name an option id from Options.',
  'prior-run-item': 'put each prior run on its own "- run-folder" line.',
  'prior-run-name': 'use a bare run-folder name with no drive prefix or path separators.',
  'duplicate-prior-run': 'list the same prior run only once.',
  'empty-prior-runs': 'list at least one prior run for disagreement.',
  'path-item': 'use "- repository-relative-path" and keep the path inside the repository.',
  'empty-paths': 'add at least one repository-relative path as a list item.',
};

const ARBITER_RUN_DETAILS = {
  'run-name': 'use a bare run-folder name with no drive prefix or path separators.',
  'run-missing': "the folder does not exist under this project's runs root.",
  'run-unreadable': 'the run folder could not be inspected.',
  'run-link': 'the run folder is a symbolic link or junction.',
  'run-not-directory': 'the run path is not a directory.',
  'meta-missing': 'meta.json is missing.',
  'meta-unreadable': 'meta.json could not be read.',
  'meta-invalid': 'meta.json must contain a valid JSON object.',
  'wrong-agent': 'meta.json must record agent "codex-advisor".',
  'wrong-phase': 'meta.json must record phase "advise".',
  'wrong-verdict': 'meta.json must record status "OK".',
  unfinished: 'meta.json must record a non-empty finished_at.',
  'result-missing': 'result.json is missing.',
  'result-unreadable': 'result.json could not be read.',
  'result-invalid': 'result.json must contain a valid JSON object.',
  'recommendation-shape': 'result.json must provide string recommendation.option_id and recommendation.text fields.',
  'rejected-shape': 'result.json must provide a rejected array with string option_id and cost fields in each entry.',
  'counterargument-shape': 'result.json must provide a string strongest_counterargument.',
};

export const RULES = Object.freeze({
  'resume-task-body': Object.freeze({
    data: Object.freeze(['heading']),
    topic: 'order',
    rule: 'Under a resume grant, write the task body as a plain note: the resumed run reuses the ' +
      'frozen questions, options, paths and verification of the named run and never reads this body, ' +
      'so Questions, Options, Paths and Verify headings are refused.',
    message: ({ heading }) => '`resume:` task body has a "' + heading.slice(0, 60) +
      '" section: a resumed run reuses the frozen inputs of the named run and never reads this body; ' +
      'remove the section and keep a plain note (to change the task, use retry: or a new order id); no quota was spent.',
  }),
  'scout-questions': Object.freeze({
    data: Object.freeze(['violation', 'line']),
    topic: 'order',
    rule: 'For codex-scout, include a non-empty Questions section in the task document. ' +
      'Whenever Questions is present, put each question on its own line as a Markdown list item ' +
      'using -, *, or a number followed by a dot.',
    message: ({ violation, line }) => {
      if (violation === 'non-list-line') {
        return `Questions section contains a non-list line: ${JSON.stringify(line.trim())}`;
      }
      if (violation === 'empty') return 'Questions section is empty';
      if (violation === 'missing') {
        return 'a sub-question is required for codex-scout: put one Markdown list item per sub-question ' +
          'under a `Questions` heading in the task document. ' +
          'The runner will not infer questions from the task text; no quota was spent.';
      }
      throw new Error(`unknown scout-questions violation: ${violation}`);
    },
  }),
  'question-kind-marker': Object.freeze({
    data: Object.freeze(['index', 'text', 'context']),
    topic: 'order',
    rule: `If a question uses a kind marker, use exactly one of ${REGISTERED_MARKERS} ` +
      'at the start, followed by whitespace (such as a space) and non-empty question text. ' +
      'An unregistered leading bracket token containing only letters, spaces, hyphens or underscores is refused.',
    message: ({ index, text, context, refusal }) => {
      if (context === 'task-input') {
        return `${refusal}; use exactly one registered marker at the start, followed by whitespace and non-empty question text; no quota was spent.`;
      }
      if (context !== undefined) throw new Error(`unknown question-kind-marker context: ${context}`);
      return `Q${index + 1} has an invalid question-kind marker (${REGISTERED_MARKERS}) in ${JSON.stringify(text)}`;
    },
  }),
  'verify-line': Object.freeze({
    data: Object.freeze(['violation']),
    topic: 'order',
    rule: 'When a Verify section is present, put exactly one non-empty command line in it; ' +
      'blank lines are ignored. The section runs until the next heading of the same or a higher level, ' +
      'so any non-empty line after the command, including a paragraph or a second command, counts as another line. ' +
      'Put ## Verify last or follow it with another heading.',
    message: ({ violation }) => {
      if (violation === 'empty') return 'Verify section is empty';
      if (violation === 'multiple-lines') return 'Verify section must contain exactly one non-empty line';
      throw new Error(`unknown verify-line violation: ${violation}`);
    },
  }),
  'advisor-task-options': Object.freeze({
    data: Object.freeze(['violation', 'lineNo', 'line', 'preference', 'optionId']),
    topic: 'order',
    rule: 'For an advisor task, write a ## Options section with at least two distinct options ' +
      'as - option-id: description, using ids matching [a-z0-9][a-z0-9-]*; ' +
      'remove preference markers from every line in that section (Plan_59 D5).',
    message: ({ violation, lineNo, line, preference, optionId }) => {
      if (violation === 'missing') return 'Options: add a "## Options" section with at least two options.';
      const location = `Options line ${lineNo} ${JSON.stringify(line)}`;
      if (violation === 'preference') {
        return `${location}: remove preference marker ${JSON.stringify(preference)} (D5).`;
      }
      if (violation === 'option-shape') {
        return `${location}: use "- option-id: description" with id matching [a-z0-9][a-z0-9-]*.`;
      }
      if (violation === 'duplicate') return `${location}: replace duplicate option id "${optionId}".`;
      if (violation === 'too-few') return `${location}: provide at least two distinct options.`;
      throw new Error(`unknown advisor-task-options violation: ${violation}`);
    },
  }),
  'advisor-task-paths': Object.freeze({
    data: Object.freeze(['violation', 'lineNo', 'line']),
    topic: 'order',
    rule: 'For an advisor task, write a ## Paths section with at least one repository-relative path as a list item.',
    message: ({ violation, lineNo, line }) => {
      if (violation === 'missing') return 'Paths: add a "## Paths" section with repository-relative paths.';
      if (violation === 'empty') {
        return `Paths line ${lineNo} ${JSON.stringify(line)}: add at least one repository-relative path as a list item.`;
      }
      throw new Error(`unknown advisor-task-paths violation: ${violation}`);
    },
  }),
  'advisor-task-arbiter-input': Object.freeze({
    data: Object.freeze(['heading', 'lineNo', 'line']),
    topic: 'order',
    rule: 'Send briefs with Trigger, Position or Prior runs headings to codex-arbiter so codex-advisor remains blind.',
    message: ({ heading, lineNo, line }) =>
      `${heading} line ${lineNo} ${JSON.stringify(line)}: this arbitration order belongs to codex-arbiter.`,
  }),
  'arbiter-task-shape': Object.freeze({
    data: Object.freeze(['section', 'violation', 'lineNo', 'line']),
    topic: 'order',
    rule: 'For codex-arbiter, write ## Question, ## Options (at least two distinct - option-id: description items ' +
      'with ids matching [a-z0-9][a-z0-9-]*), ## Trigger (one line with disagreement or irreversible), ' +
      '## Position (option-id: rationale), and ## Paths (repository-relative list items). ' +
      'For disagreement, include ## Prior runs with at least one bare run-folder name. ' +
      'List each prior run at most once.',
    message: ({ section, violation, lineNo, line }) => {
      const location = `${section} line ${lineNo} ${JSON.stringify(line)}`;
      if (violation === 'missing') return `${location}: add a "## ${section}" section.`;
      if (!Object.hasOwn(ARBITER_TASK_DETAILS, violation)) {
        throw new Error(`unknown arbiter-task-shape violation: ${violation}`);
      }
      return `${location}: ${ARBITER_TASK_DETAILS[violation]}`;
    },
  }),
  'arbiter-prior-run': Object.freeze({
    data: Object.freeze(['run', 'violation']),
    topic: 'order',
    rule: "Name completed, OK codex-advisor advise runs from this project's runs root with intact advice results. " +
      'For disagreement, at least one must recommend a different option from Position.',
    message: ({ run, violation }) => {
      if (violation === 'no-disagreement') {
        return `Prior runs ${JSON.stringify(run)}: for disagreement, at least one must recommend a different option from Position.`;
      }
      if (!Object.hasOwn(ARBITER_RUN_DETAILS, violation)) {
        throw new Error(`unknown arbiter-prior-run violation: ${violation}`);
      }
      return `Prior run ${JSON.stringify(run)}: ${ARBITER_RUN_DETAILS[violation]}`;
    },
  }),
});
