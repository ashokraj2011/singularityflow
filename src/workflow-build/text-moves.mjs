/**
 * Builder moves that change what a step's agent is told, anchored on exact text (SPEC-WIA):
 *
 * - `agent.edit` { agent, old, new?, copy? }: the agent file's instructions;
 * - `skill.edit` { skill, old, new?, copy? }: a skill's procedure;
 * - `instruction.edit` { instruction, old, new? }: a reusable instruction;
 * - `step.change` with `edit: { old, new? }`: the step's template as this workflow runs it;
 * - `instruction.extract` { id, description, text, from: [{ agent|skill|instruction|step, old }], label?, skill?, steps? }:
 *   one rule several files repeat becomes one shared instruction, placed by one skill this
 *   workflow attaches to `steps`, and taken out of each file it came from.
 *
 * `old` must occur exactly once in the text as the build leaves it so far; `new` (default: nothing)
 * takes its place. A file another workflow uses is never changed under it: an agent or skill is
 * changed on a copy (`copy`: its new ID) that this workflow's steps use instead, a template on a
 * copy this step uses in this workflow, and a shared instruction is refused with what to do. Pure:
 * every text comes from the Studio model.
 */
import { STUDIO_ID as ID } from '../agent-document-parser.mjs';

export const TEXT_MOVES = Object.freeze({
  'agent.edit': { required: ['agent', 'old'], optional: ['new', 'copy'] },
  'skill.edit': { required: ['skill', 'old'], optional: ['new', 'copy'] },
  'instruction.edit': { required: ['instruction', 'old'], optional: ['new'] },
  'instruction.extract': { required: ['id', 'description', 'text', 'from'], optional: ['label', 'skill', 'steps'] }
});

const MAX_TEXT = 64 * 1024;
const SOURCE_KINDS = ['agent', 'skill', 'instruction', 'step'];
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (text, part) => {
  let found = 0;
  for (let index = text.indexOf(part); index >= 0; index = text.indexOf(part, index + 1)) found += 1;
  return found;
};

/** The workflows (other than `workflowId`) a file reaches, read from the Studio model alone. */
export function textUsers(model, kind, id, workflowId, stepId = null) {
  const workflowsOf = (phaseIds) => [...new Set(model.workflows.filter((workflow) => workflow.phases.some((phase) => phaseIds.includes(phase))).map((workflow) => workflow.id))];
  if (kind === 'agent') {
    const drafted = model.workflows.flatMap((workflow) => workflow.steps.filter((step) => step.agent === id).map((step) => workflow.id));
    return [...new Set(drafted)].filter((other) => other !== workflowId);
  }
  if (kind === 'skill') {
    const skill = (model.skills ?? []).find((entry) => entry.id === id);
    const users = [];
    for (const use of skill?.usedBy ?? []) {
      if (use.workflow) { users.push(use.workflow); continue; }
      const drafted = model.workflows.flatMap((workflow) => workflow.steps.filter((step) => step.agent === use.agent && (!(use.phases ?? []).length || use.phases.includes(step.id)))
        .map(() => workflow.id));
      users.push(...drafted);
    }
    return [...new Set(users)].filter((other) => other !== workflowId);
  }
  if (kind === 'instruction') {
    const item = (model.instructions ?? []).find((entry) => entry.id === id);
    return [...new Set((item?.usedBy ?? []).flatMap((skill) => textUsers(model, 'skill', skill, workflowId)))];
  }
  if (kind === 'template') {
    const template = (model.templates ?? []).find((entry) => entry.path === id);
    if (!template || template.scope !== 'repository') return ['SFlow'];
    const others = [];
    for (const reference of template.usedBy ?? []) {
      const own = /^workflow ([^/]+)\/(.+)$/u.exec(reference);
      if (own) { if (own[1] !== workflowId || own[2] !== stepId) others.push(own[1] === workflowId ? `${workflowId} step ${own[2]}` : own[1]); continue; }
      const step = /^phase (.+)$/u.exec(reference)?.[1];
      if (!step) continue;
      if (step !== stepId) { others.push(...workflowsOf([step]).map((workflow) => (workflow === workflowId ? `${workflowId} step ${step}` : workflow))); continue; }
      // The step's own template reaches every workflow that runs the step without a template of its own.
      for (const workflow of model.workflows.filter((entry) => entry.id !== workflowId && entry.phases.includes(step) && !entry.steps.find((other) => other.id === step)?.template)) others.push(workflow.id);
    }
    return [...new Set(others)];
  }
  return [];
}

