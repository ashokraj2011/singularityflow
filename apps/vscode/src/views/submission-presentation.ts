import type { StoryArtifact, StoryPhase, SubmissionReadiness } from '../cli/snapshot.ts';
import { commandArgv } from '../commands.ts';

export type GenerationSkill = `/sf-${string}`;

export interface PhaseSubmissionPresentation {
  kind: 'generation-required' | 'source-review-required' | 'step-action-required' | 'ready-to-submit' | 'unavailable';
  statusLabel: string;
  detail: string;
  generation: number | null;
  skill: GenerationSkill | null;
}

export function exactSubmissionReadiness(
  readiness: SubmissionReadiness | null | undefined,
  phaseId: string
): SubmissionReadiness | null {
  return readiness?.phaseId === phaseId ? readiness : null;
}

export function generationSkill(value: string | null | undefined): GenerationSkill | null {
  return typeof value === 'string' && /^\/sf-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
    ? value as GenerationSkill
    : null;
}

/** Native Chat receives a draft query only; `isPartialQuery` is the no-execution boundary. */
export function phaseGenerationChatPrefill(value: string | null | undefined): {
  query: string; isPartialQuery: true;
} | null {
  const skill = generationSkill(value);
  return skill ? { query: `${skill} `, isPartialQuery: true } : null;
}

/** Parse only the exact engine-owned CLI route. No shell, fallback command, or local inference. */
export function submissionCommandArgv(
  readiness: SubmissionReadiness | null | undefined,
  phaseId: string
): string[] | null {
  const exact = exactSubmissionReadiness(readiness, phaseId);
  if (exact?.lifecycleReady !== true || exact.nextSkill !== '/sf-submit') return null;
  const command = exact?.nextCommand?.trim();
  if (!command || !/^singularity-flow\s+/u.test(command)) return null;
  try {
    const argv = commandArgv(command);
    return argv.length ? argv : null;
  } catch {
    return null;
  }
}

/**
 * One host presentation of engine-owned submission readiness.
 *
 * It deliberately has no "generation > 0 therefore ready" fallback. An older or incomplete
 * snapshot fails closed and leaves the engine's read-only Continue action as the recovery path.
 */
/** What pressing the hold's command does, in words: deliver it, record it, or publish the step first. */
export function stepActionHoldLabel(command: string | null | undefined): string {
  if (/^singularity-flow integrations retry /u.test(command ?? '')) return 'Deliver the required action now';
  if (/^singularity-flow integrations record\b/u.test(command ?? '')) return 'Record its receipt';
  if (/^singularity-flow sync\b/u.test(command ?? '')) return 'Publish the step first';
  return 'See the required delivery';
}

export function phaseSubmissionPresentation(
  phase: StoryPhase,
  readiness: SubmissionReadiness | null | undefined
): PhaseSubmissionPresentation {
  const exact = exactSubmissionReadiness(readiness, phase.id);
  // A required after-step action of an earlier step holds this one: its delivery is what comes next.
  if (exact?.classification === 'step-action-required') {
    return {
      kind: 'step-action-required',
      statusLabel: 'Waits for a required after-step delivery',
      detail: exact.stepActionHold?.reason ?? 'A required after-step delivery has no receipt in the Story yet.',
      generation: exact.currentGeneration,
      skill: null
    };
  }
  if (exact?.lifecycleReady === true) {
    if (!exact.publicationRecorded) {
      return {
        kind: 'ready-to-submit',
        statusLabel: exact.draftExists
          ? 'Seeded draft — not published; confirmation required'
          : 'Publication not recorded — confirmation required',
        detail: exact.sequenceGate
          ? `soft ${exact.sequenceGate} gate`
          : 'explicit lifecycle confirmation required',
        generation: null,
        skill: null
      };
    }
    const published = exact.publishedGeneration ?? phase.generation;
    return {
      kind: 'ready-to-submit',
      statusLabel: `Published generation ${published} — ready to submit`,
      detail: 'publication recorded', generation: published, skill: null
    };
  }
  const skill = generationSkill(exact?.nextSkill);
  if (exact && skill && (exact.classification === 'generation-required'
      || exact.reasonCode === 'PHASE_GENERATION_REQUIRED')) {
    return {
      kind: 'generation-required',
      statusLabel: exact.draftExists
        ? 'Seeded draft — not published'
        : `${phase.label} has not been published`,
      detail: exact.draftModified ? 'draft has local edits' : 'generation not recorded',
      generation: exact.currentGeneration,
      skill
    };
  }
  if (exact?.publicationRecorded && exact.lifecycleReady === false
      && exact.classification === 'source-review-required') {
    const published = exact.publishedGeneration ?? phase.generation;
    return {
      kind: 'source-review-required',
      statusLabel: `Published generation ${published} — source review required`,
      detail: 'independent source review must be recorded before submission',
      generation: published,
      skill: skill === '/sf-review-source' ? skill : null
    };
  }
  if (exact?.publicationRecorded) {
    const published = exact.publishedGeneration ?? phase.generation;
    const suffix = exact.classification === 'already-submitted'
      ? 'submitted for approval'
      : exact.classification === 'synchronization-required'
        ? 'synchronization required'
        : 'not ready to submit';
    return {
      kind: 'unavailable',
      statusLabel: `Published generation ${published} — ${suffix}`,
      detail: exact.reasonCode?.replaceAll('_', ' ').toLowerCase() ?? suffix,
      generation: published,
      skill: null
    };
  }
  return {
    kind: 'unavailable', statusLabel: 'Submit is unavailable',
    detail: exact?.reasonCode?.replaceAll('_', ' ').toLowerCase() ?? 'refresh lifecycle status',
    generation: null, skill: null
  };
}

export function storyArtifactPublicationLabel(
  document: StoryArtifact,
  phase: StoryPhase,
  readiness: SubmissionReadiness | null | undefined
): string {
  if (phase.generation === 0 || document.generation === 0) return 'Seeded draft — not published';
  const presentation = phaseSubmissionPresentation(phase, readiness);
  if (presentation.kind === 'ready-to-submit') return presentation.statusLabel;
  const exact = exactSubmissionReadiness(readiness, phase.id);
  if (exact?.publicationRecorded) {
    return `Published generation ${exact.publishedGeneration ?? phase.generation}`;
  }
  return document.status?.replace(/_/g, ' ') ?? 'publication status unavailable';
}
