import test from 'node:test';
import assert from 'node:assert/strict';
import {
  submissionReadinessSnapshot, submissionReadinessText
} from '../src/submission-readiness.mjs';

const RECORD_SHA = `sha256:${'a'.repeat(64)}`;

function workflow({
  phaseId = 'specification',
  status = 'in_progress',
  generation = 1,
  requirement = 'required',
  publication = generation > 0,
  publicationRecord = publication,
  rejectedAt = null,
  history = [],
  sequenceGates = { default: 'hard' }
} = {}) {
  const generationPublications = publication ? [{
    generation,
    record: publicationRecord ? {
      path: `singularity/work-items/READY-1/context/publications/${phaseId}-gen${generation}.json`,
      sha256: RECORD_SHA
    } : null
  }] : [];
  return {
    schemaVersion: 5,
    workItem: { id: 'READY-1' },
    status: 'active',
    currentPhase: phaseId,
    phaseOrder: [phaseId],
    phases: {
      [phaseId]: {
        id: phaseId,
        status,
        generation,
        generationPolicy: { requirement },
        generationPublications,
        ...(rejectedAt ? { rejectedAt } : {})
      }
    },
    history,
    resolution: { sequenceGates },
    // These are deliberately misleading. The compact projection must read the canonical phase,
    // not invent top-level fields or mistake the initial binding event for a phase publication.
    phaseStatus: 'not_started',
    publishedGeneration: 0,
    publicationProjections: [{
      event: { type: 'binding', phaseId, generation: 0 }
    }]
  };
}

function snapshot(source, options = {}) {
  return submissionReadinessSnapshot(source, {
    phaseId: source.currentPhase,
    pendingSynchronization: false,
    ...options
  });
}

test('a recorded current generation in progress is explicitly ready to submit', () => {
  const result = snapshot(workflow(), {
    draftEvidence: { draftExists: true, draftModified: true }
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.resultType, 'sflow-submission-readiness');
  assert.match(result.classification, /ready/i);
  assert.equal(result.workId, 'READY-1');
  assert.equal(result.phaseId, 'specification');
  assert.equal(result.phaseStatus, 'in_progress');
  assert.equal(result.currentGeneration, 1);
  assert.equal(result.publishedGeneration, 1);
  assert.equal(result.draftExists, true);
  assert.equal(result.draftModified, true);
  assert.equal(result.publicationRecorded, true);
  assert.equal(result.pendingSynchronization, false);
  assert.equal(result.lifecycleReady, true);
  assert.equal(result.validation, 'deferred-to-submit');
  assert.equal(result.command, 'singularity-flow submit specification --work-id READY-1');
  assert.equal(result.nextCommand, result.command);
  assert.equal(result.nextSkill, '/sf-submit');
  assert.match(result.reasonCode, /ready/i);
  assert.match(submissionReadinessText(result), /Published generation 1 — ready to submit/);
  assert.doesNotMatch(submissionReadinessText(result), /publish-ready/);
});

test('a generation number without its immutable publication record is not publication evidence', () => {
  const result = snapshot(workflow({ publicationRecord: false }));

  assert.equal(result.currentGeneration, 1);
  assert.equal(result.publishedGeneration, null);
  assert.equal(result.publicationRecorded, false);
  assert.equal(result.lifecycleReady, false);
  assert.equal(result.command, 'singularity-flow doctor --json');
  assert.match(result.reasonCode, /publication|generation/i);
});

test('malformed or ambiguous publication references fail closed', () => {
  const malformedPath = workflow();
  malformedPath.phases.specification.generationPublications[0].record.path = '../outside.json';
  assert.equal(snapshot(malformedPath).publicationRecorded, false);

  const malformedDigest = workflow();
  malformedDigest.phases.specification.generationPublications[0].record.sha256 = 'sha256:not-a-digest';
  assert.equal(snapshot(malformedDigest).publicationRecorded, false);

  const duplicate = workflow();
  duplicate.phases.specification.generationPublications.push(structuredClone(
    duplicate.phases.specification.generationPublications[0]
  ));
  assert.equal(snapshot(duplicate).publicationRecorded, false);
  assert.equal(snapshot(duplicate).lifecycleReady, false);
});

test('an ungenerated phase is not ready and never borrows generation zero from a binding event', () => {
  const result = snapshot(workflow({ generation: 0, publication: false }), {
    draftEvidence: { draftExists: true, draftModified: false }
  });

  assert.equal(result.currentGeneration, 0);
  assert.equal(result.publishedGeneration, null);
  assert.equal(result.publicationRecorded, false);
  assert.equal(result.draftExists, true);
  assert.equal(result.draftModified, false);
  assert.equal(result.lifecycleReady, false);
  assert.equal(result.command, 'singularity-flow prepare specification');
  assert.equal(result.nextCommand, result.command);
  assert.equal(result.nextSkill, '/sf-phase');
  assert.match(result.reasonCode, /generation/i);
  assert.match(submissionReadinessText(result), /Seeded draft — not published/);
  assert.match(submissionReadinessText(result), /Next in Copilot: \/sf-phase/);
  assert.match(submissionReadinessText(result), /Terminal equivalent: singularity-flow prepare specification/);
});

test('an edited generation-zero artifact remains a draft until publication is recorded', () => {
  const result = snapshot(workflow({ generation: 0, publication: false }), {
    draftEvidence: { draftExists: true, draftModified: true }
  });

  assert.equal(result.draftExists, true);
  assert.equal(result.draftModified, true);
  assert.equal(result.publicationRecorded, false);
  assert.equal(result.lifecycleReady, false);
  assert.match(submissionReadinessText(result), /Authored draft — not published/);
});

test('pending synchronization blocks submission even after publication', () => {
  const result = snapshot(workflow(), { pendingSynchronization: true });

  assert.equal(result.publicationRecorded, true);
  assert.equal(result.pendingSynchronization, true);
  assert.equal(result.lifecycleReady, false);
  assert.equal(result.command, 'singularity-flow sync');
  assert.equal(result.nextCommand, result.command);
  assert.equal(result.nextSkill, '/sf-next');
  assert.match(result.reasonCode, /sync|publication/i);
  assert.match(submissionReadinessText(result), /Published generation 1 — synchronization required/);
  assert.doesNotMatch(submissionReadinessText(result), /ready to submit/);
});

test('an awaiting-approval phase reports already submitted instead of recommending republish', () => {
  const result = snapshot(workflow({ status: 'awaiting_approval' }));

  assert.equal(result.publishedGeneration, 1);
  assert.equal(result.lifecycleReady, false);
  assert.equal(result.command, 'singularity-flow approve specification --work-id READY-1 --fetch');
  assert.equal(result.nextCommand, result.command);
  assert.equal(result.nextSkill, '/sf-approve');
  assert.match(result.classification, /submitted|approval|blocked/i);
  assert.match(result.reasonCode, /submitted|approval|status/i);
  assert.match(submissionReadinessText(result), /Published generation 1 — submitted for approval/);
});

test('a generation-zero phase is not advertised as ready when its commit gate is hard', () => {
  const result = snapshot(workflow({
    generation: 0,
    requirement: 'none',
    publication: false
  }));

  assert.equal(result.currentGeneration, 0);
  assert.equal(result.publishedGeneration, null);
  assert.equal(result.publicationRecorded, false);
  assert.equal(result.lifecycleReady, false);
  assert.equal(result.validation, 'deferred-to-submit');
  assert.equal(result.classification, 'generation-commit-required');
  assert.equal(result.command, 'singularity-flow doctor --json');
});

test('a soft generation-commit gate remains an explicit human-confirmed submit path', () => {
  const result = snapshot(workflow({
    generation: 0,
    requirement: 'none',
    publication: false,
    sequenceGates: { default: 'hard', generationCommit: 'soft' }
  }));

  assert.equal(result.lifecycleReady, true);
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.sequenceGate, 'generationCommit');
  assert.equal(result.classification, 'soft-sequence-confirmation-required');
  assert.equal(result.command, 'singularity-flow submit specification --work-id READY-1');
});

