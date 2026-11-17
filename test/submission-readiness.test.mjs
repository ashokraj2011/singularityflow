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
  sequenceGates = { default: 'hard' },
  kind = phaseId === 'convergence' ? 'convergence-report' : null
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
        ...(kind ? { requiredArtifact: { kind } } : {}),
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

test('terminal readiness text shows the concrete obligations and remediation route', () => {
  const source = snapshot(workflow({ phaseId: 'release', status: 'awaiting_approval' }));
  const held = {
    ...source,
    lifecycleReady: false,
    classification: 'terminal-obligations-required',
    reason: 'Final Story readiness has 2 open obligations.',
    terminal: { blockers: ['AC-001 needs a generation-bound witness.', 'SRI-123 has no scope disposition.'] },
    nextCommand: 'singularity-flow decision scope --item SRI-123 --as <DISPOSITION> --reason "<why>"',
    nextSkill: '/sf-decide'
  };
  assert.match(submissionReadinessText(held), /Final Story readiness has 2 open obligations/);
  assert.match(submissionReadinessText(held), /Open obligation: AC-001 needs a generation-bound witness/);
  assert.match(submissionReadinessText(held), /Copilot: \/sf-decide/);
});

test('a pinned independent review routes real corrections to the author before Submit', () => {
  const source = workflow();
  source.resolution.sourceReview = {
    mode: 'enforce', phases: ['specification'], reviewerAgent: 'sflow-source-reviewer'
  };
  // Reviewed because the specification defines the scope, as its pinned obligation graph says.
  source.resolution.obligationGraph = { nodes: [{ id: 'specification', responsibilities: ['scope'] }] };
  const pending = snapshot(source, {
    sourceReviewEvidence: { status: 'correction-required',
      findings: [{ code: 'source-unmapped', message: 'A source request is not mapped.' }] }
  });
  assert.equal(pending.classification, 'source-review-required');
  assert.equal(pending.lifecycleReady, false);
  assert.equal(pending.publicationRecorded, true);
  // The review's corrections are a next version, which opens on the person's yes [D3, OSA:REQ-020, REQ-030].
  assert.equal(pending.nextSkill, '/sf-phase');
  assert.equal(pending.nextCommand, 'singularity-flow phase rollover specification --json');
  assert.equal(pending.reasonCode, 'SOURCE_REVIEW_CORRECTION_REQUIRED');
  assert.equal(pending.sourceReviewFindings[0].code, 'source-unmapped');
  assert.match(submissionReadinessText(pending), /Published generation 1 — not ready to submit/);

  const ready = snapshot(source, { sourceReviewEvidence: { status: 'ready', findings: [] } });
  assert.equal(ready.lifecycleReady, true);
  assert.equal(ready.nextSkill, '/sf-submit');
  assert.equal(snapshot(source).sourceReviewStatus, 'unverified');
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
  assert.match(submissionReadinessText(result), /Shell: singularity-flow prepare specification/);
  assert.match(submissionReadinessText(result), /Copilot: \/sf-phase/);
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
  // Its next version opens on the person's yes [D3, OSA:REQ-030].
  assert.equal(result.command, 'singularity-flow phase rollover specification --json');
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
  assert.match(submissionReadinessText(result), /ready for advancement/);
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
    assert.equal(result.nextCommand, generationPolicy.task === 'code'
      ? `singularity-flow phase begin ${phaseId} --json` : `singularity-flow prepare ${phaseId}`, phaseId);
    assert.equal(result.nextSkill, expectedSkill, phaseId);
  }
});

