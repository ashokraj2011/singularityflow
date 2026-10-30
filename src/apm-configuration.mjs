/**
 * workflow.yml `apm` [APM A3, 2026-10-29], on its own so configuration loads without APM's lock
 * reader. Agents APM deployed keep their files exactly as APM wrote them, so the steps they draft
 * are named here; discovery applies them (agents.mjs).
 */
import { SingularityFlowError } from './util.mjs';

const STEP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function stepList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((step) => typeof step !== 'string' || !STEP_ID.test(step))) {
    throw new SingularityFlowError(`${label} must be a list of step IDs.`, { code: 'APM_CONFIGURATION_INVALID' });
  }
  if (new Set(value).size !== value.length) throw new SingularityFlowError(`${label} lists a step more than once.`, { code: 'APM_CONFIGURATION_INVALID' });
  return [...value];
}

/**
 * `agents.<id>.steps` are the steps it may draft (none: any step); `defaultFor` the steps it drafts
 * unless a Story picks another agent.
 */
export function normalizeApmConfiguration(value) {
  if (value == null) return { agents: {} };
  if (typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('apm must be an object with agents.', { code: 'APM_CONFIGURATION_INVALID' });
  const unknown = Object.keys(value).filter((key) => key !== 'agents');
  if (unknown.length) throw new SingularityFlowError(`apm contains unknown field '${unknown[0]}'.`, { code: 'APM_CONFIGURATION_INVALID' });
  const agents = value.agents ?? {};
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) throw new SingularityFlowError('apm.agents must map agent IDs to the steps they draft.', { code: 'APM_CONFIGURATION_INVALID' });
  const normalized = {};
  const drafters = new Map();
  for (const [id, binding] of Object.entries(agents)) {
    if (!STEP_ID.test(id)) throw new SingularityFlowError(`apm.agents key '${id}' must be a lower-case kebab-case agent ID.`, { code: 'APM_CONFIGURATION_INVALID' });
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new SingularityFlowError(`apm.agents.${id} must be an object with steps and defaultFor.`, { code: 'APM_CONFIGURATION_INVALID' });
    const extra = Object.keys(binding).filter((key) => !['steps', 'defaultFor'].includes(key));
    if (extra.length) throw new SingularityFlowError(`apm.agents.${id} contains unknown field '${extra[0]}'.`, { code: 'APM_CONFIGURATION_INVALID' });
    const steps = stepList(binding.steps, `apm.agents.${id}.steps`);
    const defaultFor = stepList(binding.defaultFor, `apm.agents.${id}.defaultFor`);
    const outside = defaultFor.find((step) => steps.length && !steps.includes(step));
    if (outside) throw new SingularityFlowError(`apm.agents.${id} drafts '${outside}' by default but does not list it in steps.`, { code: 'APM_CONFIGURATION_INVALID' });
    for (const step of defaultFor) {
      if (drafters.has(step)) throw new SingularityFlowError(`apm.agents gives step '${step}' to both ${drafters.get(step)} and ${id}; choose one.`, { code: 'APM_CONFIGURATION_INVALID' });
      drafters.set(step, id);
    }
    normalized[id] = { steps, defaultFor };
  }
  return { agents: normalized };
}
