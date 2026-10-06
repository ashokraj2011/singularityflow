import { isConvergencePhase } from './phase-roles.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { assertConvergencePublicationReady } from './convergence-context.mjs';
import {
  effectivePhasePublicationProducer, phasePublicationCommandForProducer
} from './manual-authorship.mjs';
import { generationSkillForPhase } from './code-delivery-policy.mjs';
import {
  assertReviewCodeEvidenceFresh, evaluateCodeDeliveryPreflight, otherStoryTagsNote, phaseRequiresCodeDelivery
} from './delivery-evidence.mjs';
import { directCopilotSkill } from './copilot-guidance.mjs';
import { commandGuidanceForCommands } from './safe-command-guidance.mjs';
import { inspectPhaseQualifiedConformance } from './conformance-readiness.mjs';
import { convergenceReviewRoute } from './convergence-review-route.mjs';
import {
  artifactFindingMessage, inspectPhaseAuthoredReviewContent, phaseAuthoredReviewArtifacts
} from './publication-preflight.mjs';
import { inspectCodeDocumentation } from './code-documentation-inspection.mjs';
import { inspectUnclaimedChangedPaths } from './spec-coverage-preview.mjs';
import { verifyOpenGenerationIntent } from './generation-boundary.mjs';
import { traceabilityDraftFingerprint, traceabilityRepairProjection } from './traceability-repair.mjs';
import { phaseAgentMutationRestriction } from './phase-actor-policy.mjs';
import { pendingIntentAmendmentAcknowledgement } from './source-review-policy.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';

function correctionClass(producer) {
  if (producer === 'deterministic') return 'kernel-regenerate';
  if (producer === 'governed-agent') return 'agent-authoring';
  if (producer === 'external-tool') return 'external-tool';
  return 'human-input';
}

function correctionGuidance(kind, phase) {
  if (kind === 'kernel-regenerate') {
    return `Run singularity-flow prepare ${phase.id} again; never hand-edit a deterministic artifact.`;
  }
  if (kind === 'agent-authoring') {
    return 'In the current Copilot turn, re-author every finding from the existing governed prompt and approved evidence. Do not delete markers, invent facts, add padding, or launch a nested model.';
  }
  if (kind === 'external-tool') {
    return 'Rerun the configured external producer or correct its source input, then check the resulting artifact again.';
  }
  return 'Open the exact file and line, provide the missing reviewed content, then check the draft again. SFlow cannot prove that the current agent owns these bytes and will not replace human-authored or unknown-authored content automatically.';
}

/**
 * The one correction a blocked draft offers when a check names its own route. Stale Code evidence
 * outranks a convergence decision, and the chosen route owns its class, guidance, command and
 * skill together: pairing the Code repair command with /sf-converge gave hosts a command they
 * could not display. A route without a skill lets its command map to the skill that owns it.
 */
export function draftCorrectionRoute(codeEvidenceRepair, convergenceReview) {
  const route = codeEvidenceRepair ?? convergenceReview;
  return route ? Object.freeze({
    class: route.class, guidance: route.guidance ?? null,
    command: route.command ?? null, skill: route.skill ?? null
  }) : null;
}

function draftOwnership(configuredProducer, workflow, phase, session) {
  if (configuredProducer !== 'governed-agent') {
    return Object.freeze({
      proven: true,
      producer: configuredProducer,
      agent: configuredProducer === 'deterministic' ? 'singularity-flow-kernel' : null,
      reason: 'producer-does-not-use-agent-session'
    });
  }
  const workMatches = session?.workId === workflow.workItem.id;
  const phaseMatches = session?.phaseId === phase.id;
  const agent = typeof session?.agent === 'string' && session.agent.trim() ? session.agent : null;
  const proven = Boolean(workMatches && phaseMatches && agent);
  return Object.freeze({
    proven,
    producer: proven ? 'governed-agent' : 'unknown',
    agent,
    reason: proven ? 'active-session-bound-to-story-phase'
      : !session ? 'active-session-missing'
        : !workMatches ? 'active-session-bound-to-different-work'
          : !phaseMatches ? 'active-session-bound-to-different-phase'
            : 'active-session-agent-missing'
  });
}

/**
 * Read-only authoring health projection used before publication.
 *
 * A failed publication is too late to discover an unfinished draft. This projection gives every
 * host the same findings and a producer-aware correction protocol without mutating the artifact,
 * invoking a model, consuming a generation intent, or opening a publication transaction.
 */