test('a soft freshness gate cannot hide a hard missing generation-commit gate', () => {
  const result = snapshot(workflow({
    generation: 0,
    publication: false,
    sequenceGates: { default: 'hard', freshGeneration: 'soft' }
  }));

  assert.equal(result.lifecycleReady, false);
  assert.equal(result.confirmationRequired, false);
  assert.equal(result.classification, 'generation-required');
  assert.equal(result.command, 'singularity-flow prepare specification');
});

test('an old publication does not satisfy a rejected phase that needs a successor generation', () => {
  const result = snapshot(workflow({
    rejectedAt: '2026-09-15T01:00:00.000Z',
    history: [{
      at: '2026-09-15T00:59:00.000Z',
      event: 'phase_generated',
      phase: 'specification'
    }]
  }));

  assert.equal(result.publicationRecorded, true);
  assert.equal(result.lifecycleReady, false);
  assert.equal(result.command, 'singularity-flow prepare specification');
  assert.match(result.reasonCode, /generation|rejected|correction/i);
});

test('a soft fresh-generation gate remains an explicit human-confirmed submit path', () => {
  const result = snapshot(workflow({
    rejectedAt: '2026-09-15T01:00:00.000Z',
    history: [{
      at: '2026-09-15T00:59:00.000Z',
      event: 'phase_generated',
      phase: 'specification'
    }],
    sequenceGates: { default: 'hard', freshGeneration: 'soft' }
  }));

  assert.equal(result.lifecycleReady, true);
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.sequenceGate, 'freshGeneration');
  assert.equal(result.classification, 'soft-sequence-confirmation-required');
  assert.equal(result.command, 'singularity-flow submit specification --work-id READY-1');
});

test('convergence readiness returns its guarded advance route rather than generic submit', () => {
  const source = workflow({ phaseId: 'convergence' });
  const result = snapshot(source);

  assert.equal(result.lifecycleReady, true);
  assert.equal(result.command, 'singularity-flow story advance --work-id READY-1');
  assert.equal(result.nextCommand, result.command);
  assert.equal(result.nextSkill, '/sf-submit');
  assert.match(submissionReadinessText(result), /ready for governed advancement/);
});

test('every phase kind routes an unpublished generation to its guarded authoring skill', () => {
  const cases = [
    ['intake', {}, '/sf-phase'],
    ['specification', {}, '/sf-phase'],
    ['planning', {}, '/sf-phase'],
    ['implementation', { task: 'code' }, '/sf-code'],
    ['verification', {}, '/sf-phase'],
    ['release', {}, '/sf-phase'],
    ['convergence', { producer: 'deterministic' }, '/sf-converge']
  ];

  for (const [phaseId, generationPolicy, expectedSkill] of cases) {
    const source = workflow({ phaseId, generation: 0, publication: false });
    Object.assign(source.phases[phaseId].generationPolicy, generationPolicy);
    const result = snapshot(source, {
      draftEvidence: { draftExists: true, draftModified: false }
    });
    assert.equal(result.lifecycleReady, false, phaseId);
    assert.equal(result.publicationRecorded, false, phaseId);
    assert.equal(result.nextCommand, `singularity-flow prepare ${phaseId}`, phaseId);
    assert.equal(result.nextSkill, expectedSkill, phaseId);
  }
});
