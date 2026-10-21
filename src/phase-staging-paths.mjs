/**
 * The exact Git-private staging files a Story step's own turns write (docs/SPEC-STAGING-PERMISSIONS-v1.md).
 *
 * A step has one clarification-response file and one source-review report file per generation. Both
 * follow from pinned state alone: the bound checkout's Git directory, the Story, the step and its
 * generation. The CLI prints them, and the Copilot guard lets every turn bound to that step write
 * them, so a turn after an interrupted one, or a new chat, can still record the person's answers.
 * Each path is one exact file, never a directory.
 */
import path from 'node:path';
import { phaseInspectionGeneration } from './phase-inspection-generation.mjs';
import { sourceReviewKind } from './phase-roles.mjs';
import { sourceReviewAuthorConflict } from './source-review-policy.mjs';

const STAGING_DIRECTORIES = Object.freeze({ clarification: 'clarification-responses', 'source-review': 'source-reviews' });

/**
 * Which pinned clarification policy governs a step: the Story's resolved copy, then the step, then
 * the definition. One copy of this fallback, shared with clarifications.mjs, so the guard and the
 * checkpoint cannot disagree about what a Story pinned.
 */
export function pinnedClarificationPolicy(definition, workflow, phase) {
  const resolved = workflow?.resolution?.phases?.find((entry) => entry.id === phase?.id);
  return resolved?.clarification ?? phase?.clarification ?? definition?.phases?.[phase?.id]?.clarification;
}

function pinnedClarificationMode(definition, workflow, phase) {
  const value = pinnedClarificationPolicy(definition, workflow, phase);
  const mode = typeof value === 'string' ? value : value && typeof value === 'object' ? value.mode ?? 'off' : 'off';
  // An unreadable policy grants nothing; the checkpoint itself reports the invalid value.
  return ['when-needed', 'required'].includes(mode) ? mode : 'off';
}

/** The step's clarification-response staging file for the generation its checkpoint inspects. */
export function clarificationStagingPath(gitDirectory, workflow, phase) {
  return path.join(gitDirectory, 'singularity-flow', STAGING_DIRECTORIES.clarification,
    `${phase.id}-gen${phaseInspectionGeneration(workflow, phase)}.json`);
}

/** The step's source-review report staging file for its current generation. */
export function sourceReviewStagingPath(gitDirectory, workflow, phase) {
  return path.join(gitDirectory, 'singularity-flow', STAGING_DIRECTORIES['source-review'],
    `${workflow.workItem.id}-${phase.id}-gen${phase.generation}.json`);
}

/**
 * The staging files a turn in `turnMode` may write for the current step. An authoring turn gets the
 * clarification file while the step's checkpoint is on; a source-review turn gets the report file
 * unless the reviewer would review its own work. Every other turn gets none.
 */
export function phaseStagingPaths({ gitDirectory, definition, workflow, phase = workflow?.phases?.[workflow?.currentPhase], turnMode }) {
  if (!gitDirectory || !phase?.id || phase.status !== 'in_progress' || workflow?.currentPhase !== phase.id) return [];
  if (turnMode === 'authoring' && pinnedClarificationMode(definition, workflow, phase) !== 'off') {
    return [clarificationStagingPath(gitDirectory, workflow, phase)];
  }
  if (turnMode === 'read-only-review' && workflow.workItem?.id && sourceReviewKind(workflow, phase.id)
      && !sourceReviewAuthorConflict(workflow, phase)) {
    return [sourceReviewStagingPath(gitDirectory, workflow, phase)];
  }
  return [];
}

/**
 * What a Git-private staging target is, read from its path alone: the Git directory that owns it and
 * the purpose of its staging directory. Null for anything else.
 */
export function stagingTargetPurpose(absolute) {
  const parts = String(absolute ?? '').split(path.sep);
  const index = parts.lastIndexOf('singularity-flow');
  if (index < 1 || parts.length !== index + 3 || !parts[index + 2]) return null;
  const purpose = Object.keys(STAGING_DIRECTORIES).find((key) => STAGING_DIRECTORIES[key] === parts[index + 1]);
  return purpose ? { purpose, gitDirectory: parts.slice(0, index).join(path.sep) || path.sep } : null;
}
