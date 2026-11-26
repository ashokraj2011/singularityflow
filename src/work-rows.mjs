/**
 * Work's rows and its task page [FPL:REQ-005 to REQ-007, REQ-036]: a Story's steps as `work status` gives them, its plan as
 * chips, one status line, what happened in plain words, where its plan came from and where a finished one ended.
 *
 * Pure: built from a Story's record (workflow.json) already read, so `work list`, `work status`, `/sf-task` and the VS Code
 * Work tab say the same words. A step is its label, a version is "version 2", and no step ID, digest or commit is said.
 */
import { normalizeApprovalAuthorities } from './approval-authority.mjs';
import { ADDABLE, agentWords, taskStepLabel } from './task-composition.mjs';
import { storyCreatorName } from './story-presentation.mjs';
import { timeWords } from './needs-you-list.mjs';

export const WORK_LIST_RESULT = 'sflow-work-list';
/** Done this week: what ended in the last seven days [FPL:REQ-007]. */
export const DONE_WINDOW_MS = 7 * 86_400_000;
const DONE = new Set(['approved', 'skipped']);
const KIND_ARTICLE = Object.freeze({
  fix: 'a fix', feature: 'a feature', change: 'a change', refactor: 'a refactor', tests: 'a tests task', docs: 'a document task',
  investigate: 'an investigation', review: 'a review', chore: 'a chore'
});
const CHIP_WORDS = Object.freeze({ done: 'done', now: 'now', 'waits-for-you': 'waits for you', 'to-do': 'to do', added: 'added, to do' });

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const lowerFirst = (value) => (value ? `${value[0].toLowerCase()}${value.slice(1)}` : value);
const listWords = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');

/** A task's Story (`work --start`, or a composed task's work type), as needs-you-items.mjs reads it. */
export function isTaskStory(workflow) {
  const composition = workflow?.resolution?.composition;
  return /^task-[a-z]+$/u.test(String(workflow?.workItem?.workType ?? ''))
    || Boolean(composition && typeof composition === 'object' && typeof composition.kind === 'string' && Array.isArray(composition.steps));
}

/** Each step as `work status` gives it: its label, its state, who approved it and its document on the Story's branch. */
export function storySteps(workflow, folder, id = workflow?.workItem?.id) {
  return (workflow?.phaseOrder ?? []).map((stepId) => {
    const phase = workflow.phases?.[stepId] ?? {};
    const approvedBy = phase.status !== 'approved' ? null
      : phase.approvalDisposition === 'approved_automatically' ? 'sflow' : phase.approvedBy ? 'person' : 'none-needed';
    return { id: stepId, label: phase.label ?? stepId, status: phase.status ?? 'not_started', approvedBy,
      document: phase.requiredArtifact?.path ? `${folder}/${id}/${phase.requiredArtifact.path}` : null };
  });
}

/** `work status`'s words for where a Story stands. */
export function standsWords(id, steps, done) {
  return done
    ? `${id} is done: ${steps.map((step) => step.label).join(', ')}.`
    : `${id} is at ${steps.find((step) => !DONE.has(step.status))?.label ?? 'its next step'}.`;
}

/** The steps added to the plan: by the team's rules or the person before the start, and by `work add` after it. */
function addedSteps(workflow) {
  const composition = workflow?.resolution?.composition ?? null;
  const intents = new Set([...(composition?.added ?? []).map((entry) => entry.intent),
    ...(composition?.changes ?? []).filter((entry) => entry.change === 'add').map((entry) => entry.intent)]);
  const ids = new Set((workflow?.history ?? []).filter((entry) => entry.event === 'task_step_added').map((entry) => entry.phase));
  for (const step of composition?.steps ?? []) if (intents.has(step.intent)) ids.add(step.id);
  return ids;
}

/**
 * The plan as one line of chips [FPL:REQ-005, REQ-037]: each step by its label with its state (done, now, waits for you,
 * to do, or added), in words as well as by state. `waitingStep` is the step a Needs-you item of this person holds.
 */
export function planChips(workflow, steps, { waitingStep = null } = {}) {
  const added = addedSteps(workflow);
  const current = workflow?.status === 'in_progress' ? workflow.currentPhase : null;
  return steps.map((step) => {
    const state = DONE.has(step.status) ? 'done' : step.id === waitingStep ? 'waits-for-you' : step.id === current ? 'now'
      : added.has(step.id) ? 'added' : 'to-do';
    const waits = state === 'now' && step.status === 'awaiting_approval' ? 'now, waits for approval' : CHIP_WORDS[state];
    return { id: step.id, label: step.label, state, ...(added.has(step.id) ? { added: true } : {}), words: `${step.label}, ${waits}` };
  });
}

/** The approval groups a step or a decision waits for, by their labels. */
function groupWords(workflow, ids) {
  let registry = {};
  try { registry = normalizeApprovalAuthorities(workflow?.resolution?.approvalAuthorities ?? null) ?? {}; } catch { registry = {}; }
  const labels = (Array.isArray(ids) ? ids : []).map((id) => registry[id]?.label ?? id).filter(Boolean);
  return labels.length ? listWords(labels).replace(/ and ([^,]+)$/u, ' or $1') : 'a person';
}

