/**
 * The repository brief a phase prompt receives.
 *
 * One brief per phase, for the phase's reader (product, architect, developer, tester), ranked by
 * the Story's own words and changed files, cut to a small per-phase budget (see phase-brief.mjs).
 * What the Story touches is read from its own changed lines (from its base commit to the working
 * state) and the files its plan names, not from the last commit.
 * It is built from repository knowledge (the committed source on this machine, cached by content)
 * and README and docs statements. It needs no model and no publication. Knowledge never blocks a prompt: if it cannot be built, the prompt goes out
 * without it and the reason is reported as a warning.
 *
 *   worldModel.knowledge.prompt:   slice (default) | off
 *   worldModel.knowledge.maxBytes: bytes for every phase's brief, replacing the per-phase defaults
 *
 * A model may phrase the selected lines (`wm brief --polish`, see brief-polish.mjs). Composing a
 * prompt never calls one: it reuses a phrasing saved for exactly these records while model use is on,
 * and otherwise keeps the fixed wording. The receipt names the records the brief included.
 */
import { createHash } from 'node:crypto';

import { resolveModelMode } from '../model-mode.mjs';
import { operationContext } from '../operation-context.mjs';
import { briefEvidence, briefNotKnown, readDocumentation, templateBrief } from './brief.mjs';
import { polishKey, polishPrompt, readPolish, validatePolish, writePolish } from './brief-polish.mjs';
import { applyReviews, readConfirmations } from './confirm.mjs';
import { readExplanations } from './explain.mjs';
import { PHASE_BRIEF_RENDERER, phaseBriefProfile, renderPhaseBrief } from './phase-brief.mjs';
import { buildRuleRecords, ruleQuestions } from './records/rules.mjs';
import { buildContractRecords } from './records/contracts.mjs';
import { buildFlowRecords } from './records/flows.mjs';
import { buildImpactRecords, impactSymbols, knowledgePaths, readChange } from './records/impact.mjs';
import { buildRiskRecords } from './records/risks.mjs';
import { knowledgePromptPolicy } from './render.mjs';
import { buildKnowledge, buildKnowledgeForAreas, selectKnowledgeAreas } from './store.mjs';

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
 * The model's phrasing of the selected lines: saved for exactly this selection, or (`write`) asked
 * for and saved. Null when there is none; a failure is a warning and the fixed wording stands.
 */
async function phrasing(root, selection, { mode, refresh, ask, key, prompt, warnings }) {
  if (mode === 'off' || !selection.length) return null;
  // Without model use the fixed wording stands, byte for byte, whatever was saved before.
  if (mode === 'cached' && !(operationContext()?.modelMode?.enabled ?? resolveModelMode([]).enabled)) return null;
  const saved = refresh ? null : await readPolish(root, key);
  if (saved || mode !== 'write') return saved ? { ...saved, cached: true } : null;
  try {
    const answer = await (ask ?? (async (text) => (await import('./model.mjs')).askKnowledgeModel(root, {
      text, channel: 'repository-brief-polish', subject: { kind: 'repository-knowledge', id: 'phase-brief' }
    })))(prompt.text);
    const checked = validatePolish(answer.output, selection);
    const record = {
      key, model: answer.model ?? null, createdAt: new Date().toISOString(), promptSha256: prompt.sha256,
      records: prompt.records, accepted: checked.accepted, rejected: checked.rejected
    };
    await writePolish(root, key, record);
    return { ...record, cached: false };
  } catch (error) {
    warnings.push(`The brief keeps its fixed wording: the model could not phrase it (${error instanceof Error ? error.message : String(error)}).`);
    return null;
  }
}

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The phase's repository brief. `polish` is `cached` (reuse a saved phrasing while model use is on),
 * `write` (ask the model when none is saved; `refresh` asks again) or `off`. `ask(text)` replaces
 * the model call, for tests.
 */
