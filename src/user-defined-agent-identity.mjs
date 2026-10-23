/**
 * What makes an agent user-defined, kept small so a Story start can ask without loading the folder
 * code. `call add` copies a person's folder unchanged to `singularity/user-defined/<name>/`, writes
 * its manifest beside it, and registers one governed agent, one step and one workflow, all under the
 * same name. The agent's metadata names the folder and pins the manifest's digest.
 */
export const USER_DEFINED_ROOT = 'singularity/user-defined';
export const USER_DEFINED_METADATA = 'sflow-user-defined';
export const USER_DEFINED_MANIFEST_METADATA = 'sflow-user-defined-manifest';

export const userDefinedFolderPath = (name) => `${USER_DEFINED_ROOT}/${name}`;
export const userDefinedManifestPath = (name) => `${USER_DEFINED_ROOT}/${name}.json`;

/** The folder name a user-defined agent runs from, or null for any other agent. */
export function userDefinedAgentName(agent) {
  const name = agent?.metadata?.[USER_DEFINED_METADATA];
  return typeof name === 'string' && name ? name : null;
}

/**
 * The workflow a Story started with `--agent NAME` alone runs: the one `call add` created for that
 * user-defined agent, whose only step the agent drafts. Any other agent keeps `--agent`'s meaning
 * (the step's agent), so this answers null for it.
 */
export function userDefinedAgentWorkType(definition, agentId) {
  if (!agentId) return null;
  const agent = definition?.agents?.[agentId];
  if (!userDefinedAgentName(agent)) return null;
  const phases = definition.workTypes?.[agentId]?.phases;
  return Array.isArray(phases) && phases.length === 1 && (agent.defaultFor ?? []).includes(phases[0]) ? agentId : null;
}
