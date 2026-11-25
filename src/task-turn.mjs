/**
 * `/sf-task` on an open task: "do what comes next" [ITW:REQ-001, REQ-008, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md].
 *
 * The person types one command between steps instead of choosing among /sf-next, /sf-approve and /sf-decide. The turn
 * is recorded as the skill the Story's next action needs, so every existing rule of that turn applies unchanged: a
 * person's approval is an approval-only turn whose Yes is the person's own answer (never the agent's), a decision is a
 * decision-only turn, and the step's own work is /sf-next's turn, bound to that one step as before. A Story with
 * nothing to do, or no Story, keeps the /sf-task turn (it starts a task, or says the task is done).
 *
 * Read in the prompt hook: the Story's guide is pure (src/guide.mjs), so this costs one Story read.
 *
 * The same turn carries the task on with nothing typed after a start it ran and after the person's Yes it recorded
 * (taskTurnContinuation, read in the after-tool hook): the turn is then that next action's, as if /sf-task were typed.
 */
import { realpath } from 'node:fs/promises';

/** The words typed after the skill's name, as the hosts deliver them (`/sf-task …` or a skill-context block). */
export function typedAfterSkill(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  const args = text.trim().startsWith('/') ? text.trim().replace(/^\/\S+\s*/u, '')
    : text.match(/\bARGUMENTS:\s*([^]*?)\s*<\/skill-context>/u)?.[1] ?? '';
  return String(args).trim();
}

const NAME = (skill) => String(skill ?? '').replace(/^\/?(?:sflow|sf)-/u, '').split(/\s+/u)[0];

/** The skill a /sf-task turn takes for this Story's next action, or null to keep the /sf-task turn. Pure. */
export function taskTurnSkillFor(workflow, guide) {
  if (!workflow || workflow.status !== 'in_progress' || !workflow.currentPhase) return null;
  const first = (guide?.nextActions ?? []).find((action) => action && !action.optional);
  const name = NAME(first?.skill);
  if (name === 'approve') return 'sf-approve';
  if (name === 'decide') return 'sf-decide';
  if (name === 'reject') return 'sf-reject';
  return 'sf-next';
}

const discoveryRoot = async (value) => (await import('./copilot-repository-boundary.mjs')).resolveCopilotDiscoveryRoot(value);
const acceptedStory = async (root) => (await import('./accepted-story-execution.mjs')).loadAcceptedStoryExecution(root);

/** The skill a typed `/sf-task` takes, from the Story this chat is bound to and in progress; null keeps /sf-task (it starts a task). */
export async function taskTurnSkill(payload, { resolveRoot = discoveryRoot, load = acceptedStory } = {}) {
  // Words typed while a task is open (an answer, "go on", a change) are that Story's next turn too; the skill reads them.
  const root = await resolveRoot(payload).catch(() => null);
  if (!root) return null;
  const accepted = await load(root).catch(() => null);
  const workflow = accepted?.workflow;
  if (!workflow) return null;
  const { workflowGuide } = await import('./guide.mjs');
  return taskTurnSkillFor(workflow, workflowGuide(workflow));
}

const TYPED = new Set(['sf-task', 'sflow-task']);
// The next actions a /sf-task turn carries on into: the next step's own work, or the next approval question. A decision
// is the person's on its card, and a return the person's with their reason: the turn never carries on into either.
const CARRIED = new Set(['sf-next', 'sf-approve']);
// A record written a moment before the turn's prompt was kept (clocks of two processes) still belongs to the turn.
const CLOCK_SLACK_MS = 1000;
const since = (at, turn) => Number.isFinite(Date.parse(at)) && Date.parse(at) >= turn.recordedAt - CLOCK_SLACK_MS;

/** What each carried call is: who ran it, and which SFlow command did it, read as the guard reads it. */
const CARRY = Object.freeze({
  start: ({ positionals, options }) => positionals[0] === 'work' && !['add', 'skip', 'status', 'handoff'].includes(positionals[1]) && options.start === true,
  approval: ({ positionals }) => positionals[0] === 'approve',
  submission: ({ positionals, options }) => positionals[0] === 'submit' || (positionals[0] === 'status' && options['submit-if-ready'] === true)
});

