/**
 * The upgrade's intent pass (step intents spec §8, Stage 5): a repository's own workflows whose steps do not yet say
 * what they are for are offered their intents on one screen per repository, and nothing changes until a person
 * confirms that screen.
 *
 * - What it offers. Every step of every workflow the repository made itself (never a workflow SFlow ships: its own
 *   update brings those, Stage 4) gets the intent its settings say, by the deterministic rules of §6.1: structure
 *   first, then its place, words and agent. An upgrade never waits for a model. A step those rules leave unclear
 *   carries the one question (§6.3): two or three intents to pick from, never free text.
 * - Nothing changes silently. Where a step's intent would give a setting other than the one it has today, the pass
 *   keeps today's value as an explicit override in that workflow's `phaseOverrides`, with its generated reason under
 *   `because:` ("Kept as it was before step intents ..."). It resolves every workflow before and after and offers only
 *   a workflow that resolves byte for byte as before, apart from the intent pins a new Story keeps (intent,
 *   intentProfile, because). Its Story start check and its walk read that resolution, so they come out as before too.
 *   A workflow that cannot be kept so, one Stories cannot start from today, one that uses a step SFlow ships before
 *   that step has its intent, and one with a compiled skill step are listed with why and keep their settings; none of
 *   them holds up another.
 * - Confirming writes each step's `intent:`, the kept overrides and `version: 4`, through the upgrade's own path
 *   (`workspace refresh-configuration`, which publishes sflow/config directly). Declining writes nothing: every
 *   workflow works as it did, at its version.
 *
 * The screen carries a short code naming exactly what it showed: a confirmation with another code writes nothing and
 * shows the screen as it is now, with its own code.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import {
  applyWorkflowCompatibility, assertWorkTypeStartable, loadDefinition, loadStepIntentSettings, resolveWorkType, validateDefinition
} from './config.mjs';
import { isKnownPackagedWorkflowValue } from './packaged-workflow-history.mjs';
import { PACKAGED_STEP_INTENTS } from './packaged-step-intents.mjs';
import { mergePhaseOverride } from './phase-overrides.mjs';
import { BECAUSE_SETTINGS, INTENTS_FILE_VERSION, STEP_INTENTS, workTypeDerivesIntents } from './phase-roles.mjs';
import { withoutReadScope } from './read-scope.mjs';
import { deriveWorkTypeSettings, intentsForKind, kindFitsIntent, WORK_TYPE_BECAUSE_SETTINGS } from './step-intent-settings.mjs';
import { inferStepIntents, intentWordScores } from './step-intents.mjs';
import { stepIntentChoice } from './step-outputs.mjs';
import { writeAtomic } from './util.mjs';
import { renderPreservingFormatting, patchYamlDocument } from './yaml-formatting.mjs';

/** How every kept setting's reason starts: what Stage 7's adoption and `workflow assess` look for. */
export const KEPT_BEFORE_INTENTS = 'Kept as it was before step intents';

export const INTENT_SCREEN_BADGES = Object.freeze({
  declared: 'It says so already', sure: 'SFlow is sure', suggested: 'SFlow suggests', yours: 'Your answer', 'needs-answer': 'Your answer needed'
});

const isMapping = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) => (Array.isArray(value) ? value.map(canonical) : isMapping(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value);
const same = (left, right) => JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null));
const listed = (values) => (values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`);
const firstLine = (text) => String(text ?? '').split('\n')[0].replace(/\s+$/u, '');
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** A resolution without the pins only a work type that derives from intents carries. */
const withoutIntentPins = (resolved) => ({
  ...resolved,
  phases: resolved.phases.map(({ intent: _intent, intentProfile: _profile, because: _because, ...phase }) => phase)
});

function resolvedOrRefused(definition, workTypeId) {
  try { return { resolved: resolveWorkType(definition, workTypeId) }; } catch (error) { return { error }; }
}

/** Where two resolutions of one workflow differ: top-level keys, and each step's own keys as `step.key`. */
function differences(before, after) {
  const found = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'phases') continue;
    if (!same(before[key], after[key])) found.push(key);
  }
  before.phases.forEach((phase, index) => {
    const other = after.phases[index] ?? {};
    for (const key of new Set([...Object.keys(phase), ...Object.keys(other)])) {
      if (!same(phase[key], other[key])) found.push(`${phase.id}.${key}`);
    }
  });
  return found;
}

// ---------------------------------------------------------------------------------------------
// What a setting is, in words

const QUESTION_WORDS = Object.freeze({ required: 'asks every time', 'when-needed': 'asks when something is unclear', off: 'asks nothing' });

function settingWords(setting, phase, labelOf) {
  switch (setting) {
    case 'writeScope': return (phase.writeScope ?? 'artifact-only') === 'source-and-artifact' ? 'changes source files' : 'changes no source files';
    case 'artifact.kind': return `output recognised as ${phase.artifact?.kind ?? 'nothing in particular'}`;
    case 'generation.task': return phase.generation?.task === 'code' ? 'a code step' : `task ${phase.generation?.task ?? 'none'}`;
    case 'clarification.mode': return QUESTION_WORDS[phase.clarification?.mode] ?? QUESTION_WORDS.off;
    case 'clarification.maxQuestions': return `at most ${phase.clarification?.maxQuestions} questions`;
    case 'approval.automatic': return phase.approval?.automatic ? 'SFlow approves it when clean' : 'a person approves it';
    case 'approval.authorities': return `approved by ${listed(phase.approval?.authorities ?? [])}`;
    case 'approval.rejectTo': return `a person may send it back to ${listed((phase.approval?.rejectTo ?? []).map(labelOf))}`;
    case 'repositoryTests': return phase.repositoryTests === 'run' ? 'runs the repository\'s tests' : 'runs no repository tests of its own';
    case 'testEvidenceFrom': return phase.testEvidenceFrom ? `cites ${labelOf(phase.testEvidenceFrom)}'s test results` : 'runs its own tests';
    case 'inputs': return phase.inputs?.length ? `reads ${listed(phase.inputs.map((input) => labelOf(input.phase)))}` : 'reads no earlier step';
    default: return setting;
  }
}