test('completed raw code at generation zero resumes its missing summary or authored draft, never submit', () => {
  for (const phaseId of ['implementation', 'team-custom-repair']) {
    const source = workflow({ phaseId, generation: 0, publication: false });
    const phase = source.phases[phaseId];
    phase.writeScope = 'source-and-artifact';
    phase.generationPolicy.task = 'code';
    phase.generationIntent = { status: 'open', generation: 1 };
    phase.requiredArtifact = { kind: 'implementation-summary', path: `artifacts/${phaseId}/implementation-summary.md` };
    // Raw code and passing local tests do not constitute an immutable publication.
    source.testResults = { passed: 33, failed: 0 };
    const missing = snapshot(source, { draftEvidence: { draftExists: false, draftModified: false } });
    assert.equal(missing.classification, 'generation-required');
    assert.equal(missing.lifecycleReady, false);
    assert.equal(missing.authoringProgress.stage, 'create-missing-draft');
    assert.match(missing.reason, /Keep existing application edits and tests/);
    assert.match(missing.reason, /Agent brief.*source\/test bindings/);
    const authored = snapshot(source, { draftEvidence: { draftExists: true, draftModified: true } });
    assert.equal(authored.nextCommand, `singularity-flow phase prepublish ${phaseId} --for-agent --json`);
    assert.equal(authored.nextSkill, '/sf-code');
    assert.equal(authored.lifecycleReady, false);
    assert.equal(authored.publicationRecorded, false);
    assert.equal(authored.authoringProgress.testsAttested, false);
  }
});

test('a required after-step delivery of an earlier step holds only the submission that ends the Story [PHR:REQ-003]', () => {
  const key = `sad_${'1'.repeat(40)}`;
  const hold = {
    missing: [{ key, phaseId: 'intake', generation: 1, action: 'audit', target: 'audit-log', here: 'failed' }],
    nextAction: `singularity-flow integrations retry ${key}`,
    reason: 'The next step waits: the required after-step action audit → audit-log (intake generation 1, approved) has no receipt in the Story.'
  };
  // A step a person approves is not held: its own work comes first, and the ending waits for the receipt.
  assert.equal(submissionReadinessSnapshot(workflow({ generation: 0, publication: false }), { stepActionHold: hold }).classification, 'generation-required');
  // The last step, which nobody approves, ends the Story when it is submitted: there the receipt comes first.
  const ending = (options) => {
    const source = workflow(options);
    source.phases[source.currentPhase].approvalPolicy = { mode: 'none' };
    return source;
  };
  const held = submissionReadinessSnapshot(ending({ generation: 0, publication: false }), { stepActionHold: hold });
  assert.deepEqual([held.classification, held.lifecycleReady, held.nextCommand, held.nextSkill, held.reasonCode],
    ['step-action-required', false, hold.nextAction, '/sf-integrations', 'STEP_ACTION_REQUIRED_UNRECORDED']);
  assert.deepEqual(held.stepActionHold, { reason: hold.reason, runnableHere: true, missing: hold.missing });
  const elsewhere = submissionReadinessSnapshot(ending({ generation: 0, publication: false }), { stepActionHold: { ...hold, nextAction: null } });
  assert.equal(elsewhere.nextCommand, 'singularity-flow integrations status --work-id READY-1 --all', 'when this machine cannot deliver it, the host can still look');
  assert.equal(elsewhere.stepActionHold.runnableHere, false);
  assert.equal(submissionReadinessSnapshot(ending({ status: 'awaiting_approval' }), { stepActionHold: hold }).classification, 'already-submitted', 'a step in review is not held');
  assert.equal(submissionReadinessSnapshot(workflow({ generation: 0, publication: false })).classification, 'generation-required');
  assert.match(submissionReadinessText(held), /Classification: step-action-required\nPhase status: in_progress[\s\S]*The next step waits: the required after-step action audit → audit-log[\s\S]*Copilot: \/sf-integrations\nShell: singularity-flow integrations retry sad_1{40}\nVS Code \(model-free\): not available for this action$/);
});

