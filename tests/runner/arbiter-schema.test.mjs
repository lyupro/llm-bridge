/** Guards the structured result contract for OW-097, chosen by the advise run named in `advice:`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProbeTag, PROBE_LIMITS, PROBE_TAG_PREFIX } from '../../src/home/lib/meta/arbiter-probe-receipts.mjs';
import { ARBITER_SCHEMA } from '../../src/home/lib/runner/arbiter-schema.mjs';
import { EVIDENCE_LOCATION } from '../../src/home/lib/runner/evidence-location.mjs';

function assertClosed(schema, field) {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, field);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), field);
    for (const [key, child] of Object.entries(schema.properties)) assertClosed(child, `${field}.${key}`);
  } else if (schema.type === 'array') {
    assertClosed(schema.items, `${field}[]`);
  }
}

test('the draft 2020-12 arbiter schema closes every object and requires every field', () => {
  assert.equal(ARBITER_SCHEMA.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(ARBITER_SCHEMA.type, 'object');
  assertClosed(ARBITER_SCHEMA, 'result');
});

test('the arbiter schema describes the expected fields and reuses the advisor location shape', () => {
  const properties = ARBITER_SCHEMA.properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    'checks', 'pre_mortem', 'prior_advice_review', 'probes', 'recommendation', 'rejected',
    'residual_gaps', 'strongest_counterargument',
  ]);
  assert.deepEqual(properties.recommendation.properties, {
    option_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
    mix_rationale: { type: 'string' },
    text: { type: 'string' },
  });
  assert.deepEqual(properties.strongest_counterargument, { type: 'string' });
  const { items, minItems, maxItems } = properties.pre_mortem;
  assert.equal(properties.pre_mortem.type, 'array');
  assert.equal(minItems, 1);
  assert.equal(maxItems, 5);
  assert.deepEqual(items.properties, { scenario: { type: 'string' }, early_check: { type: 'string' } });

  assert.deepEqual(properties.rejected.items.properties, { option_id: { type: 'string' }, cost: { type: 'string' } });
  assert.deepEqual(properties.residual_gaps.items.properties, { option_id: { type: 'string' }, gap: { type: 'string' } });
  assert.deepEqual(properties.prior_advice_review.items.properties, {
    run: { type: 'string' }, stance: { type: 'string', enum: ['agrees', 'disagrees', 'partial'] }, note: { type: 'string' },
  });
  assert.deepEqual(properties.checks.items.properties, {
    claim: { type: 'string' }, verified: { type: 'boolean' }, evidence: { type: 'array', items: EVIDENCE_LOCATION },
  });
  assert.equal(properties.checks.items.properties.evidence.items, EVIDENCE_LOCATION);
});

test('the schema allows zero probes up to the D3 cap and closes each item to its three string fields', () => {
  const { probes } = ARBITER_SCHEMA.properties;
  const { pattern } = probes.items.properties.probe_tag;
  assert.deepEqual(probes, {
    type: 'array',
    maxItems: PROBE_LIMITS.maxProbes,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['probe_tag', 'purpose', 'finding'],
      properties: { probe_tag: { type: 'string', pattern }, purpose: { type: 'string' }, finding: { type: 'string' } },
    },
  });
  assert.equal(Object.hasOwn(probes.items.properties, 'command'), false);
});

test('the schema pattern matches the D3 binder tag shape', () => {
  const { pattern } = ARBITER_SCHEMA.properties.probes.items.properties.probe_tag;
  assert.equal(typeof pattern, 'string');
  const tag = `${PROBE_TAG_PREFIX}0123456789abcdef`;
  const regex = new RegExp(pattern, 'u');
  for (const sample of [
    tag, tag.replace('012', 'abc'), tag.toLowerCase(), tag.toUpperCase(), tag.slice(PROBE_TAG_PREFIX.length),
    tag.slice(0, -1), `${tag}0`, `${tag}\n`, ` ${tag}`, `${tag.slice(0, -1)}g`,
  ]) {
    assert.equal(regex.test(sample), isProbeTag(sample), JSON.stringify(sample));
  }
});
