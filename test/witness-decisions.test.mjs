import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordWitness, WITNESS_CHECKLIST } from '../src/verification/witness-records.mjs';
import {
  phaseReadsWitnessDecisions, phaseWitnessDecisions, renderWitnessDecisions, storyWitnessDecisions,
  witnessDecisionCompositionRecord, witnessDecisionsFrom, withWitnessDecisionRefresh, WITNESS_DECISIONS_HEADING
} from '../src/verification/witness-decisions.mjs';

const SCREEN = 'singularity/work-items/bin-501/evidence/decimal-to-binary.png';
const CLAUSE = 'BIN-501:AC-001';
const SLOT = { slot: 'decimal-to-binary-screenshot', method: 'visual', witness: { target: 'converter screen' } };
const YES = Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, 'yes']));
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function story() {
  return {
    workItem: { id: 'BIN-501' }, currentPhase: 'release',
    phaseOrder: ['implementation', 'verification', 'release'],
    phases: {
      implementation: { id: 'implementation', requiredArtifact: { kind: 'implementation-summary' } },
      verification: { id: 'verification', requiredArtifact: { kind: 'visual-test-evidence' } },
      release: { id: 'release', requiredArtifact: { kind: 'conformance-report' } }
    }
  };
}

/** The incident's record, written by the same function `decision witness` uses. */
function witnessed(workflow, bytes, { answers = YES, reason = 'inspected the screenshot and it look fine', at = '2026-10-18T09:30:00.000Z' } = {}) {
  return recordWitness(workflow, {
    clauseId: CLAUSE, slot: SLOT, file: SCREEN, sha256: digest(bytes), answers, reason,
    actor: 'reviewer@example.invalid', authorityGroup: 'qa-approvers', at
  });
}

async function repository(t, bytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-witness-decisions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, path.dirname(SCREEN)), { recursive: true });
  await writeFile(path.join(root, SCREEN), bytes);
  return root;
}

test('the read helper returns the recorded witness decision with its bound file unchanged', async (t) => {
  const bytes = Buffer.from('png-bytes-as-captured');
  const root = await repository(t, bytes);
  const workflow = story();
  witnessed(workflow, bytes);
  const [decision, ...rest] = await storyWitnessDecisions(root, workflow);
  assert.equal(rest.length, 0);
  assert.deepEqual(decision, {
    id: 'WIT-001', clauseId: CLAUSE, slot: 'decimal-to-binary-screenshot', method: 'visual', target: 'converter screen',
    file: SCREEN, sha256: digest(bytes), decision: 'satisfies', reason: 'inspected the screenshot and it look fine',
    actor: 'reviewer@example.invalid', authorityGroup: 'qa-approvers', at: '2026-10-18T09:30:00.000Z',
    binding: 'bound-file-unchanged', candidate: 'unchanged', valid: true
  });
  assert.equal(Object.hasOwn(decision, 'expiresAt'), false, 'a witness record holds no expiry, so none is invented');
  assert.equal(Object.hasOwn(decision, 'identityAssurance'), false, 'an absent recorded field stays absent');
});

test('a changed or missing bound file makes the decision not valid', async (t) => {
  const bytes = Buffer.from('png-bytes-as-captured');
  const root = await repository(t, bytes);
  const workflow = story();
  witnessed(workflow, bytes);
  await writeFile(path.join(root, SCREEN), 'png-bytes-recaptured');
  const [changed] = await storyWitnessDecisions(root, workflow);
  assert.equal(changed.binding, 'bound-file-changed');
  assert.equal(changed.valid, false);
  assert.equal(changed.sha256, digest(bytes), 'the bound digest is the recorded one, not the current bytes');
  await unlink(path.join(root, SCREEN));
  const [missing] = await storyWitnessDecisions(root, workflow);
  assert.equal(missing.binding, 'bound-file-unreadable');
  assert.equal(missing.valid, false);
});

test('only the latest record of a slot is active, a failed one does not satisfy, and a changed candidate invalidates', () => {
  const bytes = Buffer.from('png');
  const workflow = story();
  witnessed(workflow, bytes);
  witnessed(workflow, bytes, { answers: { ...YES, 'matches-the-criterion': 'no' }, reason: 'the screenshot shows the old label', at: '2026-10-18T10:00:00.000Z' });
  const current = new Map([[SCREEN, digest(bytes)]]);
  const [latest, ...rest] = witnessDecisionsFrom(workflow, current);
  assert.equal(rest.length, 0, 'records are append-only; the newer one replaces the older one');
  assert.equal(latest.id, 'WIT-002');
  assert.equal(latest.decision, 'does-not-satisfy');
  assert.deepEqual(latest.answeredNo, ['matches-the-criterion']);
  assert.equal(latest.valid, false);
  // A new code candidate after the review: the evidence matrix no longer credits it, nor does this.
  const moved = story();
  witnessed(moved, bytes);
  moved.phases.implementation.deliveryEvidence = { sourceTreeSha256: `sha256:${'a'.repeat(64)}`, testInputSha256: null };
  moved.phases.implementation.generationCommit = 'b'.repeat(40);
  const [stale] = witnessDecisionsFrom(moved, current);
  assert.equal(stale.binding, 'bound-file-unchanged');
  assert.equal(stale.candidate, 'changed');
  assert.equal(stale.valid, false);
});

