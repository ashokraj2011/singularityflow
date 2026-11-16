/**
 * SPEC-OSA v1.1 Stage 1 shadow comparison (scripts/osa-shadow.mjs): the kernel's decision against the surfaces that
 * still decide on their own, on the same captured Story records, executing nothing [plan section 3].
 *
 * The migrated cohort (the edit permission the guard and the entry share, and the entry's classification) shows no
 * difference. Every remaining difference belongs to a surface Stage 3 moves, is one of the classes below with its
 * owner, and its count may only fall: a new class or a rise is a new competing decision [OSA:AC-020, section 13].
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { shadowDifferences } from '../scripts/osa-shadow.mjs';

/** The declared differences, by surface and class: the most each may show, its owner and why it is not a fault here. */
const DECLARED = {
  'sequence sequence-ignores-amendment-pause': { max: 312, owner: 'Stage 3 (b16 sequenceGuidance)', why: 'sequence reads no amendment pause; the permission and entry send the person to the decisions card' },
  'sequence sequence-writes-a-damaged-step': { max: 48, owner: 'Stage 3 (b16)', why: 'sequence routes damage to begin or prepare; the permission and entry recover it' },
  'sequence submit-led-by-readiness': { max: 20, owner: 'Stage 3 (b15, b16)', why: 'the permission leads with the readiness read, which names the exact submission; sequence names submit directly' }
};

test('the shadow comparison: the cohort agrees with the kernel; the rest differs only as declared, and no more [plan section 3]', async () => {
  const { records, differences } = await shadowDifferences();
  assert.ok(records >= 600, `${records} captured records`);
  const cohort = differences.filter((entry) => entry.surface !== 'sequence');
  assert.deepEqual(cohort.slice(0, 3), [], `${cohort.length} differences in the migrated cohort`);
  const counts = {};
  for (const entry of differences) counts[`${entry.surface} ${entry.class}`] = (counts[`${entry.surface} ${entry.class}`] ?? 0) + 1;
  for (const [key, count] of Object.entries(counts)) {
    assert.ok(DECLARED[key], `undeclared difference ${key} (${count}), e.g. ${JSON.stringify(differences.find((entry) => `${entry.surface} ${entry.class}` === key))}`);
    assert.ok(count <= DECLARED[key].max, `${key}: ${count} > ${DECLARED[key].max}`);
  }
  for (const declared of Object.values(DECLARED)) assert.ok(declared.owner && declared.why);
});
