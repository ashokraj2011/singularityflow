/**
 * The one screen that says what each step of a workflow is for (step intents spec §6.3, §6.4, §5; Stage 3), as data
 * every surface shows the same way: Workflow Studio's Build view, Copilot's table and question, and the CLI's text.
 *
 * - Each row: the step, its intent, how sure SFlow is (a badge: SFlow is sure, Copilot suggests, SFlow suggests, your
 *   choice, or your answer needed), why, and three short consequences of that intent in this workflow ("Changes code ·
 *   A person approves · Asks when unclear"). A row that needs the person's answer carries the one question, with the
 *   top two or three intents and each one's main consequence; never a free-text answer. Every row carries the intents
 *   a person may pick, each with its consequences, so a page shows a change at once.
 * - The workflow facts below the rows: where requirement IDs are written, which step is the plan, which steps a person
 *   approves, what is left out and why.
 * - The two questions the workflow rules ask (§5), each with its two ways as moves: nothing before a code step plans
 *   it, or nothing before it writes the requirements.
 * - A short code that names exactly this table: confirming with it writes every step's intent and version 4.
 *
 * Inference comes first (the deterministic §6.1 rows workflow check gives), then Copilot's proposal for the steps that
 * are not certain, then the person's own choices. Pure: it reads only what it is given and imports only modules that
 * read nothing, so a page can run it as the Builder does.
 */
import { createHash } from 'node:crypto';

import { INTENTS_FILE_VERSION, STEP_INTENTS } from './phase-roles.mjs';
import { deriveWorkTypeSettings } from './step-intent-settings.mjs';
import { PACKAGED_STEP_INTENTS } from './packaged-step-intents.mjs';
import { STEP_INTENT_CHOICES, stepIntentChoice } from './step-outputs.mjs';

export const INTENT_BADGES = Object.freeze({
  sure: 'SFlow is sure', copilot: 'Copilot suggests', suggested: 'SFlow suggests', yours: 'Your choice', 'needs-answer': 'Your answer needed'
});

