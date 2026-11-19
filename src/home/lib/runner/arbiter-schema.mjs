/** Defines the OW-097 structured arbiter result chosen by the advise run named in `advice:`. */
import { PROBE_LIMITS, PROBE_TAG_PREFIX } from '../meta/arbiter-probe-receipts.mjs';
import { EVIDENCE_LOCATION } from './evidence-location.mjs';

export const ARBITER_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'recommendation', 'rejected', 'residual_gaps', 'strongest_counterargument',
    'pre_mortem', 'prior_advice_review', 'checks', 'probes',
  ],
  properties: {
    recommendation: {
      type: 'object',
      additionalProperties: false,
      required: ['option_ids', 'mix_rationale', 'text'],
      properties: {
        option_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
        mix_rationale: { type: 'string' },
        text: { type: 'string' },
      },
    },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['option_id', 'cost'],
        properties: { option_id: { type: 'string' }, cost: { type: 'string' } },
      },
    },
    residual_gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['option_id', 'gap'],
        properties: { option_id: { type: 'string' }, gap: { type: 'string' } },
      },
    },
    strongest_counterargument: { type: 'string' },
    pre_mortem: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scenario', 'early_check'],
        properties: { scenario: { type: 'string' }, early_check: { type: 'string' } },
      },
    },
    prior_advice_review: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['run', 'stance', 'note'],
        properties: {
          run: { type: 'string' },
          stance: { type: 'string', enum: ['agrees', 'disagrees', 'partial'] },
          note: { type: 'string' },
        },
      },
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'verified', 'evidence'],
        properties: {
          claim: { type: 'string' },
          verified: { type: 'boolean' },
          evidence: { type: 'array', items: EVIDENCE_LOCATION },
        },
      },
    },
    // OW-097 D3 uses a tag because the exact command comes from the runner's event.
    probes: {
      type: 'array',
      maxItems: PROBE_LIMITS.maxProbes,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['probe_tag', 'purpose', 'finding'],
        properties: {
          probe_tag: { type: 'string', pattern: `^${PROBE_TAG_PREFIX}[0-9a-f]{16}$` },
          purpose: { type: 'string' },
          finding: { type: 'string' },
        },
      },
    },
  },
};
