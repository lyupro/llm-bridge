/** Guards the case ids shared by the OW-092 D2 troubleshooting entry points. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TROUBLESHOOTING_CASES } from '../src/home/lib/troubleshooting-cases.mjs';

const guidancePath = 'src/home/guidance/troubleshooting.md';
const guidanceUrl = new URL(`../${guidancePath}`, import.meta.url);
const readmeUrl = new URL('../README.md', import.meta.url);
const ids = TROUBLESHOOTING_CASES.map(({ id }) => id);

function caseSections() {
  const guide = fs.readFileSync(guidanceUrl, 'utf8').replaceAll('\r\n', '\n');
  return guide.split(/^## /m).slice(1).map((section) => {
    const [heading, ...lines] = section.split('\n');
    const [id] = heading.split(' — ', 1);
    return { id, heading, body: lines.join('\n') };
  }).filter(({ heading }) => heading.startsWith('T'));
}

test('the registry has frozen cases with unique ids in the required format', () => {
  assert.ok(Object.isFrozen(TROUBLESHOOTING_CASES));
  for (const entry of TROUBLESHOOTING_CASES) {
    assert.ok(Object.isFrozen(entry));
    assert.match(entry.id, /^T\d{2}$/);
  }
  assert.equal(new Set(ids).size, ids.length, 'registry ids must be unique');
});

test('every registered case has exactly one section with its registry title', () => {
  const sections = caseSections();
  for (const { id, title } of TROUBLESHOOTING_CASES) {
    const headings = sections.filter((section) => section.id === id).map(({ heading }) => heading);
    assert.deepEqual(headings, [`${id} — ${title}`]);
  }
});

test('the guide contains only registered case ids', () => {
  for (const { id } of caseSections()) {
    assert.ok(ids.includes(id), `unregistered troubleshooting case: ${id}`);
  }
});

test('each troubleshooting case has four non-empty parts in order', () => {
  for (const { id, body } of caseSections()) {
    const labels = [...body.matchAll(/^\*\*(Symptom|Check|Cause|Repair)\*\*[ \t]*$/gm)];
    assert.deepEqual(labels.map((label) => label[1]), ['Symptom', 'Check', 'Cause', 'Repair'], id);
    for (const [index, label] of labels.entries()) {
      const content = body.slice(label.index + label[0].length, labels[index + 1]?.index);
      assert.ok(content.trim(), `${id} has an empty ${label[1]} part`);
    }
  }
});

test('the README links to the existing guide from Troubleshooting after Limitations', () => {
  const readme = fs.readFileSync(readmeUrl, 'utf8').replaceAll('\r\n', '\n');
  const sections = readme.split(/^## /m);
  const limitations = sections.findIndex((section) => section.startsWith('Limitations\n'));
  assert.ok(limitations !== -1, 'the README must have a Limitations section');
  const section = sections[limitations + 1] ?? '';
  assert.match(section, /^Troubleshooting\n/, 'Troubleshooting must immediately follow Limitations');
  assert.ok(section.includes('`llm-bridge guidance troubleshooting`'));
  const links = [...section.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)].map((match) => match[1]);
  assert.ok(links.includes(guidancePath), 'Troubleshooting must link to the guide');
  assert.ok(fs.statSync(guidanceUrl).isFile());
});

test('the README contains no case headings', () => {
  const readme = fs.readFileSync(readmeUrl, 'utf8');
  assert.doesNotMatch(readme, /^##[ \t]+T\d/m);
});
