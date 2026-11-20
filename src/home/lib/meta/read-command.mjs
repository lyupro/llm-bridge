/** Spells the command a reply prints for reading a run's log. */
// OW-097 9a: its own module so arbiter-reply.mjs and reply.mjs share it without importing each other.
export const readCommand = (runDir) => `llm-bridge read ${runDir}`;