/** Where a finished task ended [ITW:REQ-018]: a report, the pull request it asked for, or its change on its branch. */
export function endedWhere(workflow) {
  const composition = workflow?.resolution?.composition ?? null;
  if (composition?.pullRequest) return 'pull request open';
  if (['investigate', 'review'].includes(composition?.kind)) return 'report ready';
  return 'checked on its branch';
}

/**
 * The status line when nothing of this person's holds the Story [FPL:REQ-005]: who or what it waits for ("Waiting for
 * Reviewers: approve Code"), or where it stands in `work status`'s words.
 */
export function statusWords(workflow, steps) {
  const id = workflow?.workItem?.id ?? 'This Story';
  if (workflow?.status === 'closed') return `Done: ${endedWhere(workflow)}.`;
  if (workflow?.status === 'cancelled') return `${id} was stopped.`;
  const pending = workflow?.pendingDecision;
  if (pending) return `Waiting for ${groupWords(workflow, pending.by)}: ${lowerFirst(text(pending.label) ?? 'a decision')}`;
  const phase = workflow?.phases?.[workflow.currentPhase];
  if (phase?.status === 'awaiting_approval') return `Waiting for ${groupWords(workflow, phase.approvalPolicy?.authorities)}: approve ${phase.label ?? phase.id}`;
  return standsWords(id, steps, false);
}

/** "Waiting for you: Approve Plan?" when a Needs-you item of this person belongs to the Story [FPL:REQ-005]. */
export const waitingForYou = (question) => `Waiting for you: ${question}`;

/** The material events of a Story, in plain words, oldest first [FPL:REQ-006]. */
const EVENT_WORDS = Object.freeze({
  work_started: () => 'Started',
  phase_submitted: (label) => `${label} is ready for approval`,
  phase_approved: (label) => `${label} approved`,
  phase_self_approved: (label) => `${label} approved by its author`,
  'phase-approved-automatically': (label) => `SFlow approved ${label}`,
  'phase-approval-waived': (label) => `${label} needed no approval`,
  phase_completed_without_approval: (label) => `${label} finished`,
  phase_rejected: (label) => `${label} was sent back`,
  rejection: (label) => `${label} was sent back`,
  task_step_added: (label) => `${label} step added`,
  task_kind_changed: () => 'The kind of task changed',
  version_opened: (label) => `A new version of ${label} started`,
  refactor_behaviour_kept: () => 'The old behaviour is kept',
  decision_settled: () => 'A decision was made',
  workflow_reopened: () => 'Reopened',
  work_cancelled: () => 'Stopped'
});
const EVENT_LIMIT = 40;

export function storyEvents(workflow, { now = new Date() } = {}) {
  const labelOf = (id) => workflow?.phases?.[id]?.label ?? id ?? 'a step';
  const events = (workflow?.history ?? []).filter((entry) => entry && Object.hasOwn(EVENT_WORDS, entry.event))
    .map((entry) => ({ at: entry.at ?? null, when: timeWords(entry.at, now), words: EVENT_WORDS[entry.event](labelOf(entry.phase)) }));
  return events.slice(-EVENT_LIMIT);
}

/** "Now" and "Next": the step being worked on and the one after it. */
export function nowAndNext(steps) {
  const index = steps.findIndex((step) => !DONE.has(step.status));
  return { now: index < 0 ? null : steps[index].label, next: index < 0 ? null : steps[index + 1]?.label ?? null };
}

/** What the person approves, named as the plan line names it. */
function approvalWords(composition, intent) {
  const step = (composition.steps ?? []).find((entry) => entry.intent === intent);
  return `your approval of the ${lowerFirst(step?.label ?? taskStepLabel(composition.kind, intent))}`;
}

/**
 * Where a task's steps came from [FPL:REQ-006]: "Composed from your words: a fix. The team's rules added the tests and your
 * approval of the code." Read from the Story's composition (`rules`, `added`, each with its `because`).
 */
