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
import { renderKnowledgeSlice, roleForPhase } from './render.mjs';
import { buildKnowledge } from './store.mjs';

export const KNOWLEDGE_PROMPT_DEFAULT_BYTES = 8192;

export function knowledgePromptPolicy(definition) {
  const policy = definition?.worldModel?.knowledge ?? {};
  const prompt = policy.prompt ?? 'slice';
  const maxBytes = Number.isInteger(policy.maxBytes) ? Math.min(32768, Math.max(2048, policy.maxBytes)) : KNOWLEDGE_PROMPT_DEFAULT_BYTES;
  return { prompt, maxBytes };
}

export async function repositoryKnowledgePrompt(root, { definition, phase, workflow }) {
  const policy = knowledgePromptPolicy(definition);
  if (policy.prompt === 'off') return { text: '', warnings: [], status: 'off' };
  try {
    const result = await buildKnowledge(root);
    if (result.status !== 'ok') {
      return {
        text: '', status: result.status,
        warnings: [`Repository knowledge was not added: the repository has ${result.codeFiles} code files; set worldModel.sourceRoots to the parts this repository models.`]
      };
    }
    const item = workflow?.workItem ?? {};
    const focus = [item.title, item.description, ...(item.acceptanceCriteria ?? [])].filter((value) => typeof value === 'string').join(' ');
    const role = roleForPhase(phase);
    const text = renderKnowledgeSlice(result.knowledge, { role, focus: focus || null, maximumBytes: policy.maxBytes });
    return {
      text: `${text.trimEnd()}\n\nThis knowledge was read from the committed source by pattern analysis. Open the cited lines before relying on a detail.`,
      warnings: [], status: 'ok', role, cache: result.cache
    };
  } catch (error) {
    return { text: '', status: 'unavailable', warnings: [`Repository knowledge was not added: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