function workTypeWords(setting, resolved, labelOf) {
  if (setting === 'plannedClaims') {
    const claims = resolved.plannedClaims ?? {};
    const owners = Object.entries(claims.owners ?? {}).map(([code, owner]) => `${labelOf(owner)} plans ${labelOf(code)}`);
    return `requirement IDs in ${listed((claims.clausePhases ?? []).map(labelOf)) || 'no step'}${owners.length ? `; ${listed(owners)}` : ''}`;
  }
  if (setting === 'documents.allowedPhases') {
    const steps = resolved.documents?.allowedPhases ?? [];
    return steps.length ? `attached documents on ${listed(steps.map(labelOf))}` : 'no attached documents';
  }
  return setting;
}

/** The reason a kept setting says, 20 to 1000 characters (spec §7.1). */
const keptReason = (intent, words) => `${KEPT_BEFORE_INTENTS}, so it runs as it did; its ${intent} intent would give: ${words}.`.slice(0, 1000);
const keptWorkflowReason = (words) => `${KEPT_BEFORE_INTENTS}, so it runs as it did; its steps' intents would give: ${words}.`.slice(0, 1000);

// ---------------------------------------------------------------------------------------------
// The settings kept as they were (spec §8.2)

/**
 * The overrides that keep one workflow as it resolved before (`before`) where its intents give otherwise (`after`):
 * `{ steps: { step → override patch }, workType: patch, kept: [{ step, setting, today, intent }], stuck: [path] }`.
 * A setting is written only where it differs; content settings (who approves, what it reads, how many questions) need
 * no reason, framework settings say why under `because` (spec §7.3).
 */
function keptSettings(raw, workflowId, before, after, { intentOf, labelOf }) {
  const type = raw.workTypes[workflowId];
  const overrides = isMapping(type.phaseOverrides) ? type.phaseOverrides : {};
  const steps = {};
  const kept = [];
  const stuck = [];
  before.phases.forEach((today, index) => {
    const derived = after.phases[index];
    const id = today.id;
    const intent = intentOf(id);
    const merged = mergePhaseOverride(structuredClone(raw.phases[id] ?? {}), structuredClone(isMapping(overrides[id]) ? overrides[id] : {}));
    const patch = {};
    const because = {};
    const keep = (setting, { reason = true } = {}) => {
      kept.push({ step: id, setting, today: settingWords(setting, today, labelOf), intent: settingWords(setting, derived, labelOf) });
      if (reason && BECAUSE_SETTINGS.includes(setting)) because[setting] = keptReason(intent, settingWords(setting, derived, labelOf));
    };
    if ((today.writeScope ?? 'artifact-only') !== (derived.writeScope ?? 'artifact-only')) {
      patch.writeScope = today.writeScope ?? 'artifact-only';
      keep('writeScope');
    }
    if (today.artifact?.kind !== derived.artifact?.kind) {
      if (today.artifact?.kind == null) stuck.push(`${id}.artifact.kind`);
      else { patch.artifact = { kind: today.artifact.kind }; keep('artifact.kind'); }
    }
    if (today.generation?.task !== derived.generation?.task) {
      if (today.generation?.task == null) stuck.push(`${id}.generation.task`);
      else { patch.generation = { task: today.generation.task }; keep('generation.task'); }
    }
    if (!same(today.clarification, derived.clarification)) {
      // An override's clarification replaces the step's whole, so the kept one carries everything the step has.
      const written = typeof merged.clarification === 'string' ? { mode: merged.clarification }
        : isMapping(merged.clarification) ? structuredClone(merged.clarification) : {};
      patch.clarification = { ...written, mode: today.clarification.mode, maxQuestions: today.clarification.maxQuestions };
      if (today.clarification.mode !== derived.clarification.mode) keep('clarification.mode');
      if (today.clarification.maxQuestions !== derived.clarification.maxQuestions) keep('clarification.maxQuestions', { reason: false });
    }
    const approval = {};
    if (!same(today.approval?.authorities, derived.approval?.authorities)) {
      approval.authorities = [...today.approval.authorities];
      keep('approval.authorities', { reason: false });
    }
    if (!same(today.approval?.rejectTo, derived.approval?.rejectTo)) {
      approval.rejectTo = [...today.approval.rejectTo];
      keep('approval.rejectTo');
    }
    if (Boolean(today.approval?.automatic) !== Boolean(derived.approval?.automatic)) {
      // Automatic approval is only ever written on, so a step approved automatically today keeps it as written.
      if (today.approval?.automatic) stuck.push(`${id}.approval.automatic`);
      else { approval.automatic = 'off'; keep('approval.automatic'); }
    }
    if (Object.keys(approval).length) {
      if (typeof merged.approval === 'string') stuck.push(`${id}.approval`);
      else patch.approval = approval;
    }
    if ((today.repositoryTests ?? 'off') !== (derived.repositoryTests ?? 'off')) {
      patch.repositoryTests = today.repositoryTests ?? 'off';
      keep('repositoryTests');
    }
    if (today.testEvidenceFrom !== derived.testEvidenceFrom) {
      if (today.testEvidenceFrom == null) { patch.testEvidenceFrom = false; keep('testEvidenceFrom'); }
      else stuck.push(`${id}.testEvidenceFrom`);
    }
    // What it reads is the author's: kept only when the step named nothing (its intent reads earlier steps).
    if (!same(today.inputs, derived.inputs) && merged.inputs === undefined) {
      patch.inputs = [];
      keep('inputs', { reason: false });
    }
    if (Object.keys(patch).length) steps[id] = { ...patch, ...(Object.keys(because).length ? { because } : {}) };
  });
  const workType = {};
  const workTypeBecause = {};
  if (!same(before.plannedClaims, after.plannedClaims)) {
    if (before.plannedClaims?.mode === 'required') {
      workType.plannedClaims = { mode: 'required', clausePhases: [...before.plannedClaims.clausePhases], owners: { ...before.plannedClaims.owners } };
      kept.push({ step: null, setting: 'plannedClaims', today: workTypeWords('plannedClaims', before, labelOf), intent: workTypeWords('plannedClaims', after, labelOf) });
      workTypeBecause.plannedClaims = keptWorkflowReason(workTypeWords('plannedClaims', after, labelOf));
    } else stuck.push('plannedClaims');
  }
  if (!same(before.documents?.allowedPhases, after.documents?.allowedPhases)) {
    workType.documents = { ...(isMapping(type.documents) ? structuredClone(type.documents) : {}), allowedPhases: [...(before.documents?.allowedPhases ?? [])] };
    kept.push({ step: null, setting: 'documents.allowedPhases', today: workTypeWords('documents.allowedPhases', before, labelOf),
      intent: workTypeWords('documents.allowedPhases', after, labelOf) });
    if (WORK_TYPE_BECAUSE_SETTINGS.includes('documents.allowedPhases')) {
      workTypeBecause['documents.allowedPhases'] = keptWorkflowReason(workTypeWords('documents.allowedPhases', after, labelOf));
    }
  }
  if (Object.keys(workTypeBecause).length) workType.because = workTypeBecause;
  return { steps, workType, kept, stuck };
}