/** The template a step runs in a workflow, from the model: its own for the workflow, else the step's. */
export function stepTemplate(model, workflow, stepId) {
  const step = workflow?.steps.find((entry) => entry.id === stepId);
  return step?.template ?? model.phases.find((phase) => phase.id === stepId)?.template ?? null;
}

/** The text a move edits, as the repository has it. */
function baseText(model, kind, id, workflow) {
  if (kind === 'agent') {
    const agent = model.agents.find((entry) => entry.id === id);
    return agent?.scope === 'repository' && agent.path ? agent.instructions ?? '' : null;
  }
  if (kind === 'skill') return (model.skills ?? []).find((entry) => entry.id === id)?.instructions ?? null;
  if (kind === 'instruction') return (model.instructions ?? []).find((entry) => entry.id === id)?.instructions ?? null;
  if (kind === 'step') {
    const template = stepTemplate(model, workflow, id);
    return template ? (model.templates ?? []).find((entry) => entry.path === template)?.content ?? null : null;
  }
  return null;
}

const keyOf = (kind, id) => `${kind}:${id}`;
const applyEdits = (text, edits) => edits.reduce((current, edit) => current.replace(edit.old, () => edit.new ?? ''), text);

/** The text a key has once the draft's edits are applied, and the draft entry. */
function currentText(draft, model, kind, id, workflow) {
  const entry = draft.texts?.[keyOf(kind, id)] ?? null;
  const base = baseText(model, kind, id, workflow);
  return base == null ? null : applyEdits(base, entry?.edits ?? []);
}

/**
 * Checks text moves in order, each against the text the ones before it leave: `check(move, at)`
 * adds findings `{ at, code, message }` through `add`, and remembers the edit when it is valid.
 */
