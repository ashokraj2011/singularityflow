import { assertConvergencePublicationReady } from './convergence-context.mjs';
import {
  effectivePhasePublicationProducer, phasePublicationCommand
} from './manual-authorship.mjs';
import { generationSkillForPhase } from './code-delivery-policy.mjs';
import { directCopilotSkill } from './copilot-guidance.mjs';
import {
  artifactFindingMessage, inspectPhaseAuthoredReviewContent, phaseAuthoredReviewArtifacts
} from './publication-preflight.mjs';

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

  if (phase.id === 'convergence') {
    try {
      await assertConvergencePublicationReady(root, config, workflow, phase);
    } catch (error) {
      findings = [{
        code: `convergence.${String(error.code ?? 'not-ready').toLocaleLowerCase('en-US').replaceAll('_', '-')}`,
        category: 'projection', path: error.details?.path ?? artifact.path,
        line: null, value: null, message: error.message, fingerprint: null
      }];
    }
  } else {
    findings = await inspectPhaseAuthoredReviewContent(root, config, workflow, phase);
  }

  const repairClass = correctionClass(producer);
  const generationSkill = directCopilotSkill(generationSkillForPhase(phase));
  const awaitingApproval = phase.status === 'awaiting_approval';
  const clean = findings.length === 0;
  return Object.freeze({
    schemaVersion: 1, // schema-transient: read-only process projection, never persisted
    resultType: 'sflow-phase-draft-check',
    status: clean ? 'ready' : 'correction-required',
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: phase.status === 'in_progress'
      ? Number(phase.generation ?? 0) + 1
      : Number(phase.generation ?? 0),
    phaseStatus: phase.status,
    configuredProducer,
    producer,
    ownership,
    draftFingerprint: reviewDraft.fingerprint,
    artifact,
    artifacts: reviewDraft.artifacts,
    findings: Object.freeze(findings.map((finding) => Object.freeze({
      ...finding,
      message: finding.message ?? artifactFindingMessage(finding)
    }))),
    correction: Object.freeze({
      class: repairClass,
      automatic: false,
      sameTurn: repairClass === 'agent-authoring' && !awaitingApproval,
      requiresNewGeneration: awaitingApproval && !clean,
      maximumChangedFingerprints: 3,
      guidance: clean ? null : correctionGuidance(repairClass, phase),
      skill: repairClass === 'agent-authoring' ? generationSkill : null
    }),
    commands: Object.freeze({
      recheck: `singularity-flow phase draft-check ${phase.id} --json`,
      recover: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`,
      publish: phasePublicationCommand(phase)
    }),
    mutates: false,
    modelInvocations: 0
  });
}
