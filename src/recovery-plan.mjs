import path from 'node:path';

import { planAgentBriefs } from './agent-briefs.mjs';
import { evaluateCodeDeliveryPreflight, phaseRequiresCodeDelivery } from './delivery-evidence.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import { inspectRequiredArtifactContent } from './publication-preflight.mjs';
import { applicationChangeSetProjection } from './work-intervals.mjs';
import { publishedGenerationCommit } from './generation-boundary.mjs';
import { phasePublicationCommand } from './manual-authorship.mjs';

function action({ id, mode = 'guided', detail, command = null, skill = null, evidence = null, retry = null }) {
  return {
    id, safe: mode !== 'manual', automatic: mode === 'automatic', mode,
    detail, command, skill, evidence,
    confirmation: mode === 'automatic' ? 'plan-hash' : mode === 'manual' ? 'human-authority' : 'none',
    ...(retry ? { retry } : {})
  };
}

function artifactActions(workflow, phase, findings) {
  const first = findings[0];
  if (!first) return [];
  if (first.code === 'artifact.required.missing') return [action({
    id: `prepare-artifact:${phase.id}`,
    detail: `Create the required ${phase.id} artifact at ${first.path}.`,
    command: `singularity-flow prepare ${phase.id}`,
    skill: '/sf-phase', evidence: { path: first.path, line: null }
  })];
  return [action({
    id: `complete-artifact:${phase.id}`,
    detail: first.line
      ? `Complete all ${findings.length} authoring blocker(s), starting at ${first.path}:${first.line}. A Copilot host must re-author from the governed prompt before retrying.`
      : `Complete all ${findings.length} authoring blocker(s) at ${first.path}. A Copilot host must re-author from the governed prompt before retrying.`,
    command: `singularity-flow phase show ${phase.id} --show-artifact`,
    skill: '/sf-phase', evidence: { path: first.path, line: first.line },
    retry: {
      maximumAttempts: 1,
      requiresFingerprintChange: true,
      beforeRetry: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`,
      command: phasePublicationCommand(phase)
    }
  })];
}

export async function generationRecovery(root, workflow, phase, generationDigest) {
  if (!phaseRequiresCodeDelivery(phase)
      || phase.generationIntent?.status !== 'consumed'
      || Number(phase.generationIntent.generation) !== Number(phase.generation)) return null;
  const digest = await generationDigest(root, phase);
  if (digest === phase.generationIntent.publication?.resultDigest) return null;

  let command = null;
  let mode = 'guided';
  let changeSetDigest = null;
  let previousGenerationCommit = null;
  let publicationAuthorityError = null;
  try {
    previousGenerationCommit = publishedGenerationCommit(root, workflow, phase, phase.generation);
  } catch (error) {
    publicationAuthorityError = error;
  }
  const baseCommit = previousGenerationCommit
    ?? workflow.workIntervals?.current?.sourceBaseCommit ?? null;
  if (baseCommit) {
    try {
      const changeSet = await buildRepositoryChangeSet(root, {
        baseCommit,
        subject: {
          workId: workflow.workItem.id, phase: phase.id, generation: Number(phase.generation) + 1,
          generationIntentId: null
        }
      });
      const applicationChangeSet = applicationChangeSetProjection(changeSet);
      if (applicationChangeSet.entries.length) {
        changeSetDigest = applicationChangeSet.digest;
        if (!previousGenerationCommit
            && (workflow.resolution?.codeDelivery?.generationBoundary?.dirtyStart ?? 'block') !== 'allow-explicit-adoption') {
          mode = 'manual';
        }
      }
    } catch {
      // The recovery finding remains valid. The ordinary phase-begin command will perform the same
      // fail-closed change-set inspection and return a more specific repository error.
    }
  }
  const rolloverConfirmation = changeSetDigest ?? digest;
  if (mode !== 'manual') {
    command = `singularity-flow phase rollover ${phase.id} --confirm ${rolloverConfirmation}`;
  }
  return {
    blocker: {
      code: 'generation.intent.consumed-changed', category: 'lifecycle', blocking: true,
      phase: phase.id, generation: phase.generation, path: phase.generationIntent.path ?? null,
      line: null, value: null,
      details: {
        generationIntentId: phase.generationIntent.id,
        publishedResultDigest: phase.generationIntent.publication?.resultDigest ?? null,
        currentResultDigest: digest,
        changeSetDigest,
        rolloverConfirmation,
        publicationAuthority: publicationAuthorityError ? {
          code: publicationAuthorityError.code ?? 'GENERATION_PUBLICATION_UNAVAILABLE',
          message: publicationAuthorityError.message
        } : null
      }
    },
    action: action({
      id: `begin-new-generation:${phase.id}`, mode,
      detail: mode === 'manual'
        ? publicationAuthorityError
          ? 'Published bytes changed, but the exact prior generation commit could not be authenticated. Preserve the work and repair or migrate publication authority before beginning another generation.'
          : 'Published bytes changed, but Story policy forbids adopting the existing application changes. Preserve the work and obtain a policy decision before beginning another generation.'
        : 'Begin a new generation intent bound to the exact current artifact and application bytes. The published generation remains preserved.',
      command, skill: mode === 'manual' ? null : '/sf-code',
      evidence: { path: phase.generationIntent.path ?? null, line: null }
    })
  };
}

function projectionFinding(error, phase) {
  return {
    code: error.code === 'AGENT_BRIEF_HEADING_AMBIGUOUS'
      ? 'projection.agent-brief.heading-ambiguous'
      : `projection.agent-brief.${String(error.code ?? 'invalid').toLocaleLowerCase('en-US').replaceAll('_', '-')}`,
    category: 'projection', blocking: true, phase: phase.id, generation: Number(phase.generation) + 1,
    path: phase.requiredArtifact?.path ?? null,
    line: error.details?.lines?.[0] ?? null,
    value: error.details?.heading ?? null,
    details: { sourceCode: error.code ?? null, message: error.message, ...(error.details ?? {}) }
  };
}

/**
 * Inspect the prospective publication without writing workflow, projection, telemetry, or Git
 * state. Models and AST are deliberately absent: recovery classification is deterministic and AST
 * availability cannot block ordinary file-based work.
 */
export async function inspectPhaseRecovery(root, config, workflow, phase, { generationDigest } = {}) {
  if (!phase || !['in_progress', 'awaiting_approval'].includes(phase.status)) {
    return { phaseId: phase?.id ?? null, blockers: [], actions: [], requiresLifecycleRecovery: false };
  }
  const blockers = [];
  const actions = [];

  const generation = generationDigest
    ? await generationRecovery(root, workflow, phase, generationDigest)
    : null;
  if (generation) {
    blockers.push(generation.blocker);
    actions.push(generation.action);
  }

  const artifactFindings = await inspectRequiredArtifactContent(root, config, workflow, phase);
  blockers.push(...artifactFindings.map((finding) => ({
    ...finding, blocking: true, phase: phase.id, generation: Number(phase.generation) + 1,
    details: {
      bytes: finding.bytes ?? null, minimumBytes: finding.minimumBytes ?? null
    }
  })));
  actions.push(...artifactActions(workflow, phase, artifactFindings));

  if (!artifactFindings.length) {
    const itemRelative = `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}`;
    try {
      await planAgentBriefs(root, workflow, phase, {
        itemDirectory: path.join(root, itemRelative), itemRelative,
        generation: Number(phase.generation) + 1
      });
    } catch (error) {
      blockers.push(projectionFinding(error, phase));
      actions.push(action({
        id: `repair-agent-brief-source:${phase.id}`,
        detail: `${error.message} Edit only the authored source; approved managed inputs and existing published briefs remain preserved.`,
        command: `singularity-flow phase show ${phase.id} --show-artifact`,
        skill: '/sf-phase',
        evidence: {
          path: `${itemRelative}/${phase.requiredArtifact.path}`,
          line: error.details?.lines?.[0] ?? null
        }
      }));
    }

    if (phaseRequiresCodeDelivery(phase)
        && phase.generationIntent?.status === 'open'
        && !generation) {
      try {
        await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
      } catch (error) {
        blockers.push({
          code: 'code.delivery.incomplete', category: 'code-delivery', blocking: true,
          phase: phase.id, generation: Number(phase.generation) + 1,
          path: null, line: null, value: null,
          details: { sourceCode: error.code ?? null, message: error.message, ...(error.details ?? {}) }
        });
        actions.push(action({
          id: `complete-code-delivery:${phase.id}`,
          detail: error.message,
          command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id}`,
          skill: '/sf-code'
        }));
      }
    }
  }

  const uniqueActions = [...new Map(actions.map((entry) => [entry.id, entry])).values()];
  return {
    phaseId: phase.id,
    blockers,
    actions: uniqueActions,
    requiresLifecycleRecovery: blockers.some((finding) => finding.category === 'lifecycle')
  };
}
