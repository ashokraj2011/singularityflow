import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySkillAmendmentSelectiveReopen, decideStorySkillVersion,
  nextPhaseAfterSkillAmendment, storySkillVersionStatus
} from '../src/state.mjs';
import { canonicalJson } from '../src/records.mjs';
import { phaseNeedsGeneration } from '../src/sequence.mjs';

function phase(id, status, receipt) {
  return {
    id, status, generation: 1,
    submittedAt: '2026-09-26T00:00:00.000Z',
    approvedAt: status === 'approved' ? '2026-09-26T00:01:00.000Z' : null,
    approvedBy: status === 'approved' ? 'reviewer@example.invalid' : null,
    approvals: status === 'approved' ? [{ decision: 'approved', actor: {
      email: 'reviewer@example.invalid'
    }, receipt }] : [],
    artifacts: [{ path: `${id}.md`, sha256: receipt }],
    generationPublications: [{ generation: 1, receipt }]
  };
}

function workflow() {
  return {
    workItem: { id: 'SKP-SELECTIVE-1' },
    workflowSnapshot: { revision: 2 },
    resolution: { phases: [] },
    status: 'complete', currentPhase: null,
    phaseOrder: ['a', 'b', 'c', 'd'],
    phases: {
      a: phase('a', 'approved', 'a-receipt'),
      b: phase('b', 'approved', 'b-receipt'),
      c: phase('c', 'approved', 'c-receipt'),
      d: phase('d', 'approved', 'd-receipt')
    },
    skillVersionAmendments: [{
      id: 'SAM-001', status: 'approved', skillId: 'example-skill',
      affectedPhaseIds: ['a', 'c'], preservedPhaseIds: ['b', 'd']
    }]
  };
}

test('adoption reopens only dependent phases and keeps unrelated approvals and receipts byte-identical', () => {
  const subject = workflow();
  const preserved = Object.fromEntries(['b', 'd'].map((id) =>
    [id, canonicalJson(subject.phases[id])]));
  const at = '2026-09-26T01:00:00.000Z';
  const selected = applySkillAmendmentSelectiveReopen(subject,
    subject.skillVersionAmendments[0], at);
  assert.equal(selected, 'a');
  assert.equal(subject.currentPhase, 'a');
  assert.equal(subject.status, 'in_progress');
  assert.equal(subject.phases.a.status, 'in_progress');
  assert.equal(subject.phases.c.status, 'not_started');
  assert.equal(subject.phases.a.approvals[0].invalidatedAt, at);
  assert.equal(subject.phases.c.approvals[0].invalidatedAt, at);
  assert.equal(phaseNeedsGeneration(subject, subject.phases.a), true,
    'a previously published affected generation must not be resubmitted');
  assert.equal(phaseNeedsGeneration(subject, subject.phases.c), true);
  subject.phases.a.generation += 1;
  assert.equal(phaseNeedsGeneration(subject, subject.phases.a), false,
    'a newly published generation satisfies the amendment freshness gate');
  subject.phases.a.generation -= 1;
  for (const id of ['b', 'd']) {
    assert.equal(canonicalJson(subject.phases[id]), preserved[id]);
    assert.equal(subject.phases[id].approvals[0].invalidatedAt, undefined);
  }
  assert.equal(nextPhaseAfterSkillAmendment(subject, subject.phases.a).id, 'c');
  assert.equal(nextPhaseAfterSkillAmendment(subject, subject.phases.c), null);
});

test('active preserved downstream phase refuses selective reopen without mutating anything', () => {
  const subject = workflow();
  subject.phases.d.status = 'in_progress';
  subject.phases.d.approvedAt = null;
  subject.phases.d.approvedBy = null;
  const before = canonicalJson(subject);
  assert.throws(() => applySkillAmendmentSelectiveReopen(subject,
    subject.skillVersionAmendments[0], '2026-09-26T01:00:00.000Z'), {
    code: 'SKP_AMENDMENT_ACTIVE_PRESERVED_PHASE'
  });
  assert.equal(canonicalJson(subject), before);
});

test('an affected phase with no publication mechanism refuses selective adoption', () => {
  const subject = workflow();
  subject.phases.c.generationPolicy = { requirement: 'none' };
  const before = canonicalJson(subject);
  assert.throws(() => applySkillAmendmentSelectiveReopen(subject,
    subject.skillVersionAmendments[0], '2026-09-26T01:00:00.000Z'), {
    code: 'SKP_AMENDMENT_DEPENDENCY_UNPROVEN'
  });
  assert.equal(canonicalJson(subject), before);
});

test('active predecessor refuses adoption of a later skill before its turn', () => {
  const subject = workflow();
  subject.phases.a.status = 'in_progress';
  const amendment = { id: 'SAM-002', affectedPhaseIds: ['c'],
    preservedPhaseIds: ['a', 'b', 'd'] };
  const before = canonicalJson(subject);
  assert.throws(() => applySkillAmendmentSelectiveReopen(subject, amendment,
    '2026-09-26T01:00:00.000Z'), { code: 'SKP_AMENDMENT_SEQUENCE_UNSAFE' });
  assert.equal(canonicalJson(subject), before);
});

test('status exposes the pin and review state without adopting it', () => {
  const subject = workflow();
  subject.resolution.phases = [{ kind: 'skill', skillBinding: {
    bindingRefs: { skill: { id: 'example-skill', packageSha256: 'sha256:'.concat('a'.repeat(64)) } }
  } }];
  const before = canonicalJson(subject);
  const status = storySkillVersionStatus(subject);
  assert.equal(status.snapshotRevision, 2);
  assert.deepEqual(status.selectedPackages, [{ skillId: 'example-skill',
    packageSha256: 'sha256:'.concat('a'.repeat(64)) }]);
  assert.equal(status.proposals[0].id, 'SAM-001');
  assert.equal(canonicalJson(subject), before);
});

test('caller-supplied reviewer authority is refused before any Git or Story mutation', async () => {
  const subject = workflow();
  const before = canonicalJson(subject);
  await assert.rejects(decideStorySkillVersion('/not-used', {}, subject, {
    actor: { email: 'impersonated@example.invalid' },
    proposalId: 'SAM-001', decision: 'approve',
    confirmPreviewDigest: 'sha256:'.concat('0'.repeat(64))
  }), { code: 'SKP_AMENDMENT_REVIEWER_INELIGIBLE' });
  assert.equal(canonicalJson(subject), before);
});