test('verification, conformance and visual-input steps read the reviews; an implementation step does not', () => {
  const workflow = story();
  assert.equal(phaseReadsWitnessDecisions(workflow, workflow.phases.release), true);
  assert.equal(phaseReadsWitnessDecisions(workflow, workflow.phases.verification), true);
  assert.equal(phaseReadsWitnessDecisions(workflow, workflow.phases.implementation), false);
  const review = { id: 'review', requiredArtifact: { kind: 'review-notes' } };
  workflow.phases.review = review;
  assert.equal(phaseReadsWitnessDecisions(workflow, review), false);
  workflow.resolution = { inputsMode: 'enforce', phases: [{ id: 'review', inputs: [{ phase: 'verification', projection: 'full' }] }] };
  assert.equal(phaseReadsWitnessDecisions(workflow, review), true, 'its approved inputs include visual evidence');
  workflow.resolution = { obligationGraph: { nodes: [{ id: 'review', responsibilities: ['verify'] }] } };
  assert.equal(phaseReadsWitnessDecisions(workflow, review), true, 'it holds the verify responsibility');
});

test('the block lists each review with its binding status, and is absent without a witness or for a non-reporting step', async (t) => {
  const bytes = Buffer.from('png-bytes-as-captured');
  const root = await repository(t, bytes);
  const workflow = story();
  assert.equal(await phaseWitnessDecisions(root, workflow, workflow.phases.release), null, 'no witness, no block');
  witnessed(workflow, bytes);
  assert.equal(await phaseWitnessDecisions(root, workflow, workflow.phases.implementation), null);
  const projection = await phaseWitnessDecisions(root, workflow, workflow.phases.release);
  assert.equal(projection.revision, 'recorded-visual-reviews-v1');
  assert.equal(projection.readOnly, true);
  assert.match(projection.projectionSha256, /^sha256:[a-f0-9]{64}$/u);
  const block = renderWitnessDecisions(projection);
  assert.ok(block.startsWith(`${WITNESS_DECISIONS_HEADING}\n`));
  assert.match(block, /do not say that criterion lacks human visual review or acceptance; cite its record ID/u);
  assert.ok(block.includes(`- WIT-001: visual of \`${SCREEN}\` (screen: "converter screen") for ${CLAUSE} slot \`decimal-to-binary-screenshot\` satisfies it.`));
  assert.ok(block.includes('Recorded by reviewer@example.invalid for qa-approvers at 2026-10-18T09:30:00.000Z.'));
  assert.ok(block.includes(`Bound to ${digest(bytes)}; bound file unchanged.`));
  assert.ok(block.includes('Reviewer note: "inspected the screenshot and it look fine"'));
  assert.doesNotMatch(block, /\bgoverned\b/iu);
  await writeFile(path.join(root, SCREEN), 'png-bytes-recaptured');
  const changed = renderWitnessDecisions(await phaseWitnessDecisions(root, workflow, workflow.phases.release));
  assert.ok(changed.includes(`Bound to ${digest(bytes)}; bound file changed since: not valid.`));
});

test('a reused prompt gets the current reviews beside it only when they differ from the composed ones', async (t) => {
  const bytes = Buffer.from('png-bytes-as-captured');
  const root = await repository(t, bytes);
  const workflow = story();
  witnessed(workflow, bytes);
  const projection = await phaseWitnessDecisions(root, workflow, workflow.phases.release);
  const composed = { promptBudget: { visualReviews: witnessDecisionCompositionRecord(projection) } };
  assert.deepEqual(composed.promptBudget.visualReviews, { projectionSha256: projection.projectionSha256, reviews: 1, valid: 1 });
  assert.equal(withWitnessDecisionRefresh('# Prompt\n', composed, projection), '# Prompt\n');
  assert.equal(withWitnessDecisionRefresh('# Prompt\n', { promptBudget: {} }, null), '# Prompt\n');
  const refreshed = withWitnessDecisionRefresh('# Prompt\n', { promptBudget: {} }, projection);
  assert.ok(refreshed.startsWith('# Prompt\n\n# Current recorded visual reviews refresh\n'));
  assert.ok(refreshed.includes(`${WITNESS_DECISIONS_HEADING}\n`));
  assert.ok(refreshed.includes('- WIT-001: visual of'));
});
