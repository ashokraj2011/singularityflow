/**
 * The moves a workflow build is made of, and how they become one Workflow Studio change set.
 *
 * A proposal (from Copilot or the person) is a short list of moves: add or change a step, add an
 * agent from an existing one, add or attach a skill, add an instruction, a decision, an approval
 * group, an action after a step, a check a step runs (a command the material holds), a responsibility
 * a workflow that writes no code leaves out, or say what a found item becomes. Each move is checked on its own
 * (closed fields, IDs, references), every finding located at `moves[i].field`. Accepted moves fold
 * into a draft, and the draft lowers to ordinary Studio operations, so a build finishes through
 * Studio's own reviewed proposal and the check runs on exactly what would be published.
 */
import { CHECK_KINDS } from '../guidance-scan.mjs';
import { scannerCheck } from '../findings/ci-scanners.mjs';
import { looksSecretName, looksSecretValue } from '../secret-looking.mjs';
import { STUDIO_ID as ID } from '../agent-document-parser.mjs';
import { SingularityFlowError } from '../util.mjs';
import { normalizeClarificationPolicy } from '../clarifications.mjs';
import { TEXT_MOVES, applyTextMove, lowerTextEdits, textMoveChecker } from './text-moves.mjs';
import { BECAUSE_SETTINGS, STEP_INTENTS } from '../phase-roles.mjs';
import { STEP_INTENT_CHOICES, stepIntentChoice } from '../step-outputs.mjs';
import { inferStepIntents } from '../step-intents.mjs';
import { intentsForKind } from '../step-intent-settings.mjs';

const OUTPUTS = ['document', 'analysis', 'code', 'none'];
// What step.reset gives back to a step's intent (workflow-assess/checks.mjs RESETTABLE_SETTINGS).
const RESET_SETTINGS = Object.freeze(['writeScope', 'sourceBoundary', 'artifact.kind', 'clarification.mode', 'approval.automatic',
  'approval.rejectTo', 'repositoryTests', 'testEvidenceFrom', 'testRuns', 'repairBudget']);
const TRIGGERS = ['submitted', 'approved', 'rejected'];
const SIGN_OFF_FIELDS = ['groups', 'minimum', 'sendBackTo'];
// What every route of a workflow must hold unless it says why not (src/evidence/obligation-compiler.mjs).
export const RESPONSIBILITIES = Object.freeze(['scope', 'plan', 'implement', 'verify', 'review']);
// A workflow with a code step needs requirements, a plan and the change itself; only one that writes no code leaves them out.
const CODE_NEEDS = new Set(['scope', 'plan', 'implement']);
const ITEM_AS = ['step', 'agent', 'skill', 'instruction', 'prompt', 'document', 'api-call', 'tool', 'link', 'command', 'checkpoint', 'branch', 'script'];
const INPUT_NAME = /^[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/u;
const kebab = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60);

export const MOVES = Object.freeze({
  // intent: what the step does (step intents); a new step starts from it, so it is required on a new step with no `from`.
  // because: { setting: reason } for a setting the step sets itself rather than taking from its intent.
  // changesCode false: the step writes only its own document, never the repository's files (a testing step that only reports).
  'step.add': { required: ['id'], optional: ['label', 'after', 'from', 'agent', 'intent', 'output', 'changesCode', 'reads', 'signOff', 'purpose', 'because'] },
  // edit: { old, new } changes the step's template as this workflow runs it (src/workflow-build/text-moves.mjs).
  'step.change': { required: ['id'], optional: ['label', 'purpose', 'agent', 'intent', 'output', 'changesCode', 'reads', 'signOff', 'edit', 'because'] },
  // What a step does, on its own: Copilot's proposal for a step SFlow is not sure of, or the person's answer.
  'step.intent': { required: ['id', 'intent'], optional: [] },
  // A framework setting a step writes itself, given back to its intent (workflow assess's fix for a setting that needs no override).
  'step.reset': { required: ['id', 'settings'], optional: [] },
  'step.remove': { required: ['id'], optional: [] },
  'step.move': { required: ['id'], optional: ['after'] },
  // command, category, directory and a test command's completed record are filled in from the found
  // command, never written by hand.
  'step.check': { required: ['id', 'item'], optional: ['requirement', 'command', 'category', 'directory', 'record'] },
  // A step's clarifying questions in this workflow only: its whole policy, checked as the loader checks it.
  'step.clarify': { required: ['id', 'mode'], optional: ['topics', 'maxQuestions', 'markers'] },
  'agent.add': { required: ['id', 'label', 'description'], optional: ['from', 'instructions', 'tools'] },
  'skill.add': { required: ['id', 'description'], optional: ['label', 'from', 'procedure', 'loading'] },
  'skill.attach': { required: ['skill'], optional: ['agent', 'steps', 'use'] },
  'instruction.add': { required: ['id', 'description'], optional: ['label', 'from', 'text'] },
  'decision.add': { required: ['after', 'kind', 'label'], optional: ['inputs', 'routes', 'goal', 'back', 'maxRounds', 'by'] },
  'decision.remove': { required: ['after'], optional: [] },
  // The work goes a different way by one value (channel web, mobile, otherwise) and comes back together.
  'branch.add': { required: ['after', 'name', 'arms', 'join'], optional: ['label', 'values', 'otherwise', 'item'] },
  'group.add': { required: ['id', 'label'], optional: [] },
  // A responsibility this workflow, which writes no code, does not hold: written as its omits, which the
  // group records once with the workflow, so no Story asks it again [owner, 2026-11-12].
  'workflow.omit': { required: ['responsibility', 'reason', 'authority'], optional: [] },
  'action.add': { required: ['step', 'on', 'target'], optional: [] },
  'item.classify': { required: ['item', 'as'], optional: [] },
  'item.leaveOut': { required: ['item', 'reason'], optional: [] },
  'item.keepAsLink': { required: ['item'], optional: [] },
  'item.prerequisite': { required: ['item', 'description'], optional: [] },
  // What a step's agent is told, changed by exact text (src/workflow-build/text-moves.mjs).
  ...TEXT_MOVES
});