/** `value` with `patch` laid over it as a workflow override is: approval, generation, artifact and because key by key. */
function layOver(value, patch) {
  const out = isMapping(value) ? structuredClone(value) : {};
  for (const [key, entry] of Object.entries(patch)) {
    out[key] = ['approval', 'generation', 'artifact', 'because', 'documents'].includes(key) && isMapping(out[key]) && isMapping(entry)
      ? { ...out[key], ...entry } : structuredClone(entry);
  }
  return out;
}

function withKept(raw, workflowId, { steps, workType }) {
  const type = raw.workTypes[workflowId];
  if (Object.keys(steps).length) {
    type.phaseOverrides = isMapping(type.phaseOverrides) ? type.phaseOverrides : {};
    for (const [id, patch] of Object.entries(steps)) type.phaseOverrides[id] = layOver(type.phaseOverrides[id], patch);
  }
  if (Object.keys(workType).length) Object.assign(type, layOver(type, workType));
}

// ---------------------------------------------------------------------------------------------
// The screen

const STEP_TEXT = (step) => [[step.id, 2], [step.label, 2], [step.description, 1], ...(step.headings ?? []).map((heading) => [heading, 1])];

const TEST_OUTPUT = new Set(['test-evidence', 'visual-test-evidence']);
const CLAUSE_OUTPUT = new Set(['requirements', 'implementation-spec']);

/**
 * Whether a step can take `intent` and still run exactly as it does (spec §7.5's refusals, which no kept setting can
 * lift): its output kind fits the intent, a test step's output is test results, a requirements step's defines clauses,
 * a code step changes source files and only a code step is one, and only the first step is the intake.
 */
function keepsAs(intent, input, index) {
  const kind = input.kind;
  if (!kindFitsIntent(kind, intent)) return false;
  if (intent === 'test' && !TEST_OUTPUT.has(kind)) return false;
  if (intent === 'requirements' && !CLAUSE_OUTPUT.has(kind)) return false;
  if (intent === 'intake' && index > 0) return false;
  const codeStep = input.task === 'code' || (kind === 'implementation-summary' && input.task == null);
  if (intent === 'code') return input.writeScope === 'source-and-artifact';
  return !codeStep;
}

/**
 * The two or three intents the one question offers (§6.3): the rules' pick, the intents its words lean to, then
 * "Something else", each one the step can take and run as it does. `note` says what an intent its words name needs
 * first, when the step cannot take it as it is.
 */
function questionChoices(row, input, index, also = [], place = []) {
  const scores = [...intentWordScores(STEP_TEXT(input)).entries()].sort(([, left], [, right]) => right.score - left.score).map(([intent]) => intent);
  const named = [...new Set([...also, row.intent, ...scores, ...place].filter((intent) => STEP_INTENTS.includes(intent) && intent !== 'document'))];
  const picks = named.filter((intent) => keepsAs(intent, input, index)).slice(0, 2);
  const blocked = named.find((intent) => !keepsAs(intent, input, index) && ['test', 'requirements', 'code'].includes(intent));
  const choices = [...picks, ...(keepsAs('document', input, index) ? ['document'] : [])].map((intent) => ({ intent,
    text: `${intent === 'document' && !picks.length ? 'Writes a document' : intent === 'document' ? 'Something else' : stepIntentChoice(intent).label} (${intent})` }));
  const needs = { test: 'its output be test results', requirements: 'its output be requirements', code: 'it change source files' }[blocked];
  return { choices, ...(blocked ? { note: `It reads like a ${blocked} step, which needs ${needs}; change that in Workflow Studio, where you see what it changes.` } : {}) };
}
const question = (label, picked) => ({ question: `What does "${label}" do?`, ...picked });

const NAMED_PLAN = 'the workflow names it as the plan of a code step';

/**
 * The rows as configuration will take them: an intent never contradicts the step's output kind, which configuration
 * refuses (spec §7.5). A step the workflow names as a code step's plan keeps what its kind says it is (an intake or a
 * design can plan the code step: the workflow's own plan owners stay), and a step citing test results whose kind is a
 * conformance report is a review.
 */
function byKind(rows, inputs, owners) {
  const plain = owners.length ? inferStepIntents(inputs, { planOwners: [] }) : rows;
  return rows.map((row, index) => {
    if (row.source === 'declared') return row;
    const kind = inputs[index].kind;
    if (row.why === NAMED_PLAN && plain[index].intent !== 'plan' && plain[index].confidence === 'certain') {
      return { ...plain[index], why: `${plain[index].why}; the workflow names it as the plan of a code step, which it stays` };
    }
    const fits = intentsForKind(kind);
    // An output kind only one intent writes settles the step, whatever its words say.
    if (fits?.length === 1 && (row.confidence !== 'certain' || row.intent !== fits[0])) {
      return { step: row.step, intent: fits[0], confidence: 'certain', source: 'structure', why: `its output kind is ${kind}` };
    }
    if (kindFitsIntent(kind, row.intent)) return row;
    const intent = fits.includes(plain[index].intent) ? plain[index].intent
      : kind === 'requirements' ? (index === 0 ? 'intake' : 'requirements') : fits[0];
    return { step: row.step, intent, confidence: 'certain', source: 'structure', why: `its output kind is ${kind}, which a ${row.intent} step does not write` };
  });
}

