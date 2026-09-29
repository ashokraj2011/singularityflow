import path from 'node:path';

import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { verifyOpenGenerationIntent } from './generation-boundary.mjs';
import { phaseDraftCheck } from './phase-draft-check.mjs';
import { inspectPendingPublication } from './publication-pending.mjs';
import { inspectPhaseRecovery } from './recovery-plan.mjs';

function findingKey(finding) {
  return [finding.code, finding.path ?? '', finding.line ?? ''].join('\0');
}

async function staticPublicationBlockers(root, config, workflow, phase) {
  const blockers = [];
  const actions = [];
  const id = workflow.workItem.id;
  const pending = await inspectPendingPublication(root, {
    kind: 'story', id,
    legacyPath: path.join(root, config.workItemRoot ?? 'singularity/work-items', id,
      'publication-pending.json'),
    roots: { workItemRoot: config.workItemRoot }
  });
  if (pending.status !== 'absent') {
    blockers.push({
      code: pending.status === 'pending' ? 'phase.publication.pending' : 'phase.publication.unreadable',
      category: 'lifecycle', path: pending.path, line: null,
      message: pending.status === 'pending'
        ? 'A retained publication has not reached its remote. Synchronize that exact publication before another generation.'
        : 'The retained publication marker cannot be verified. Inspect recovery before another generation.'
    });
    actions.push({ command: pending.status === 'pending' ? 'singularity-flow sync'
      : `singularity-flow recover ${id} --phase ${phase.id} --json`,
    skill: pending.status === 'pending' ? '/sf-next' : '/sf-recover',
    detail: 'Resolve the retained publication before editing or publishing another generation.' });
  }
  const pinned = workflow.resolution?.phases?.find((entry) => entry.id === phase.id);
  if (pinned?.kind === 'skill' || phase.kind === 'skill') {
    blockers.push({
      code: 'phase.skill-host.unavailable', category: 'host', path: null, line: null,
      message: `Skill phase '${phase.id}' cannot publish until the qualified execution host and delivery receipt are available.`
    });
  }
  if (workflow.resolution?.collaboration?.assignmentMode === 'required'
      && !workflow.collaboration?.assignments?.[phase.id]) {
    blockers.push({
      code: 'phase.assignment.required', category: 'collaboration', path: null, line: null,
      message: `Phase '${phase.id}' requires an assignment before publication.`
    });
    actions.push({ command: `singularity-flow assign ${phase.id} <assignee>`, skill: '/sf-assign',
      detail: `Assign the ${phase.id} owner, then rerun prepublish.` });
  }
  if (phaseRequiresCodeDelivery(phase)) {
    try {
      await verifyOpenGenerationIntent(root, workflow, phase);
    } catch (error) {
      blockers.push({
        code: 'phase.generation-intent.required', category: 'code-delivery', path: null, line: null,
        message: error.message, details: { sourceCode: error.code ?? null }
      });
      const consumed = phase.generationIntent?.status === 'consumed';
      actions.push({ command: `singularity-flow phase ${consumed ? 'rollover' : 'begin'} ${phase.id}`,
        skill: '/sf-code', detail: consumed
          ? 'Preview the guarded next generation; do not overwrite a published result.'
          : 'Open the governed code generation before changing source, then recheck.' });
    }
  }
  const sourceId = pinned?.testEvidenceFrom;
  if (sourceId) {
    const source = workflow.phases?.[sourceId];
    if (!source || source.status !== 'approved' || source.deliveryEvidence?.status !== 'ready'
        || source.deliveryEvidence?.validation?.status !== 'passed') {
      blockers.push({
        code: 'phase.prior-test-evidence.required', category: 'code-delivery', path: null, line: null,
        message: `Phase '${phase.id}' needs approved passing test evidence from '${sourceId}'.`
      });
    }
  }
  return { blockers, actions };
}

/**
 * Read-only, phase-scoped readiness projection for guided pre-publication repair.
 *
 * Draft-check owns authored Markdown and producer identity. Recovery adds known projection,
 * configuration, and code-delivery blockers. Neither is a substitute for the exact checks in the
 * publication transaction: tests and remote state can change after this read.
 */
export async function phasePrepublish(root, config, workflow, phase, options = {}) {
  const draft = await phaseDraftCheck(root, config, workflow, phase, options);
  const recovery = await inspectPhaseRecovery(root, config, workflow, phase);
  const staticChecks = await staticPublicationBlockers(root, config, workflow, phase);
  const lifecycleReady = workflow.currentPhase === phase.id && phase.status === 'in_progress';
  const findings = new Map(draft.findings.map((finding) => [findingKey(finding), finding]));
  for (const blocker of [...staticChecks.blockers, ...recovery.blockers]) {
    const key = findingKey(blocker);
    if (!findings.has(key)) findings.set(key, {
      ...blocker,
      message: blocker.message ?? blocker.details?.message ?? blocker.code
    });
  }
  if (!lifecycleReady) {
    const finding = {
      code: 'phase.lifecycle.not-publishable', category: 'lifecycle', path: null, line: null,
      message: `Phase '${phase.id}' is not the current in-progress phase. Publication cannot repair or bypass this lifecycle gate.`
    };
    findings.set(findingKey(finding), finding);
  }
  const ready = lifecycleReady && draft.status === 'ready'
    && staticChecks.blockers.length === 0 && recovery.blockers.length === 0;
  const action = draft.status !== 'ready'
    ? recovery.actions[0] ?? staticChecks.actions[0] ?? null
    : staticChecks.actions[0] ?? recovery.actions[0] ?? null;
  const briefOnly = recovery.actions.length > 0
    && recovery.actions.every((entry) => entry.id === `repair-agent-brief-source:${phase.id}`);
  const hardBlocker = staticChecks.blockers.some((entry) =>
    ['lifecycle', 'host'].includes(entry.category));
  return Object.freeze({
    schemaVersion: 1,
    resultType: 'sflow-phase-prepublish',
    status: ready ? 'ready' : 'correction-required',
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: draft.generation,
    phaseStatus: phase.status,
    producer: draft.producer,
    ownership: draft.ownership,
    draftFingerprint: draft.draftFingerprint,
    artifact: draft.artifact,
    artifacts: draft.artifacts,
    findings: Object.freeze([...findings.values()].map((finding) => Object.freeze(finding))),
    readiness: Object.freeze({
      lifecycle: lifecycleReady,
      authoring: draft.status === 'ready',
      knownRecoveryBlockers: staticChecks.blockers.length === 0 && recovery.blockers.length === 0,
      publicationTransaction: 'not-run'
    }),
    correction: Object.freeze({
      ...draft.correction,
      class: draft.status === 'ready' && (staticChecks.blockers.length || recovery.blockers.length)
        ? 'phase-recovery' : draft.correction.class,
      sameTurn: !ready && !hardBlocker && (draft.status !== 'ready'
        ? draft.correction.sameTurn
        : briefOnly && draft.ownership.proven && draft.producer === 'governed-agent'),
      guidance: ready ? null : draft.status !== 'ready'
        ? draft.correction.guidance
        : action?.detail ?? 'Resolve the reported phase-scoped blocker, then recheck before publication.',
      skill: ready ? null : draft.status !== 'ready' ? draft.correction.skill : action?.skill ?? null
    }),
    commands: Object.freeze({
      recheck: `singularity-flow phase prepublish ${phase.id} --json`,
      draftCheck: draft.commands.recheck,
      recover: draft.commands.recover,
      next: ready ? null : action?.command ?? null,
      publish: ready ? draft.commands.publish : null
    }),
    mutates: false,
    modelInvocations: 0
  });
}
