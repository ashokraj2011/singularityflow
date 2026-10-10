import { SingularityFlowError } from './util.mjs';

/**
 * Settings and commands of removed features: the registered World Model (WMB v4 views, its state-branch
 * publication and the Story history pins), the CALM architecture projection and architecture
 * intent. A configuration that still carries them loads unchanged: they are dropped when it is
 * validated, `doctor` names them, and nothing reads them. Removing them from
 * `singularity/workflow.yml` silences doctor. Their commands are refused by name, saying what
 * replaced them, so a script learns it instead of failing on an unknown command.
 */

const DROPPED = new WeakMap();

/** The top-level settings that belong only to removed features. */
const REMOVED_TOP_LEVEL = Object.freeze(['architectureIntent']);

/** The `worldModel.*` settings that belong only to removed features. */
const REMOVED_WORLD_MODEL = Object.freeze(['projections']);

function record(definition, name) {
  if (!DROPPED.has(definition)) DROPPED.set(definition, []);
  DROPPED.get(definition).push(name);
}

/** Drop removed-feature settings from a definition being validated; returns their names. */
export function dropRemovedSettings(definition) {
  if (!definition || typeof definition !== 'object') return [];
  for (const key of REMOVED_TOP_LEVEL) {
    if (Object.hasOwn(definition, key)) {
      delete definition[key];
      record(definition, key);
    }
  }
  const worldModel = definition.worldModel;
  if (worldModel && typeof worldModel === 'object' && !Array.isArray(worldModel)) {
    for (const key of REMOVED_WORLD_MODEL) {
      if (Object.hasOwn(worldModel, key)) {
        delete worldModel[key];
        record(definition, `worldModel.${key}`);
      }
    }
  }
  return removedSettings(definition);
}

/** The removed-feature settings a validated definition carried. */
export function removedSettings(definition) {
  return definition && typeof definition === 'object' ? [...(DROPPED.get(definition) ?? [])] : [];
}

/** Architecture intent as every Story pins it now: the removed feature, disabled. */
export function disabledArchitectureIntent() {
  return { enabled: false, allowedPhases: [], blockRequiredUnfulfilledAt: [] };
}

/** `wm` subcommands of the removed registered (v4) and legacy-v3 World Models. */
export const REMOVED_WORLD_MODEL_SUBCOMMANDS = Object.freeze(new Set([
  'plan', 'snapshot', 'build', 'status', 'availability', 'ensure', 'refresh-authority', 'manifest', 'show', 'facts', 'evidence',
  'derivation', 'validate', 'check', 'validate-view', 'verify-cache', 'regenerate', 'views', 'view-contract', 'extractors',
  'doctor', 'context', 'migrate', 'history', 'recovery', 'cleanup', 'migrate-views', 'init', 'prompt', 'budget', 'light'
]));

/** The refusal for a command of the removed World Models. */
export function removedWorldModelError(source) {
  return new SingularityFlowError(
    `The registered World Model was removed, so ${source} no longer exists. Phase prompts get the Repository brief, `
    + 'read from the source with no build and no model: see what a phase receives with singularity-flow wm brief --phase PHASE, '
    + 'or read the repository with singularity-flow wm knowledge brief.',
    { code: 'WMB_REMOVED', details: { source } }
  );
}
