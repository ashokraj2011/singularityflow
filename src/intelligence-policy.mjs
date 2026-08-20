import { SingularityFlowError } from './util.mjs';

export const WORK_TYPE_WORLD_MODEL_MODES = Object.freeze(['inherit', 'required', 'off']);
export const WORK_TYPE_AST_MODES = Object.freeze(['inherit', 'required-context', 'off']);
export const WORK_TYPE_AGENT_BRIEF_MODES = Object.freeze(['inherit', 'required', 'off']);

/**
 * The intelligence profile is pinned with a Story so a benchmark arm cannot drift when shared
 * configuration changes. Existing work types inherit today's behavior; benchmark profiles opt in
 * to a stronger, explicit contract.
 */
export function normalizeWorkTypeIntelligence(value = null, label = 'Work type intelligence') {
  const source = value ?? {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new SingularityFlowError(`${label} must be an object.`);
  }
  for (const key of Object.keys(source)) {
    if (!['worldModel', 'ast', 'agentBriefs'].includes(key)) {
      throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
    }
  }
  const worldModel = source.worldModel ?? 'inherit';
  const ast = source.ast ?? 'inherit';
  const agentBriefs = source.agentBriefs ?? 'inherit';
  if (!WORK_TYPE_WORLD_MODEL_MODES.includes(worldModel)) {
    throw new SingularityFlowError(`${label}.worldModel must be ${WORK_TYPE_WORLD_MODEL_MODES.join(', ')}.`);
  }
  if (!WORK_TYPE_AST_MODES.includes(ast)) {
    throw new SingularityFlowError(`${label}.ast must be ${WORK_TYPE_AST_MODES.join(', ')}.`);
  }
  if (!WORK_TYPE_AGENT_BRIEF_MODES.includes(agentBriefs)) {
    throw new SingularityFlowError(`${label}.agentBriefs must be ${WORK_TYPE_AGENT_BRIEF_MODES.join(', ')}.`);
  }
  return Object.freeze({ worldModel, ast, agentBriefs });
}

export function worldModelModeForIntelligence(configuredMode, intelligence) {
  if (intelligence?.worldModel === 'required') return 'enforce';
  if (intelligence?.worldModel === 'off') return 'off';
  return configuredMode;
}

export function astContextRequired(workflow) {
  return workflow?.resolution?.intelligence?.ast === 'required-context';
}

export function astDisabledForWorkflow(workflow) {
  return workflow?.resolution?.intelligence?.ast === 'off';
}

export function worldModelDisabledForWorkflow(workflow) {
  return workflow?.resolution?.intelligence?.worldModel === 'off';
}
