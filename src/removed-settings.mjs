/**
 * Settings of removed features: the registered World Model (WMB v4 views, its state-branch
 * publication and the Story history pins), the CALM architecture projection and architecture
 * intent. A configuration that still carries them loads unchanged: they are dropped when it is
 * validated, `doctor` names them, and nothing reads them. Removing them from
 * `singularity/workflow.yml` silences doctor.
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
