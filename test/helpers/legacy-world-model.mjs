/** Explicit reader-v3 fixtures; new repository initialization must not default back to v3. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../../src/config.mjs';
import { LEGACY_WORLD_MODEL_VIEW_IDS } from '../../src/world-model-views.mjs';

const PHASE_VIEWS = {
  intake: ['business'], requirements: ['business'], design: ['architecture', 'security'],
  'implementation-spec': ['architecture', 'development', 'testing', 'security'],
  reproduction: ['development', 'testing'], 'fix-design': ['architecture', 'development', 'security'],
  'fix-spec': ['development', 'testing', 'security'],
  'design-intake': ['business', 'architecture'], 'design-inventory': ['business', 'architecture'],
  'component-mapping': ['architecture', 'development', 'security'],
  'mobile-spec': ['architecture', 'development', 'testing', 'security'],
  implementation: ['development', 'testing'], verification: ['testing', 'development', 'security'],
  testing: ['testing', 'development', 'security'], 'visual-verification': ['testing', 'development', 'security'],
  conformance: ['architecture', 'development', 'testing', 'security'],
  'poc-intake': ['business', 'testing', 'security'],
  'poc-impact-analysis': ['architecture', 'development', 'testing', 'security'],
  'poc-ui-exploration': ['testing', 'development', 'security'],
  'poc-test-generation': ['development', 'testing', 'architecture', 'security'],
  'poc-validation': ['testing', 'development', 'security'],
  'poc-publication-review': ['release', 'testing', 'development', 'security'],
  specification: ['business'], planning: ['architecture'], release: ['release'],
  convergence: ['development'], implement: ['development'], verify: ['testing']
};
const AGENT_VIEWS = {
  architect: ['architecture', 'security', 'operations'], developer: ['development', 'testing', 'architecture'],
  'mobile-architect': ['architecture', 'development', 'testing', 'security'],
  'poc-analyst': ['business', 'architecture', 'development', 'testing', 'security'],
  'poc-automation': ['business', 'architecture', 'development', 'testing', 'release', 'security'],
  'poc-explorer': ['testing', 'development', 'security'],
  'poc-test-developer': ['development', 'testing', 'architecture', 'security'],
  'poc-validator': ['testing', 'development', 'release', 'security'],
  'product-designer': ['business', 'architecture', 'testing'], 'product-owner': ['business'],
  qa: ['testing', 'development', 'security']
};
const INITIATIVE_VIEWS = {
  define: ['business'], plan: ['business', 'architecture', 'security'],
  build: ['architecture', 'development', 'testing', 'security', 'operations'],
  release: ['release', 'operations', 'testing'], 'discover-define': ['business'],
  'design-iterate': ['business', 'architecture'], 'pre-inception': ['business', 'architecture', 'security'],
  inception: ['business', 'architecture', 'testing', 'security'],
  elaboration: ['business', 'architecture', 'development', 'testing', 'security', 'operations'],
  construction: ['architecture', 'development', 'testing', 'security', 'operations'],
  delivery: ['release', 'operations', 'testing', 'security']
};

export async function initializeLegacyWorldModelDefinition(root) {
  const installed = await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.worldModel = { ...definition.worldModel, format: 'legacy-v3',
    views: [...LEGACY_WORLD_MODEL_VIEW_IDS], promptSource: 'singularity/prompts/worldmodel-builder.md' };
  delete definition.worldModel.v4;
  for (const [id, phase] of Object.entries(definition.phases)) {
    if (phase.worldModel) phase.worldModel.views = PHASE_VIEWS[id] ?? [];
  }
  await writeFile(file, YAML.stringify(definition));
  for (const name of await readdir(path.join(root, '.github/agents'))) {
    if (!name.endsWith('.agent.md')) continue;
    const file = path.join(root, '.github/agents', name);
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/^([ \t]*sflow-world-model-views:) .*$/m,
      `$1 "${(AGENT_VIEWS[name.slice(0, -9)] ?? []).join(',')}"`));
  }
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const [id, phase] of Object.entries(portfolio.initiativePhases)) {
    phase.worldModelViews = INITIATIVE_VIEWS[id] ?? [];
  }
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  return installed;
}
