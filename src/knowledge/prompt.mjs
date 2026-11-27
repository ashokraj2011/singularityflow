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
 *
 * WMR [docs/SPEC-WMR-WORLD-MODEL-REPAIR-v1.md]: the plan's files lead, new ones listed as "(new, planned)" (REQ-007);
 * a large repository builds the planned and changed files' areas (REQ-008) inside the Story's own source scope
 * (REQ-009); the brief goes only where it helps (REQ-011, phaseBriefPlacement), written for the step's intent
 * (REQ-012); a step's next version reuses it while nothing it was read from changed (REQ-013); and calls matched by
 * name are never stated as facts (REQ-014, REQ-015).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { languageOf } from '../code-intelligence/generated/code-explainer-model.mjs';
import { repositoryGitPath } from '../git-directory.mjs';
import { head } from '../git.mjs';
import { resolveModelMode } from '../model-mode.mjs';
import { operationContext } from '../operation-context.mjs';
import { KNOWLEDGE_ANALYZER_VERSION } from './analyze.mjs';
import { briefEvidence, briefNotKnown, readDocumentation, templateBrief } from './brief.mjs';
import { polishKey, polishPrompt, readPolish, validatePolish, writePolish } from './brief-polish.mjs';
import { applyReviews, readConfirmations } from './confirm.mjs';
import { readExplanations } from './explain.mjs';
import { briefLeftOutByDefault, PHASE_BRIEF_RENDERER, phaseBriefProfile, renderPhaseBrief } from './phase-brief.mjs';
import { buildRuleRecords, ruleQuestions } from './records/rules.mjs';
import { applyRuleMeanings, readRuleMeanings } from './rule-meaning.mjs';
import { buildContractRecords } from './records/contracts.mjs';
import { buildFlowRecords } from './records/flows.mjs';
import { buildImpactRecords, filesNamedByWords, impactSymbols, knowledgePaths, readChange } from './records/impact.mjs';
import { partRead } from './items.mjs';
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

async function storyKnowledge(root, { focus, changedPaths, plannedPaths, limits, scope }) {
  let result = await buildKnowledge(root, { limits, scope });
  if (result.status !== 'ok') {
    // Too large to read whole: build only the areas this Story changes, plans or names [WMR:REQ-008]. Before it plans
    // or changes a file, the files its words name choose areas too, read as the brief reads them (impact.mjs). An area
    // too large to read whole is read in the part those files need [WMR:§11].
    const namedPaths = changedPaths.length || plannedPaths.length ? [] : filesNamedByWords(result.codeFilePaths ?? [], focus);
    const areas = selectKnowledgeAreas(result.areas ?? [], { changedPaths, plannedPaths, namedPaths, focus });
    if (areas.length) result = await buildKnowledgeForAreas(root, areas, { limits, scope, storyPaths: [...changedPaths, ...plannedPaths, ...namedPaths] });
  }
  return result;
}

/**
 * The source scope compose applies, from the Story's pinned configuration [WMR:REQ-009]: its roots, shared roots and
 * excluded roots (the environment's exclusions are among them). Null when the definition names none of them.
 */
export function storySourceScope(definition) {
  const worldModel = definition?.worldModel ?? {};
  const list = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);
  if (![worldModel.sourceRoots, worldModel.sharedRoots, worldModel.excludedRoots].some(Array.isArray)) return null;
  return { sourceRoots: list(worldModel.sourceRoots), sharedRoots: list(worldModel.sharedRoots), excludedRoots: list(worldModel.excludedRoots) };
}

/**
 * What a step declares about itself, as the Story pinned it: its output kind and task, its intent, and the kind of
 * task it is part of (a `/sf-task`'s composition) [WMR:REQ-012].
 */