/** One step as the §6.1 rules read it: its words and agent from workflow.yml, its structure as the workflow resolves it. */
function stepInput(id, raw, resolvedPhase, { agentOf, headings }) {
  const own = isMapping(raw.phases?.[id]) ? raw.phases[id] : {};
  const phase = resolvedPhase ?? own;
  const shipped = Object.hasOwn(PACKAGED_STEP_INTENTS, id) && isKnownPackagedWorkflowValue('phases', id, own) ? PACKAGED_STEP_INTENTS[id] : null;
  return {
    id, label: typeof own.label === 'string' ? own.label : id, description: typeof own.description === 'string' ? own.description : null,
    headings: headings?.[id] ?? [], agent: agentOf(id), declared: STEP_INTENTS.includes(own.intent) ? own.intent : null, shipped,
    kind: phase.artifact?.kind ?? null, task: isMapping(phase.generation) ? phase.generation.task ?? null : null,
    writeScope: phase.writeScope ?? 'artifact-only', testEvidenceFrom: phase.testEvidenceFrom || null, repositoryTests: phase.repositoryTests ?? null
  };
}

/**
 * The definition as configuration loads it: compatibility, the agents loadDefinition found, then validation, which
 * resolves every workflow. Throws as configuration would.
 */
function prepared(raw, agents) {
  const definition = applyWorkflowCompatibility(structuredClone(raw));
  definition.agents = agents.byId;
  definition.agentCatalog = agents.catalog;
  if (agents.root) definition.agentPromptsRoot = agents.root;
  return validateDefinition(definition);
}

/** The screen's code: exactly the rows, intents, badges, kept settings and questions it shows. */
export function intentScreenCode(workflows) {
  const text = JSON.stringify(workflows.map((entry) => [entry.workflow, entry.status, entry.reason ?? null, entry.rows.map((row) => [
    row.step, row.intent, row.badge, (row.kept ?? []).map((item) => item.setting), row.question?.choices.map((choice) => choice.intent) ?? null])]));
  return createHash('sha256').update(text).digest('hex').slice(0, 6);
}

/**
 * The intent pass over one workflow.yml as data (`raw`, as written). `loaded` is the configuration loadDefinition gives
 * for it (its agents); `packaged` the packaged workflow.yml, whose work types are SFlow's; `headings` each step's
 * template headings (step ID → list), for the word rules; `answers` the person's picks for the rows that ask
 * (step ID → intent, each one of that question's choices).
 *
 * Returns `{ workflows, counts, code, after, intents }`: each of the repository's own workflows whose steps do not all
 * say what they are for, with its status (ready, needs-answer or held, with why) and its rows (step, intent, badge,
 * why, the settings it keeps, the one question when it asks); `after` the workflow.yml data confirming writes, or null
 * when nothing is ready; `intents` the steps it gives an intent.
 */