/** Which carried call this turn may make: the task's own turn starts, the turns /sf-task took approve or submit. */
function carryReason(turn) {
  if (TYPED.has(turn.skill)) return 'start';
  if (!TYPED.has(turn.typedSkill)) return null;
  return { approve: 'approval', next: 'submission' }[NAME(turn.skill)] ?? null;
}

/**
 * Whether the tool call that just finished carries this `/sf-task` turn on into the task's next action, and as which
 * skill's turn [ITW:REQ-008, A11, A17, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md]. Three calls do, each only once what it did
 * shows in the Story, never on the host's word that it succeeded:
 * - the task's own turn (`/sf-task <words>`, nothing open yet) ran `work … --start`, and this checkout now holds a task's
 *   Story in progress that was created during this turn: the turn goes on into its first step (the intake's question,
 *   then its writing) with nothing typed;
 * - the step's own work /sf-task took (/sf-next's turn) ran `submit` or `status --submit-if-ready`, and the step that turn
 *   was bound to, still the current one, now waits for a person's approval after a submission recorded during this turn:
 *   the turn goes on into that approval's question, as the approval-only turn of that step, whose Yes is the person's;
 * - the approval-only turn `/sf-task` took ran `approve`, and the step that turn was bound to now reads approved, by an
 *   approval recorded during this turn (the person's own Yes, which the guard held that command to): the turn goes on
 *   with the next step's work or the next approval question.
 * Every other turn, a classic Story's and one the person typed `/sf-approve` or `/sf-next` for among them, ends as before.
 * `turn` is the session's boundary record; `ran` is its mutation record and the SFlow commands the call ran, as the guard
 * read them (copilot-mutation-guard.mjs turnRanCommands). Returns `{ skill, workId, reason }`, or null to leave the turn.
 */
export async function taskTurnContinuation(payload, { turn, ran, resolveRoot = discoveryRoot, load = acceptedStory } = {}) {
  const value = ran?.value;
  if (!turn || !value || value.turnId !== turn.turnId || value.sessionId !== turn.sessionId || !Number.isFinite(turn.recordedAt)) return null;
  const reason = carryReason(turn);
  const workId = value.contract?.workId ?? null;
  if (!reason || (reason !== 'start' && !workId) || (reason === 'approval' && value.contract.turnMode !== 'approval-only')) return null;
  const ours = (options) => reason === 'start' || options['work-id'] === undefined || options['work-id'] === workId;
  if (!(ran.commands ?? []).some((command) => CARRY[reason](command) && ours(command.options))) return null;
  // The checkout this turn is bound to, and none other (a start in an isolated worktree, or a Story another folder holds).
  const bound = value.contract?.repositoryRoot ?? value.repositoryRoot ?? null;
  const root = await resolveRoot(payload).catch(() => null);
  if (!bound || !root || await realpath(root).catch(() => null) !== bound) return null;
  const workflow = (await load(root).catch(() => null))?.workflow ?? null;
  const { isTaskStory } = await import('./safe-command-guidance.mjs');
  if (!isTaskStory(workflow) || workflow.status !== 'in_progress' || (reason !== 'start' && workflow.workItem?.id !== workId)) return null;
  const step = reason === 'start' ? null : workflow.phases?.[value.originPhase ?? value.contract.phaseId];
  if (reason === 'start' && !since(workflow.workItem?.createdAt, turn)) return null;
  if (reason === 'submission' && (step?.status !== 'awaiting_approval' || workflow.currentPhase !== step.id || !since(step.submittedAt, turn))) return null;
  if (reason === 'approval' && (step?.status !== 'approved'
      || !(step.approvals ?? []).some((entry) => entry && !entry.invalidatedAt && since(entry.at, turn)))) return null;
  const { workflowGuide } = await import('./guide.mjs');
  const skill = taskTurnSkillFor(workflow, workflowGuide(workflow));
  // A submission goes on only into the person's approval of that same step.
  return CARRIED.has(skill) && (reason !== 'submission' || skill === 'sf-approve') ? { skill, workId: workflow.workItem.id, reason } : null;
}
