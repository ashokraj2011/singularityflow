/**
 * The repository knowledge a phase prompt receives.
 *
 * One slice per phase: the phase's reader (product, architect, developer, tester), focused on the
 * Story's own words, cut to a byte budget, opening with what a newcomer would get wrong. It is
 * built from the committed source on this machine (cached by content), so it needs no model and no
 * publication. Knowledge never blocks a prompt: if it cannot be built, the prompt goes out without
 * it and the reason is reported as a warning.
 *
 *   worldModel.knowledge.prompt:   slice (default) | off
 *   worldModel.knowledge.maxBytes: bytes per phase slice (default 8192, 2048–32768)
 */
import { applyReviews, readConfirmations } from './confirm.mjs';
import { readExplanations } from './explain.mjs';
import { knowledgePromptPolicy, renderKnowledgeSlice, roleForPhase } from './render.mjs';
import { buildKnowledge, buildKnowledgeForAreas, selectKnowledgeAreas } from './store.mjs';

export { KNOWLEDGE_PROMPT_DEFAULT_BYTES, knowledgePromptPolicy } from './render.mjs';

export async function repositoryKnowledgePrompt(root, { definition, phase, workflow, changedPaths = [], limits = undefined }) {
  const policy = knowledgePromptPolicy(definition);
  if (policy.prompt === 'off') return { text: '', warnings: [], status: 'off' };
  try {
    const item = workflow?.workItem ?? {};
    const focus = [item.title, item.description, ...(item.acceptanceCriteria ?? [])].filter((value) => typeof value === 'string').join(' ');
    let result = await buildKnowledge(root, { limits });
    if (result.status !== 'ok') {
      // Too large to read whole: build only the areas this Story changes or names.
      const areas = selectKnowledgeAreas(result.areas ?? [], { changedPaths, focus });
      if (areas.length) result = await buildKnowledgeForAreas(root, areas, { limits });
      if (result.status !== 'ok') {
        return {
          text: '', status: result.status,
          warnings: [`Repository knowledge was not added: the repository has ${result.codeFiles ?? 'too many'} code files and this Story names no area of it; set worldModel.sourceRoots, or change files in an area first.`]
        };
      }
    }
    const role = roleForPhase(phase);
    // Explanations are read from this machine's cache only; composing a prompt never calls a model for them.
    const explanations = (await readExplanations(root, result.key))?.accepted ?? [];
    const knowledge = applyReviews(result.knowledge, await readConfirmations(root));
    const text = renderKnowledgeSlice(knowledge, { role, focus: focus || null, maximumBytes: policy.maxBytes, explanations });
    return {
      text: `${text.trimEnd()}\n\nThis knowledge was read from the committed source by pattern analysis. Open the cited lines before relying on a detail.`,
      warnings: [], status: 'ok', role, cache: result.cache
    };
  } catch (error) {
    return { text: '', status: 'unavailable', warnings: [`Repository knowledge was not added: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