export function textMoveChecker({ model, draft, add }) {
  const workflow = model.workflows.find((entry) => entry.id === draft.workflow.id) ?? { id: draft.workflow.id, phases: draft.workflow.phases, steps: [] };
  const state = { texts: structuredClone(draft.texts ?? {}), workflow: draft.workflow };
  const local = { ...draft, texts: state.texts };
  const shared = (kind, id, stepId) => textUsers(model, kind === 'step' ? 'template' : kind, kind === 'step' ? stepTemplate(model, workflow, stepId) : id, workflow.id, stepId);
  const stepsDrafted = (agentId) => draft.workflow.phases.filter((stepId) => (draft.overrides?.[stepId]?.agent ?? workflow.steps.find((step) => step.id === stepId)?.agent) === agentId);

  const edit = (kind, id, at, { old, new: replacement = '', copy = null }) => {
    const label = kind === 'step' ? `step '${id}'s template` : `${kind} '${id}'`;
    if (kind === 'step' && !draft.workflow.phases.includes(id)) { add(`${at}.id`, 'BUILD_MOVE_REFERENCE', `Step '${id}' is not in this workflow.`); return false; }
    const text = currentText(local, model, kind, id, workflow);
    if (text == null) {
      add(at, 'BUILD_MOVE_REFERENCE', kind === 'step' ? `Step '${id}' has no template in this repository to edit.`
        : kind === 'agent' ? `There is no agent file '${id}' in this repository; a packaged agent changes with SFlow.` : `There is no ${kind} '${id}' in this repository.`);
      return false;
    }
    if (typeof old !== 'string' || !old.length) { add(`${at}.old`, 'BUILD_MOVE_FIELD_MISSING', 'old is the exact text to replace.'); return false; }
    if (typeof replacement !== 'string' || replacement.length > MAX_TEXT) { add(`${at}.new`, 'BUILD_MOVE_SHAPE', `new is the text that takes its place, at most ${MAX_TEXT} characters (empty removes it).`); return false; }
    if (replacement === old) { add(`${at}.new`, 'BUILD_MOVE_SHAPE', 'new is the same as old, so nothing changes.'); return false; }
    const found = count(text, old);
    if (found !== 1) {
      add(`${at}.old`, 'BUILD_MOVE_TEXT', found
        ? `old occurs ${found} times in ${label}; quote enough of the text around it that it occurs once.`
        : `old is not in ${label} as this build leaves it; quote its exact text (workflow assess --read shows it with line numbers).`);
      return false;
    }
    if (kind !== 'step' && !applyEdits(text, [{ old, new: replacement }]).trim()) {
      add(`${at}.old`, 'BUILD_MOVE_TEXT', kind === 'agent' ? `Agent '${id}' needs instructions; this would leave none.`
        : `This would leave ${kind} '${id}' empty; take it off what uses it in Workflow Studio instead, or keep some of its text.`);
      return false;
    }
    const users = shared(kind, id, id);
    const entry = state.texts[keyOf(kind, id)] ?? { edits: [], copy: null };
    const copyId = entry.copy ?? copy;
    if (users.length && kind === 'instruction') {
      add(at, 'BUILD_MOVE_SHARED_TEXT', `Instruction '${id}' is also used by ${users.join(', ')}, so changing it changes their steps too. Edit the skill that places it instead, or change it in Workflow Studio for every workflow that uses it.`);
      return false;
    }
    if (users.length && (kind === 'agent' || kind === 'skill') && !copyId) {
      add(`${at}.copy`, 'BUILD_MOVE_SHARED_TEXT', `${kind === 'agent' ? 'Agent' : 'Skill'} '${id}' is also used by ${users.join(', ')}; give copy: '${id}-${workflow.id}' to change a copy that only this workflow's steps use.`);
      return false;
    }
    if (copyId && !entry.copy) {
      if (typeof copyId !== 'string' || !ID.test(copyId)) { add(`${at}.copy`, 'BUILD_MOVE_ID', `copy '${copyId}' must be lower-case kebab-case.`); return false; }
      const taken = kind === 'agent' ? model.agents.some((agent) => agent.id === copyId) || Boolean(draft.agents?.[copyId]) : (model.skills ?? []).some((skill) => skill.id === copyId) || Boolean(draft.skills?.[copyId]);
      if (taken) { add(`${at}.copy`, 'BUILD_MOVE_EXISTS', `There is already a ${kind} called '${copyId}'; name the copy another way.`); return false; }
      if (kind === 'agent') {
        const sharedSteps = stepsDrafted(id).filter((stepId) => (model.phases.find((phase) => phase.id === stepId)?.usedBy ?? []).some((other) => other !== workflow.id));
        if (sharedSteps.length) {
          add(`${at}.copy`, 'BUILD_MOVE_SHARED_STEP', `${sharedSteps.join(', ')} ${sharedSteps.length === 1 ? 'is' : 'are'} also used by other workflows, and a step has one agent everywhere: add a copy of ${sharedSteps.length === 1 ? 'that step' : 'those steps'} with step.add and from first.`);
          return false;
        }
      } else {
        const skill = (model.skills ?? []).find((entry) => entry.id === id);
        const blocked = (skill?.usedBy ?? []).filter((use) => use.agent && textUsers(model, 'agent', use.agent, workflow.id).length
          && workflow.steps.some((step) => step.agent === use.agent));
        if (blocked.length) {
          add(`${at}.copy`, 'BUILD_MOVE_SHARED_STEP', `Agent '${blocked[0].agent}' attaches the skill and also drafts steps of other workflows, so a copy cannot replace it for this workflow alone; copy the agent first (agent.edit with copy).`);
          return false;
        }
      }
    }
    state.texts[keyOf(kind, id)] = { edits: [...entry.edits, { old, new: replacement }], copy: copyId ?? null };
    return true;
  };

  return function check(move, at) {
    if (move.move === 'step.change') return move.edit == null ? true : plain(move.edit) ? edit('step', move.id, `${at}.edit`, move.edit) : (add(`${at}.edit`, 'BUILD_MOVE_SHAPE', 'edit is { old, new }: the exact text of the step\'s template to replace, and what replaces it.'), false);
    if (move.move === 'agent.edit') return edit('agent', move.agent, at, move);
    if (move.move === 'skill.edit') return edit('skill', move.skill, at, move);
    if (move.move === 'instruction.edit') return edit('instruction', move.instruction, at, move);
    if (move.move !== 'instruction.extract') return true;
    let fits = true;
    if (typeof move.id !== 'string' || !ID.test(move.id)) { add(`${at}.id`, 'BUILD_MOVE_ID', `id '${move.id}' must be lower-case kebab-case.`); fits = false; }
    else if ((model.instructions ?? []).some((item) => item.id === move.id) || draft.instructions?.[move.id]) { add(`${at}.id`, 'BUILD_MOVE_EXISTS', `An instruction called '${move.id}' already exists.`); fits = false; }
    if (typeof move.text !== 'string' || !move.text.trim() || move.text.length > 4000) { add(`${at}.text`, 'BUILD_MOVE_SHAPE', 'text is the one rule, at most 4,000 characters.'); fits = false; }
    if (typeof move.description !== 'string' || !move.description.trim() || move.description.length > 600) { add(`${at}.description`, 'BUILD_MOVE_SHAPE', 'description says what the rule is about in one sentence.'); fits = false; }
    const carrier = move.skill ?? `${draft.workflow.id}-shared-rules`;
    if (!ID.test(carrier)) { add(`${at}.skill`, 'BUILD_MOVE_ID', `skill '${carrier}' must be lower-case kebab-case.`); fits = false; }
    else if ((model.skills ?? []).some((skill) => skill.id === carrier) && !draft.skills?.[carrier]?.carrier) {
      add(`${at}.skill`, 'BUILD_MOVE_EXISTS', `There is already a skill called '${carrier}'; name the skill that places the shared rules another way.`); fits = false;
    }
    if (move.steps != null && (!Array.isArray(move.steps) || !move.steps.length || move.steps.some((stepId) => !draft.workflow.phases.includes(stepId)))) {
      add(`${at}.steps`, 'BUILD_MOVE_REFERENCE', 'steps lists steps of this workflow that read the shared rule.'); fits = false;
    }
    if (!Array.isArray(move.from) || move.from.length < 1 || move.from.length > 20) { add(`${at}.from`, 'BUILD_MOVE_SHAPE', 'from lists 1 to 20 places the rule is taken out of: { agent|skill|instruction|step: ID, old }.'); return false; }
    move.from.forEach((source, index) => {
      const where = `${at}.from[${index}]`;
      const kinds = plain(source) ? SOURCE_KINDS.filter((kind) => source[kind] != null) : [];
      if (kinds.length !== 1 || Object.keys(source).some((key) => ![...SOURCE_KINDS, 'old'].includes(key))) {
        add(where, 'BUILD_MOVE_SHAPE', `${where} names one of ${SOURCE_KINDS.join(', ')} and the exact text it removes: { agent: 'pay-dev', old: '...' }.`); fits = false; return;
      }
      // A copy is never made here: a shared file keeps its rule, so its workflows keep reading it.
      if (!edit(kinds[0], source[kinds[0]], where, { old: source.old, new: '' })) fits = false;
    });
    return fits;
  };
}