export function planNote(workflow) {
  const composition = workflow?.resolution?.composition ?? null;
  if (!composition || !Array.isArray(composition.steps)) {
    return workflow?.workItem?.workType ? `Follows the workflow ${workflow.workItem.workType}, as it is.` : null;
  }
  const labelOf = (intent) => lowerFirst((composition.steps ?? []).find((step) => step.intent === intent)?.label ?? taskStepLabel(composition.kind, intent));
  const sentences = [];
  if (composition.uses) sentences.push(composition.rules?.[0]?.because ?? `Your team runs every ${composition.kind} task as one of its workflows.`);
  else if (composition.local) sentences.push(`You chose your team's workflow ${composition.local.label ?? composition.local.workflow} as the plan.`);
  else if (composition.agent) sentences.push(`Its steps are ${agentWords(composition.agent)}'s workflow, for ${KIND_ARTICLE[composition.kind] ?? 'a task'}.`);
  else sentences.push(`Composed from your words: ${KIND_ARTICLE[composition.kind] ?? 'a task'}.`);
  const byRules = [...new Set((composition.added ?? []).map((entry) => `the ${labelOf(entry.intent)}`)),
    ...(composition.personApproves ?? []).map((intent) => approvalWords(composition, intent))];
  if (byRules.length) sentences.push(`The team's rules added ${listWords(byRules)}.`);
  const byPerson = (composition.changes ?? []).filter((entry) => entry.change === 'add').map((entry) => `the ${labelOf(entry.intent)}`);
  if (byPerson.length) sentences.push(`You added ${listWords(byPerson)}.`);
  const later = (workflow.history ?? []).filter((entry) => entry.event === 'task_step_added').map((entry) => lowerFirst(workflow.phases?.[entry.phase]?.label ?? entry.phase));
  if (later.length) sentences.push(`Added after the start: ${listWords(later)}.`);
  return sentences.join(' ');
}

/** The rules that applied to the task, each with its `because` [FPL:REQ-006]. */
export function rulesApplied(workflow) {
  return (workflow?.resolution?.composition?.rules ?? []).filter((entry) => text(entry?.because))
    .map((entry) => ({ rule: String(entry.rule ?? ''), because: entry.because.trim() }));
}

/** The steps `work add` can give this task: ADDABLE, minus those it has; a plan or a review only with code [ITW:REQ-009]. */
export function addableSteps(workflow) {
  const composition = workflow?.resolution?.composition ?? null;
  if (!isTaskStory(workflow) || workflow?.status !== 'in_progress' || !composition || composition.uses || composition.local) return [];
  const has = new Set((composition.steps ?? []).map((step) => step.intent));
  return ADDABLE.filter((intent) => !has.has(intent) && (!['plan', 'review'].includes(intent) || has.has('code')))
    .map((intent) => ({ step: intent, label: taskStepLabel(composition.kind, intent) }));
}

/**
 * One row of Work [FPL:REQ-005, REQ-007]: the title, its ID and repository, when it started and by whom, the plan as chips
 * with `work status`'s steps, one status line, and where a finished one ended. `place` says where it is on this computer.
 */
export function workRow(workflow, { repository, folder, mine, place = {}, now = new Date() }) {
  const id = workflow.workItem?.id;
  const steps = storySteps(workflow, folder, id);
  const composition = workflow.resolution?.composition ?? null;
  const updatedAt = workflow.history?.at(-1)?.at ?? workflow.workItem?.createdAt ?? null;
  return {
    id, title: workflow.workItem?.title ?? id, task: isTaskStory(workflow), kind: composition?.kind ?? null, workType: workflow.workItem?.workType ?? null,
    repository: { id: repository.id, name: repository.name ?? repository.id },
    branch: workflow.lineage?.canonicalBranch ?? workflow.workItem?.branch ?? id, base: workflow.workItem?.baseBranch ?? null,
    startedAt: workflow.workItem?.createdAt ?? null, startedWhen: timeWords(workflow.workItem?.createdAt, now),
    startedBy: storyCreatorName(workflow.workItem?.createdBy), mine,
    status: workflow.status ?? null, steps, chips: planChips(workflow, steps), statusLine: statusWords(workflow, steps),
    // The line without this person's Needs-you item: what a surface shows once that item is acted on.
    standing: statusWords(workflow, steps),
    updatedAt, ...(workflow.status === 'closed' ? { ended: { at: updatedAt, when: timeWords(updatedAt, now), where: endedWhere(workflow) } } : {}),
    place: { checkout: place.checkout ?? null, clone: place.clone ?? null }
  };
}

/** The row with this person's Needs-you item, when one belongs to its Story: its status line, and its chip waits for you. */
export function withWaiting(row, item) {
  if (!item) return row;
  const step = item.step?.id ?? null;
  const chips = row.chips.map((chip) => (chip.id === step && chip.state !== 'done'
    ? { ...chip, state: 'waits-for-you', words: `${chip.label}, waits for you` } : chip));
  return { ...row, chips, statusLine: waitingForYou(item.question), waiting: { key: item.key, question: item.question } };
}

/** In progress: newest first, ties by repository then ID. Done this week: most recently ended first. */
export function orderRows(rows, { now = new Date() } = {}) {
  const time = (value) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : 0; };
  const tie = (left, right) => left.repository.name.localeCompare(right.repository.name) || String(left.id).localeCompare(String(right.id));
  const inProgress = rows.filter((row) => row.status === 'in_progress')
    .sort((left, right) => time(right.startedAt) - time(left.startedAt) || tie(left, right));
  const doneThisWeek = rows.filter((row) => row.status === 'closed' && row.ended && now.getTime() - time(row.ended.at) <= DONE_WINDOW_MS)
    .sort((left, right) => time(right.ended.at) - time(left.ended.at) || tie(left, right));
  return { inProgress, doneThisWeek };
}