export async function phaseDraftCheck(root, config, workflow, phase, {
  modelEnabled = true,
  session = null
} = {}) {
  const configuredProducer = effectivePhasePublicationProducer(phase, { modelEnabled });
  const ownership = draftOwnership(configuredProducer, workflow, phase, session);
  const producer = ownership.producer;
  const reviewDraft = await phaseAuthoredReviewArtifacts(root, config, workflow, phase);
  const artifact = reviewDraft.artifacts.find((entry) => entry.scope === 'primary');
  let findings = [];
  let convergenceReview = null;
  let codeEvidenceRepair = null;
  let traceabilityRepair = null;
  let verifiedCodeIntent = false;
  const editableCode = workflow.currentPhase === phase.id && phase.status === 'in_progress'
    && phase.generationIntent?.status === 'open';

  if (isConvergencePhase(phase)) {
    try {
      await assertConvergencePublicationReady(root, config, workflow, phase);
    } catch (error) {
      convergenceReview = convergenceReviewRoute(error, workflow);
      findings = [{
        code: `convergence.${String(error.code ?? 'not-ready').toLocaleLowerCase('en-US').replaceAll('_', '-')}`,
        category: 'projection', path: error.details?.path ?? artifact.path,
        line: null, value: null, message: error.message, fingerprint: null
      }];
    }
  } else {
    findings = await inspectPhaseAuthoredReviewContent(root, config, workflow, phase);
  }

  try {
    await assertReviewCodeEvidenceFresh(root, config, workflow, phase);
  } catch (error) {
    codeEvidenceRepair = {
      class: 'code-rework', guidance: error.message,
      command: error.details?.repairCommand ?? null
    };
    findings.push({ code: error.code ?? 'PRIOR_CODE_TEST_EVIDENCE_UNAVAILABLE',
      category: 'evidence', path: error.details?.changedPaths?.[0] ?? null,
      line: null, value: null, message: error.message, fingerprint: null });
  }

  if (!findings.length && artifact?.exists) {
    const comparison = await inspectPhaseQualifiedConformance(root, config, workflow, phase);
    findings.push(...comparison.map((finding) => ({
      code: finding.code, category: 'traceability', path: finding.path,
      line: finding.line, value: finding.clauseId, message: finding.message,
      fingerprint: artifact.fingerprint
    })));
  }

  // Surface the exact missing source/test witness while the code generation is still editable. The
  // preflight is read-only; other code-delivery failures remain owned by the recovery projection.
  if (!findings.length && phaseRequiresCodeDelivery(phase)
      && editableCode && (workflow.resolution?.codeDelivery?.traceability?.sourceBindings === 'enforce'
        || config.governance?.requireAcceptanceCriteriaTags)) {
    try {
      verifiedCodeIntent = Boolean(await verifyOpenGenerationIntent(root, workflow, phase));
      await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
    } catch (error) {
      if (error.code === 'GENERATION_INTENT_REQUIRED') {
        codeEvidenceRepair = { class: 'phase-recovery', guidance: error.message,
          command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`,
          skill: '/sf-recover' };
        findings.push({ code: 'code.generation.intent-unverified', category: 'lifecycle',
          path: phase.generationIntent?.path ?? null, line: null, value: null,
          message: error.message, fingerprint: null });
      }
      traceabilityRepair = await traceabilityRepairProjection(root, error.details?.traceabilityRepair, {
        workId: workflow.workItem.id, phase,
        sameTurn: verifiedCodeIntent && ownership.proven && producer === 'governed-agent'
      });
      if (traceabilityRepair?.status === 'manual-review') findings.push({
        code: 'code.delivery.traceability-repair-unavailable', category: 'traceability',
        path: null, line: null, value: null, message: traceabilityRepair.guidance,
        fingerprint: traceabilityRepair.fingerprint
      });
      if (error.code === 'CODE_DELIVERY_SOURCE_BINDING_TOO_LARGE') {
        findings.push({
          code: 'code.delivery.source-binding-too-large', category: 'traceability',
          path: error.details?.path ?? null, line: null, value: null,
          message: error.message, fingerprint: null
        });
      }
      for (const missing of error.details?.explanationsMissing ?? []) {
        findings.push({
          code: 'code.delivery.clause-explanation-missing', category: 'traceability',
          path: missing.path, line: missing.line, value: missing.clauseId,
          message: `Explain how the change meets ${missing.clauseId} after its @clause tag${missing.path ? ` in ${missing.path}:${missing.line}` : ''}, in 10 to 300 characters.`,
          fingerprint: null
        });
      }
      for (const missing of error.details?.sourceBindingsMissing ?? []) {
        findings.push({
          code: 'code.delivery.source-clause-tag-missing', category: 'traceability',
          path: missing.expectedPaths?.[0] ?? null, line: null, value: missing.clauseId,
          message: `Planned clause ${missing.clauseId} needs @clause:${missing.clauseId} in an exact planned product source path: ${missing.expectedPaths.join(', ')}${otherStoryTagsNote(missing.otherStoryTags)}.`,
          fingerprint: null
        });
      }
      for (const action of traceabilityRepair?.actions ?? []) {
        if (!action.kind.startsWith('acceptance-')) continue;
        findings.push({
          code: action.kind === 'acceptance-tag' ? 'code.delivery.acceptance-tag-missing'
            : 'code.delivery.acceptance-tag-unattached',
          category: 'traceability', path: action.paths[0]?.path ?? null,
          line: action.line, value: action.clauseId, fingerprint: action.fingerprint,
          message: `${action.tag} ${action.kind === 'acceptance-tag' ? 'is missing' : 'is not attached to an exact executable test'}. `
            + (action.disposition === 'clarify-mapping' ? 'Resolve its approved test mapping; do not guess a declaration.'
              : `Verify the assertion in its planned test path(s): ${action.paths.map((target) => target.path).join(', ')}; place the tag directly above the test, not at file scope. Missing assertions need test implementation, not tags.`)
        });
      }
      for (const finding of findings) {
        const kind = finding.code === 'code.delivery.source-clause-tag-missing' ? 'source-tag'
          : finding.code === 'code.delivery.clause-explanation-missing' ? 'clause-explanation' : null;
        const action = traceabilityRepair?.actions.find((candidate) => candidate.kind === kind
          && candidate.clauseId === finding.value);
        if (action) finding.fingerprint = action.fingerprint;
      }
      // A tag naming a clause or criterion the specification does not hold, at its exact line.
      const tagCodes = {
        EVIDENCE_CRITERION_UNKNOWN: 'code.delivery.criterion-tag-unknown',
        EVIDENCE_CLAUSE_UNAPPROVED: 'code.delivery.source-clause-tag-unapproved'
      };
      for (const finding of tagCodes[error.code] ? error.details?.findings ?? [] : []) {
        findings.push({
          code: tagCodes[error.code], category: 'traceability',
          path: finding.path ?? finding.sourcePath ?? null, line: finding.line ?? null, value: finding.clauseId,
          message: finding.message, fingerprint: null
        });
      }
    }
  }

  // Doc comments on the code this generation changed: advisories only, never findings, so they
  // cannot change the status, the correction class or whether publication is offered.
  const { documentation, advisories } = await inspectCodeDocumentation(root, config, workflow, phase);
  // Changed paths the final code approval would refuse as unclaimed, said while they can still be
  // planned for; advisories too, so readiness is unchanged.
  const { coverage, advisories: coverageAdvisories } = phase.generationIntent?.status === 'open'
    ? await inspectUnclaimedChangedPaths(root, config, workflow, phase)
    : { coverage: { status: 'not-applicable', unclaimed: 0, blocking: false }, advisories: [] };

  const route = draftCorrectionRoute(codeEvidenceRepair, convergenceReview);
  const restriction = phaseAgentMutationRestriction(config, workflow, phase, session, 'publish');
  const hold = pendingIntentAmendmentAcknowledgement(workflow) ? phaseGovernanceHold(workflow, phase) : null;
  const actorRoute = restriction?.actions[0] ?? hold?.actions[0];
  if (restriction || hold) findings.push({ code: restriction?.code ?? hold.code,
    category: restriction ? 'agent-role' : 'amendment', path: null, line: null,
    message: restriction?.message ?? hold.reason });
  const nextRoute = actorRoute ? { class: 'human-context', command: actorRoute.command,
    skill: actorRoute.skill, guidance: restriction?.message ?? hold.reason } : route;
  const repairClass = nextRoute?.class ?? correctionClass(producer);
  const generationSkill = directCopilotSkill(generationSkillForPhase(phase, workflow));
  const awaitingApproval = phase.status === 'awaiting_approval';
  const clean = findings.length === 0;
  const commands = Object.freeze({
    recheck: `singularity-flow phase draft-check ${phase.id} --json${modelEnabled === false ? ' --no-model' : ''}`,
    recover: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json${modelEnabled === false ? ' --no-model' : ''}`,
    // A red check must never offer an executable publication action.
    publish: clean ? phasePublicationCommandForProducer(phase, configuredProducer, {
      noModel: modelEnabled === false
    }) : null,
    next: nextRoute?.command ?? null
  });
  return Object.freeze({
    schemaVersion: 1, // schema-transient: read-only process projection, never persisted
    resultType: 'sflow-phase-draft-check',
    status: clean ? 'ready' : 'correction-required',
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: phase.status === 'in_progress'
      ? nextPhaseGeneration(phase)
      : Number(phase.generation ?? 0),
    phaseStatus: phase.status,
    configuredProducer,
    producer,
    ownership,
    draftFingerprint: traceabilityDraftFingerprint(reviewDraft.fingerprint, traceabilityRepair),
    artifact,
    artifacts: reviewDraft.artifacts,
    findings: Object.freeze(findings.map((finding) => Object.freeze({
      ...finding,
      message: finding.message ?? artifactFindingMessage(finding)
    }))),
    advisories: Object.freeze([...advisories, ...coverageAdvisories]),
    documentation,
    coverage,
    traceabilityRepair,
    correction: Object.freeze({
      class: repairClass,
      automatic: false,
      sameTurn: repairClass === 'agent-authoring' && !awaitingApproval
        && (!phaseRequiresCodeDelivery(phase) || editableCode)
        && traceabilityRepair?.status !== 'manual-review',
      requiresNewGeneration: awaitingApproval && !clean,
      maximumChangedFingerprints: 3,
      guidance: clean ? null : nextRoute?.guidance
        ?? (traceabilityRepair?.sameTurn ? traceabilityRepair.guidance : correctionGuidance(repairClass, phase)),
      skill: nextRoute ? nextRoute.skill : (repairClass === 'agent-authoring' ? generationSkill : null)
    }),
    commands,
    commandGuidance: commandGuidanceForCommands(commands),
    mutates: false,
    modelInvocations: 0
  });
}