export function stepBriefSignals({ definition = null, workflow = null, phase }) {
  const resolved = workflow?.resolution?.phases?.find((entry) => entry.id === phase);
  const composition = workflow?.resolution?.composition;
  return {
    task: workflow?.phases?.[phase]?.generationPolicy?.task ?? resolved?.generation?.task ?? null,
    kind: workflow?.phases?.[phase]?.requiredArtifact?.kind ?? resolved?.artifact?.kind ?? null,
    intent: composition?.steps?.find((step) => step.id === phase)?.intent ?? definition?.phases?.[phase]?.intent
      ?? workflow?.phases?.[phase]?.intent ?? resolved?.intent ?? null,
    taskKind: typeof composition?.kind === 'string' ? composition.kind : null
  };
}

/**
 * Whether a step's prompt carries the brief [WMR:REQ-011]. Left out of intake, requirements, verification and release
 * by default; a work type with `intelligence.worldModel: on` gives it to every step, and `worldModel.knowledge.prompt`
 * naming a step decides for that step. `reasonCode` is what the prompt's receipt records when it is left out.
 */
/** Whether a work type asks for the brief in every step, those it is left out of by default too [WMR:REQ-011]. */
function worldModelOnForWorkflow(workflow) {
  return ['on', 'required'].includes(workflow?.resolution?.intelligence?.worldModel);
}

export function phaseBriefPlacement({ definition = null, workflow = null, phase }) {
  const policy = knowledgePromptPolicy(definition);
  const explicitBudget = Number.isInteger(definition?.worldModel?.knowledge?.maxBytes) ? policy.maxBytes : null;
  const profile = phaseBriefProfile(phase, { maxBytes: explicitBudget, ...stepBriefSignals({ definition, workflow, phase }) });
  const named = Object.hasOwn(policy.steps, phase) ? policy.steps[phase] : null;
  const included = named ? named !== 'off' : worldModelOnForWorkflow(workflow) || !briefLeftOutByDefault(profile);
  return {
    included, profile, reasonCode: included ? null : 'BRIEF_NOT_FOR_THIS_STEP',
    why: included ? null : named === 'off'
      ? `worldModel.knowledge.prompt leaves the brief out of ${phase}.`
      : `The ${phase} step gets no Repository brief by default: little code is read there. Bring it back with worldModel.knowledge.prompt: { ${phase}: slice }, or with intelligence.worldModel: on on the work type.`
  };
}

/**
 * Whether a file's calls are resolved, so claims built on them are facts [WMR:REQ-014]: a semantic pack resolved calls
 * in a file of its language. While a language's calls are only matched by name, the brief states no reach, callers or
 * test reach for its files. Nor does it for a file of a large area read only in part: who calls it and which tests
 * reach it are not known from a part [WMR:§11].
 */
export function callTrust(knowledge) {
  const resolved = new Set((knowledge?.graph?.callSites ?? []).filter((edge) => edge.how === 'resolved')
    .flatMap((edge) => [edge.from?.file, edge.to?.file]).filter(Boolean).map(languageOf));
  const part = partRead(knowledge);
  return (file) => !file || (resolved.has(languageOf(file)) && !part.read(file));
}

/** The digest of a file in the working tree, or null when it is not there. */
function fileDigest(root, relative) {
  try { return createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex'); } catch { return null; }
}

/** A step's last brief, kept on this machine so its next version reuses it [WMR:REQ-013]. */
function reusedBriefFile(root, workId) {
  return repositoryGitPath(root, 'singularity-flow', 'knowledge', 'briefs', `${encodeURIComponent(workId)}.json`);
}

async function readReusedBrief(root, workId, phase, key) {
  const saved = await readFile(reusedBriefFile(root, workId), 'utf8').then(JSON.parse).catch(() => null);
  const entry = saved?.[phase];
  return entry?.key === key && entry.brief?.text ? entry : null;
}

async function keepBrief(root, workId, phase, key, brief) {
  const file = reusedBriefFile(root, workId);
  const saved = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({}));
  saved[phase] = { key, composedAt: new Date().toISOString(), brief };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(saved));
  await rename(temporary, file);
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

/** The checked-out commit, or null when it cannot be read. */
function headOf(root) {
  try { return head(root); } catch { return null; }
}

/**
 * The phase's repository brief. `polish` is `cached` (reuse a saved phrasing while model use is on),
 * `write` (ask the model when none is saved; `refresh` asks again) or `off`. `ask(text)` replaces
 * the model call, for tests.
 */