/** Fold an accepted text move into the draft (applyMoves calls this). */
export function applyTextMove(next, move) {
  next.texts ??= {};
  const push = (kind, id, edit, copy = null) => {
    const key = keyOf(kind, id);
    const entry = next.texts[key] ?? { edits: [], copy: null };
    next.texts[key] = { edits: [...entry.edits, { old: edit.old, new: edit.new ?? '' }], copy: entry.copy ?? copy ?? null };
  };
  if (move.move === 'step.change' && plain(move.edit)) push('step', move.id, move.edit);
  else if (move.move === 'agent.edit') push('agent', move.agent, move, move.copy);
  else if (move.move === 'skill.edit') push('skill', move.skill, move, move.copy);
  else if (move.move === 'instruction.edit') push('instruction', move.instruction, move);
  else if (move.move === 'instruction.extract') {
    next.instructions[move.id] = { label: move.label ?? null, description: move.description, from: null, text: move.text };
    const carrier = move.skill ?? `${next.workflow.id}-shared-rules`;
    const tag = `- <instruction>${move.id}</instruction>`;
    const existing = next.skills[carrier];
    next.skills[carrier] = existing?.carrier ? { ...existing, procedure: `${existing.procedure}\n${tag}` }
      : { label: `${next.workflow.label} shared rules`, description: `The rules every step of ${next.workflow.label} that reads them follows, kept in one place.`,
        from: null, procedure: tag, loading: 'eager', carrier: true };
    const steps = move.steps ?? [];
    const attached = next.attachments.find((entry) => entry.skill === carrier && entry.agent == null);
    next.attachments = [...next.attachments.filter((entry) => entry !== attached),
      { skill: carrier, agent: null, steps: [...new Set([...(attached?.steps ?? []), ...steps])], use: 'Always' }];
    for (const source of move.from) {
      const kind = SOURCE_KINDS.find((entry) => source[entry] != null);
      push(kind, source[kind], { old: source.old, new: '' });
    }
  }
  return next;
}