const isMapping = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const listed = (values) => (values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`);

/**
 * The definition as it would be with these intents: every step of the workflow given one, in a version 4 file. Only the
 * steps it gives an intent are copied: the derivation copies what it reads and changes nothing it is given.
 */
function withIntents(definition, workflowId, intents) {
  const phases = { ...definition.phases };
  for (const id of definition.workTypes[workflowId].phases) {
    if (isMapping(phases[id]) && intents[id]) phases[id] = { ...phases[id], intent: intents[id] };
  }
  return { ...definition, version: Math.max(Number.isSafeInteger(definition.version) ? definition.version : 0, INTENTS_FILE_VERSION), phases };
}

function derive(definition, workflowId, intents, groups) {
  try { return deriveWorkTypeSettings(withIntents(definition, workflowId, intents), workflowId, { groups }); } catch { return null; }
}

/** The three short consequences of a step's derived settings: code, who approves it, its questions. */
export function intentConsequences(settings) {
  if (!settings) return [];
  const approval = settings.approval;
  const none = approval === 'none' || approval?.mode === 'none';
  const mode = typeof settings.clarification === 'string' ? settings.clarification : settings.clarification?.mode ?? 'off';
  return [
    settings.writeScope === 'source-and-artifact' ? 'Changes code' : 'Changes no code',
    none ? 'Nobody approves it' : approval?.automatic === 'when-ready' ? 'SFlow approves it when clean' : 'A person approves it',
    mode === 'required' ? 'Asks every time' : mode === 'when-needed' ? 'Asks when unclear' : 'Asks nothing'
  ];
}

/** A short code that names exactly what the person saw: confirming with another code is refused. */
export function intentTableCode(workflowId, rows, factLines) {
  const text = JSON.stringify({ workflowId, rows: rows.map((row) => [row.step, row.intent]), factLines });
  return createHash('sha256').update(text).digest('hex').slice(0, 6);
}

/**
 * The workflow facts in plain lines, read from a derivation: where requirement IDs are written, the plan, who approves,
 * what is left out.
 */
function factsOf(derivation, label) {
  if (!derivation) return { requirementIds: [], plan: [], personApproves: [], leftOut: [], lines: [] };
  const person = derivation.steps.filter((step) => {
    const approval = step.settings.approval;
    return !(approval === 'none' || approval?.mode === 'none') && approval?.automatic !== 'when-ready';
  }).map((step) => step.id);
  const facts = {
    requirementIds: [...derivation.facts.scopeSteps],
    plan: [...derivation.planSteps],
    personApproves: person,
    leftOut: derivation.workType.omits.map((entry) => ({ responsibility: entry?.responsibility, reason: entry?.reason ?? '' }))
  };
  facts.lines = [
    facts.requirementIds.length ? `Requirement IDs are written in ${listed(facts.requirementIds.map(label))}.` : 'No step writes requirement IDs.',
    facts.plan.length ? `The plan: ${listed(facts.plan.map(label))}.` : 'No step is the plan.',
    person.length ? `A person approves ${listed(person.map(label))}.` : 'No step waits for a person\'s approval.',
    ...facts.leftOut.map((entry) => `Left out: ${entry.responsibility}. ${entry.reason}`)
  ];
  return facts;
}

/**
 * The §5 questions a workflow's rules ask, each with its two ways as builder moves (the first recommended): nothing
 * before a code step plans it, or nothing before it writes the requirements. `freeId` gives an unused step ID,
 * `agentFor` the agent a new step of an intent is drafted by.
 */
function ruleQuestions(derivation, { label, freeId, agentFor, approverOf }) {
  if (!derivation) return [];
  const { facts } = derivation;
  const ids = derivation.steps.map((step) => step.id);
  const questions = [];
  const omit = (responsibility, reason, code) => ({ move: 'workflow.omit', responsibility, reason, authority: approverOf(code) });
  if (facts.unplanned.length) {
    const code = facts.unplanned[0];
    const name = label(code);
    const before = ids[ids.indexOf(code) - 1] ?? null;
    const planId = freeId(`${code}-plan`);
    const writesIds = facts.scopeSteps.length > 0;
    questions.push({ kind: 'unplanned', step: code,
      question: `Nothing before ${name} plans its change. Add a short plan step before ${name}, or let ${name} plan its own change?`,
      choices: [
        { key: 'add-plan', label: `Add a short plan step before ${name} (recommended)`, recommended: true,
          moves: [{ move: 'step.add', id: planId, label: `Plan ${name}`.slice(0, 120), intent: 'plan', after: before, agent: agentFor('plan', code),
            purpose: `Lists the exact changes ${name} makes and the tests that prove each requirement; a person approves it before the code changes.`.slice(0, 600) }] },
        { key: 'plans-itself', label: `Let ${name} plan its own change`,
          moves: [...(writesIds ? [] : [omit('scope', `${name} works without requirement IDs; no step before it writes requirements.`, code)]),
            omit('plan', `${name} plans and makes its change itself, in its one step, from its own instructions.`, code)] }
      ] });
  } else if (facts.hasCode && !facts.scopeSteps.length && !(derivation.workType.omits ?? []).some((entry) => entry?.responsibility === 'scope')) {
    const code = facts.codeSteps[0];
    const name = label(code);
    questions.push({ kind: 'unscoped', step: code,
      question: `No step before ${name} writes the requirements it builds. Add a requirements step before it, or let ${name} work without requirement IDs?`,
      choices: [
        { key: 'add-requirements', label: `Add a requirements step at the start (recommended)`, recommended: true,
          moves: [{ move: 'step.add', id: freeId('requirements'), label: 'Requirements', intent: 'requirements', after: null, agent: agentFor('requirements', code),
            purpose: `Writes the numbered, testable requirements and acceptance criteria ${name} builds and the later steps cite.`.slice(0, 600) }] },
        { key: 'no-requirement-ids', label: `Let ${name} work without requirement IDs`, moves: [omit('scope', `${name} works without requirement IDs; no step before it writes requirements.`, code)] }
      ] });
  }
  return questions;
}

/**
 * The intents table of one workflow. `definition` is workflow.yml as written (the build's candidate); `rows` the §6.1
 * inference workflow check gives (`{ step, intent, confidence, source, why }`); `proposed` Copilot's pending step.intent
 * moves (step → `{ intent, why, proposal }`); `chosen` the person's own picks (step → intent); `confirmed` what the
 * person confirmed before (step → intent), if anything; `groups` the repository's approval groups; `agents` the agent
 * IDs it has, with `agentOf(step)` the agent of a step; `protectedSteps` and `seededWorkflows` the steps and workflows
 * SFlow ships that the repository has as shipped (seeded-workflow-protection.mjs).
 *
 * A step SFlow ships takes only its packaged intent. Since Stage 4 the shipped workflow.yml says it on every step; a
 * repository the upgrade kept on an earlier version has the shipped steps without it, and such a step takes none while
 * that would make a shipped workflow derive from intents before the repository moves to version 4. Either way the
 * workflow keeps its own settings, and `derivable` is false.
 */
export function intentTable(definition, workflowId, { rows = [], proposed = {}, chosen = {}, confirmed = null, groups = null, agents = [], agentOf = () => null,
  protectedSteps = [], seededWorkflows = [] } = {}) {
  const workType = definition?.workTypes?.[workflowId];
  if (!isMapping(workType) || !Array.isArray(workType.phases)) return null;
  const label = (id) => (typeof definition.phases?.[id]?.label === 'string' ? definition.phases[id].label : id);
  const byStep = new Map(rows.map((row) => [row.step, row]));
  const skill = (id) => definition.phases?.[id]?.kind === 'skill';
  const ids = workType.phases.filter((id) => !skill(id));
  const known = (intent) => STEP_INTENTS.includes(intent);

  const entries = ids.map((id) => {
    const row = byStep.get(id) ?? { step: id, intent: 'document', confidence: 'unclear', source: 'none', why: 'nothing in it says what it is for' };
    const mine = known(chosen[id]) ? chosen[id] : null;
    const copilot = known(proposed[id]?.intent) ? proposed[id] : null;
    const certain = row.confidence === 'certain';
    let intent = row.intent;
    let badge;
    let why = row.why;
    if (mine) { intent = mine; badge = 'yours'; why = 'you chose it'; }
    else if (certain) badge = 'sure';
    else if (copilot && row.confidence === 'likely' && copilot.intent !== row.intent) { badge = 'needs-answer'; why = `${row.why}; Copilot says ${copilot.intent}: ${copilot.why}`; }
    else if (copilot) { intent = copilot.intent; badge = 'copilot'; why = copilot.why; }
    else badge = row.confidence === 'likely' ? 'suggested' : 'needs-answer';
    // A step SFlow ships, or one its structure decides, keeps that intent; to change it, copy the step.
    const locked = certain && ['shipped', 'structure'].includes(row.source);
    const candidates = [...new Set([row.intent, copilot?.intent, row.inferred?.intent].filter(known))];
    return { step: id, label: label(id), intent, confidence: row.confidence, source: mine ? 'person' : badge === 'copilot' ? 'copilot' : row.source,
      why, badge, badgeText: INTENT_BADGES[badge], locked, candidates, ...(copilot ? { proposal: copilot.proposal } : {}) };
  });
  const current = Object.fromEntries(entries.map((entry) => [entry.step, entry.intent]));
  const registered = groups ?? Object.keys(definition.approvalAuthorities ?? {});
  const derivation = derive(definition, workflowId, current, registered);
  const settingsOf = (result, id) => result?.steps.find((step) => step.id === id)?.settings ?? null;

  // Each intent a person may pick for a row, with what it would mean in this workflow.
  const optionsFor = (entry) => (entry.locked ? [entry.intent] : STEP_INTENTS).map((intent) => {
    const result = intent === entry.intent ? derivation : derive(definition, workflowId, { ...current, [entry.step]: intent }, registered);
    return { intent, label: stepIntentChoice(intent).label, consequences: intentConsequences(settingsOf(result, entry.step)) };
  });
  const table = entries.map((entry) => {
    const options = optionsFor(entry);
    const consequences = options.find((option) => option.intent === entry.intent)?.consequences ?? [];
    const out = { step: entry.step, label: entry.label, intent: entry.intent, intentLabel: stepIntentChoice(entry.intent).label, confidence: entry.confidence,
      source: entry.source, why: entry.why, badge: entry.badge, badgeText: entry.badgeText, consequences, options,
      ...(entry.locked ? { locked: true } : {}), ...(entry.proposal ? { proposal: entry.proposal } : {}) };
    if (entry.badge === 'needs-answer') {
      // The one question: the top candidates, each with its main consequence, and "something else" as a document.
      const picks = [...entry.candidates, 'document'].filter((intent, index, all) => all.indexOf(intent) === index).slice(0, 3);
      out.question = { question: `What does "${entry.label}" do?`, choices: picks.map((intent) => {
        const option = options.find((candidate) => candidate.intent === intent);
        const words = intent === 'document' && !entry.candidates.includes('document') ? 'Something else' : stepIntentChoice(intent).label;
        return { intent, text: `${words} (${intent}: ${(option?.consequences[1] ?? '').replace(/^./u, (first) => first.toLowerCase())})` };
      }) };
    }
    return out;
  });

  const facts = factsOf(derivation, label);
  // A step SFlow ships keeps its packaged intent; one workflow.yml does not say it for yet (a repository kept on an earlier
  // version, Stage 4) takes none while giving it one would change a shipped workflow.
  const written = (id) => (typeof definition.phases?.[id]?.intent === 'string' ? definition.phases[id].intent : null);
  const declaredAfter = (id) => current[id] ?? written(id);
  const completes = seededWorkflows.filter((id) => Array.isArray(definition.workTypes?.[id]?.phases)
    && definition.workTypes[id].phases.every((phase) => definition.phases?.[phase]?.kind === 'skill' || declaredAfter(phase)));
  const otherIntent = protectedSteps.filter((id) => ids.includes(id) && current[id] !== PACKAGED_STEP_INTENTS[id]);
  const notYet = protectedSteps.filter((id) => ids.includes(id) && !otherIntent.includes(id) && !written(id)
    && completes.some((workflow) => definition.workTypes[workflow].phases.includes(id)));
  const held = new Set([...otherIntent, ...notYet]);
  for (const row of table) if (held.has(row.step)) row.writable = false;
  const derivable = held.size === 0;
  const steps = (list) => `${listed(list.map(label))} ${list.length === 1 ? 'is a step' : 'are steps'} SFlow ships`;
  if (otherIntent.length) {
    facts.lines.push(`${steps(otherIntent)} with what ${otherIntent.length === 1 ? 'it is' : 'they are'} for (${otherIntent.map((id) => `${label(id)}: ${PACKAGED_STEP_INTENTS[id]}`).join(', ')}), `
      + 'so this workflow keeps its own settings; nothing to confirm. To give one another intent, use a copy of it.');
  }
  if (notYet.length) {
    facts.lines.push(`${steps(notYet)}, which this repository's workflow.yml keeps without what ${notYet.length === 1 ? 'it is' : 'they are'} for until it moves to `
      + 'version 4, so this workflow keeps its own settings too; nothing to confirm. To derive them now, use copies of those steps.');
  }
  const phaseIds = new Set(Object.keys(definition.phases ?? {}));
  const freeId = (stem) => { let id = stem; for (let index = 2; phaseIds.has(id); index += 1) id = `${stem}-${index}`; return id; };
  const agentFor = (intent, near) => {
    const wanted = { plan: 'architect', requirements: 'product-owner' }[intent];
    return agents.includes(wanted) ? wanted : agentOf(near) ?? agents[0] ?? null;
  };
  const approverOf = (id) => settingsOf(derivation, id)?.approval?.authorities?.[0] ?? registered[0] ?? null;
  const questions = ruleQuestions(derivation, { label, freeId, agentFor, approverOf });
  const problems = (derivation?.refusals ?? []).map(({ step, field, message, fix }) => ({ step, field, message, fix }));
  const warnings = (derivation?.warnings ?? []).map(({ step, setting, code, title, fix }) => ({ step, setting, code, title, fix }));
  const open = table.filter((row) => row.badge === 'needs-answer').length + questions.length;
  const code = intentTableCode(workflowId, table, facts.lines);
  const isConfirmed = isMapping(confirmed) && ids.every((id) => confirmed[id] === current[id]) && Object.keys(confirmed).length === ids.length;
  return { workflow: workflowId, rows: table, facts, questions, problems, warnings, open, code, confirmed: isConfirmed, derivable,
    choices: STEP_INTENT_CHOICES.map(({ id, label: words, detail }) => ({ intent: id, label: words, detail })) };
}