export async function repositoryBriefPrompt(root, {
  definition, phase, workflow, changedPaths = [], plannedPaths = [], limits = undefined, knowledge: knowledgeOn = true,
  polish = 'cached', refresh = false, ask = null
}) {
  const policy = knowledgePromptPolicy(definition);
  const explicitBudget = Number.isInteger(definition?.worldModel?.knowledge?.maxBytes) ? policy.maxBytes : null;
  // What this Story pinned for the step: its output kind and task choose the reader before its name.
  const resolved = workflow?.resolution?.phases?.find((entry) => entry.id === phase);
  const task = workflow?.phases?.[phase]?.generationPolicy?.task ?? resolved?.generation?.task ?? null;
  const kind = workflow?.phases?.[phase]?.requiredArtifact?.kind ?? resolved?.artifact?.kind ?? null;
  const profile = phaseBriefProfile(phase, { maxBytes: explicitBudget, task, kind });
  const warnings = [];
  const focus = storyFocus(workflow, changedPaths);
  let template = null;
  let rules = null;
  let contracts = null;
  let flows = null;
  let impact = null;
  let risks = null;
  let explanations = [];
  let knowledge = null;
  let cache = null;
  let knowledgeKey = null;
  let changeSha256 = null;
  let status = 'ok';
  if (knowledgeOn && policy.prompt !== 'off') {
    try {
      const result = await storyKnowledge(root, { focus, changedPaths, limits });
      if (result.status === 'ok') {
        cache = result.cache;
        knowledgeKey = result.key ?? null;
        knowledge = applyReviews(result.knowledge, await readConfirmations(root));
        // Explanations are read from this machine's cache only; composing a prompt never calls a model for them.
        explanations = (await readExplanations(root, result.key))?.accepted ?? [];
        const documentation = readDocumentation(root, { focus: focus || null });
        template = templateBrief(briefEvidence(knowledge, documentation, { focus: focus || null }));
        template.notKnown = briefNotKnown(knowledge, documentation);
        rules = buildRuleRecords(knowledge, documentation, { focus: focus || null });
        contracts = buildContractRecords(knowledge, { focus: focus || null });
        flows = buildFlowRecords(knowledge, { focus: focus || null });
        const known = knowledgePaths(knowledge);
        const { changedRanges } = changedPaths.length
          ? await readChange(root, workflow?.workItem?.baseCommit ?? workflow?.workItem?.baseBranch ?? null, { paths: changedPaths, keep: (file) => known.has(file) })
          : { changedRanges: null };
        impact = buildImpactRecords(knowledge, { changedPaths, changedRanges, plannedPaths });
        changeSha256 = sha256({ changedPaths, changedRanges, plannedPaths });
        risks = buildRiskRecords(knowledge, { focus: focus || null, changedPaths, changedSymbols: changedRanges ? impactSymbols(impact) : null });
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
  if (!template) return { text: '', warnings, status, role: profile.reader, profile: profile.id, receipt: null };
  const repository = knowledge?.repository?.name ?? workflow?.workItem?.repository ?? 'repository';
  const inputs = {
    repository, commit: knowledge?.repository?.commit ?? null,
    profile, focus, template, phase,
    rules, questions: rules ? ruleQuestions(rules) : null, contracts, flows, impact, risks,
    explanations,
    notKnown: template?.notKnown ?? []
  };
  let rendered = renderPhaseBrief(inputs);
  const prompt = polishPrompt(rendered.selection, { repository, profile: profile.id });
  const key = polishKey({ knowledgeKey, diffSha256: changeSha256, prompt });
  const phrased = await phrasing(root, rendered.selection, { mode: polish, refresh, ask, key, prompt, warnings });
  if (phrased?.accepted?.length) rendered = renderPhaseBrief({ ...inputs, phrasing: { model: phrased.model, sentences: phrased.accepted } });
  const applied = rendered.phrased > 0;
  return {
    text: rendered.text,
    warnings, status, role: profile.reader, profile: profile.id, cache,
    budget: profile.budget, included: rendered.included, omitted: rendered.omitted,
    // What the prompt receipt records: which records were sent, and whether a model phrased them.
    receipt: {
      renderer: `${PHASE_BRIEF_RENDERER.id}@${PHASE_BRIEF_RENDERER.version}`, profile: profile.id, budget: profile.budget,
      bytes: Buffer.byteLength(rendered.text), records: rendered.records, omitted: rendered.omitted,
      phrasing: applied ? { by: 'model', model: phrased.model ?? null, key, sentences: rendered.phrased } : { by: 'template' }
    },
    polish: phrased ? {
      key, cached: phrased.cached, model: phrased.model ?? null, sent: phrased.records ?? [],
      accepted: phrased.accepted.length, applied: rendered.phrased, rejected: phrased.rejected ?? []
    } : { key, cached: false, sent: [], accepted: 0, applied: 0, rejected: [] }
  };
}

/** The same brief; kept under its earlier name for callers that still use it. */
export async function repositoryKnowledgePrompt(root, options) {
  return repositoryBriefPrompt(root, options);
}
