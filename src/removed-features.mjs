export { dropRemovedSettings, removedSettings, disabledArchitectureIntent } from './kernel/configuration-declarations.mjs';
import { SingularityFlowError } from './util.mjs';

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