export function intentScreen(raw, { loaded = null, packaged = null, headings = {}, answers = {} } = {}) {
  const agents = { catalog: loaded?.agentCatalog ?? [], byId: loaded?.agents ?? {}, root: loaded?.agentPromptsRoot ?? null };
  const workTypes = isMapping(raw?.workTypes) ? raw.workTypes : {};
  const phases = isMapping(raw?.phases) ? raw.phases : {};
  const packagedTypes = new Set(Object.keys(packaged?.workTypes ?? {}));
  const protectedSteps = new Set(Object.keys(workTypes).filter((id) => packagedTypes.has(id)).flatMap((id) => workTypes[id]?.phases ?? []));
  const labelOf = (id) => (typeof phases[id]?.label === 'string' ? phases[id].label : id);
  const agentOf = (id) => agents.catalog.find((agent) => agent.defaultFor?.includes(id))?.id ?? null;
  const own = Object.entries(workTypes).filter(([id, type]) => !packagedTypes.has(id) && isMapping(type) && Array.isArray(type.phases)
    && type.phases.length && !workTypeDerivesIntents(raw, type));
  if (!own.length) return { workflows: [], counts: counts([]), code: intentScreenCode([]), after: null, intents: {} };
  const before = prepared(raw, agents);
  const today = new Map(Object.keys(workTypes).map((id) => [id, resolvedOrRefused(before, id)]));

  // Each workflow's rows, by the deterministic rules alone.
  const workflows = [];
  const inputs = new Map();
  for (const [id, type] of own) {
    const entry = { workflow: id, label: typeof type.label === 'string' ? type.label : id, status: 'ready', reason: null, rows: [] };
    workflows.push(entry);
    const hold = (reason) => { entry.status = 'held'; entry.reason = reason; };
    const steps = type.phases;
    const shipped = steps.filter((step) => protectedSteps.has(step) && !STEP_INTENTS.includes(phases[step]?.intent));
    const { resolved, error } = today.get(id);
    if (steps.some((step) => phases[step]?.kind === 'skill')) {
      hold('It has a compiled skill step, which runs as its reviewed binding says, so its steps keep their settings.');
      continue;
    }
    if (shipped.length) {
      hold(`It uses ${listed(shipped.map(labelOf))}, ${shipped.length === 1 ? 'a step' : 'steps'} SFlow ships, which ${shipped.length === 1 ? 'says' : 'say'} `
        + 'what it is for once SFlow\'s own update brings its intent, so this workflow keeps its settings until then. To say what each step is for now, '
        + 'use copies of those steps in Workflow Studio.');
      continue;
    }
    if (error) { hold(`SFlow cannot resolve it today, so it keeps its settings: ${firstLine(error.message)} See what to fix: singularity-flow workflow check ${id}`); continue; }
    try { assertWorkTypeStartable(resolved); } catch (refusal) {
      hold(`Stories cannot start from it today, so it keeps its settings until that is fixed: ${firstLine(refusal.message)} See what to fix: singularity-flow workflow check ${id}`);
      continue;
    }
    const stepInputs = steps.map((step) => stepInput(step, raw, resolved.phases.find((phase) => phase.id === step), { agentOf, headings }));
    stepInputs.forEach((input) => inputs.set(input.id, input));
    const owners = isMapping(type.plannedClaims?.owners) ? Object.values(type.plannedClaims.owners).filter((owner) => typeof owner === 'string') : [];
    const inferred = byKind(inferStepIntents(stepInputs, { planOwners: owners }), stepInputs, owners);
    const codeAt = inferred.flatMap((row, index) => (row.intent === 'code' ? [index] : []));
    // What a step's place leans to (§6.1), for the question's choices.
    const place = (index) => [...(index === 0 ? ['intake'] : []), ...(codeAt.length && index === Math.min(...codeAt) - 1 ? ['plan'] : []),
      ...(codeAt.length && index > Math.max(...codeAt) ? ['review', 'release', 'report'] : []),
      ...(!codeAt.length && index === steps.length - 1 ? ['report'] : [])];
    entry.rows = inferred.map((row, index) => {
      const out = { step: row.step, label: labelOf(row.step), intent: row.intent, confidence: row.confidence, source: row.source, why: row.why };
      if (row.source === 'declared') return { ...out, badge: 'declared', declared: true };
      // §5: a workflow has at most one intake, and it is its first step.
      if (row.intent === 'intake' && index > 0) {
        return { ...out, confidence: 'unclear', why: `${row.why}, but only a workflow's first step captures the request`, badge: 'needs-answer',
          question: question(out.label, questionChoices({ intent: 'requirements' }, stepInputs[index], index, ['requirements'], place(index))) };
      }
      if (row.confidence === 'certain') return { ...out, badge: 'sure' };
      // A suggestion the step could not take and still run as it does is a question instead.
      if (row.confidence === 'likely' && keepsAs(row.intent, stepInputs[index], index)) return { ...out, badge: 'suggested' };
      return { ...out, confidence: 'unclear', badge: 'needs-answer', question: question(out.label, questionChoices(row, stepInputs[index], index, [], place(index))) };
    });
  }

  // A step means one thing in every workflow. A shared step one workflow's structure settles is that in all of them
  // (a workflow's own override can hide what the step is); one they read two ways, or none settles, asks once.
  const byStep = new Map();
  for (const entry of workflows) {
    for (const row of entry.rows) if (!row.declared) byStep.set(row.step, [...(byStep.get(row.step) ?? []), { row, entry }]);
  }
  for (const [step, uses] of byStep) {
    if (uses.length < 2) continue;
    const rows = uses.map((use) => use.row);
    const settled = uses.filter((use) => use.row.badge === 'sure');
    const sure = [...new Set(settled.map((use) => use.row.intent))];
    if (sure.length === 1) {
      for (const row of rows.filter((candidate) => candidate.badge !== 'sure')) {
        Object.assign(row, { intent: sure[0], confidence: 'certain', badge: 'sure', why: `${settled[0].row.why} in ${settled[0].entry.label}, and a step means one thing in every workflow` });
        delete row.question;
      }
      continue;
    }
    const intents = [...new Set(rows.map((row) => row.intent))];
    if (intents.length < 2) continue;
    const picked = questionChoices({ intent: intents[0] }, inputs.get(step), Math.max(...uses.map((use) => use.entry.rows.indexOf(use.row))), intents);
    for (const row of rows) {
      Object.assign(row, { badge: 'needs-answer', confidence: 'unclear', why: `its workflows read it as ${listed(intents)}, and a step means one thing in every workflow`,
        question: question(row.label, picked) });
    }
  }
  // The person's answers, each one of its question's choices.
  for (const entry of workflows) {
    for (const row of entry.rows) {
      const answer = answers?.[row.step];
      if (row.question && row.question.choices.some((choice) => choice.intent === answer)) {
        Object.assign(row, { intent: answer, badge: 'yours', why: 'you chose it', answered: true });
      }
    }
    // A step no intent fits without changing how it runs keeps its workflow as it is, with what it needs first.
    const unfit = entry.rows.find((row) => row.badge === 'needs-answer' && !row.question.choices.length);
    if (entry.status !== 'held' && unfit) {
      Object.assign(entry, { status: 'held', reason: `${unfit.label} cannot say what it is for and still run as it does, so this workflow keeps its settings. `
        + `${unfit.question.note ?? ''} Say what each step is for with what it changes in view: singularity-flow workflow build start --intents ${entry.workflow}`.trim() });
    } else if (entry.status === 'ready' && entry.rows.some((row) => row.badge === 'needs-answer')) entry.status = 'needs-answer';
  }

  // Give every ready workflow's steps their intents, keep what they would change, and check every workflow resolves as
  // before. One that cannot be kept so is held with why, and the rest are tried again without it.
  let result = null;
  for (let round = 0; round <= workflows.length; round += 1) {
    const ready = workflows.filter((entry) => entry.status === 'ready');
    if (!ready.length) break;
    result = converted(raw, ready, { workTypes, today, agents, labelOf });
    if (!result.held.size) break;
    for (const [workflowId, reason] of result.held) Object.assign(workflows.find((entry) => entry.workflow === workflowId), { status: 'held', reason });
    result = null;
  }
  for (const entry of workflows) {
    for (const row of entry.rows) {
      row.badgeText = INTENT_SCREEN_BADGES[row.badge];
      row.intentLabel = stepIntentChoice(row.intent)?.label ?? row.intent;
      const kept = entry.status === 'ready' ? (result?.kept.get(entry.workflow) ?? []).filter((item) => item.step === row.step) : [];
      if (kept.length) row.kept = kept;
    }
    const workflowKept = entry.status === 'ready' ? (result?.kept.get(entry.workflow) ?? []).filter((item) => item.step == null) : [];
    if (workflowKept.length) entry.kept = workflowKept;
    if (entry.status !== 'ready') for (const row of entry.rows) delete row.kept;
  }
  return { workflows, counts: counts(workflows), code: intentScreenCode(workflows), after: result?.after ?? null, intents: result?.intents ?? {} };
}