/** The vocabulary as data, for the skill and the chat tool: what each move takes, with an example. */
export function movesGuide() {
  return {
    // Text edits are made by `workflow assess` (its suggestion.moves), so the guide that fits one answer leaves them out.
    // So is step.reset, which gives a setting back to a step's intent.
    moves: Object.fromEntries(Object.entries(MOVES).filter(([name]) => !TEXT_MOVES[name] && name !== 'step.reset').map(([name, fields]) => [name, name === 'step.change'
      ? { ...fields, optional: fields.optional.filter((field) => field !== 'edit') } : fields])),
    values: { intent: [...STEP_INTENTS], output: OUTPUTS, on: TRIGGERS, as: ITEM_AS,
      requirement: ['required', 'advisory'], responsibility: [...RESPONSIBILITIES], signOff: "'none' or { groups: [group IDs], minimum, sendBackTo: [step IDs] }" },
    examples: [
      { move: 'step.add', id: 'pay-pci-review', label: 'PCI review', after: 'pay-build', agent: 'pay-reviewer', intent: 'review',
        reads: ['pay-build'], signOff: { groups: ['payments-security'], minimum: 1 }, purpose: 'Checks the change against the PCI rules before release.' },
      { move: 'agent.add', id: 'pay-reviewer', label: 'Payments reviewer', description: 'Reviews payment changes against PCI rules.', from: 'architect' },
      { move: 'skill.add', id: 'pci-check', description: 'Checks a change against the PCI rules.', procedure: 'Check card data never reaches logs.' },
      { move: 'skill.attach', skill: 'pci-check', agent: 'pay-reviewer', steps: ['pay-pci-review'] },
      { move: 'step.check', id: 'pay-build', item: 'i-0123456789ab' },
      { move: 'step.clarify', id: 'pay-build', mode: 'when-needed', maxQuestions: 3, topics: ['approved deviations', 'implementation blockers'] },
      { move: 'branch.add', after: 'intake', name: 'channel', arms: [{ when: 'web', steps: ['web-build', 'web-test'] }, { when: 'mobile', steps: ['mobile-build'] }],
        otherwise: { steps: ['other-build'] }, join: 'release' },
      { move: 'workflow.omit', responsibility: 'implement', reason: 'It runs the tests and reports; it changes no code.', authority: 'quality-reviewers' },
      { move: 'item.leaveOut', item: 'i-0123456789ab', reason: 'CI already scans every change.' }
    ],
    proposal: {
      title: 'the piece in one line, at most 120 characters',
      why: 'in plain words, why this piece belongs in the workflow and what you inferred',
      moves: 'the moves above, at most 50',
      evidence: "[{ path, startLine, endLine }]: lines of a captured file (the path as an item's evidence names it) that you relied on",
      items: '[item IDs] of what was found that this piece uses',
      questions: '[{ question, choices: [2 to 8 concrete choices], blocking }]: what you cannot infer'
    },
    rules: [
      'Reuse what the repository has: a step, agent, skill or instruction ID that exists is used as it is; give `from` to start a new one from it.',
      'A new step needs an agent: one the repository has, or one an agent.add in the build adds.',
      'A step that other workflows use keeps its name, output, agent and purpose; add a copy with step.add and `from` to change those.',
      'Moves apply in order: step.add places the step after `after`, or last. A group, agent, skill or instruction the proposal adds can be used by any of its moves.',
      'Steps the person names up front (intake, testing, a test report) are the first piece, in that order.',
      'Every new step says what it does with intent: its settings and template follow; `from` copies text and agent. Leave output and changesCode out.',
      'A code step needs a step before it that plans it and one that writes the requirements; else the check asks which way.',
      "A workflow that writes no code has no code step: the check names what it leaves out; its fix gives the workflow.omit moves, or the choice of a first step that defines the acceptance criteria as clauses. A person's review is never left out.",
      "Propose a finding's fix.moves as they are; of fix.choices, take the one the person chose, else ask.",
      'action.add runs an integration target the repository has registered; a command found in the material is never invented as a target.',
      "When the work goes different ways by one value (a branch item, or text like 'when channel is web … if mobile … otherwise …'), use branch.add: the person submitting the step after which it is known chooses the value; every way comes back to join. Put the steps in order first (after, each arm's steps, otherwise's steps, join), each way's steps its own; the last step of each way needs a sign-off to skip the other ways.",
      "A script or document in a skill's folder (partOf names the skill) goes with that skill: when the skill's procedure names it, write its repositoryPath, where the agent finds it; one with no repositoryPath is not in the repository and becomes needed first once the skill is used.",
      "A test, lint, type-check, format or build command the material holds (an item whose category says so) becomes the check of the step it belongs to with step.check: sflow runs it when that step is submitted and records the result. Install, run, script and deployment commands stay in their skill or instructions for the agent; never make them checks.",
      "signOff.sendBackTo (optional) names the steps an approver may send rejected work back to: the step itself or steps before it in this workflow. A reused step keeps its own; when the check says rejecting it returns to a step this workflow does not have before it, that finding's fix gives the step.change that repoints it.",
      'Approval groups are created empty; people are added in Workflow Studio, never by a move.',
      "step.clarify sets a step's clarifying questions for this workflow only, its whole policy: mode off, when-needed or required; topics; maxQuestions 1 to 10; markers { mode: off, warn or block }. Ask at or before the step that defines the scope; a code step asks when-needed, never required; a later step does not ask about what the approved scope settles.",
      'Edits of agent, skill, instruction or template text come as suggestion.moves from workflow assess --verify: propose them as given.',
      'Cite the lines you relied on in the proposal evidence; say what you inferred in `why`.'
    ]
  };
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const intentWords = () => STEP_INTENT_CHOICES.map((entry) => `${entry.id} (${entry.label.toLowerCase()})`).join(', ');

/**
 * The intents a repository step may have from its structure, with why, or null when its structure leaves it open (step
 * intents §6.1, §7.5): its declared intent; a code task; an output kind the engine reads as a role; citing a code step's
 * test results or running the repository's tests. A proposal against them is refused (§6.2).
 */
function structuralIntents(phase) {
  if (!phase) return null;
  if (STEP_INTENTS.includes(phase.intent)) return { intents: [phase.intent], why: 'it says so in workflow.yml' };
  if (phase.task === 'code' || phase.output === 'code') return { intents: ['code'], why: 'it delivers code changes' };
  const forKind = phase.kind ? intentsForKind(phase.kind) : null;
  if (forKind) return { intents: forKind, why: `its output kind is ${phase.kind}` };
  if (phase.testEvidenceFrom || phase.repositoryTests === 'run') return { intents: ['test'], why: 'it runs tests' };
  return null;
}

/**
 * The likeliest intent of a new step from its name, purpose, place and agent, and how sure (§6.1): what a refusal of a
 * new step without an intent suggests.
 */
function suggestedIntent(draft, model, stepId, move) {
  const phaseOf = (id) => model.phases.find((phase) => phase.id === id) ?? null;
  const steps = draft.workflow.phases.map((id) => {
    const own = draft.steps[id];
    const phase = phaseOf(id);
    if (id === stepId) return { id, label: move.label ?? id, description: move.purpose ?? null, agent: move.agent ?? null };
    const intent = own?.intent ?? draft.overrides[id]?.intent ?? phase?.intent ?? null;
    return { id, label: own?.label ?? phase?.label ?? id, description: own?.purpose ?? phase?.description ?? null, agent: own?.agent ?? null,
      declared: intent, kind: phase?.kind ?? null, task: own?.output === 'code' || intent === 'code' ? 'code' : phase?.task ?? null,
      writeScope: phase?.changesCode ? 'source-and-artifact' : 'artifact-only' };
  });
  return inferStepIntents(steps).find((row) => row.step === stepId) ?? null;
}

/** A step.clarify move's policy: the fields it gives, as workflow.yml holds them. */
const clarificationOf = (move) => Object.fromEntries(['mode', 'maxQuestions', 'topics', 'markers'].filter((key) => move[key] !== undefined).map((key) => [key, move[key]]));
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

/**
 * Check moves on their own. `context` holds what the repository has (`model`: the Studio model)
 * and what the build already adds (`draft`). Returns findings `{ at, code, message }`.
 */
export function validateMoves(moves, { model, draft }) {
  const findings = [];
  const add = (at, code, message) => findings.push({ at, code, message });
  if (!Array.isArray(moves)) { add('moves', 'BUILD_MOVES_SHAPE', 'moves is a list of moves.'); return findings; }
  if (moves.length > 50) add('moves', 'BUILD_MOVES_LIMIT', 'A proposal has at most 50 moves; split it into smaller pieces.');
  const has = {
    step: (id) => model.phases.some((phase) => phase.id === id) || Boolean(draft.steps[id]),
    agent: (id) => model.agents.some((agent) => agent.id === id) || Boolean(draft.agents[id]),
    skill: (id) => (model.skills ?? []).some((skill) => skill.id === id) || Boolean(draft.skills[id]),
    instruction: (id) => (model.instructions ?? []).some((item) => item.id === id) || Boolean(draft.instructions[id]),
    group: (id) => model.groups.some((group) => group.id === id) || Boolean(draft.groups[id]),
    target: (id) => (model.integrations?.targets ?? []).some((target) => target.id === id)
  };
  const added = { step: new Set(), agent: new Set(), skill: new Set(), instruction: new Set(), group: new Set() };
  // Steps this proposal makes (new, or copies): their intent is theirs to give; a reused step keeps its structure.
  const fresh = new Set();
  // Groups, agents, skills and instructions become their own Studio changes ahead of every step
  // (lowerDraft), so a move may use one the same proposal adds further down. Steps keep their order.
  const declared = { agent: new Set(), skill: new Set(), instruction: new Set(), group: new Set() };
  for (const move of moves.slice(0, 50)) {
    const kind = plain(move) && typeof move.move === 'string' && move.move.endsWith('.add') ? move.move.slice(0, -4) : null;
    if (declared[kind] && typeof move.id === 'string' && ID.test(move.id)) declared[kind].add(move.id);
  }
  const steps = new Set(draft.workflow.phases);
  // The order the proposal leaves the workflow in: a send-back target must come at or before its step.
  let order = null;
  let after = null;
  try { if (moves.every(plain)) { after = applyMoves(draft, moves.slice(0, 50)); order = after.workflow.phases; } } catch { order = null; after = null; }
  // Text edits are checked in order, each against the text the ones before it leave.
  const checkText = textMoveChecker({ model, draft, add });
  moves.slice(0, 50).forEach((move, index) => {
    const at = `moves[${index}]`;
    if (!plain(move) || typeof move.move !== 'string' || !MOVES[move.move]) {
      add(`${at}.move`, 'BUILD_MOVE_UNKNOWN', `${at} must name one of: ${Object.keys(MOVES).join(', ')}.`); return;
    }
    const spec = MOVES[move.move];
    for (const field of Object.keys(move)) if (field !== 'move' && !spec.required.includes(field) && !spec.optional.includes(field)) add(`${at}.${field}`, 'BUILD_MOVE_FIELD_UNKNOWN', `${move.move} has no field '${field}'.`);
    for (const field of spec.required) if (move[field] == null || move[field] === '') add(`${at}.${field}`, 'BUILD_MOVE_FIELD_MISSING', `${move.move} needs '${field}'.`);
    const id = (field, kind) => {
      if (move[field] == null) return null;
      if (typeof move[field] !== 'string' || !ID.test(move[field])) { add(`${at}.${field}`, 'BUILD_MOVE_ID', `${field} '${move[field]}' must be lower-case kebab-case, like pci-review.`); return null; }
      return move[field];
    };
    const known = (field, kind, value = move[field]) => {
      if (value == null) return;
      if (!has[kind](value) && !added[kind]?.has(value) && !declared[kind]?.has(value)) {
        add(`${at}.${field}`, 'BUILD_MOVE_REFERENCE', kind === 'target'
          ? `There is no integration target '${value}' in this repository. Targets are registered in Workflow Studio's Integrations; keep a found command with item.classify or item.prerequisite instead.`
          : `There is no ${kind} '${value}' in this repository or this build.`);
      }
    };
    const signOff = (field) => {
      const value = move[field];
      if (value == null || value === 'none') return;
      if (!plain(value) || !Array.isArray(value.groups) || !value.groups.length || value.groups.length > 10) { add(`${at}.${field}`, 'BUILD_MOVE_SIGNOFF', "signOff is 'none' or { groups: [1 to 10 group IDs], minimum, sendBackTo }."); return; }
      for (const key of Object.keys(value)) if (!SIGN_OFF_FIELDS.includes(key)) add(`${at}.${field}.${key}`, 'BUILD_MOVE_SIGNOFF', `signOff has no field '${key}'; it takes ${SIGN_OFF_FIELDS.join(', ')}.`);
      value.groups.forEach((group) => known(field, 'group', group));
      if (value.minimum != null && (!Number.isInteger(value.minimum) || value.minimum < 1 || value.minimum > 20)) add(`${at}.${field}.minimum`, 'BUILD_MOVE_SIGNOFF', 'minimum is a whole number from 1 to 20.');
      const targets = value.sendBackTo;
      if (targets == null) return;
      if (!Array.isArray(targets) || !targets.length || targets.length > 10 || targets.some((target) => typeof target !== 'string' || !ID.test(target))) {
        add(`${at}.${field}.sendBackTo`, 'BUILD_MOVE_SIGNOFF', 'sendBackTo lists 1 to 10 step IDs.'); return;
      }
      // The step itself, or a step of this workflow (one an earlier move adds too) that comes before it.
      for (const target of targets) {
        if (target === move.id) continue;
        if ((!steps.has(target) && !added.step.has(target)) || (order && !order.includes(target))) add(`${at}.${field}.sendBackTo`, 'BUILD_MOVE_REFERENCE', `Step '${target}' is not in this workflow.`);
        else if (order?.includes(move.id) && order.indexOf(target) > order.indexOf(move.id)) add(`${at}.${field}.sendBackTo`, 'BUILD_MOVE_SEND_BACK', `Step '${target}' comes after '${move.id}'; rejected work goes back only to the step itself or an earlier step.`);
      }
    };
    const changesCodeField = (entry, where) => {
      if (entry.changesCode == null) return;
      if (typeof entry.changesCode !== 'boolean') add(`${where}.changesCode`, 'BUILD_MOVE_SHAPE', 'changesCode is true or false.');
      else if (entry.changesCode === false && entry.output === 'code') add(`${where}.changesCode`, 'BUILD_MOVE_SHAPE', 'A step whose output is code changes code; give it another output, or leave changesCode out.');
    };
    // What the step does: one of the ten intents, agreeing with its output and with what its structure says for certain.
    const intentField = (entry, where, phase) => {
      if (entry.intent == null) return;
      if (!STEP_INTENTS.includes(entry.intent)) { add(`${where}.intent`, 'BUILD_MOVE_SHAPE', `intent is one of ${intentWords()}.`); return; }
      const code = entry.intent === 'code';
      if ((code && ((entry.output != null && entry.output !== 'code') || entry.changesCode === false)) || (!code && entry.output === 'code')) {
        add(`${where}.intent`, 'BUILD_MOVE_INTENT_CONTRADICTION', code
          ? `A code step delivers code changes: leave out output and changesCode, or give ${entry.id} another intent if it changes no code.`
          : `A ${entry.intent} step does not deliver code changes: leave out output, or give ${entry.id} intent code if it changes the code.`);
        return;
      }
      const known = structuralIntents(phase);
      if (known && !known.intents.includes(entry.intent)) {
        add(`${where}.intent`, 'BUILD_MOVE_INTENT_CERTAIN', `${phase.label ?? entry.id} is a ${known.intents.join(' or ')} step for certain (${known.why}), so it cannot be ${entry.intent}. `
          + `Propose intent ${known.intents[0]}, or add a copy with step.add, from: '${entry.id}' and intent ${entry.intent}.`);
        return;
      }
      const users = (phase?.usedBy ?? []).filter((workflow) => workflow !== draft.workflow.id && workflow !== draft.workflow.copyOf);
      if (phase && users.length && STEP_INTENTS.includes(phase.intent) && phase.intent !== entry.intent) {
        add(`${where}.id`, 'BUILD_MOVE_SHARED_STEP', `Step '${entry.id}' is a ${phase.intent} step in ${users.join(', ')} too, and a step means one thing in every workflow. Add a copy with step.add and from: '${entry.id}' instead.`);
      }
    };
    const becauseField = (entry, where) => {
      if (entry.because == null) return;
      if (!plain(entry.because) || !Object.keys(entry.because).length) { add(`${where}.because`, 'BUILD_MOVE_SHAPE', `because is { setting: reason }, setting one of ${BECAUSE_SETTINGS.join(', ')}.`); return; }
      for (const [setting, reason] of Object.entries(entry.because)) {
        if (!BECAUSE_SETTINGS.includes(setting)) add(`${where}.because.${setting}`, 'BUILD_MOVE_SHAPE', `'${setting}' is not a setting a step's intent gives; because names one of ${BECAUSE_SETTINGS.join(', ')}.`);
        else if (typeof reason !== 'string' || reason.trim().length < 20 || reason.trim().length > 1000) add(`${where}.because.${setting}`, 'BUILD_MOVE_SHAPE', 'A reason says why in 20 to 1000 characters, in plain words.');
      }
    };
    const stepList = (field) => {
      if (move[field] == null) return;
      if (!Array.isArray(move[field]) || move[field].some((value) => typeof value !== 'string')) { add(`${at}.${field}`, 'BUILD_MOVE_SHAPE', `${field} is a list of step IDs.`); return; }
      for (const value of move[field]) if (!steps.has(value) && !added.step.has(value)) add(`${at}.${field}`, 'BUILD_MOVE_REFERENCE', `Step '${value}' is not in this workflow.`);
    };
    switch (move.move) {
      case 'step.add': {
        const stepId = id('id', 'step');
        if (stepId && (steps.has(stepId) || added.step.has(stepId))) add(`${at}.id`, 'BUILD_MOVE_DUPLICATE', `Step '${stepId}' is already in this workflow.`);
        if (move.from != null) {
          id('from', 'step'); known('from', 'step');
          if (stepId && has.step(stepId)) add(`${at}.id`, 'BUILD_MOVE_EXISTS', `A step called '${stepId}' already exists; a copy needs a new ID.`);
        }
        const reused = stepId && has.step(stepId) && move.from == null;
        if (!reused && move.from == null && move.agent == null) add(`${at}.agent`, 'BUILD_MOVE_FIELD_MISSING', 'A new step needs the agent that drafts it.');
        if (!reused && move.label == null) add(`${at}.label`, 'BUILD_MOVE_FIELD_MISSING', 'A new step needs a name.');
        if (!reused && move.from == null && move.intent == null && move.output !== 'code' && stepId) {
          // A new step starts from what it does; SFlow names its likeliest intent, never picks one silently. A step
          // whose output is code is a code step for certain, so SFlow fills that in itself.
          const guess = after ? suggestedIntent(after, model, stepId, move) : null;
          const choice = guess ? stepIntentChoice(guess.intent) : null;
          add(`${at}.intent`, 'BUILD_MOVE_FIELD_MISSING', `A new step says what it does: give ${move.label ?? stepId} intent, one of ${STEP_INTENTS.join(', ')}.`
            + (choice && guess.source !== 'none' ? ` It looks like ${guess.intent} (${choice.label.toLowerCase()}): ${guess.why}.` : ''));
        }
        if (reused && ['label', 'agent', 'intent', 'output', 'changesCode', 'reads', 'signOff', 'purpose', 'because'].some((field) => move[field] != null)) {
          add(`${at}.id`, 'BUILD_MOVE_REUSE', `Step '${stepId}' exists and is added as it is; change it with step.change, or add a copy with from: '${stepId}' and a new ID.`);
        }
        if (move.agent != null) { id('agent', 'agent'); known('agent', 'agent'); }
        if (move.after != null && !steps.has(move.after) && !added.step.has(move.after)) add(`${at}.after`, 'BUILD_MOVE_REFERENCE', `Step '${move.after}' is not in this workflow.`);
        if (move.output != null && !OUTPUTS.includes(move.output)) add(`${at}.output`, 'BUILD_MOVE_SHAPE', `output is one of ${OUTPUTS.join(', ')}.`);
        changesCodeField(move, at);
        intentField(move, at, null);
        becauseField(move, at);
        if (move.label != null && !text(move.label, 120)) add(`${at}.label`, 'BUILD_MOVE_SHAPE', 'label is a name of 1 to 120 characters.');
        if (move.purpose != null && !text(move.purpose, 600)) add(`${at}.purpose`, 'BUILD_MOVE_SHAPE', 'purpose is one paragraph of at most 600 characters.');
        stepList('reads'); signOff('signOff');
        if (stepId) added.step.add(stepId);
        if (stepId && !reused) fresh.add(stepId);
        break;
      }
      case 'step.change':
        if (move.id && !steps.has(move.id) && !added.step.has(move.id)) add(`${at}.id`, 'BUILD_MOVE_REFERENCE', `Step '${move.id}' is not in this workflow.`);
        else if (move.id && !draft.steps[move.id]?.new && ['label', 'output', 'changesCode', 'agent', 'purpose'].some((field) => move[field] != null)) {
          const users = (model.phases.find((phase) => phase.id === move.id)?.usedBy ?? []).filter((workflow) => workflow !== draft.workflow.id && workflow !== draft.workflow.copyOf);
          if (users.length) add(`${at}.id`, 'BUILD_MOVE_SHARED_STEP', `Step '${move.id}' is also used by ${users.join(', ')}; its name, output, whether it changes code, agent and purpose change there too. Add a copy with step.add and from: '${move.id}' instead.`);
        }
        if (move.agent != null) known('agent', 'agent');
        if (move.output != null && !OUTPUTS.includes(move.output)) add(`${at}.output`, 'BUILD_MOVE_SHAPE', `output is one of ${OUTPUTS.join(', ')}.`);
        changesCodeField(move, at);
        if (move.intent != null) intentField(move, at, draft.steps[move.id]?.new || fresh.has(move.id) ? null : model.phases.find((phase) => phase.id === move.id) ?? null);
        becauseField(move, at);
        if (move.purpose != null && typeof move.purpose === 'string' && move.purpose.length > 600) add(`${at}.purpose`, 'BUILD_MOVE_SHAPE', 'purpose is at most 600 characters.');
        stepList('reads'); signOff('signOff');
        if (move.edit != null && move.id && steps.has(move.id)) checkText(move, at);
        break;
      case 'step.intent':
        if (move.id && !steps.has(move.id) && !added.step.has(move.id)) { add(`${at}.id`, 'BUILD_MOVE_REFERENCE', `Step '${move.id}' is not in this workflow.`); break; }
        intentField(move, at, draft.steps[move.id]?.new || fresh.has(move.id) ? null : model.phases.find((phase) => phase.id === move.id) ?? null);
        break;
      case 'step.reset':
        if (move.id && !steps.has(move.id) && !added.step.has(move.id)) { add(`${at}.id`, 'BUILD_MOVE_REFERENCE', `Step '${move.id}' is not in this workflow.`); break; }
        if (draft.steps[move.id]?.new || fresh.has(move.id)) add(`${at}.id`, 'BUILD_MOVE_SHAPE', `${move.id} is new in this build and starts from its intent: leave the setting out of its step.add instead.`);
        if (!Array.isArray(move.settings) || !move.settings.length || move.settings.some((setting) => !RESET_SETTINGS.includes(setting))) {
          add(`${at}.settings`, 'BUILD_MOVE_SHAPE', `settings lists what to give back to the step's intent, from: ${RESET_SETTINGS.join(', ')}.`);
        }
        break;
      case 'step.remove':
      case 'step.move':
        if (move.id && !steps.has(move.id) && !added.step.has(move.id)) add(`${at}.id`, 'BUILD_MOVE_REFERENCE', `Step '${move.id}' is not in this workflow.`);
        if (move.move === 'step.move' && move.after != null && !steps.has(move.after) && !added.step.has(move.after)) add(`${at}.after`, 'BUILD_MOVE_REFERENCE', `Step '${move.after}' is not in this workflow.`);
        break;
      case 'agent.add': {
        const agentId = id('id', 'agent');
        if (agentId && (has.agent(agentId) || added.agent.has(agentId))) add(`${at}.id`, 'BUILD_MOVE_EXISTS', `An agent called '${agentId}' already exists; reuse it, or give the new one another ID.`);
        if (move.from != null) known('from', 'agent');
        if (!text(move.description ?? '', 600)) add(`${at}.description`, 'BUILD_MOVE_SHAPE', 'description says what the agent does in one sentence.');
        if (move.tools != null && (!Array.isArray(move.tools) || move.tools.some((tool) => typeof tool !== 'string' || !tool.trim()))) add(`${at}.tools`, 'BUILD_MOVE_SHAPE', 'tools is a list of tool names.');
        if (agentId) added.agent.add(agentId);
        break;
      }
      case 'skill.add': {
        const skillId = id('id', 'skill');
        if (skillId && (has.skill(skillId) || added.skill.has(skillId))) add(`${at}.id`, 'BUILD_MOVE_EXISTS', `A skill called '${skillId}' already exists; attach it, or give the new one another ID.`);
        if (move.from != null) known('from', 'skill');
        if (move.from == null && !text(move.procedure ?? '', 256 * 1024)) add(`${at}.procedure`, 'BUILD_MOVE_FIELD_MISSING', 'A new skill needs its procedure, or `from` to start from an existing skill.');
        if (move.loading != null && !['eager', 'on-demand'].includes(move.loading)) add(`${at}.loading`, 'BUILD_MOVE_SHAPE', 'loading is eager or on-demand.');
        if (skillId) added.skill.add(skillId);
        break;
      }
      case 'skill.attach':
        known('skill', 'skill');
        if (move.agent != null) known('agent', 'agent');
        stepList('steps');
        break;
      case 'instruction.add': {
        const instructionId = id('id', 'instruction');
        if (instructionId && (has.instruction(instructionId) || added.instruction.has(instructionId))) add(`${at}.id`, 'BUILD_MOVE_EXISTS', `An instruction called '${instructionId}' already exists.`);
        if (move.from != null) known('from', 'instruction');
        if (move.from == null && !text(move.text ?? '', 64 * 1024)) add(`${at}.text`, 'BUILD_MOVE_FIELD_MISSING', 'A new instruction needs its text, or `from`.');
        if (instructionId) added.instruction.add(instructionId);
        break;
      }
      case 'decision.add':
        if (move.after && !steps.has(move.after) && !added.step.has(move.after)) add(`${at}.after`, 'BUILD_MOVE_REFERENCE', `Step '${move.after}' is not in this workflow.`);
        if (!['branch', 'loop', 'ask'].includes(move.kind)) add(`${at}.kind`, 'BUILD_MOVE_SHAPE', 'kind is branch, loop or ask.');
        for (const group of Array.isArray(move.by) ? move.by : []) known('by', 'group', group);
        break;
      case 'decision.remove':
        if (!draft.workflow.decisions.some((decision) => decision.after === move.after)) add(`${at}.after`, 'BUILD_MOVE_REFERENCE', `No decision follows '${move.after}'.`);
        break;
      case 'group.add': {
        const groupId = id('id', 'group');
        if (groupId && (has.group(groupId) || added.group.has(groupId))) add(`${at}.id`, 'BUILD_MOVE_EXISTS', `An approval group called '${groupId}' already exists; use it.`);
        if (groupId) added.group.add(groupId);
        break;
      }
      case 'branch.add': {
        const inWorkflow = (stepId) => steps.has(stepId) || added.step.has(stepId);
        if (move.after && !inWorkflow(move.after)) add(`${at}.after`, 'BUILD_MOVE_REFERENCE', `Step '${move.after}' is not in this workflow.`);
        if (typeof move.name !== 'string' || !INPUT_NAME.test(move.name) || move.name.length > 40) add(`${at}.name`, 'BUILD_MOVE_SHAPE', 'name is what the work goes different ways on, like channel.');
        const arms = Array.isArray(move.arms) ? move.arms : [];
        if (!arms.length || arms.length > 8) add(`${at}.arms`, 'BUILD_MOVE_SHAPE', 'arms lists 1 to 8 ways: [{ when, steps, label }].');
        const values = new Set();
        const blocks = [];
        arms.forEach((arm, armIndex) => {
          const where = `${at}.arms[${armIndex}]`;
          if (!plain(arm)) { add(where, 'BUILD_MOVE_SHAPE', `${where} is { when, steps, label }.`); return; }
          for (const key of Object.keys(arm)) if (!['when', 'steps', 'label'].includes(key)) add(`${where}.${key}`, 'BUILD_MOVE_FIELD_UNKNOWN', `An arm has no field '${key}'; it takes when, steps and label.`);
          const when = [arm.when].flat();
          if (!when.length || when.some((value) => typeof value !== 'string' || !value.trim() || value.length > 60)) add(`${where}.when`, 'BUILD_MOVE_SHAPE', `when is a value of ${move.name ?? 'name'}, or a list of them.`);
          for (const value of when.filter((entry) => typeof entry === 'string')) {
            if (values.has(value.toLowerCase())) add(`${where}.when`, 'BUILD_MOVE_SHAPE', `'${value}' already leads another way.`);
            values.add(value.toLowerCase());
            if (Array.isArray(move.values) && !move.values.includes(value)) add(`${where}.when`, 'BUILD_MOVE_SHAPE', `'${value}' is not one of values.`);
          }
          if (!Array.isArray(arm.steps) || !arm.steps.length) { add(`${where}.steps`, 'BUILD_MOVE_SHAPE', 'steps lists the steps this way runs, in order.'); return; }
          arm.steps.forEach((stepId, stepIndex) => { if (!inWorkflow(stepId)) add(`${where}.steps[${stepIndex}]`, 'BUILD_MOVE_REFERENCE', `Step '${stepId}' is not in this workflow.`); });
          blocks.push(arm.steps);
        });
        if (move.otherwise != null) {
          if (!plain(move.otherwise) || !Array.isArray(move.otherwise.steps) || !move.otherwise.steps.length) add(`${at}.otherwise`, 'BUILD_MOVE_SHAPE', 'otherwise is { steps, label }: the steps for every other value.');
          else blocks.push(move.otherwise.steps);
        }
        if (Array.isArray(move.values) && (move.values.length > 20 || move.values.some((value) => typeof value !== 'string' || !value.trim()))) add(`${at}.values`, 'BUILD_MOVE_SHAPE', 'values lists the choices, at most 20.');
        if (move.join !== 'end' && !(typeof move.join === 'string' && inWorkflow(move.join))) add(`${at}.join`, 'BUILD_MOVE_REFERENCE', 'join is the step every way comes back to, or end.');
        if (order && blocks.length === arms.length + (move.otherwise != null ? 1 : 0) && blocks.length) {
          const expected = [move.after, ...blocks.flat(), ...(move.join === 'end' ? [] : [move.join])];
          const start = order.indexOf(move.after);
          const fits = start >= 0 && JSON.stringify(order.slice(start, start + expected.length)) === JSON.stringify(expected)
            && (move.join !== 'end' || start + expected.length === order.length);
          if (!fits) add(`${at}.arms`, 'BUILD_BRANCH_ORDER', `Put the steps in this order first (step.add with after, or step.move): ${expected.join(' → ')}${move.join === 'end' ? ', last in the workflow' : ''}.`);
        }
        break;
      }
      case 'step.clarify':
        if (move.id && !steps.has(move.id) && !added.step.has(move.id)) add(`${at}.id`, 'BUILD_MOVE_REFERENCE', `Step '${move.id}' is not in this workflow.`);
        try { normalizeClarificationPolicy(clarificationOf(move)); }
        catch (error) { add(`${at}.mode`, 'BUILD_MOVE_CLARIFICATION', String(error.message).replace(/^clarification\./u, 'clarification ')); }
        break;
      case 'step.check':
        if (move.id && !steps.has(move.id) && !added.step.has(move.id)) add(`${at}.id`, 'BUILD_MOVE_REFERENCE', `Step '${move.id}' is not in this workflow.`);
        if (move.requirement != null && !['required', 'advisory'].includes(move.requirement)) add(`${at}.requirement`, 'BUILD_MOVE_SHAPE', 'requirement is required or advisory.');
        if (typeof move.command !== 'string' || !move.command) add(`${at}.item`, 'BUILD_MOVE_REFERENCE', 'item names a command this build found in the material.');
        else if (secretsIn(move.command).length) {
          // Named, never quoted: the finding itself must not carry the value into the proposal.
          add(`${at}.item`, 'BUILD_CHECK_SECRET', `${secretsIn(move.command).join(', ')} in this command looks like a credential. Declare it in singularity/environments.yml and bind it with env bind; a check never carries its value.`);
        } else if (!CHECK_KINDS[move.category]) {
          add(`${at}.item`, 'BUILD_CHECK_NOT_A_CHECK', `'${move.command}' is a${move.category === 'install' ? 'n' : ''} ${move.category} command: it stays with its skill or instructions for the agent, and sflow never runs it as a check.`);
        }
        break;
      case 'action.add':
        if (move.step && !steps.has(move.step) && !added.step.has(move.step)) add(`${at}.step`, 'BUILD_MOVE_REFERENCE', `Step '${move.step}' is not in this workflow.`);
        if (!Array.isArray(move.on) || !move.on.length || move.on.some((trigger) => !TRIGGERS.includes(trigger))) add(`${at}.on`, 'BUILD_MOVE_SHAPE', `on lists one or more of ${TRIGGERS.join(', ')}.`);
        known('target', 'target');
        break;
      case 'item.classify':
        if (!ITEM_AS.includes(move.as)) add(`${at}.as`, 'BUILD_MOVE_SHAPE', `as is one of ${ITEM_AS.join(', ')}.`);
        break;
      case 'workflow.omit': {
        if (!RESPONSIBILITIES.includes(move.responsibility)) { add(`${at}.responsibility`, 'BUILD_MOVE_SHAPE', `responsibility is one of ${RESPONSIBILITIES.join(', ')}.`); break; }
        if (move.responsibility === 'review') add(`${at}.responsibility`, 'BUILD_OMIT_REVIEW', "A person's review is never left out: give the last step a sign-off (signOff) instead.");
        if (typeof move.reason !== 'string' || move.reason.trim().length < 20 || move.reason.length > 400) add(`${at}.reason`, 'BUILD_MOVE_SHAPE', 'reason says in 20 to 400 characters why this workflow does not need it.');
        if (move.authority != null && (typeof move.authority !== 'string' || !ID.test(move.authority))) add(`${at}.authority`, 'BUILD_MOVE_ID', `authority '${move.authority}' must be a group ID.`);
        else known('authority', 'group');
        // The one case a code step goes without them (step intents §5): nothing before it plans it, or nothing before it
        // writes the requirements; the person chose to let it plan its own change, or work without requirement IDs.
        const own = after && ['scope', 'plan'].includes(move.responsibility) ? plansItself(after, model) : null;
        const coding = CODE_NEEDS.has(move.responsibility) && after && !own?.includes(move.responsibility) ? codeSteps(after, model) : [];
        if (coding.length) {
          add(`${at}.responsibility`, 'BUILD_OMIT_CODE_STEP', `${coding.join(', ')} may change code, so this workflow needs requirements, a plan and the change itself; it cannot leave out ${move.responsibility}. `
            + `If ${coding.length === 1 ? 'it only tests' : 'they only test'}, checks or reports, copy ${coding.length === 1 ? 'it' : 'each'} with from and changesCode false first.`);
        }
        break;
      }
      default:
        if (TEXT_MOVES[move.move]) checkText(move, at);
        break;
    }
  });
  return findings;
}

/**
 * An empty draft for a build: a new workflow, a copy of the one it starts from, or (a change build)
 * that workflow itself, changed in place. `base` is the workflow as it was, so what the build adds,
 * removes, moves or changes can be named, never dropped without saying so.
 */
export function initialDraft(build, model) {
  const base = build.goal.startedFrom.find((entry) => entry.kind === 'workflow');
  const source = base ? model.workflows.find((workflow) => workflow.id === base.id) : null;
  const inPlace = Boolean(build.goal.change && source);
  return {
    workflow: {
      id: build.goal.workflow, label: build.goal.label, description: source?.description ?? '',
      copyOf: source && !inPlace ? source.id : null,
      inPlace,
      base: source ? { id: source.id, label: source.label, phases: [...source.phases] } : null,
      phases: source ? [...source.phases] : [],
      decisions: source ? structuredClone(source.decisions ?? []) : [],
      baseDecisions: source ? structuredClone(source.decisions ?? []) : [],
      // What the workflow says it leaves out (omits), as the one it starts from has it.
      omits: source ? structuredClone(source.omits ?? []) : [],
      baseOmits: source ? structuredClone(source.omits ?? []) : []
    },
    steps: {}, overrides: {}, agents: {}, skills: {}, instructions: {}, groups: {}, attachments: [], actions: {}, checks: {}, clarifications: {},
    texts: {}, items: {}
  };
}

function insertAfter(list, id, after) {
  const without = list.filter((entry) => entry !== id);
  if (after == null) return [id, ...without];
  const at = without.indexOf(after);
  return at < 0 ? [...without, id] : [...without.slice(0, at + 1), id, ...without.slice(at + 1)];
}

/** Fold accepted moves into the draft, in order. */
export function applyMoves(draft, moves) {
  const next = structuredClone(draft);
  for (const move of moves) {
    switch (move.move) {
      case 'step.add': {
        const after = move.after === undefined ? next.workflow.phases.at(-1) ?? null : move.after;
        next.workflow.phases = insertAfter(next.workflow.phases, move.id, after);
        if (move.from != null || move.agent != null || move.label != null) {
          next.steps[move.id] = { new: true, label: move.label, from: move.from ?? null, agent: move.agent ?? null, output: move.output ?? null,
            // A new step whose output is code is a code step for certain: SFlow fills in what it is for.
            ...(move.intent != null ? { intent: move.intent } : move.from == null && move.output === 'code' ? { intent: 'code' } : {}),
            ...(move.because != null ? { because: structuredClone(move.because) } : {}),
            ...(move.changesCode != null ? { changesCode: move.changesCode } : {}), reads: move.reads ?? null, signOff: move.signOff ?? null, purpose: move.purpose ?? null };
        }
        break;
      }
      case 'step.change': {
        const own = next.steps[move.id];
        const target = own?.new ? own : (next.overrides[move.id] ??= {});
        const earlier = target.signOff;
        for (const field of ['label', 'purpose', 'agent', 'intent', 'output', 'changesCode', 'reads', 'signOff']) if (move[field] !== undefined) target[field] = move[field];
        if (plain(move.because)) target.because = { ...(target.because ?? {}), ...structuredClone(move.because) };
        // A sign-off that does not name send-back targets keeps the ones an earlier move gave it, as Studio does.
        if (plain(move.signOff) && move.signOff.sendBackTo == null && plain(earlier) && earlier.sendBackTo) target.signOff = { ...move.signOff, sendBackTo: earlier.sendBackTo };
        if (move.edit) applyTextMove(next, move);
        break;
      }
      case 'step.intent': {
        const own = next.steps[move.id];
        (own?.new ? own : (next.overrides[move.id] ??= {})).intent = move.intent;
        break;
      }
      case 'step.reset': {
        const target = (next.overrides[move.id] ??= {});
        target.reset = [...new Set([...(target.reset ?? []), ...move.settings])];
        break;
      }
      case 'step.remove':
        next.workflow.phases = next.workflow.phases.filter((entry) => entry !== move.id);
        delete next.steps[move.id]; delete next.overrides[move.id]; delete next.actions[move.id]; if (next.checks) delete next.checks[move.id];
        if (next.clarifications) delete next.clarifications[move.id];
        next.workflow.decisions = next.workflow.decisions.filter((decision) => decision.after !== move.id);
        break;
      case 'step.move':
        next.workflow.phases = insertAfter(next.workflow.phases, move.id, move.after ?? null);
        break;
      case 'agent.add': next.agents[move.id] = { label: move.label, description: move.description, from: move.from ?? null, instructions: move.instructions ?? null, tools: move.tools ?? null }; break;
      case 'skill.add': next.skills[move.id] = { label: move.label ?? null, description: move.description, from: move.from ?? null, procedure: move.procedure ?? null, loading: move.loading ?? null }; break;
      case 'instruction.add': next.instructions[move.id] = { label: move.label ?? null, description: move.description, from: move.from ?? null, text: move.text ?? null }; break;
      case 'group.add': next.groups[move.id] = { label: move.label }; break;
      case 'workflow.omit':
        next.workflow.omits = [...(next.workflow.omits ?? []).filter((entry) => entry.responsibility !== move.responsibility),
          { responsibility: move.responsibility, reason: move.reason.trim(), authority: move.authority }];
        break;
      case 'skill.attach':
        next.attachments = [...next.attachments.filter((entry) => !(entry.skill === move.skill && (entry.agent ?? null) === (move.agent ?? null))),
          { skill: move.skill, agent: move.agent ?? null, steps: move.steps ?? [], use: move.use ?? '' }];
        break;
      case 'decision.add': {
        const { move: ignored, ...decision } = move;
        next.workflow.decisions = [...next.workflow.decisions.filter((entry) => entry.after !== move.after), { id: `${next.workflow.id}-${move.after}`, ...decision }];
        break;
      }
      case 'decision.remove': next.workflow.decisions = next.workflow.decisions.filter((entry) => entry.after !== move.after); break;
      case 'branch.add': {
        // One decision after the step that knows the value, and one at the end of every way but the
        // last, reusing that value, so each way comes back to the join without asking again.
        const id = next.workflow.id;
        const arms = move.arms.map((arm) => ({ ...arm, when: [arm.when].flat() }));
        const values = move.values ?? [...arms.flatMap((arm) => arm.when), ...(move.otherwise ? ['other'] : [])];
        const test = (when) => ({ [move.name]: when.length === 1 ? when[0] : when });
        const branch = { id: `${id}-${move.after}`, after: move.after, kind: 'branch', label: move.label ?? `Which ${move.name}?`,
          inputs: [{ name: move.name, label: move.name, values }],
          routes: [...arms.map((arm, index) => ({ id: kebab(arm.when.join('-')) || `way-${index + 1}`, label: arm.label ?? `${move.name} is ${arm.when.join(' or ')}`, when: test(arm.when), to: arm.steps[0] })),
            { id: 'otherwise', label: move.otherwise?.label ?? (move.otherwise ? 'Otherwise' : `Any other ${move.name}`), to: move.otherwise?.steps[0] ?? move.join }] };
        const rejoin = (move.otherwise ? arms : arms.slice(0, -1)).map((arm) => ({
          id: `${id}-${arm.steps.at(-1)}`, after: arm.steps.at(-1), kind: 'branch', label: `Back together after ${move.name} ${arm.when.join(' or ')}`.slice(0, 120),
          inputs: [{ name: move.name, from: branch.id }],
          routes: [{ id: 'rejoin', label: 'Back together', when: test(arm.when), to: move.join }, { id: 'otherwise', label: 'Back together', to: move.join }]
        }));
        const made = [branch, ...rejoin];
        next.workflow.decisions = [...next.workflow.decisions.filter((entry) => !made.some((decision) => decision.after === entry.after)), ...made];
        break;
      }
      case 'step.check':
        next.checks ??= {};
        next.checks[move.id] = [...(next.checks[move.id] ?? []).filter((check) => check.command !== move.command),
          { item: move.item, command: move.command, category: move.category, ...(move.directory ? { directory: move.directory } : {}),
            ...(move.record ? { record: move.record } : {}), requirement: move.requirement ?? 'required' }];
        break;
      case 'action.add': next.actions[move.step] = [...(next.actions[move.step] ?? []), { on: move.on, target: move.target }]; break;
      case 'step.clarify': (next.clarifications ??= {})[move.id] = clarificationOf(move); break;
      case 'item.classify': next.items[move.item] = { ...next.items[move.item], kind: move.as }; break;
      case 'item.leaveOut': next.items[move.item] = { ...next.items[move.item], status: 'left-out', reason: move.reason }; break;
      case 'item.keepAsLink': next.items[move.item] = { ...next.items[move.item], status: 'kept-as-link' }; break;
      case 'item.prerequisite': next.items[move.item] = { ...next.items[move.item], status: 'prerequisite', prerequisite: move.description }; break;
      default: if (TEXT_MOVES[move.move]) applyTextMove(next, move); break;
    }
  }
  return next;
}

/**
 * The steps of a draft that may change code (the engine's implement responsibility): a step whose
 * output is code, or one allowed to change the repository's files, as testing and verification are to
 * write tests. Studio's rules decide: changesCode says it outright; moving a step to code makes it
 * change code; moving one from code to another output stops it; any other output keeps what it had.
 */
export function codeSteps(draft, model) {
  const repository = (id) => model.phases.find((phase) => phase.id === id) ?? null;
  const changes = (setting, base) => {
    if (setting.output === 'code' || setting.intent === 'code') return true;
    if (setting.changesCode != null) return setting.changesCode;
    // A new step, or a copy, that says what it does starts from that intent: only a code step changes code.
    if (setting.new && setting.intent != null) return false;
    if (setting.output != null && base?.output === 'code') return false;
    return Boolean(base?.changesCode ?? base?.output === 'code');
  };
  return draft.workflow.phases.filter((id) => {
    const own = draft.steps[id];
    if (own?.new) return changes(own, own.from ? repository(own.from) : { output: 'document', changesCode: false });
    return changes(draft.overrides[id] ?? {}, repository(id));
  }).map((id) => draft.steps[id]?.label ?? repository(id)?.label ?? id);
}

/**
 * What a draft's first code step goes without because nothing before it holds it (step intents §5): scope and plan when
 * nothing comes before it; scope when no step before it writes the requirements (intent intake, requirements or plan,
 * or a step that defines clauses). Empty when the draft has no code step.
 */
function plansItself(draft, model) {
  const labels = new Set(codeSteps(draft, model));
  const phaseOf = (id) => model.phases.find((phase) => phase.id === id) ?? null;
  const labelOf = (id) => draft.steps[id]?.label ?? phaseOf(id)?.label ?? id;
  const first = draft.workflow.phases.findIndex((id) => labels.has(labelOf(id)));
  if (first < 0) return [];
  if (first === 0) return ['scope', 'plan'];
  const writes = draft.workflow.phases.slice(0, first).some((id) => {
    const intent = draft.steps[id]?.intent ?? draft.overrides[id]?.intent ?? phaseOf(id)?.intent ?? null;
    return ['intake', 'requirements', 'plan'].includes(intent) || (intent == null && Boolean(phaseOf(id)?.definesClauses));
  });
  return writes ? [] : ['scope'];
}

const approvalChange = (signOff) => (signOff === 'none' ? 'none'
  : { groups: [...signOff.groups], minimum: signOff.minimum ?? 1, ...(signOff.sendBackTo ? { rejectTo: [...signOff.sendBackTo] } : {}) });

/**
 * The Studio change set for a draft. `model` supplies source texts for `from` copies and the base
 * hashes. An empty draft (no steps yet) lowers to no changes.
 */
export function lowerDraft(draft, model) {
  const changes = [];
  const workflowId = draft.workflow.id;
  if (!draft.workflow.phases.length) return { schema: 'sflow-studio-change-set@1', base: model.base, changes };
  for (const [id, group] of Object.entries(draft.groups)) changes.push({ op: 'group.create', id, label: group.label, members: [] });
  for (const [id, agent] of Object.entries(draft.agents)) {
    changes.push({ op: 'agent.create', id, label: agent.label, description: agent.description, role: 'blank',
      ...(agent.from ? { from: agent.from } : {}), ...(agent.instructions ? { instructions: agent.instructions } : {}), ...(agent.tools ? { tools: agent.tools } : {}) });
  }
  for (const [id, instruction] of Object.entries(draft.instructions)) {
    const source = instruction.from ? (model.instructions ?? []).find((entry) => entry.id === instruction.from) : null;
    changes.push({ op: 'instruction.create', id, label: instruction.label ?? source?.label ?? id, description: instruction.description,
      instructions: instruction.text ?? source?.instructions ?? '' });
  }
  for (const [id, skill] of Object.entries(draft.skills)) {
    const source = skill.from ? (model.skills ?? []).find((entry) => entry.id === skill.from) : null;
    changes.push({ op: 'skill.create', id, label: skill.label ?? source?.label ?? null, description: skill.description,
      instructions: skill.procedure ?? source?.instructions ?? '', loading: skill.loading ?? source?.loading ?? 'eager',
      instructionRefs: source ? [...(source.instructionRefs ?? [])] : [] });
  }
  for (const id of draft.workflow.phases) {
    const step = draft.steps[id];
    if (!step?.new) continue;
    // A step that says what it does starts from its intent: what it reads and who signs it off come from the intent
    // unless the move says (a step with no sign-off was approval none, which no check lets through).
    const fromIntent = step.intent != null;
    changes.push({ op: 'phase.create', id, label: step.label ?? id,
      // A copy of a step the source workflow runs keeps that workflow's settings for it.
      ...(step.from ? { copyOf: step.from, ...(model.workflows.find((workflow) => workflow.id === draft.workflow.copyOf)?.phases.includes(step.from) ? { copyFromWorkflow: draft.workflow.copyOf } : {}) } : {}),
      ...(fromIntent ? { intent: step.intent } : {}),
      ...(step.output || (!step.from && !fromIntent) ? { output: step.output ?? 'document' } : {}),
      ...(step.changesCode != null ? { changesCode: step.changesCode } : {}),
      ...(step.reads ? { inputs: [...step.reads] } : step.from || fromIntent ? {} : { inputs: [] }),
      ...(step.signOff ? { approval: approvalChange(step.signOff) } : step.from || fromIntent ? {} : { approval: 'none' }),
      ...(step.because ? { because: structuredClone(step.because) } : {}),
      ...(step.agent ? { agent: step.agent } : {}),
      ...(step.purpose ? { description: step.purpose } : {}),
      ...(draft.actions[id] ? { afterStep: draft.actions[id].map((action, index) => ({ id: `${id}-action-${index + 1}`, on: action.on, target: action.target })) } : {}) });
  }
  const decisionsChanged = JSON.stringify(draft.workflow.decisions) !== JSON.stringify(draft.workflow.baseDecisions ?? []);
  const omits = draft.workflow.omits ?? [];
  const omitsChanged = JSON.stringify(omits) !== JSON.stringify(draft.workflow.baseOmits ?? []);
  if (draft.workflow.inPlace) {
    // A change build updates the workflow it names; only what changed is written.
    const base = draft.workflow.base;
    const update = {
      ...(JSON.stringify(draft.workflow.phases) !== JSON.stringify(base.phases) ? { phases: [...draft.workflow.phases] } : {}),
      ...(draft.workflow.label !== base.label ? { label: draft.workflow.label } : {}),
      ...(decisionsChanged ? { decisions: structuredClone(draft.workflow.decisions) } : {}),
      ...(omitsChanged ? { omits: omits.length ? structuredClone(omits) : null } : {})
    };
    if (Object.keys(update).length) changes.push({ op: 'workflow.update', id: workflowId, ...update });
  } else {
    changes.push({ op: 'workflow.create', id: workflowId, label: draft.workflow.label, phases: [...draft.workflow.phases],
      ...(draft.workflow.description ? { description: draft.workflow.description } : {}), ...(draft.workflow.copyOf ? { copyOf: draft.workflow.copyOf } : {}),
      ...(omitsChanged && omits.length ? { omits: structuredClone(omits) } : {}) });
    // A copy starts with the omits of the workflow it copies; one the build takes away is removed after.
    if (omitsChanged && !omits.length) changes.push({ op: 'workflow.update', id: workflowId, omits: null });
  }
  for (const [id, change] of Object.entries(draft.overrides)) {
    if (!draft.workflow.phases.includes(id)) continue;
    const shared = {};
    if (change.label != null) shared.label = change.label;
    if (change.purpose != null) shared.description = change.purpose;
    if (change.output != null) shared.output = change.output;
    if (change.changesCode != null) shared.changesCode = change.changesCode;
    // What a step does lives on the step itself: a step means one thing in every workflow.
    if (change.intent != null) shared.intent = change.intent;
    if (Object.keys(shared).length) changes.push({ op: 'phase.update', id, ...shared });
    if (change.agent != null) changes.push({ op: 'phase.agent', phase: id, agent: change.agent });
    const scoped = {};
    if (change.reads != null) scoped.inputs = [...change.reads];
    if (change.signOff != null) scoped.approval = approvalChange(change.signOff);
    if (change.because != null) scoped.because = structuredClone(change.because);
    if (change.reset?.length) scoped.reset = [...change.reset];
    if (draft.actions[id] && !draft.steps[id]?.new) scoped.afterStep = draft.actions[id].map((action, index) => ({ id: `${id}-action-${index + 1}`, on: action.on, target: action.target }));
    if (Object.keys(scoped).length) changes.push({ op: 'phase.update', id, workflow: workflowId, ...scoped });
  }
  for (const [id, actions] of Object.entries(draft.actions)) {
    if (draft.steps[id]?.new || draft.overrides[id] || !draft.workflow.phases.includes(id)) continue;
    changes.push({ op: 'phase.update', id, workflow: workflowId, afterStep: actions.map((action, index) => ({ id: `${id}-action-${index + 1}`, on: action.on, target: action.target })) });
  }
  if (decisionsChanged && !draft.workflow.inPlace) changes.push({ op: 'workflow.update', id: workflowId, decisions: structuredClone(draft.workflow.decisions) });
  // Checks are added to what the step already runs here, never in place of it.
  const base = model.workflows.find((workflow) => workflow.id === (draft.workflow.inPlace ? workflowId : draft.workflow.copyOf));
  for (const [id, checks] of Object.entries(draft.checks ?? {})) {
    if (!draft.workflow.phases.includes(id) || !checks.length) continue;
    const current = structuredClone(base?.steps.find((step) => step.id === id)?.qualityCommands ?? []);
    const commandOf = (entry) => (typeof entry === 'string' ? entry : entry?.command ?? (entry?.argv ?? []).join(' '));
    const taken = new Set(current.map((entry) => (typeof entry === 'string' ? entry : entry?.id)));
    const added = checks.filter((check) => !current.some((entry) => [check.command, check.record?.argv.join(' ')].includes(commandOf(entry)))).map((check) => qualityCommand(check, taken));
    if (added.length) changes.push({ op: 'phase.update', id, workflow: workflowId, qualityCommands: [...current, ...added] });
  }
  // What steps' agents are told, edited by exact text; a file another workflow uses changes on a copy.
  changes.push(...lowerTextEdits(draft, model));
  // Clarifying questions are this workflow's own (phase.update with workflow), so another workflow's stay.
  for (const [id, clarificationPolicy] of Object.entries(draft.clarifications ?? {})) {
    if (draft.workflow.phases.includes(id)) changes.push({ op: 'phase.update', id, workflow: workflowId, clarificationPolicy: structuredClone(clarificationPolicy) });
  }
  for (const attachment of draft.attachments) {
    changes.push({ op: 'skill.attach', skill: attachment.skill, ...(attachment.agent ? { agent: attachment.agent } : { workflow: workflowId }),
      phases: attachment.steps.filter((step) => draft.workflow.phases.includes(step)), use: attachment.use ?? '' });
  }
  // What each step is for, as the person confirmed it on one screen: every step's intent, and version 4.
  if (draft.workflow.intents) changes.push({ op: 'workflow.intents', id: workflowId, steps: structuredClone(draft.workflow.intents) });
  return { schema: 'sflow-studio-change-set@1', base: model.base, changes };
}

/**
 * The names (or the option) of every literal in a command line that reads as a secret: a `NAME=value`
 * assignment or `--name=value` option whose name or value looks secret, or a bare token that does. A
 * `$NAME` reference is not a literal. Copied as written, the line would carry it into workflow.yml.
 */
function secretsIn(command) {
  const found = [];
  for (const token of String(command).split(/\s+/u).filter(Boolean)) {
    const assigned = token.match(/^(-{0,2})([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/u);
    const value = (assigned ? assigned[3] : token).replace(/^["']|["']$/gu, '');
    if (value.startsWith('$')) continue;
    const name = assigned ? assigned[2].toUpperCase().replace(/[.-]/gu, '_') : null;
    if ((name && looksSecretName(name)) || looksSecretValue(value)) found.push(assigned ? `${assigned[1]}${assigned[2]}` : 'a token');
  }
  return [...new Set(found)];
}

/**
 * A found command as a check sflow runs when the step is submitted. A test command the completer
 * finished (engine.mjs, instruction-test-commands.mjs) is its full record: variables, folder, module
 * and result, so a code step can publish with it [TCE:REQ-063]. Any other is argv when it is plain
 * words, the command as written when it sets environment variables or quotes. It uses no model.
 */
function qualityCommand(check, taken) {
  const stem = check.command.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60) || 'check';
  let id = stem;
  for (let index = 2; taken.has(id); index += 1) id = `${stem}-${index}`;
  taken.add(id);
  if (check.record) return { ...structuredClone(check.record), id, requirement: check.requirement ?? 'required' };
  const asWritten = /^[A-Za-z_][A-Za-z0-9_]*=|["'\\$`*?]/u.test(check.command);
  // A scanner reads its findings where a reader fits, else it is advisory unless the move says otherwise [CQF decision 6].
  return scannerCheck({ id, modelPolicy: 'never', ...(asWritten ? { command: check.command } : { argv: check.command.split(/\s+/u) }),
    kind: CHECK_KINDS[check.category], ...(check.requirement ? { requirement: check.requirement } : {}), ...(check.directory ? { workingDirectory: check.directory } : {}) },
  check.category, { requirement: 'required' });
}

export function invalidMoves(findings) {
  const listed = findings.slice(0, 12).map((finding) => `\n  ${finding.at}: ${finding.message}`).join('');
  return new SingularityFlowError(`The proposal cannot be used yet:${listed}${findings.length > 12 ? `\n  … and ${findings.length - 12} more` : ''}`,
    { code: 'WORKFLOW_BUILD_PROPOSAL_INVALID', details: { findings } });
}
