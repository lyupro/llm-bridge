/** Defines the single-location schema fragment shared by advisor and arbiter results. */

// The 2026-09-24_094352_plan62-g1-dispatcher-gate run folded 3-5 citations into one advisor
// address; like the 2026-07-31 build changes[].file precedent, constrain a single location here.
export const EVIDENCE_LOCATION = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'line_start', 'line_end'],
  properties: {
    file: {
      type: 'string',
      minLength: 1,
      pattern: '^[^:;,*?{}\\r\\n]+$',
      description: 'Exactly one repository-root-relative path. Spaces are allowed; lists, globs, drive letters and line suffixes are not — use a separate location object for each place.',
    },
    line_start: { type: 'integer', minimum: 1 },
    line_end: { type: 'integer', minimum: 1 },
  },
};
