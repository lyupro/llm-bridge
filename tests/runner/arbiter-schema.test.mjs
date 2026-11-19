/** Guards the structured result contract for OW-097, chosen by the advise run named in `advice:`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARBITER_SCHEMA } from '../../src/home/lib/runner/arbiter-schema.mjs';
import { EVIDENCE_LOCATION } from '../../src/home/lib/runner/schemas.mjs';

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
  assert.deepEqual(properties.probes.items.properties, {
    command: { type: 'string' }, purpose: { type: 'string' }, finding: { type: 'string' },
  });
});
