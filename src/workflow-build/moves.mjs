/**
 * The moves a workflow build is made of, and how they become one Workflow Studio change set.
 *
 * A proposal (from Copilot or the person) is a short list of moves: add or change a step, add an
 * agent from an existing one, add or attach a skill, add an instruction, a decision, an approval
 * group, an action after a step, a check a step runs (a command the material holds), or say what a
 * found item becomes. Each move is checked on its own
 * (closed fields, IDs, references), every finding located at `moves[i].field`. Accepted moves fold
 * into a draft, and the draft lowers to ordinary Studio operations, so a build finishes through
 * Studio's own reviewed proposal and the check runs on exactly what would be published.
 */
import { CHECK_KINDS } from '../guidance-scan.mjs';
import { SingularityFlowError } from '../util.mjs';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const OUTPUTS = ['document', 'analysis', 'code', 'none'];
const TRIGGERS = ['submitted', 'approved', 'rejected'];
const SIGN_OFF_FIELDS = ['groups', 'minimum', 'sendBackTo'];
const ITEM_AS = ['step', 'agent', 'skill', 'instruction', 'prompt', 'document', 'api-call', 'tool', 'link', 'command', 'checkpoint', 'branch', 'script'];
const INPUT_NAME = /^[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/u;
const kebab = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60);

export const MOVES = Object.freeze({
  'step.add': { required: ['id'], optional: ['label', 'after', 'from', 'agent', 'output', 'reads', 'signOff', 'purpose'] },
  'step.change': { required: ['id'], optional: ['label', 'purpose', 'agent', 'output', 'reads', 'signOff'] },
  'step.remove': { required: ['id'], optional: [] },
  'step.move': { required: ['id'], optional: ['after'] },
  // command, category and directory are filled in from the found command, never written by hand.
  'step.check': { required: ['id', 'item'], optional: ['requirement', 'command', 'category', 'directory'] },
  'agent.add': { required: ['id', 'label', 'description'], optional: ['from', 'instructions', 'tools'] },
  'skill.add': { required: ['id', 'description'], optional: ['label', 'from', 'procedure', 'loading'] },
  'skill.attach': { required: ['skill'], optional: ['agent', 'steps', 'use'] },
  'instruction.add': { required: ['id', 'description'], optional: ['label', 'from', 'text'] },
  'decision.add': { required: ['after', 'kind', 'label'], optional: ['inputs', 'routes', 'goal', 'back', 'maxRounds', 'by'] },
  'decision.remove': { required: ['after'], optional: [] },
  // The work goes a different way by one value (channel web, mobile, otherwise) and comes back together.
  'branch.add': { required: ['after', 'name', 'arms', 'join'], optional: ['label', 'values', 'otherwise', 'item'] },
  'group.add': { required: ['id', 'label'], optional: [] },
  'action.add': { required: ['step', 'on', 'target'], optional: [] },
  'item.classify': { required: ['item', 'as'], optional: [] },
  'item.leaveOut': { required: ['item', 'reason'], optional: [] },
  'item.keepAsLink': { required: ['item'], optional: [] },
  'item.prerequisite': { required: ['item', 'description'], optional: [] }
});

