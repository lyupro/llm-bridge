/** Prints detailed package guidance from the installed brand home. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';
import { renderGuidance } from './guidance-render.mjs';

const topicList = (topics) => [
  'Topics:',
  ...Object.entries(topics).map(([topic, summary]) => `  ${topic} — ${summary}`),
  '',
  'Usage: llm-bridge guidance [<topic>]',
].join('\n');

function validTopics(topics) {
  if (topics === null || typeof topics !== 'object') return false;
  const prototype = Object.getPrototypeOf(topics);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(topics).every((topic) => {
    if (typeof topic !== 'string' || !/^[a-z][a-z-]*$/.test(topic) || topic === 'all') return false;
    const { enumerable, value } = Object.getOwnPropertyDescriptor(topics, topic);
    return enumerable && typeof value === 'string' && value.trim().length > 0;
  });
}

export async function guidance(argv, { env = process.env, homedir } = {}) {
  // On 2026-11-20, package 0.8.2 refused arbiter from a home installed from the clone.
  // Read the registry alongside the installed guidance so the two agree.
  const { root, configPath } = resolveBrandHome({ homedir, env });
  const registryPath = path.join(root, 'lib', 'guidance-topics.mjs');
  let topics;
  try {
    ({ GUIDANCE_TOPICS: topics } = await import(pathToFileURL(registryPath).href));
    if (!validTopics(topics)) throw new Error('Invalid GUIDANCE_TOPICS export');
  } catch (error) {
    return {
      exitCode: 1,
      output: `Cannot load guidance registry ${registryPath}: ${error?.message ?? String(error)}\nrun llm-bridge update`,
    };
  }

  if (argv.length === 0) return { exitCode: 0, output: topicList(topics) };
  if (argv.length > 1) {
    return { exitCode: 2, output: `llm-bridge guidance accepts at most one topic.\n${topicList(topics)}` };
  }
  const [topic] = argv;
  if (!Object.hasOwn(topics, topic)) {
    return { exitCode: 2, output: `Unknown guidance topic "${topic}".\n${topicList(topics)}` };
  }

  // The 2026-08-26 seeded-config incident forbids reading installed files from the clone.
  const file = path.join(root, 'guidance', `${topic}.md`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      exitCode: 1,
      output: `Cannot read guidance file ${file}: ${error.message}\nrun llm-bridge update`,
    };
  }
  return renderGuidance(text, { root, topic, configPath, topics }).then(
    (output) => ({ exitCode: 0, output }),
    (error) => ({
      exitCode: 1,
      output: error.hostConfig === true ? error.message : `${error.message}\nrun llm-bridge update`,
    }),
  );
}