/** The table as plain text lines, for the CLI and for Copilot's chat: rows, facts, questions, and the next command. */
export function intentTableLines(table, { confirm = null, answer = null } = {}) {
  const lines = [`What each step of ${table.workflow} is for:`];
  for (const row of table.rows) {
    lines.push(`  ${row.label}: ${row.intent} (${row.intentLabel.toLowerCase()}) [${row.badgeText}] ${row.consequences.join(' · ')}`);
    lines.push(`      Why: ${row.why}`);
    if (row.question) {
      lines.push(`      ${row.question.question}`);
      for (const choice of row.question.choices) lines.push(`        - ${choice.text}${answer ? `: ${answer(row.step, choice.intent)}` : ''}`);
    }
  }
  for (const line of table.facts.lines) lines.push(`  ${line}`);
  for (const question of table.questions) {
    lines.push(`  ${question.question}`);
    for (const choice of question.choices) lines.push(`    - ${choice.label}`);
  }
  for (const problem of table.problems) lines.push(`  problem  ${problem.message} ${problem.fix}`);
  if (table.confirmed) lines.push('  Confirmed: every step says what it is for.');
  else if (table.open) lines.push(`  ${table.open} ${table.open === 1 ? 'answer is' : 'answers are'} needed before you confirm.`);
  else if (confirm) lines.push(`  Confirm this table (code ${table.code}): ${confirm}`);
  return lines;
}
