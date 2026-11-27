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
// How SFlow records a step it approved itself: approve twice's automatic approval, or a policy's waiver.
const AUTOMATIC = new Set(['approved_automatically', 'policy_waived']);
const since = (at, turn) => Number.isFinite(Date.parse(at)) && Date.parse(at) >= turn.recordedAt - CLOCK_SLACK_MS;

/** What each carried call is: who ran it, and which SFlow command did it, read as the guard reads it. */
const CARRY = Object.freeze({
  start: ({ positionals, options }) => positionals[0] === 'work' && !['add', 'skip', 'shape', 'status', 'handoff'].includes(positionals[1]) && options.start === true,
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
 *   the turn goes on into that approval's question, as the approval-only turn of that step, whose Yes is the person's.
 *   Or SFlow approved that step itself during this turn and the Story moved on: the turn goes on with the next step's
 *   work or approval question (reason `completion`; owner, 2026-11-26, replacing OSA decision 7 for tasks only);
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
  // A submission waits for a person's approval of that step, or SFlow approved the step itself (owner, 2026-11-26).
  const waiting = reason === 'submission' && step?.status === 'awaiting_approval' && workflow.currentPhase === step.id && since(step.submittedAt, turn);
  const completed = reason === 'submission' && step?.status === 'approved' && AUTOMATIC.has(step.approvalDisposition) && workflow.currentPhase !== step.id
    && [step.approvedAt, step.automaticApproval?.at].some((at) => since(at, turn));
  // Or the task grew at that submission (ITW v1.2 REQ-106): SFlow returned the code to the plan it added before it, and the
  // turn goes on with the plan, as after a step SFlow approves itself.
  const grown = reason === 'submission' && !waiting && !completed && workflow.currentPhase !== step?.id
    && (workflow.changeRequests ?? []).some((entry) => entry?.automatic?.kind === 'task-grown' && entry.sourcePhase === step?.id && since(entry.requestedAt, turn));
  if (reason === 'submission' && !waiting && !completed && !grown) return null;
  if (reason === 'approval' && (step?.status !== 'approved'
      || !(step.approvals ?? []).some((entry) => entry && !entry.invalidatedAt && since(entry.at, turn)))) return null;
  const { workflowGuide } = await import('./guide.mjs');
  const skill = taskTurnSkillFor(workflow, workflowGuide(workflow));
  // A submission that waits goes on only into the person's approval of that same step.
  if (!CARRIED.has(skill) || (waiting && skill !== 'sf-approve')) return null;
  return { skill, workId: workflow.workItem.id, reason: completed ? 'completion' : grown ? 'grown' : reason };
}

/**
 * Who carries a `/sf-task` turn on in this repository [ITW:REQ-111, docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md]: `hooks` when a
 * live `/sf-task` turn record, written by the prompt hook, binds this checkout (its mutation contract names it), else
 * `skill`, where the sflow-task skill goes on by its own instructions (IntelliJ Copilot's local agent, a folder opened
 * through a link: no hook ran). Decided from the records alone, never from the host's word. With the session known
 * (COPILOT_AGENT_SESSION_ID) only that session's record counts. Reads only.
 */
export async function taskTurnCarrier(root, { env = process.env, now = Date.now() } = {}) {
  try {
    const [{ readdir, readFile }, path, { createHash }, mode] = await Promise.all([import('node:fs/promises'), import('node:path'),
      import('node:crypto'), import('./copilot-mode.mjs')]);
    const directory = path.join(path.dirname(mode.copilotModeFile(env)), 'copilot-boundaries');
    const bound = await realpath(root).catch(() => path.resolve(root));
    const session = typeof env.COPILOT_AGENT_SESSION_ID === 'string' && env.COPILOT_AGENT_SESSION_ID ? env.COPILOT_AGENT_SESSION_ID : null;
    const names = session ? [`${createHash('sha256').update(session).digest('hex')}.json`]
      : (await readdir(directory).catch(() => [])).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
    for (const name of names) {
      const file = path.join(directory, name);
      const turn = await mode.withTurnRenewal(JSON.parse(await readFile(file, 'utf8').catch(() => 'null')), file, now);
      if (!turn || !TYPED.has(turn.typedSkill ?? turn.skill) || !Number.isFinite(turn.recordedAt)
          || now - mode.turnWindowStart(turn) > mode.TURN_WINDOW_MS) continue;
      const contract = JSON.parse(await readFile(file.replace(/\.json$/u, '.mutation.json'), 'utf8').catch(() => 'null'));
      const named = contract?.contract?.repositoryRoot ?? contract?.repositoryRoot ?? null;
      if (named && await realpath(named).catch(() => named) === bound) return 'hooks';
    }
  } catch { /* unreadable records carry nothing: the skill goes on */ }
  return 'skill';
}
