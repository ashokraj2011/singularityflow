/**
 * The repository brief a phase prompt receives.
 *
 * One brief per phase, for the phase's reader (product, architect, developer, tester), ranked by
 * the Story's own words and changed files, cut to a small per-phase budget (see phase-brief.mjs).
 * It is built from repository knowledge (the committed source on this machine, cached by content),
 * README and docs statements, and what the registered World Model views say. It needs no model and
 * no publication. Knowledge never blocks a prompt: if it cannot be built, the prompt goes out
 * without it and the reason is reported as a warning.
 *
 *   worldModel.knowledge.prompt:   slice (default) | off      (off keeps only the registered views)
 *   worldModel.knowledge.maxBytes: bytes for every phase's brief, replacing the per-phase defaults
 */
import { briefEvidence, briefNotKnown, readDocumentation, templateBrief } from './brief.mjs';
import { applyReviews, readConfirmations } from './confirm.mjs';
import { readExplanations } from './explain.mjs';
import { phaseBriefProfile, renderPhaseBrief } from './phase-brief.mjs';
import { buildRuleRecords, ruleQuestions } from './records/rules.mjs';
import { knowledgePromptPolicy } from './render.mjs';
import { buildKnowledge, buildKnowledgeForAreas, selectKnowledgeAreas } from './store.mjs';
import { projectRegisteredView, viewProjectionDigest } from './view-brief.mjs';

export { KNOWLEDGE_PROMPT_DEFAULT_BYTES, knowledgePromptPolicy } from './render.mjs';

function storyFocus(workflow, changedPaths) {
  const item = workflow?.workItem ?? {};
  const words = [item.title, item.description, ...(item.acceptanceCriteria ?? [])].filter((value) => typeof value === 'string');
  // A changed file's name is part of what the Story is about.
  for (const file of changedPaths ?? []) words.push(String(file).split('/').pop().replace(/\.[^.]+$/u, ''));
  return words.join(' ');
}

async function storyKnowledge(root, { focus, changedPaths, limits }) {
  let result = await buildKnowledge(root, { limits });
  if (result.status !== 'ok') {
    // Too large to read whole: build only the areas this Story changes or names.
    const areas = selectKnowledgeAreas(result.areas ?? [], { changedPaths, focus });
    if (areas.length) result = await buildKnowledgeForAreas(root, areas, { limits });
  }
  return result;
}

/**
 * The phase's repository brief. `registeredViews` are the registered World Model view files the
 * phase selected (`{ path, body }`); each is read through `projectRegisteredView`, and `files`
 * reports what was read from each so the prompt receipt can bind it.
 */
export async function repositoryBriefPrompt(root, {
  definition, phase, workflow, changedPaths = [], limits = undefined, registeredViews = [], modelCommit = null, knowledge: knowledgeOn = true
}) {
  const policy = knowledgePromptPolicy(definition);
  const explicitBudget = Number.isInteger(definition?.worldModel?.knowledge?.maxBytes) ? policy.maxBytes : null;
  const profile = phaseBriefProfile(phase, { maxBytes: explicitBudget });
  const warnings = [];
  const focus = storyFocus(workflow, changedPaths);
  const registered = registeredViews.map((view) => ({ view, projection: projectRegisteredView(view.body) }));
  let template = null;
  let rules = null;
  let explanations = [];
  let knowledge = null;
  let cache = null;
  let status = 'ok';
  if (knowledgeOn && policy.prompt !== 'off') {
    try {
      const result = await storyKnowledge(root, { focus, changedPaths, limits });
      if (result.status === 'ok') {
        cache = result.cache;
        knowledge = applyReviews(result.knowledge, await readConfirmations(root));
        // Explanations are read from this machine's cache only; composing a prompt never calls a model for them.
        explanations = (await readExplanations(root, result.key))?.accepted ?? [];
        const documentation = readDocumentation(root, { focus: focus || null });
        template = templateBrief(briefEvidence(knowledge, documentation, { focus: focus || null }));
        template.notKnown = briefNotKnown(knowledge, documentation);
        rules = buildRuleRecords(knowledge, documentation, { focus: focus || null });
      } else {
        status = result.status;
        warnings.push(`Repository knowledge was not added: the repository has ${result.codeFiles ?? 'too many'} code files and this Story names no area of it; set worldModel.sourceRoots, or change files in an area first.`);
      }
    } catch (error) {
      status = 'unavailable';
      warnings.push(`Repository knowledge was not added: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    status = 'off';
  }
  if (!template && !registered.length) return { text: '', warnings, status, role: profile.reader, profile: profile.id, files: [] };
  const rendered = renderPhaseBrief({
    repository: knowledge?.repository?.name ?? workflow?.workItem?.repository ?? 'repository',
    commit: knowledge?.repository?.commit ?? null,
    profile, focus, template, phase,
    rules, questions: rules ? ruleQuestions(rules) : null,
    registered: registered.map((entry) => entry.projection),
    explanations,
    notKnown: [...(template?.notKnown ?? []), ...registered.flatMap((entry) => entry.projection.notKnown)],
    modelCommit: registered.length ? modelCommit : null
  });
  return {
    text: rendered.text,
    warnings, status, role: profile.reader, profile: profile.id, cache,
    budget: profile.budget, included: rendered.included, omitted: rendered.omitted,
    files: registered.map(({ view, projection }) => {
      const digest = viewProjectionDigest(projection);
      return { path: view.path, renderer: projection.renderer, projectionSha256: digest.sha256, projectionBytes: digest.bytes };
    })
  };
}

/** The brief from repository knowledge alone (no registered views). */
export async function repositoryKnowledgePrompt(root, options) {
  return repositoryBriefPrompt(root, { ...options, registeredViews: [] });
}