/** How many workflows are ready, steps get an intent, steps keep earlier settings, steps ask, and workflows are held. */
function counts(workflows) {
  const ready = workflows.filter((entry) => entry.status === 'ready');
  const steps = (rows) => new Set(rows.map((row) => row.step)).size;
  return {
    workflows: ready.length,
    steps: steps(ready.flatMap((entry) => entry.rows).filter((row) => !row.declared)),
    kept: steps(ready.flatMap((entry) => entry.rows).filter((row) => row.kept?.length)),
    open: steps(workflows.flatMap((entry) => entry.rows).filter((row) => row.badge === 'needs-answer')),
    held: workflows.filter((entry) => entry.status === 'held').length
  };
}

/**
 * The ready workflows given their intents, with their kept settings: `{ after, intents, kept, held }`, where `held`
 * names each workflow that could not be kept as it was, with why. Every other workflow of the file must resolve as
 * before too: one that shares a step with a ready workflow and would change holds that workflow back.
 */
function converted(raw, ready, { workTypes, today, agents, labelOf }) {
  const intents = {};
  for (const entry of ready) for (const row of entry.rows) if (!row.declared) intents[row.step] = row.intent;
  const intentOf = (id) => intents[id] ?? raw.phases[id]?.intent;
  const after = structuredClone(raw);
  for (const [id, intent] of Object.entries(intents)) after.phases[id] = { intent, ...after.phases[id] };
  if (!(Number.isSafeInteger(after.version) && after.version >= INTENTS_FILE_VERSION)) after.version = INTENTS_FILE_VERSION;
  const kept = new Map();
  const held = new Map();
  const readyIds = new Set(ready.map((entry) => entry.workflow));
  // Every other workflow of the file must run as before too: one sharing a step that now says what it is for, and one a
  // version 4 file would let derive.
  const others = Object.keys(workTypes).filter((id) => !readyIds.has(id));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let definition;
    try { definition = prepared(after, agents); } catch (error) {
      const named = error?.details?.workType;
      const reason = `With its intents, configuration would refuse it: ${firstLine(error.message)}`;
      for (const entry of ready) if (!named || named === entry.workflow || !readyIds.has(named)) held.set(entry.workflow, reason);
      return { after: null, intents, kept, held };
    }
    let changed = false;
    for (const entry of ready) {
      const { resolved, error } = resolvedOrRefused(definition, entry.workflow);
      if (error) { held.set(entry.workflow, `With its intents, configuration would refuse it: ${firstLine(error.message)}`); continue; }
      const before = withoutIntentPins(today.get(entry.workflow).resolved);
      const now = withoutIntentPins(resolved);
      if (same(before, now)) continue;
      const keeps = keptSettings(after, entry.workflow, before, now, { intentOf, labelOf });
      const fresh = keeps.kept.filter((item) => !(kept.get(entry.workflow) ?? []).some((known) => known.step === item.step && known.setting === item.setting));
      if (keeps.stuck.length || (!Object.keys(keeps.steps).length && !Object.keys(keeps.workType).length) || attempt === 3) {
        const paths = keeps.stuck.length ? keeps.stuck : differences(before, now);
        held.set(entry.workflow, `Its settings could not be kept exactly as they are (${listed(paths.slice(0, 4))}${paths.length > 4 ? ', …' : ''}), `
          + `so it keeps them as they are. Say what each step is for with what it changes in view: singularity-flow workflow build start --intents ${entry.workflow}`);
        continue;
      }
      kept.set(entry.workflow, [...(kept.get(entry.workflow) ?? []), ...fresh]);
      withKept(after, entry.workflow, keeps);
      changed = true;
    }
    if (held.size) return { after: null, intents, kept, held };
    if (changed) continue;
    for (const other of others) {
      const now = resolvedOrRefused(definition, other);
      const was = today.get(other);
      const unchanged = now.resolved && was.resolved ? same(withoutIntentPins(was.resolved), withoutIntentPins(now.resolved)) : Boolean(now.error && was.error);
      if (unchanged) continue;
      const name = workTypes[other]?.label ?? other;
      const shared = (workTypes[other]?.phases ?? []).filter((step) => Object.hasOwn(intents, step));
      const sharing = ready.filter((entry) => entry.rows.some((row) => shared.includes(row.step)));
      for (const entry of sharing) {
        held.set(entry.workflow, `It shares ${listed(shared.map(labelOf))} with ${name}, which would run differently once `
          + `${shared.length === 1 ? 'that step says' : 'those steps say'} what ${shared.length === 1 ? 'it is' : 'they are'} for, so both keep their settings.`);
      }
      if (!sharing.length) {
        for (const entry of ready) held.set(entry.workflow, `${name} would run differently in a version ${INTENTS_FILE_VERSION} workflow.yml, so this file keeps its version and every workflow its settings.`);
      }
    }
    if (held.size) return { after: null, intents, kept, held };
    // A framework setting a step already set itself, other than its intent gives, says why as well, so the upgrade
    // leaves no unexplained override behind (spec §7.5): the reason changes nothing a Story runs.
    if (withReasons(after, definition, ready, intentOf)) {
      try { prepared(after, agents); } catch (error) {
        for (const entry of ready) held.set(entry.workflow, `With its intents, configuration would refuse it: ${firstLine(error.message)}`);
        return { after: null, intents, kept, held };
      }
    }
    return { after, intents, kept, held };
  }
  return { after: null, intents, kept, held };
}

/** Adds a reason for each framework setting a ready workflow's step sets itself against its intent; true when it added one. */
function withReasons(after, definition, ready, intentOf) {
  let added = false;
  for (const entry of ready) {
    let derivation;
    try { derivation = deriveWorkTypeSettings(definition, entry.workflow); } catch { continue; }
    const type = after.workTypes[entry.workflow];
    for (const warning of derivation?.warnings ?? []) {
      if (warning.code !== 'CHECK_INTENT_OVERRIDE_WITHOUT_REASON' || !warning.setting) continue;
      if (warning.step) {
        if (!BECAUSE_SETTINGS.includes(warning.setting)) continue;
        type.phaseOverrides = isMapping(type.phaseOverrides) ? type.phaseOverrides : {};
        type.phaseOverrides[warning.step] = layOver(type.phaseOverrides[warning.step], { because: {
          [warning.setting]: `${KEPT_BEFORE_INTENTS}, so it runs as it did; the step set it itself, and its ${intentOf(warning.step)} intent gives another value.` } });
      } else {
        if (!WORK_TYPE_BECAUSE_SETTINGS.includes(warning.setting)) continue;
        Object.assign(type, layOver(type, { because: { [warning.setting]: `${KEPT_BEFORE_INTENTS}, so it runs as it did; the workflow set it itself, and its steps' intents give another value.` } }));
      }
      added = true;
    }
  }
  return added;
}