// Review findings 2026-11-17 (kernel #8, #10): a typed change leads with its version question, and readiness names what the
// person's No goes on with. Before, a review still owed gave no route but the question again, so /sf-submit asked it
// forever; and a submission the engine refuses (an instruction still unaccounted) was offered as "submit it as it is".
test('a typed change: the version question leads; the person\'s No goes on with the review, the account or the submission', () => {
  const reviewed = () => {
    const source = workflow();
    source.resolution.sourceReview = { mode: 'enforce', phases: ['specification'], reviewerAgent: 'sflow-source-reviewer' };
    source.resolution.obligationGraph = { nodes: [{ id: 'specification', responsibilities: ['scope'] }] };
    return source;
  };
  const change = { outcome: null, changeRequested: true };
  // The review is still owed: the question leads, and No goes to that review, never a submission or the question again.
  const owed = snapshot(reviewed(), { sourceReviewEvidence: { status: 'pending', findings: [] }, taskOutcome: change });
  assert.deepEqual([owed.classification, owed.lifecycleReady, owed.nextCommand], ['change-requested', false, 'singularity-flow phase rollover specification --json']);
  assert.equal(owed.submission, undefined);
  assert.equal(owed.otherwise?.classification, 'source-review-required', JSON.stringify(owed));
  assert.match(owed.otherwise.command, /^singularity-flow review-source /u);
  assert.notEqual(owed.otherwise.command, owed.nextCommand);
  // Reviewed: No submits this version as it is.
  const ready = snapshot(reviewed(), { sourceReviewEvidence: { status: 'ready', findings: [] }, taskOutcome: change });
  assert.deepEqual([ready.classification, ready.lifecycleReady, ready.submission, ready.otherwise],
    ['change-requested', true, 'singularity-flow submit specification --work-id READY-1', undefined]);
  // What the person typed in the published version still waits for its account: No goes to that account, and the
  // submission the engine would refuse is never offered.
  const unaccounted = snapshot(workflow(), { taskOutcome: { ...change, askedFor: [1] } });
  assert.deepEqual([unaccounted.classification, unaccounted.lifecycleReady, unaccounted.submission], ['change-requested', false, undefined]);
  assert.equal(unaccounted.otherwise?.classification, 'instructions-unaccounted', JSON.stringify(unaccounted));
  assert.match(unaccounted.otherwise.command, /^singularity-flow departure account --work-id READY-1 --instruction 1 /u);
  // With no change typed, the account leads, as before.
  const account = snapshot(workflow(), { taskOutcome: { askedFor: [1] } });
  assert.deepEqual([account.classification, account.lifecycleReady], ['instructions-unaccounted', false]);
});

// Review finding 2026-11-17 (routes #3): readiness never read the code-delivery receipt, so it said "ready" and named
// /sf-submit, whose submission refused CODE_DELIVERY_RECEIPT_MISSING; /sf-submit went round the two. Readiness now says it.
test('a published code version without its code-delivery receipt is never "ready": readiness names the submission refusal\'s own route', () => {
  const code = (deliveryEvidence) => {
    const source = workflow({ phaseId: 'implement' });
    Object.assign(source.phases.implement, { generationPolicy: { requirement: 'required', task: 'code' }, generationIntent: { status: 'consumed', generation: 1 },
      ...(deliveryEvidence ? { deliveryEvidence } : {}) });
    return source;
  };
  const missing = snapshot(code(null));
  assert.deepEqual([missing.classification, missing.lifecycleReady, missing.reasonCode], ['code-delivery-receipt-missing', false, 'CODE_DELIVERY_RECEIPT_MISSING']);
  assert.equal(missing.nextCommand, 'singularity-flow phase rollover implement --reason "<what to change>" --json');
  assert.notEqual(missing.nextSkill, '/sf-submit');
  // A receipt of another version is not this version's.
  assert.equal(snapshot(code({ generation: 0 })).classification, 'code-delivery-receipt-missing');
  // With its receipt it is ready, as before.
  const ready = snapshot(code({ generation: 1 }));
  assert.deepEqual([ready.classification, ready.nextSkill], ['ready-to-attempt', '/sf-submit']);
});