/** A free template path beside `template` for this workflow's step: the copy an edit goes on. */
function copyPath(model, template, workflowId, stepId) {
  const directory = template.includes('/') ? template.slice(0, template.lastIndexOf('/')) : workflowId;
  const taken = new Set((model.templates ?? []).map((entry) => entry.path));
  let candidate = `${directory}/${workflowId}-${stepId}.md`;
  for (let index = 2; taken.has(candidate); index += 1) candidate = `${directory}/${workflowId}-${stepId}-${index}.md`;
  return candidate;
}

/**
 * The Studio changes the draft's text edits make (lowerDraft calls this, after new agents, skills
 * and instructions exist and before skills are attached).
 */
export function lowerTextEdits(draft, model) {
  const changes = [];
  const workflow = model.workflows.find((entry) => entry.id === draft.workflow.id) ?? { id: draft.workflow.id, phases: draft.workflow.phases, steps: [] };
  for (const [key, entry] of Object.entries(draft.texts ?? {})) {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const base = baseText(model, kind, id, workflow);
    if (base == null || !entry.edits.length) continue;
    const text = applyEdits(base, entry.edits);
    if (kind === 'agent') {
      const agent = model.agents.find((candidate) => candidate.id === id);
      if (!entry.copy) { changes.push({ op: 'agent.update', id, instructions: text }); continue; }
      changes.push({ op: 'agent.create', id: entry.copy, label: `${agent.label ?? id} (${draft.workflow.label})`.slice(0, 120), description: agent.description || `Drafts ${draft.workflow.label}'s steps.`,
        role: 'blank', from: id, instructions: text });
      for (const stepId of draft.workflow.phases.filter((candidate) => (draft.overrides?.[candidate]?.agent ?? workflow.steps.find((step) => step.id === candidate)?.agent) === id)) {
        changes.push({ op: 'phase.agent', phase: stepId, agent: entry.copy });
      }
    } else if (kind === 'skill') {
      const skill = (model.skills ?? []).find((candidate) => candidate.id === id);
      if (!entry.copy) { changes.push({ op: 'skill.update', id, instructions: text }); continue; }
      changes.push({ op: 'skill.create', id: entry.copy, label: `${skill.label ?? id} (${draft.workflow.label})`.slice(0, 120), description: skill.description,
        instructions: text, loading: skill.loading ?? 'eager', instructionRefs: [...(skill.instructionRefs ?? [])] });
      for (const use of skill.usedBy ?? []) {
        const mine = use.workflow ? use.workflow === workflow.id : workflow.steps.some((step) => step.agent === use.agent);
        if (!mine) continue;
        const owner = use.workflow ? { workflow: use.workflow } : { agent: use.agent };
        changes.push({ op: 'skill.detach', skill: id, ...owner }, { op: 'skill.attach', skill: entry.copy, ...owner, phases: [...(use.phases ?? [])], use: use.use ?? '' });
      }
    } else if (kind === 'instruction') {
      changes.push({ op: 'instruction.update', id, instructions: text });
    } else if (kind === 'step') {
      const template = stepTemplate(model, workflow, id);
      if (!textUsers(model, 'template', template, workflow.id, id).length) changes.push({ op: 'template.update', path: template, content: text });
      else {
        const target = copyPath(model, template, workflow.id, id);
        changes.push({ op: 'template.create', path: target, content: text }, { op: 'phase.update', id, workflow: workflow.id, template: target });
      }
    }
  }
  return changes;
}

/** What the draft's text edits change, in plain words, for the build's own list of changes. */
export function textChangesOf(draft, model) {
  return Object.entries(draft.texts ?? {}).filter(([, entry]) => entry.edits.length).map(([key, entry]) => {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const label = kind === 'agent' ? model.agents.find((agent) => agent.id === id)?.label ?? id
      : kind === 'skill' ? (model.skills ?? []).find((skill) => skill.id === id)?.label ?? id
        : kind === 'instruction' ? (model.instructions ?? []).find((item) => item.id === id)?.label ?? id
          : `${model.phases.find((phase) => phase.id === id)?.label ?? id}'s template`;
    const removed = entry.edits.filter((edit) => !edit.new).length;
    return { kind, id, label, edits: entry.edits.length, removed, ...(entry.copy ? { copy: entry.copy } : {}) };
  });
}