/** The vocabulary as data, for the skill and the chat tool: what each move takes, with an example. */
export function movesGuide() {
  return {
    moves: Object.fromEntries(Object.entries(MOVES).map(([name, fields]) => [name, fields])),
    values: { output: OUTPUTS, on: TRIGGERS, as: ITEM_AS, requirement: ['required', 'advisory'], signOff: "'none' or { groups: [group IDs], minimum, sendBackTo: [step IDs] }" },
    examples: [
      { move: 'step.add', id: 'pay-pci-review', label: 'PCI review', after: 'pay-build', agent: 'pay-reviewer', output: 'document',
        reads: ['pay-build'], signOff: { groups: ['payments-security'], minimum: 1 }, purpose: 'Checks the change against the PCI rules before release.' },
      { move: 'agent.add', id: 'pay-reviewer', label: 'Payments reviewer', description: 'Reviews payment changes against PCI rules.', from: 'architect' },
      { move: 'skill.add', id: 'pci-check', description: 'Checks a change against the PCI rules.', procedure: 'Check card data never reaches logs.' },
      { move: 'skill.attach', skill: 'pci-check', agent: 'pay-reviewer', steps: ['pay-pci-review'] },
      { move: 'step.check', id: 'pay-build', item: 'i-0123456789ab' },
      { move: 'branch.add', after: 'intake', name: 'channel', arms: [{ when: 'web', steps: ['web-build', 'web-test'] }, { when: 'mobile', steps: ['mobile-build'] }],
        otherwise: { steps: ['other-build'] }, join: 'release' },
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
      'A step that writes code (output code) needs a step that defines the requirements at or before the step just before it: reuse one the repository has that defines requirements (such as requirements or implementation-spec), as it is or copied with `from`. No move declares a workflow without requirements, so never offer that choice.',
      'action.add runs an integration target the repository has registered; a command found in the material is never invented as a target.',
      "When the work goes different ways by one value (a branch item, or text like 'when channel is web … if mobile … otherwise …'), use branch.add: the person submitting the step after which it is known chooses the value; every way comes back to join. Put the steps in order first (after, each arm's steps, otherwise's steps, join), each way's steps its own; the last step of each way needs a sign-off to skip the other ways.",
      "A test, lint, type-check, format or build command the material holds (an item whose category says so) becomes the check of the step it belongs to with step.check: sflow runs it when that step is submitted and records the result. Install, run, script and deployment commands stay in their skill or instructions for the agent; never make them checks.",
      "signOff.sendBackTo (optional) names the steps an approver may send rejected work back to: the step itself or steps before it in this workflow. A reused step keeps its own; when the check says rejecting it returns to a step this workflow does not have before it, that finding's fix gives the step.change that repoints it.",
      'Approval groups are created empty; people are added in Workflow Studio, never by a move.',
      'Cite the lines you relied on in the proposal evidence; say what you inferred in `why`.'
    ]
  };
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
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
  try { if (moves.every(plain)) order = applyMoves(draft, moves.slice(0, 50)).workflow.phases; } catch { order = null; }
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
        if (reused && ['label', 'agent', 'output', 'reads', 'signOff', 'purpose'].some((field) => move[field] != null)) {
          add(`${at}.id`, 'BUILD_MOVE_REUSE', `Step '${stepId}' exists and is added as it is; change it with step.change, or add a copy with from: '${stepId}' and a new ID.`);
        }
        if (move.agent != null) { id('agent', 'agent'); known('agent', 'agent'); }
        if (move.after != null && !steps.has(move.after) && !added.step.has(move.after)) add(`${at}.after`, 'BUILD_MOVE_REFERENCE', `Step '${move.after}' is not in this workflow.`);
        if (move.output != null && !OUTPUTS.includes(move.output)) add(`${at}.output`, 'BUILD_MOVE_SHAPE', `output is one of ${OUTPUTS.join(', ')}.`);
        if (move.label != null && !text(move.label, 120)) add(`${at}.label`, 'BUILD_MOVE_SHAPE', 'label is a name of 1 to 120 characters.');
        if (move.purpose != null && !text(move.purpose, 600)) add(`${at}.purpose`, 'BUILD_MOVE_SHAPE', 'purpose is one paragraph of at most 600 characters.');
        stepList('reads'); signOff('signOff');
        if (stepId) added.step.add(stepId);
        break;
      }
      case 'step.change':
        if (move.id && !steps.has(move.id) && !added.step.has(move.id)) add(`${at}.id`, 'BUILD_MOVE_REFERENCE', `Step '${move.id}' is not in this workflow.`);
        else if (move.id && !draft.steps[move.id]?.new && ['label', 'output', 'agent', 'purpose'].some((field) => move[field] != null)) {
          const users = (model.phases.find((phase) => phase.id === move.id)?.usedBy ?? []).filter((workflow) => workflow !== draft.workflow.id && workflow !== draft.workflow.copyOf);
          if (users.length) add(`${at}.id`, 'BUILD_MOVE_SHARED_STEP', `Step '${move.id}' is also used by ${users.join(', ')}; its name, output, agent and purpose change there too. Add a copy with step.add and from: '${move.id}' instead.`);
        }
        if (move.agent != null) known('agent', 'agent');
        if (move.output != null && !OUTPUTS.includes(move.output)) add(`${at}.output`, 'BUILD_MOVE_SHAPE', `output is one of ${OUTPUTS.join(', ')}.`);
        if (move.purpose != null && typeof move.purpose === 'string' && move.purpose.length > 600) add(`${at}.purpose`, 'BUILD_MOVE_SHAPE', 'purpose is at most 600 characters.');
        stepList('reads'); signOff('signOff');
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
      case 'step.check':
        if (move.id && !steps.has(move.id) && !added.step.has(move.id)) add(`${at}.id`, 'BUILD_MOVE_REFERENCE', `Step '${move.id}' is not in this workflow.`);
        if (move.requirement != null && !['required', 'advisory'].includes(move.requirement)) add(`${at}.requirement`, 'BUILD_MOVE_SHAPE', 'requirement is required or advisory.');
        if (typeof move.command !== 'string' || !move.command) add(`${at}.item`, 'BUILD_MOVE_REFERENCE', 'item names a command this build found in the material.');
        else if (!CHECK_KINDS[move.category]) {
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
      default:
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
      baseDecisions: source ? structuredClone(source.decisions ?? []) : []
    },
    steps: {}, overrides: {}, agents: {}, skills: {}, instructions: {}, groups: {}, attachments: [], actions: {}, checks: {},
    items: {}
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
            reads: move.reads ?? null, signOff: move.signOff ?? null, purpose: move.purpose ?? null };
        }
        break;
      }
      case 'step.change': {
        const own = next.steps[move.id];
        const target = own?.new ? own : (next.overrides[move.id] ??= {});
        const earlier = target.signOff;
        for (const field of ['label', 'purpose', 'agent', 'output', 'reads', 'signOff']) if (move[field] !== undefined) target[field] = move[field];
        // A sign-off that does not name send-back targets keeps the ones an earlier move gave it, as Studio does.
        if (plain(move.signOff) && move.signOff.sendBackTo == null && plain(earlier) && earlier.sendBackTo) target.signOff = { ...move.signOff, sendBackTo: earlier.sendBackTo };
        break;
      }
      case 'step.remove':
        next.workflow.phases = next.workflow.phases.filter((entry) => entry !== move.id);
        delete next.steps[move.id]; delete next.overrides[move.id]; delete next.actions[move.id]; if (next.checks) delete next.checks[move.id];
        next.workflow.decisions = next.workflow.decisions.filter((decision) => decision.after !== move.id);
        break;
      case 'step.move':
        next.workflow.phases = insertAfter(next.workflow.phases, move.id, move.after ?? null);
        break;
      case 'agent.add': next.agents[move.id] = { label: move.label, description: move.description, from: move.from ?? null, instructions: move.instructions ?? null, tools: move.tools ?? null }; break;
      case 'skill.add': next.skills[move.id] = { label: move.label ?? null, description: move.description, from: move.from ?? null, procedure: move.procedure ?? null, loading: move.loading ?? null }; break;
      case 'instruction.add': next.instructions[move.id] = { label: move.label ?? null, description: move.description, from: move.from ?? null, text: move.text ?? null }; break;
      case 'group.add': next.groups[move.id] = { label: move.label }; break;
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
          { item: move.item, command: move.command, category: move.category, ...(move.directory ? { directory: move.directory } : {}), requirement: move.requirement ?? 'required' }];
        break;
      case 'action.add': next.actions[move.step] = [...(next.actions[move.step] ?? []), { on: move.on, target: move.target }]; break;
      case 'item.classify': next.items[move.item] = { ...next.items[move.item], kind: move.as }; break;
      case 'item.leaveOut': next.items[move.item] = { ...next.items[move.item], status: 'left-out', reason: move.reason }; break;
      case 'item.keepAsLink': next.items[move.item] = { ...next.items[move.item], status: 'kept-as-link' }; break;
      case 'item.prerequisite': next.items[move.item] = { ...next.items[move.item], status: 'prerequisite', prerequisite: move.description }; break;
      default: break;
    }
  }
  return next;
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
    changes.push({ op: 'phase.create', id, label: step.label ?? id,
      // A copy of a step the source workflow runs keeps that workflow's settings for it.
      ...(step.from ? { copyOf: step.from, ...(model.workflows.find((workflow) => workflow.id === draft.workflow.copyOf)?.phases.includes(step.from) ? { copyFromWorkflow: draft.workflow.copyOf } : {}) } : {}),
      ...(step.output || !step.from ? { output: step.output ?? 'document' } : {}),
      ...(step.reads ? { inputs: [...step.reads] } : step.from ? {} : { inputs: [] }),
      ...(step.signOff ? { approval: approvalChange(step.signOff) } : step.from ? {} : { approval: 'none' }),
      ...(step.agent ? { agent: step.agent } : {}),
      ...(step.purpose ? { description: step.purpose } : {}),
      ...(draft.actions[id] ? { afterStep: draft.actions[id].map((action, index) => ({ id: `${id}-action-${index + 1}`, on: action.on, target: action.target })) } : {}) });
  }
  const decisionsChanged = JSON.stringify(draft.workflow.decisions) !== JSON.stringify(draft.workflow.baseDecisions ?? []);
  if (draft.workflow.inPlace) {
    // A change build updates the workflow it names; only what changed is written.
    const base = draft.workflow.base;
    const update = {
      ...(JSON.stringify(draft.workflow.phases) !== JSON.stringify(base.phases) ? { phases: [...draft.workflow.phases] } : {}),
      ...(draft.workflow.label !== base.label ? { label: draft.workflow.label } : {}),
      ...(decisionsChanged ? { decisions: structuredClone(draft.workflow.decisions) } : {})
    };
    if (Object.keys(update).length) changes.push({ op: 'workflow.update', id: workflowId, ...update });
  } else {
    changes.push({ op: 'workflow.create', id: workflowId, label: draft.workflow.label, phases: [...draft.workflow.phases],
      ...(draft.workflow.description ? { description: draft.workflow.description } : {}), ...(draft.workflow.copyOf ? { copyOf: draft.workflow.copyOf } : {}) });
  }
  for (const [id, change] of Object.entries(draft.overrides)) {
    if (!draft.workflow.phases.includes(id)) continue;
    const shared = {};
    if (change.label != null) shared.label = change.label;
    if (change.purpose != null) shared.description = change.purpose;
    if (change.output != null) shared.output = change.output;
    if (Object.keys(shared).length) changes.push({ op: 'phase.update', id, ...shared });
    if (change.agent != null) changes.push({ op: 'phase.agent', phase: id, agent: change.agent });
    const scoped = {};
    if (change.reads != null) scoped.inputs = [...change.reads];
    if (change.signOff != null) scoped.approval = approvalChange(change.signOff);
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
    const added = checks.filter((check) => !current.some((entry) => commandOf(entry) === check.command)).map((check) => qualityCommand(check, taken));
    if (added.length) changes.push({ op: 'phase.update', id, workflow: workflowId, qualityCommands: [...current, ...added] });
  }
  for (const attachment of draft.attachments) {
    changes.push({ op: 'skill.attach', skill: attachment.skill, ...(attachment.agent ? { agent: attachment.agent } : { workflow: workflowId }),
      phases: attachment.steps.filter((step) => draft.workflow.phases.includes(step)), use: attachment.use ?? '' });
  }
  return { schema: 'sflow-studio-change-set@1', base: model.base, changes };
}

/**
 * A found command as a check sflow runs when the step is submitted: argv when it is plain words, the
 * command as written when it sets environment variables or quotes. It uses no model.
 */
function qualityCommand(check, taken) {
  const stem = check.command.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60) || 'check';
  let id = stem;
  for (let index = 2; taken.has(id); index += 1) id = `${stem}-${index}`;
  taken.add(id);
  const asWritten = /^[A-Za-z_][A-Za-z0-9_]*=|["'\\$`*?]/u.test(check.command);
  return { id, modelPolicy: 'never', ...(asWritten ? { command: check.command } : { argv: check.command.split(/\s+/u) }),
    kind: CHECK_KINDS[check.category], requirement: check.requirement ?? 'required', ...(check.directory ? { workingDirectory: check.directory } : {}) };
}

export function invalidMoves(findings) {
  const listed = findings.slice(0, 12).map((finding) => `\n  ${finding.at}: ${finding.message}`).join('');
  return new SingularityFlowError(`The proposal cannot be used yet:${listed}${findings.length > 12 ? `\n  … and ${findings.length - 12} more` : ''}`,
    { code: 'WORKFLOW_BUILD_PROPOSAL_INVALID', details: { findings } });
}