// ---------------------------------------------------------------------------------------------
// The screen as text, routes and the summary line

/** The commands of one repository's screen: confirm it, and confirm it with each answer to each question. */
export function intentScreenRoutes(pass, { repository = null } = {}) {
  const base = ['singularity-flow', 'workspace', 'refresh-configuration', ...(repository ? ['--repository', repository] : []), '--confirm-intents', pass.code];
  const answers = pass.workflows.flatMap((entry) => entry.rows.filter((row) => row.question && row.badge === 'needs-answer')
    .flatMap((row) => row.question.choices.map((choice) => ({ step: row.step, intent: choice.intent, argv: [...base, '--intent', `${row.step}=${choice.intent}`] }))));
  const uniqueAnswers = answers.filter((answer, index) => answers.findIndex((other) => other.step === answer.step && other.intent === answer.intent) === index);
  return {
    ...(pass.counts.workflows ? { confirm: { argv: base, command: base.join(' ') } } : {}),
    answers: uniqueAnswers.map((answer) => ({ ...answer, command: answer.argv.join(' ') }))
  };
}

/** The one screen as plain lines, for the CLI and Copilot's chat (spec §6.4, §8.6). */
export function intentScreenLines(pass) {
  if (!pass?.workflows?.length) return [];
  const lines = [pass.confirmation === 'written' ? 'Step intents, as you confirmed:' : 'Step intents for your own workflows (nothing changes until you confirm):'];
  for (const entry of pass.workflows) {
    const state = entry.status === 'ready' ? (pass.confirmation === 'written' ? 'each step now says what it is for' : 'ready')
      : entry.status === 'needs-answer' ? 'needs your answer first' : 'kept as it is';
    lines.push(`  ${entry.label} (${entry.workflow}): ${state}`);
    if (entry.reason) lines.push(`    ${entry.reason}`);
    for (const row of entry.rows) {
      lines.push(`    ${row.label}: ${row.intent} (${row.intentLabel.toLowerCase()}) [${row.badgeText}] Why: ${row.why}`);
      for (const item of row.kept ?? []) lines.push(`      Keeps ${item.today}; its intent would give: ${item.intent}`);
      if (row.question && row.badge === 'needs-answer') {
        lines.push(`      ${row.question.question}`);
        for (const choice of row.question.choices) lines.push(`        - ${choice.text}`);
        if (row.question.note) lines.push(`      ${row.question.note}`);
      }
    }
    for (const item of entry.kept ?? []) lines.push(`    The workflow keeps ${item.today}; its steps' intents would give: ${item.intent}`);
  }
  if (pass.problems?.length) for (const problem of pass.problems) lines.push(`  ${problem}`);
  const routes = pass.routes ?? {};
  if (pass.confirmation !== 'written' && routes.confirm) lines.push(`  Confirm this screen (code ${pass.code}): ${routes.confirm.command}`);
  for (const answer of routes.answers ?? []) lines.push(`  Answer ${answer.step} as ${answer.intent} and confirm: ${answer.command}`);
  return lines;
}

/** The upgrade's one line about step intents for a repository (spec §8.5), or null when it has nothing to offer. */
export function intentScreenSummary(pass) {
  if (!pass?.workflows?.length) return null;
  const { workflows, steps, kept, open, held } = pass.counts;
  if (pass.confirmation === 'written') {
    return `Step intents: ${plural(steps, 'step', 'steps')} of ${plural(workflows, 'workflow', 'workflows')} now say what they are for`
      + `${kept ? `, ${kept} keeping earlier settings` : ''}; every workflow runs as before.${open ? ` ${plural(open, 'step needs', 'steps need')} your answer: ${pass.routes?.answers?.[0]?.command ?? ''}`.trimEnd() : ''}`;
  }
  const parts = [];
  if (steps) parts.push(`${plural(steps, 'step', 'steps')} of your own workflows can say what they are for${kept ? `, ${kept} keeping earlier settings` : ''}`);
  if (open) parts.push(`${plural(open, 'step needs', 'steps need')} your answer`);
  if (held) parts.push(`${plural(held, 'workflow keeps', 'workflows keep')} its settings for now`);
  if (!steps && !open) return held ? `Step intents: ${parts.join('; ')}.` : null;
  const command = pass.routes?.confirm?.command ?? pass.routes?.answers?.[0]?.command ?? null;
  const stale = pass.confirmation === 'stale' ? ' The code you confirmed named an earlier screen, so nothing was written; this is the screen now.' : '';
  return `Step intents: ${parts.join('; ')}.${stale} Nothing changes until you confirm${command ? `: ${command}` : '.'}`;
}

// ---------------------------------------------------------------------------------------------
// The upgrade's pass over a configuration checkout

const TEMPLATE_HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu;

/** Each step's template headings, for the word rules: read from the checkout, nothing when unreadable. */
async function templateHeadings(root, raw, steps, resolvedPhases) {
  const templatesRoot = typeof raw.templatesRoot === 'string' ? raw.templatesRoot : 'singularity/templates';
  const headings = {};
  await Promise.all(steps.map(async (id) => {
    const template = resolvedPhases.get(id)?.template ?? raw.phases?.[id]?.defaultTemplate;
    if (typeof template !== 'string' || /^(?:agent|template):/u.test(template) || template.includes('..')) return;
    const text = await readFile(path.join(root, templatesRoot, ...template.split('/')), 'utf8').catch(() => null);
    if (text) headings[id] = [...text.matchAll(TEMPLATE_HEADING)].map((match) => match[1]).filter((heading) => !heading.includes('{{')).slice(0, 20);
  }));
  return headings;
}

