/**
 * Complete packaged repository-law assets installed by legacy init.
 *
 * This inventory is deliberately data-only so initializers can bind prospective bytes without
 * importing the large configuration runtime. Smart init selects a reviewed minimal subset below.
 */
export const INITIALIZATION_MAPPINGS = Object.freeze([
  Object.freeze(['workflow.yml', 'singularity/workflow.yml']),
  Object.freeze(['portfolio.yml', 'singularity/portfolio.yml']),
  Object.freeze(['agent-mappings.yml', 'singularity/agent-mappings.yml']),
  Object.freeze(['impact.yml', 'singularity/impact.yml']),
  Object.freeze(['modelTiers.yml', 'singularity/modelTiers.yml']),
  Object.freeze(['artifacts', 'singularity/templates']),
  Object.freeze(['starter-packs', 'singularity/templates/starter-packs']),
  // SFlow's step agents live in the agents home [AGH:REQ-006]; a repository whose workflow.yml is
  // still on the legacy layout keeps them in .github/agents (initializationMappingsFor).
  Object.freeze(['agents', 'singularity/agents']),
  Object.freeze(['skill-library', 'singularity/skill-library']),
  Object.freeze(['instruction-library', 'singularity/instruction-library']),
  // The sample user-defined agent folder (and its manifest) the packaged careful-change step runs.
  Object.freeze(['user-defined', 'singularity/user-defined']),
  Object.freeze(['copilot-planning.md', 'singularity/prompts/copilot-planning.md'])
]);

// Smart init installs the smallest built-in Story surface that is independently useful. Portfolio,
// Figma, benchmarking and POC packs remain available through explicit configuration adoption; a
// fresh repository does not receive them merely because they ship in the npm package.
export const SMART_INITIALIZATION_ASSETS = Object.freeze([
  Object.freeze(['workflow.yml', 'singularity/workflow.yml']),
  Object.freeze(['agent-mappings.yml', 'singularity/agent-mappings.yml']),
  Object.freeze(['impact.yml', 'singularity/impact.yml']),
  Object.freeze(['modelTiers.yml', 'singularity/modelTiers.yml']),
  ...['common', 'feature', 'bugfix', 'chore', 'quick-fix', 'spec-driven']
    .map((name) => Object.freeze([`artifacts/${name}`, `singularity/templates/${name}`])),
  Object.freeze(['starter-packs', 'singularity/templates/starter-packs']),
  ...['architect', 'developer', 'product-owner', 'qa']
    .map((name) => Object.freeze([`agents/${name}.agent.md`, `singularity/agents/${name}.agent.md`])),
  Object.freeze(['user-defined', 'singularity/user-defined']),
  Object.freeze(['copilot-planning.md', 'singularity/prompts/copilot-planning.md'])
]);

/** The mappings with SFlow's agents in `agentsRoot`, the layout of the workflow.yml being kept [AGH:REQ-007]. */
export function initializationMappingsFor(agentsRoot, mappings = INITIALIZATION_MAPPINGS) {
  return mappings.map(([source, destination]) => (destination === 'singularity/agents' || destination.startsWith('singularity/agents/')
    ? [source, `${agentsRoot}${destination.slice('singularity/agents'.length)}`] : [source, destination]));
}

/**
 * workflow.yml text that records the agents home [AGH:REQ-006]: the key after the `version` line, every
 * other line as written. Text that already records a layout is returned unchanged.
 */
export function withAgentsHomeSetting(text) {
  if (/^agentPromptsRoot\s*:/mu.test(text)) return text;
  const line = '# SFlow\'s step agents live in singularity/agents; .github/agents is the team\'s own.\nagentPromptsRoot: singularity/agents\n';
  const version = /^version\s*:.*(?:\r?\n|$)/mu.exec(text);
  return version ? `${text.slice(0, version.index + version[0].length)}${line}${text.slice(version.index + version[0].length)}` : `${line}${text}`;
}

export function governedInitializationRoot(destination) {
  const segments = String(destination).split('/');
  return segments[0] === '.github' ? segments.slice(0, 2).join('/') : segments[0];
}
