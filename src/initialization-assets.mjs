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
  Object.freeze(['agents', '.github/agents']),
  Object.freeze(['worldmodel-builder.md', 'singularity/prompts/worldmodel-builder.md']),
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
  ...['architect', 'developer', 'product-owner', 'qa']
    .map((name) => Object.freeze([`agents/${name}.agent.md`, `.github/agents/${name}.agent.md`])),
  Object.freeze(['worldmodel-builder.md', 'singularity/prompts/worldmodel-builder.md']),
  Object.freeze(['copilot-planning.md', 'singularity/prompts/copilot-planning.md'])
]);

export function governedInitializationRoot(destination) {
  const segments = String(destination).split('/');
  return segments[0] === '.github' ? segments.slice(0, 2).join('/') : segments[0];
}
