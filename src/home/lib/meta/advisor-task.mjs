/** Parses blind advisor task choices and guards their input boundary under Plan_59 D5 and OW-097. */
import { orderRuleMessage } from '../order-rules.mjs';
import { orderDiagnosticMessage } from '../order-diagnostics.mjs';

const OPTION = /^\s*-\s+([a-z0-9][a-z0-9-]*):\s*(.*)$/;
const PREFERENCE = /recommend|prefer|рекоменд|предпочт|\(✓\)|★/iu;
const ARBITER_HEADING = /^(trigger|position|prior[ \t]+runs)$/i;

function arbiterHeading(value, next) {
  const atx = value.match(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*$/);
  const name = atx ? atx[1].replace(/[ \t]+#+$/, '') : value.trim();
  if (ARBITER_HEADING.test(name) && (atx || /^ {0,3}(?:=+|-+)[ \t]*$/.test(next))) return name;
  return null;
}

function sections(text) {
  if (typeof text !== 'string') throw new TypeError(orderDiagnosticMessage('advisor-task-text-required'));
  const found = { options: { header: null, lines: [] }, paths: { header: null, lines: [] } };
  const lines = text.split(/\r\n|\n|\r/);
  let arbiter = null;
  let current = null;
  for (const [index, value] of lines.entries()) {
    const line = { number: index + 1, value };
    if (!arbiter) {
      const name = arbiterHeading(value, lines[index + 1]);
      if (name) arbiter = { name, ...line };
    }
    const heading = value.match(/^\s{0,3}(#{1,2})\s+(.+?)\s*$/);
    if (heading) {
      const name = heading[2].replace(/\s+#+$/, '').toLowerCase();
      current = heading[1] === '##' && Object.hasOwn(found, name) ? found[name] : null;
      if (current && !current.header) current.header = line;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return { ...found, arbiter };
}

function optionsFrom(lines) {
  return lines.flatMap(({ value }) => {
    const match = value.match(OPTION);
    return match ? [{ id: match[1], description: match[2].trim() }] : [];
  });
}

function pathsFrom(lines) {
  return lines.flatMap(({ value }) => {
    const match = value.match(/^\s*-\s+(.+?)\s*$/);
    return match && match[1].trim() ? [match[1].trim()] : [];
  });
}

export function parseAdvisorTask(text) {
  const { options, paths } = sections(text);
  return { options: optionsFrom(options.lines), paths: pathsFrom(paths.lines) };
}

export function advisorTaskRefusal(text) {
  const { options, paths, arbiter } = sections(text);
  if (arbiter) return orderRuleMessage('advisor-task-arbiter-input', {
    heading: arbiter.name, lineNo: arbiter.number, line: arbiter.value,
  });
  if (!options.header) return orderRuleMessage('advisor-task-options', { violation: 'missing' });
  const ids = new Set();
  for (const line of options.lines) {
    const preference = line.value.match(PREFERENCE);
    if (preference) {
      return orderRuleMessage('advisor-task-options', {
        violation: 'preference', lineNo: line.number, line: line.value, preference: preference[0],
      });
    }
    if (!/^\s*[-*+](?:\s|$)/.test(line.value)) continue;
    const match = line.value.match(OPTION);
    if (!match) {
      return orderRuleMessage('advisor-task-options', {
        violation: 'option-shape', lineNo: line.number, line: line.value,
      });
    }
    if (ids.has(match[1])) return orderRuleMessage('advisor-task-options', {
      violation: 'duplicate', lineNo: line.number, line: line.value, optionId: match[1],
    });
    ids.add(match[1]);
  }
  if (ids.size < 2) return orderRuleMessage('advisor-task-options', {
    violation: 'too-few', lineNo: options.header.number, line: options.header.value,
  });
  if (!paths.header) return orderRuleMessage('advisor-task-paths', { violation: 'missing' });
  if (!pathsFrom(paths.lines).length) {
    return orderRuleMessage('advisor-task-paths', {
      violation: 'empty', lineNo: paths.header.number, line: paths.header.value,
    });
  }
  return null;
}
