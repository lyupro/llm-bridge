/** Parses the OW-097 arbitration brief chosen by the advise run named in `advice:`. */
import path from 'node:path';
import { orderRuleMessage } from '../order-rules.mjs';

const SECTION_NAMES = ['Question', 'Options', 'Trigger', 'Position', 'Prior runs', 'Paths'];
const OPTION_ID = '[a-z0-9][a-z0-9-]*';
const OPTION = new RegExp(`^\\s*-\\s+(${OPTION_ID}):\\s*(.*)$`);
const POSITION = new RegExp(`^(${OPTION_ID}):\\s*(\\S.*)$`);
const LIST_MARKER = /^\s*[-*+](?:\s|$)/;
const LIST_ITEM = /^\s*-\s+(\S.*)$/;

export function isArbiterRunName(name) {
  return typeof name === 'string' && name.trim() !== '' && name !== '.' && name !== '..'
    && !/[/\\:\0\r\n]/.test(name) && !(process.platform === 'win32' && /[ .]$/.test(name));
}

function readSections(text) {
  const sections = new Map(SECTION_NAMES.map((name) => [name.toLowerCase(), { name, header: null, lines: [] }]));
  let current = null;
  for (const [index, value] of text.split(/\r\n|\n|\r/).entries()) {
    const line = { number: index + 1, value };
    const heading = value.match(/^\s{0,3}(#{1,2})\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1] === '##' ? sections.get(heading[2].replace(/\s+#+$/, '').toLowerCase()) : null;
      if (current) current.header ??= line;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return [...sections.values()];
}

function repositoryRelative(value) {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return !/^[a-z]:/i.test(value) && !value.includes('\0')
    && !normalized.startsWith('/') && normalized !== '..' && !normalized.startsWith('../');
}

function inspectTask(text) {
  if (typeof text !== 'string') throw new TypeError('Arbiter task text must be a string.');
  const [question, options, trigger, position, priorRuns, paths] = readSections(text);
  const start = { number: 1, value: text.split(/\r\n|\n|\r/, 1)[0] };
  const refuse = (section, violation, where = section.header ?? start) => ({
    refusal: orderRuleMessage('arbiter-task-shape', {
      section: section.name, violation, lineNo: where.number, line: where.value,
    }),
  });

  if (!question.header) return refuse(question, 'missing');
  const questionText = question.lines.map(({ value }) => value).join('\n').trim();
  if (!questionText) return refuse(question, 'empty-question');

  if (!options.header) return refuse(options, 'missing');
  const choices = new Map();
  for (const line of options.lines) {
    if (!LIST_MARKER.test(line.value)) continue;
    const match = line.value.match(OPTION);
    if (!match) return refuse(options, 'option-shape', line);
    const [, id, description] = match;
    if (choices.has(id)) return refuse(options, 'duplicate-option', line);
    choices.set(id, { id, description: description.trim() });
  }
  if (choices.size < 2) return refuse(options, 'too-few-options');

  if (!trigger.header) return refuse(trigger, 'missing');
  const [triggerLine, extraTriggerLine] = trigger.lines.filter(({ value }) => value.trim());
  if (!triggerLine) return refuse(trigger, 'empty-trigger');
  const triggerValue = triggerLine.value.trim();
  if (triggerValue !== 'disagreement' && triggerValue !== 'irreversible') {
    return refuse(trigger, 'trigger-value', triggerLine);
  }
  if (extraTriggerLine) return refuse(trigger, 'multiple-trigger-lines', extraTriggerLine);

  if (!position.header) return refuse(position, 'missing');
  const positionIndex = position.lines.findIndex(({ value }) => value.trim());
  if (positionIndex === -1) return refuse(position, 'empty-position');
  const positionLine = position.lines[positionIndex];
  const match = positionLine.value.trim().match(POSITION);
  if (!match) return refuse(position, 'position-shape', positionLine);
  const [, option, firstRationaleLine] = match;
  if (!choices.has(option)) return refuse(position, 'unknown-position-option', positionLine);
  const rationale = [firstRationaleLine, ...position.lines.slice(positionIndex + 1).map(({ value }) => value)]
    .join('\n').trimEnd();

  if (!priorRuns.header && triggerValue === 'disagreement') return refuse(priorRuns, 'missing');
  const names = [];
  const seen = new Set();
  for (const line of priorRuns.lines) {
    if (!line.value.trim()) continue;
    const item = line.value.trimEnd().match(LIST_ITEM);
    if (!item) return refuse(priorRuns, 'prior-run-item', line);
    const name = item[1];
    if (!isArbiterRunName(name)) return refuse(priorRuns, 'prior-run-name', line);
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    if (seen.has(key)) return refuse(priorRuns, 'duplicate-prior-run', line);
    seen.add(key);
    names.push(name);
  }
  if (triggerValue === 'disagreement' && !names.length) return refuse(priorRuns, 'empty-prior-runs');

  if (!paths.header) return refuse(paths, 'missing');
  const repoPaths = [];
  for (const line of paths.lines) {
    if (!LIST_MARKER.test(line.value)) continue;
    const item = line.value.trimEnd().match(LIST_ITEM);
    if (!item || !repositoryRelative(item[1])) return refuse(paths, 'path-item', line);
    repoPaths.push(item[1]);
  }
  if (!repoPaths.length) return refuse(paths, 'empty-paths');

  return { task: {
    question: questionText, options: [...choices.values()], trigger: triggerValue,
    position: { option, rationale }, priorRuns: names, paths: repoPaths,
  }, refusal: null };
}

export function parseArbiterTask(text) {
  const { task, refusal } = inspectTask(text);
  if (refusal) throw new Error(refusal);
  return task;
}

export function arbiterTaskRefusal(text) {
  return inspectTask(text).refusal;
}