/** Writes `after` over the file's own text: each new intent first among its step's keys, every other line as it was. */
function intentsText(text, raw, after, intents) {
  const document = YAML.parseDocument(text);
  if (document.errors.length) throw document.errors[0];
  const staged = structuredClone(raw);
  for (const [id, intent] of Object.entries(intents)) {
    const node = document.getIn(['phases', id], true);
    if (!YAML.isMap(node)) continue;
    node.items.unshift(document.createPair('intent', intent));
    staged.phases[id] = { intent, ...staged.phases[id] };
  }
  patchYamlDocument(document, staged, after);
  const written = renderPreservingFormatting(text, document);
  if (!same(YAML.parse(written), after)) throw new Error('the workflow file could not be written as planned');
  return written;
}

/**
 * The upgrade's intent pass over a refreshed configuration checkout (`root`, after the packaged refresh wrote and
 * loaded it): the screen, or with `confirm` (the screen's code) and `answers`, the confirmed intents written into
 * `workflowFile`. Never throws: a confirmation that cannot be written leaves the file as it was and says why.
 *
 * Returns null when the repository's own workflows all say what each step is for already (or it has none), else the
 * screen with `confirmation` when one was asked: written, stale (another code: the screen as it is now is returned),
 * refused (with `problems`), or nothing-ready.
 */
export async function upgradeStepIntents(root, { workflowFile, packaged, loaded, confirm = null, answers = {}, repository = null } = {}) {
  let text;
  let raw;
  try {
    text = await readFile(workflowFile, 'utf8');
    raw = YAML.parse(text);
  } catch { return null; }
  if (!isMapping(raw?.workTypes) || !isMapping(raw?.phases)) return null;
  await loadStepIntentSettings();
  const packagedTypes = new Set(Object.keys(packaged?.workTypes ?? {}));
  const ownSteps = [...new Set(Object.entries(raw.workTypes).filter(([id]) => !packagedTypes.has(id)).flatMap(([, type]) => type?.phases ?? []))];
  const resolvedPhases = new Map();
  for (const id of Object.keys(raw.workTypes).filter((workType) => !packagedTypes.has(workType))) {
    try { for (const phase of resolveWorkType(loaded, id).phases) resolvedPhases.set(phase.id, phase); } catch { /* the pass reports it */ }
  }
  const headings = await templateHeadings(root, raw, ownSteps, resolvedPhases);
  const routed = (pass, extra = {}) => {
    const out = { schemaVersion: 1, ...pass, ...extra };
    delete out.after;
    delete out.intents;
    out.routes = intentScreenRoutes(out, { repository });
    return { ...out, summary: intentScreenSummary(out) };
  };
  let screen;
  try { screen = intentScreen(raw, { loaded, packaged, headings }); }
  catch (error) { return { schemaVersion: 1, workflows: [], counts: counts([]), code: null, error: firstLine(error.message) }; }
  if (!screen.workflows.length) return null;
  if (confirm == null) return routed(screen);
  if (String(confirm) !== screen.code) {
    return routed(screen, { confirmation: 'stale', problems: [`Code ${confirm} names a screen that has changed since it was shown; nothing was written. `
      + `This is the screen as it is now, with its own code ${screen.code}.`] });
  }
  const problems = [];
  const rows = new Map(screen.workflows.flatMap((entry) => entry.rows).map((row) => [row.step, row]));
  for (const [step, intent] of Object.entries(answers ?? {})) {
    const row = rows.get(step);
    if (!row?.question || row.badge !== 'needs-answer') problems.push(`${row ? row.label : step} has no question on this screen, so it takes no answer; nothing was written.`);
    else if (!row.question.choices.some((choice) => choice.intent === intent)) {
      problems.push(`${row.label} is answered with one of ${listed(row.question.choices.map((choice) => choice.intent))}, not ${intent}; nothing was written.`);
    }
  }
  if (problems.length) return routed(screen, { confirmation: 'refused', problems });
  const final = Object.keys(answers ?? {}).length ? intentScreen(raw, { loaded, packaged, headings, answers }) : screen;
  if (!final.after) return routed(final, { confirmation: 'nothing-ready' });
  let written;
  try { written = intentsText(text, raw, final.after, final.intents); }
  catch (error) { return routed(screen, { confirmation: 'refused', problems: [`The workflow file could not be written: ${firstLine(error.message)} Nothing was written.`] }); }
  await writeAtomic(workflowFile, written);
  // From the checkout as written: it loads, and every workflow resolves as it did.
  try {
    const reloaded = await withoutReadScope(() => loadDefinition(root));
    const moved = Object.keys(raw.workTypes).filter((id) => {
      const was = resolvedOrRefused(loaded, id);
      const now = resolvedOrRefused(reloaded, id);
      return was.resolved && now.resolved ? !same(withoutIntentPins(was.resolved), withoutIntentPins(now.resolved)) : Boolean(was.error) !== Boolean(now.error);
    });
    if (moved.length) throw new Error(`${listed(moved)} would resolve differently`);
  } catch (error) {
    await writeAtomic(workflowFile, text);
    return routed(screen, { confirmation: 'refused', problems: [`The confirmed intents did not load as planned (${firstLine(error.message)}); nothing was written.`] });
  }
  // What is left for another time (a question not answered, a workflow held): its routes name the screen the next
  // upgrade shows, which is the written file's.
  let rest = null;
  try { rest = intentScreen(final.after, { loaded, packaged, headings }); } catch { rest = null; }
  const shown = { ...routed(final, { confirmation: 'written', version: final.after.version,
    written: final.workflows.filter((entry) => entry.status === 'ready').map((entry) => entry.workflow) }),
  routes: rest?.workflows.length ? intentScreenRoutes(rest, { repository }) : { answers: [] },
  ...(rest?.workflows.length ? { next: { code: rest.code, counts: rest.counts } } : {}) };
  return { ...shown, summary: intentScreenSummary(shown) };
}
