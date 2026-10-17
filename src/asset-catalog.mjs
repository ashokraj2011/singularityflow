/** Read only the libraries and attachment owners, not templates, imports, blueprints or canvases. */
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { loadSkillLibrary, readSkillAttachments, SKILL_ATTACHMENTS_PATH } from './skill-library.mjs';
import { loadInstructionLibrary } from './instruction-library.mjs';
import { projectInstructions, projectSkills } from './asset-catalog-projection.mjs';

export async function readAssetCatalog(root, { kind = 'skill' } = {}) {
  const configRoot = configurationReadRoot(root);
  const [library, instructions, agents, attachments] = await Promise.all([
    loadSkillLibrary(configRoot), loadInstructionLibrary(configRoot),
    kind === 'instruction' ? [] : import('./agents.mjs').then(({ discoverAgents }) => discoverAgents(root)),
    kind === 'instruction' ? [] : readSkillAttachments(configRoot)
  ]);
  const discovered = agents.filter(agent => agent.scope !== 'plugin');
  return {
    agents: discovered.map(({ id, label }) => ({ id, label: label ?? id })),
    skills: kind === 'instruction' ? [] : projectSkills(library, discovered, attachments.filter(entry => entry.workflow)),
    skillProblems: library.problems,
    instructions: projectInstructions(library, instructions),
    instructionProblems: instructions.problems, skillAttachmentsPath: SKILL_ATTACHMENTS_PATH
  };
}