export async function repositoryBriefPrompt(root, {
  definition, phase, workflow, changedPaths = [], plannedPaths = [], limits = undefined, knowledge: knowledgeOn = true,
  polish = 'cached', refresh = false, ask = null, scope = null, trustCalls = null, reuse = 'off'
}) {
  const policy = knowledgePromptPolicy(definition);
  const explicitBudget = Number.isInteger(definition?.worldModel?.knowledge?.maxBytes) ? policy.maxBytes : null;
  // What this Story pinned for the step: its output kind and task, then its intent, choose the reader before its name.
  const profile = phaseBriefProfile(phase, { maxBytes: explicitBudget, ...stepBriefSignals({ definition, workflow, phase }) });
  const warnings = [];
  // A planned file's name is part of what the Story is about, as a changed file's is.
  const focus = storyFocus(workflow, [...changedPaths, ...plannedPaths]);
  // A step's next version reuses its brief while nothing it is read from changed [WMR:REQ-013]: the Story's base, its
  // changed files' bytes, its plan, its words and scope, the reviews people wrote, and how it is rendered.
  const workId = workflow?.workItem?.id ?? null;
  const reuseKey = workId && reuse !== 'off' && polish !== 'write' && !refresh && knowledgeOn && policy.prompt !== 'off' ? sha256({
    renderer: PHASE_BRIEF_RENDERER, analyzer: KNOWLEDGE_ANALYZER_VERSION, phase, profile: [profile.id, profile.budget], focus, scope,
    base: workflow?.workItem?.baseCommit ?? null, head: workflow?.workItem?.baseCommit ? null : headOf(root),
    changed: [...changedPaths].sort().map((file) => [file, fileDigest(root, file)]), planned: [...plannedPaths].sort(),
    reviews: ['docs/knowledge/confirmations.yml', 'docs/knowledge/rule-meanings.yml'].map((file) => fileDigest(root, file)),
    polish: polish === 'off' ? 'off' : operationContext()?.modelMode?.enabled ?? resolveModelMode([]).enabled, trusted: Boolean(trustCalls)
  }) : null;
  if (reuseKey) {
    const kept = await readReusedBrief(root, workId, phase, reuseKey);
    if (kept) {
      return { ...kept.brief, warnings: [], cache: 'reused',
        receipt: kept.brief.receipt ? { ...kept.brief.receipt, reused: { key: reuseKey, composedAt: kept.composedAt } } : null };
    }
  }
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
      const result = await storyKnowledge(root, { focus, changedPaths, plannedPaths, limits, scope });
      if (result.status === 'ok') {
        cache = result.cache;
        knowledgeKey = result.key ?? null;
        knowledge = applyReviews(result.knowledge, await readConfirmations(root));
        // Explanations are read from this machine's cache only; composing a prompt never calls a model for them.
        explanations = (await readExplanations(root, result.key))?.accepted ?? [];
        // Claims built on calls matched by name are left out [WMR:REQ-014]; `trustCalls` stands in for resolved calls in a test.
        // A large area read only in part for this Story says less: no callers, test reach or folder-wide counts [WMR:§11].
        const part = partRead(knowledge);
        const trusted = trustCalls ?? callTrust(knowledge);
        const trust = part.parts.length ? (file) => trusted(file) && !part.read(file) : trusted;
        const documentation = readDocumentation(root, { focus: focus || null });
        template = templateBrief(briefEvidence(knowledge, documentation, { focus: focus || null, trust, importersKnown: part.importersKnown }));
        template.notKnown = [...briefNotKnown(knowledge, documentation), ...part.notes];
        // A person's confirmed meanings, never a model's draft; an unreadable file is a warning.
        const meanings = await readRuleMeanings(root, { warnings }).catch((error) => { warnings.push(error.message); return []; });
        // A rule's own "tested" stays when a test names it; reach through calls matched by name is not a fact [WMR:REQ-014].
        rules = applyRuleMeanings(buildRuleRecords(knowledge, documentation, { focus: focus || null }), meanings)
          .map((record) => (record.tested == null || trust(record.sources.code[0]?.path) ? record : { ...record, tested: record.testNamed ? true : null }))
          // "No code enforcing it was found" needs every file: from a part it is not known [WMR:§11].
          .filter((record) => !part.parts.length || record.status !== 'documented-only');
        contracts = buildContractRecords(knowledge, { focus: focus || null })
          .map((record) => (record.tested == null || trust(record.sources.code[0]?.path) ? record : { ...record, tested: null }));
        flows = buildFlowRecords(knowledge, { focus: focus || null, trust });
        const known = knowledgePaths(knowledge);
        const { changedRanges } = changedPaths.length
          ? await readChange(root, workflow?.workItem?.baseCommit ?? workflow?.workItem?.baseBranch ?? null, { paths: changedPaths, keep: (file) => known.has(file) })
          : { changedRanges: null };
        // A planned file the knowledge does not know and the checkout does not have is a new one [WMR:REQ-007].
        const newPaths = [...new Set(plannedPaths)].filter((file) => !known.has(file) && !changedPaths.includes(file) && !existsSync(path.join(root, file)));
        impact = buildImpactRecords(knowledge, { changedPaths, changedRanges, plannedPaths, newPaths, focus: focus || null, trust, importersOf: part.importersOf });
        changeSha256 = sha256({ changedPaths, changedRanges, plannedPaths });
        risks = buildRiskRecords(knowledge, { focus: focus || null, changedPaths, changedSymbols: changedRanges ? impactSymbols(impact) : null, trust,
          partRead: part.read, importersKnown: part.importersKnown });
        // Said once, whatever the step's sections: the claims it left out, and why [WMR:REQ-014].
        if (knowledge.graph?.functions?.some((fn) => !trust(fn.file))) {
          template.notKnown = template.notKnown.map((entry) => (/^calls are matched by name/u.test(entry)
            ? `${entry}, so who calls what and which tests reach it are left out` : entry));
        }
      } else {
        status = result.status;
        warnings.push(`Repository knowledge was not added: the repository has ${result.codeFiles ?? 'too many'} code files and this Story names no area of it; set worldModel.sourceRoots, or plan or change files in an area first.`);
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
  const brief = {
    text: rendered.text,
    warnings, status, role: profile.reader, profile: profile.id, cache,
    // The files the Story's words name while it has no plan and no change (WMR §11), for the lessons a step is given:
    // the World Model's guess, never a claim about what the Story will change [LRN:REQ-008].
    likelyPaths: (impact ?? []).filter((record) => record.state === 'named').map((record) => record.parts.path),
    budget: profile.budget, included: rendered.included, omitted: rendered.omitted,
    // What the prompt receipt records: which records were sent, and whether a model phrased them.
    receipt: {
      renderer: `${PHASE_BRIEF_RENDERER.id}@${PHASE_BRIEF_RENDERER.version}`, profile: profile.id, budget: profile.budget,
      bytes: Buffer.byteLength(rendered.text), records: rendered.records, omitted: rendered.omitted,
      phrasing: applied ? { by: 'model', model: phrased.model ?? null, key, sentences: rendered.phrased } : { by: 'template' },
      ...(reuseKey ? { reuseKey } : {})
    },
    polish: phrased ? {
      key, cached: phrased.cached, model: phrased.model ?? null, sent: phrased.records ?? [],
      accepted: phrased.accepted.length, applied: rendered.phrased, rejected: phrased.rejected ?? []
    } : { key, cached: false, sent: [], accepted: 0, applied: 0, rejected: [] }
  };
  // Kept for the step's next version; a write that fails only means the next one is composed again.
  if (reuseKey && reuse === 'read-write' && status === 'ok' && !warnings.length) {
    await keepBrief(root, workId, phase, reuseKey, { ...brief, warnings: [] }).catch(() => {});
  }
  return brief;
}

/** The same brief; kept under its earlier name for callers that still use it. */
export async function repositoryKnowledgePrompt(root, options) {
  return repositoryBriefPrompt(root, options);
}
