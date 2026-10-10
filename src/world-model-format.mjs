/**
 * The one World Model format, and the refusal for the retired one's commands.
 *
 * The legacy-v3 builder (light and semantic builds, dual state/current-branch publication, the
 * business/architecture/... view names) was removed in a hard cutover: there is no compatibility
 * mode. Its commands and options are refused by name. A configuration that still names its format
 * or views is not refused: the World Model is guidance, so loading drops those entries, `doctor`
 * names them, and `wm migrate-views` rewrites them to registered views. A Story started under it
 * keeps its records and continues without the World Model.
 */
import { SingularityFlowError } from './util.mjs';

export const WORLD_MODEL_FORMAT = 'registered-v4';
export const RETIRED_WORLD_MODEL_FORMAT = 'legacy-v3';

// Kept free of the view registry: the command registry refuses retired subcommands before loading anything heavy.
const REMEDIATION = `Set worldModel.format: ${WORLD_MODEL_FORMAT} (or remove the setting), list worldModel.views from the `
  + 'registered views (singularity-flow wm views), and replace phase, agent and initiative view assignments with those IDs. '
  + 'Existing legacy-v3 output is not read. Phase prompts get the repository brief read from the source (singularity-flow wm brief); '
  + 'registered views are used only where worldModel.registered is on.';

/** The refusal for a registered World Model command while `worldModel.registered` is off. */
export function registeredWorldModelOffError(source) {
  return new SingularityFlowError(
    `The registered World Model is off in this repository, so ${source} has nothing to work on. `
    + 'Phase prompts get the repository brief, read from the source with no model: see what a phase receives with '
    + 'singularity-flow wm brief --phase PHASE, or read the repository with singularity-flow wm knowledge brief. '
    + 'To use registered views again, set worldModel.registered: on in singularity/workflow.yml.',
    { code: 'WMB_REGISTERED_OFF', details: { source } }
  );
}

/** The refusal for anything that still asks for the retired format. */
export function retiredWorldModelFormatError(source, details = {}) {
  return new SingularityFlowError(
    `The legacy-v3 World Model was removed (${source}). ${REMEDIATION}`,
    { code: 'WMB_FORMAT_RETIRED', details: { retiredFormat: RETIRED_WORLD_MODEL_FORMAT, format: WORLD_MODEL_FORMAT, source, ...details } }
  );
}

/** A Story pinned to the retired format keeps its records; only World Model use is refused. */
export function retiredStoryWorldModelError(workId) {
  return new SingularityFlowError(
    `Story ${workId} was started with the legacy-v3 World Model, which was removed. Its records stay readable, `
    + `but it cannot build or consume World Model grounding; its phases continue without it. Start a new Story to use ${WORLD_MODEL_FORMAT} grounding.`,
    { code: 'WMB_FORMAT_RETIRED', details: { retiredFormat: RETIRED_WORLD_MODEL_FORMAT, format: WORLD_MODEL_FORMAT, workId } }
  );
}

/** Whether a definition (repository or Story-pinned) still selects the retired format. */
export function selectsRetiredWorldModel(definition) {
  const format = definition?.worldModel?.format;
  return format != null && format !== WORLD_MODEL_FORMAT;
}

/** The refusal for a definition that selects the retired format, or null when it does not. */
export function retiredWorldModelError(definition, { source = 'worldModel.format', workId = null } = {}) {
  if (!selectsRetiredWorldModel(definition)) return null;
  const story = workId ?? definition.worldModel.retiredStoryWorkId ?? null;
  if (story) return retiredStoryWorldModelError(story);
  return retiredWorldModelFormatError(source, { configured: definition.worldModel.format });
}

/** Refuse a definition (repository or Story-pinned) that still selects the retired format. */
export function assertRegisteredWorldModel(definition, options = {}) {
  const error = retiredWorldModelError(definition, options);
  if (error) throw error;
}
