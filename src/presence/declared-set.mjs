/**
 * SF Guard's declared set [SPEC-SFG-v1 §4, REQ-010 to REQ-012, G2]: which agents and skills the
 * workflow declares, for one Story step or for the whole repository, and the class a recorded writer
 * settles into against it. Pure: the caller hands in the approved configuration it already loaded.
 *
 * Allow but label: a class is a label and nothing else. No refusal, prompt or gate reads it.
 */
const SFLOW_SKILL = /^(?:sf|sflow)-[a-z0-9-]+$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
/** SFlow's own agents: the plugin's, in their own turn modes, are always declared. */
export const SF_GUARD_BUNDLED_AGENTS = Object.freeze(['sflow-workflow', 'sflow-utility', 'sflow-source-reviewer']);
export const SF_GUARD_CLASSES = Object.freeze(['declared', 'outside-workflow', 'unknown-agent', 'shell', 'unattributed', 'pre-guard']);

const isSflowSkill = (skill) => typeof skill === 'string' && SFLOW_SKILL.test(skill.replace(/^\//u, ''));
const listed = (agent, step) => !agent.phases?.length || agent.phases.includes(step) || agent.defaultFor?.includes(step);
const fileName = (file) => (typeof file === 'string' ? (file.split(/[\\/]/u).at(-1) ?? '').replace(/\.agent\.md$|\.md$/u, '') : null);

/** The library skill IDs a step's agent may use: attached for that step, or for every step. */
function attachedFor(agent, step) {
  return (agent.attachedSkills ?? []).filter((entry) => !step || !entry.phases?.length || entry.phases.includes(step)).map((entry) => entry.id);
}

/** The skill a step pins: its authoring skill, or a skill step's binding. */
function stepSkills(phase) {
  const skills = [];
  if (typeof phase?.authoringSkill === 'string') skills.push(phase.authoringSkill);
  const bound = phase?.skillBinding?.bindingRefs?.skill?.id ?? phase?.skillBinding?.skill ?? null;
  if (typeof bound === 'string') skills.push(bound);
  return skills;
}

/**
 * The declared set. `agents` is the configuration's agent catalog (repository, APM, user-defined,
 * plugin and bundled agents alike, each `{ id, name?, file?, phases, defaultFor, attachedSkills? }`);
 * `librarySkills` the approved skill library's IDs; `mappings` agent-mappings.yml's Copilot name to
 * Flow agent; `phase` the Story step (resolved), or null for the whole repository (REQ-011).
 */
export function sfGuardDeclaredSet({ agents = [], librarySkills = [], mappings = {}, phase = null } = {}) {
  const step = phase?.id ?? null;
  const declaredAgents = new Set(SF_GUARD_BUNDLED_AGENTS);
  const skills = new Set();
  for (const agent of agents) {
    if (!agent?.id) continue;
    if (step && !listed(agent, step) && phase?.defaultAgent !== agent.id) continue;
    declaredAgents.add(agent.id);
    for (const id of attachedFor(agent, step)) skills.add(id);
  }
  if (step) for (const id of stepSkills(phase)) skills.add(id);
  else for (const id of librarySkills) skills.add(id);
  // The names Copilot reports for an agent: its ID, its file's name and its frontmatter name, and
  // the Copilot agents agent-mappings.yml maps onto it. Each points at the catalog ID.
  const names = new Map();
  for (const agent of agents) {
    if (!agent?.id) continue;
    for (const alias of [agent.id, fileName(agent.file), agent.name]) if (typeof alias === 'string' && NAME.test(alias) && !names.has(alias)) names.set(alias, agent.id);
  }
  for (const [copilot, flow] of Object.entries(mappings ?? {})) if (NAME.test(copilot) && typeof flow === 'string') names.set(copilot, flow);
  for (const bundled of SF_GUARD_BUNDLED_AGENTS) names.set(bundled, bundled);
  return Object.freeze({
    scope: step ? 'step' : 'repository', step,
    agents: Object.freeze([...declaredAgents].sort()), skills: Object.freeze([...skills].sort()),
    agentOf: (name) => names.get(name) ?? null,
    hasAgent: (id) => declaredAgents.has(id),
    hasSkill: (skill) => typeof skill === 'string' && (skills.has(skill.replace(/^\//u, '')) || isSflowSkill(skill))
  });
}

/**
 * The class a recorded writer settles into [REQ-010 to REQ-012]. `writer` is an observed write's or
 * shell record's writer: G1's `attribution` object (format @3), or an older explicit turn's own
 * `{ skill, agent }` (format @2). Returns `declared`, `outside-workflow` or `unknown-agent`, plus
 * the agent and skill it was read from.
 */
export function sfGuardSettle(writer, declared) {
  const attribution = writer?.attribution ?? null;
  const agent = attribution ? attribution.agent ?? null : writer?.agent ?? null;
  const agentSource = attribution ? attribution.agentSource ?? 'none' : agent ? 'binding' : 'none';
  const skill = attribution ? attribution.skill ?? null : writer?.skill ?? null;
  const drift = Array.isArray(attribution?.agentFilesChanged) && attribution.agentFilesChanged.length ? attribution.agentFilesChanged : null;
  const result = (classification) => ({ classification, agent, skill, ...(drift ? { agentFilesChanged: drift } : {}) });
  if (!agent || agentSource === 'none') {
    // Plain Copilot with no agent and no skill is outside the workflow (D1). A declared skill with
    // no agent the hooks could name is that skill's work by an unknown agent; SFlow's own skills run
    // as SFlow's own agents.
    if (!skill) return result('outside-workflow');
    if (isSflowSkill(skill)) return result('declared');
    return result(declared.hasSkill(skill) ? 'unknown-agent' : 'outside-workflow');
  }
  const id = declared.agentOf(agent) ?? agent;
  if (!declared.hasAgent(id)) return result('outside-workflow');
  return result(!skill || declared.hasSkill(skill) ? 'declared' : 'outside-workflow');
}
