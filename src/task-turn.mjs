/**
 * What comes next on any Story, in the same chat [owner, 2026-11-28: "every Story carries on like a task"; ITW:REQ-001,
 * REQ-008, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md].
 *
 * The one way on is typed with no words in the Story's chat: `/sf-task` on a task, `/sf-next` on any Story, and the older
 * names that now do the same (`/sf-nextsteps`, `/sf-status`, `/sf-resume`, `/sf-continue`: NEXT_ACTION_SKILLS). `/sf-recover`
 * keeps its own turn, which runs the repairs the one way on routes to.
 * The turn is recorded as the skill the Story's next action needs, so every existing rule of that turn applies unchanged:
 * a person's approval is an approval-only turn whose Yes is the person's own answer (never the agent's), a decision is a
 * decision-only turn, and the step's own work is /sf-next's turn, bound to that one step as before. A Story with nothing
 * to do, or no Story, keeps the typed turn (it starts a task, attaches a Story, or says what is open).
 *
 * Read in the prompt hook: the Story's guide is pure (src/guide.mjs), so this costs one Story read.
 *
 * The same turn carries the Story on with nothing typed (storyTurnContinuation, read in the after-tool hook): after a
 * task's start, after a step's submission (into the person's approval, or into the next step once SFlow approved it),
 * and after the person's Yes. Workflows run as they are: this changes the turn, never the steps. Each step's prompt is
 * composed fresh by SFlow, so going on in the same chat depends on nothing said earlier in it.
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

/** The skill the one way on takes for this Story's next action, or null to keep the typed turn. Pure. */
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

/**
 * The typed skills that take the Story's next turn [owner, 2026-11-28: one way on that always works]: `/sf-task`, and
 * `/sf-next` with the older names kept as its aliases, so none of them leaves a person choosing among them.
 */
export const NEXT_ACTION_SKILLS = Object.freeze(['task', 'next', 'nextsteps', 'status', 'resume', 'continue']
  .flatMap((name) => [`sf-${name}`, `sflow-${name}`]));

/**
 * The skill a typed one way on takes, from the Story this chat is bound to and in progress; null keeps the typed turn (it
 * starts a task, attaches a Story, or reads). Words typed after `/sf-task` while a task is open (an answer, "go on", a
 * change) are that Story's next turn too; the skill reads them. After any other name only the bound Story's own ID or a
 * flag is: another ID is the typed turn's, which attaches that Story first.
 */
export async function taskTurnSkill(payload, { skill = 'sf-task', resolveRoot = discoveryRoot, load = acceptedStory } = {}) {
  const root = await resolveRoot(payload).catch(() => null);
  if (!root) return null;
  const accepted = await load(root).catch(() => null);
  const workflow = accepted?.workflow;
  if (!workflow) return null;
  const words = typedAfterSkill(payload?.prompt).split(/\s+/u).filter(Boolean);
  if (!TYPED.has(skill) && words.some((word) => !word.startsWith('--') && word !== workflow.workItem?.id)) return null;
  const { workflowGuide } = await import('./guide.mjs');
  return taskTurnSkillFor(workflow, workflowGuide(workflow));
}

const TYPED = new Set(['sf-task', 'sflow-task']);
// The next actions a turn carries on into: the next step's own work, or the next approval question. A decision is the
// person's on its card, and a return the person's with their reason: the turn never carries on into either.
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
    || (positionals[0] === 'story' && positionals[1] === 'advance' && options.submit === true),
  publication: ({ positionals, options }) => positionals[0] === 'phase' && (positionals[1] === 'publish'
    || (positionals[1] === 'prepublish' && options['publish-if-ready'] === true))
});

/**
 * Which carried call this turn may make: the task's own turn starts; an approval turn approves; the step's own work (the
 * work command, /sf-next, any step's writer or writing alias) and /sf-submit submit. Whoever typed it, and on any Story.
 */
async function carryReason(turn) {
  if (TYPED.has(turn.skill)) return 'start';
  const name = NAME(turn.skill);
  if (name === 'approve') return 'approval';
  if (STEP_WORK.has(name)) return 'submission';
  // A step's configured writer (/sf-design, /sf-release, …): the authoring catalog, a leaf, read only for such a turn.
  const { AUTHORING_SKILL_DECLARATION } = await import('./authoring-skills.mjs');
  return Object.hasOwn(AUTHORING_SKILL_DECLARATION, `sflow-${name}`) ? 'submission' : null;
}
// The turns that do a step's own work and submit it: /sf-next, /sf-submit and every writing alias (writing-aliases.mjs
// WRITING_ALIASES, held equal by test/carry-on.test.mjs), named here so the after-tool hook loads no command table.
export const STEP_WORK_SKILLS = Object.freeze(['next', 'submit', 'code', 'phase', 'implement', 'scenario-repair', 'call', 'specify', 'plan', 'verify',
  'run', 'converge', 'code-docs']);
const STEP_WORK = new Set(STEP_WORK_SKILLS);

/**
 * Whether the tool call that just finished carries this turn on into the Story's next action, and as which skill's turn
 * [owner, 2026-11-28: every Story carries on like a task; ITW:REQ-008, A11, A17, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md].
 * Three calls do, each only once what it did shows in the Story, never on the host's word that it succeeded:
 * - the task's own turn (`/sf-task <words>`, nothing open yet) ran `work … --start`, and this checkout now holds a task's
 *   Story in progress that was created during this turn: the turn goes on into its first step (the intake's question,
 *   then its writing) with nothing typed;
 * - the step's own work (the work command, /sf-next, a step's writer, /sf-submit) ran `submit` or `status
 *   --submit-if-ready`, and the step that turn was bound to, still the current one, now waits for a person's approval
 *   after a submission recorded during this turn: the turn goes on into that approval's question, as the approval-only
 *   turn of that step, whose Yes is the person's. Or SFlow approved that step itself during this turn and the Story moved
 *   on: the turn goes on with the next step's work or approval question (reason `completion`; owner, 2026-11-26 for tasks,
 *   2026-11-28 for every Story, replacing OSA decision 7);
 * - an approval-only turn ran `approve`, and the step that turn was bound to now reads approved, by an approval recorded
 *   during this turn (the person's own Yes, which the guard held that command to): the turn goes on with the next step's
 *   work or the next approval question.
 * Every other turn ends as before: a decision, a return and a read are the person's or say what is next.
 * `turn` is the session's boundary record; `ran` is its mutation record and the SFlow commands the call ran, as the guard
 * read them (copilot-mutation-guard.mjs turnRanCommands). Returns `{ skill, workId, reason }`, or null to leave the turn.
 */
export async function taskTurnContinuation(payload, { turn, ran, resolveRoot = discoveryRoot, load = acceptedStory } = {}) {
  const value = ran?.value;
  if (!turn || !value || value.turnId !== turn.turnId || value.sessionId !== turn.sessionId || !Number.isFinite(turn.recordedAt)) return null;
  const reason = await carryReason(turn);
  const workId = value.contract?.workId ?? null;
  if (!reason || (reason !== 'start' && !workId) || (reason === 'approval' && value.contract.turnMode !== 'approval-only')) return null;
  const ours = (options) => reason === 'start' || options['work-id'] === undefined || options['work-id'] === workId;
  const made = (kind) => (ran.commands ?? []).some((command) => CARRY[kind](command) && ours(command.options));
  // A step SFlow builds itself, just published by this step's work, goes on to its submission (below).
  const published = reason === 'submission' && !made('submission') && made('publication');
  if (!published && !made(reason)) return null;
  // The checkout this turn is bound to, and none other (a start in an isolated worktree, or a Story another folder holds).
  const bound = value.contract?.repositoryRoot ?? value.repositoryRoot ?? null;
  const root = await resolveRoot(payload).catch(() => null);
  if (!bound || !root || await realpath(root).catch(() => null) !== bound) return null;
  const workflow = (await load(root).catch(() => null))?.workflow ?? null;
  const { isTaskStory } = await import('./safe-command-guidance.mjs');
  // Only a task is started by a turn; every Story in progress carries on.
  if ((reason === 'start' && !isTaskStory(workflow)) || workflow?.status !== 'in_progress' || (reason !== 'start' && workflow.workItem?.id !== workId)) return null;
  const step = reason === 'start' ? null : workflow.phases?.[value.originPhase ?? value.contract.phaseId];
  if (reason === 'start' && !since(workflow.workItem?.createdAt, turn)) return null;
  if (published) {
    // Its publication is the kernel's own (deterministic), recorded in this turn, and its next action is its submission,
    // nothing a person answers: the turn goes on into that submission as /sf-submit's (a ready step submits itself).
    const built = step?.status === 'in_progress' && workflow.currentPhase === step.id && (step.authorship ?? [])
      .some((entry) => entry?.generation === step.generation && entry.producer === 'deterministic' && since(entry.publishedAt, turn));
    const { workflowGuide } = await import('./guide.mjs');
    const first = (workflowGuide(workflow).nextActions ?? []).find((action) => action && !action.optional);
    return built && NAME(first?.skill) === 'submit' ? { skill: 'sf-submit', workId, reason: 'publication', task: isTaskStory(workflow) } : null;
  }
  // A submission waits for a person's approval of that step, or SFlow approved the step itself (owner, 2026-11-26).
  const waiting = reason === 'submission' && step?.status === 'awaiting_approval' && workflow.currentPhase === step.id && since(step.submittedAt, turn);
  const completed = reason === 'submission' && step?.status === 'approved' && AUTOMATIC.has(step.approvalDisposition) && workflow.currentPhase !== step.id
    && [step.approvedAt, step.automaticApproval?.at].some((at) => since(at, turn));
  // Or SFlow sent the step back itself at that submission, with nothing for a person to answer: the task grew (ITW v1.2
  // REQ-106: the code went back to the plan it added before it), or the test step's tests failed and SFlow started the
  // code step's next version to fix them. The turn goes on with that work, as after a step SFlow approves itself.
  const returnedBy = reason === 'submission' && !waiting && !completed && workflow.currentPhase !== step?.id
    ? (workflow.changeRequests ?? []).find((entry) => entry?.automatic?.kind && entry.sourcePhase === step?.id && since(entry.requestedAt, turn)) ?? null : null;
  const grown = returnedBy?.automatic.kind === 'task-grown';
  if (reason === 'submission' && !waiting && !completed && !returnedBy) return null;
  if (reason === 'approval' && (step?.status !== 'approved'
      || !(step.approvals ?? []).some((entry) => entry && !entry.invalidatedAt && since(entry.at, turn)))) return null;
  const { workflowGuide } = await import('./guide.mjs');
  const skill = taskTurnSkillFor(workflow, workflowGuide(workflow));
  // A submission that waits goes on only into the person's approval of that same step.
  if (!CARRIED.has(skill) || (waiting && skill !== 'sf-approve')) return null;
  return { skill, workId: workflow.workItem.id, reason: completed ? 'completion' : grown ? 'grown' : returnedBy ? 'returned' : reason, task: isTaskStory(workflow) };
}

/** The same decision under the name every Story's carry-on reads it by. */
export const storyTurnContinuation = taskTurnContinuation;

/**
 * What the agent is told when SFlow carries its turn on (copilot-repository-boundary.mjs), one line: what happened, and
 * what this same turn does now, under the turn rules that follow. A task's names /sf-task's step 1, which its skill has;
 * any other Story's says the step itself, so the skill that was typed needs no other skill's text to go on.
 */
export function carryOnWords(next) {
  if (!next?.workId) return null;
  const { workId, reason, skill } = next;
  if (next.task) {
    return { start: `SFlow: ${workId} started, and this /sf-task turn goes on with it now, under the turn rules below: do /sf-task's step 1 in this turn.`,
      submission: 'SFlow: the step is submitted and waits for the person\'s approval, and this /sf-task turn goes on with it now, under the turn rules below: do /sf-task\'s step 1 again in this turn (its question is theirs to answer).',
      completion: `SFlow: SFlow approved the step, and this /sf-task turn goes on with ${workId}'s next action now, under the turn rules below: do /sf-task's step 1 again in this turn.`,
      grown: `SFlow: the task grew, its code went back to the plan SFlow added, and this /sf-task turn goes on with ${workId}'s next action now, under the turn rules below: do /sf-task's step 1 again in this turn.`,
      returned: `SFlow: the tests failed, SFlow started the code step's next version to fix them, and this /sf-task turn goes on with ${workId}'s next action now, under the turn rules below: do /sf-task's step 1 again in this turn.`,
      publication: `SFlow: SFlow built and published the step, and this /sf-task turn goes on with ${workId}'s submission now, under the turn rules below: do /sf-task's step 1 again in this turn.`,
      approval: `SFlow: the approval is recorded, and this /sf-task turn goes on with ${workId}'s next action now, under the turn rules below: do /sf-task's step 1 again in this turn.` }[reason] ?? null;
  }
  const what = { submission: 'the step is submitted and waits for the person\'s approval', completion: 'SFlow approved the step',
    approval: 'the approval is recorded', grown: 'the code went back to the plan SFlow added',
    returned: 'the tests failed and SFlow started the code step\'s next version to fix them',
    publication: 'SFlow built and published the step, and its submission is next' }[reason] ?? null;
  if (!what) return null;
  return `SFlow: ${what}, and this turn goes on with ${workId} now, under the turn rules below: ${skill === 'sf-approve' ? approvalWords(workId)
    : reason === 'publication' ? `run \`singularity-flow status ${workId} --submission-readiness --submit-if-ready --for-agent --json\` and follow its act to the submission in this turn.` : STEP_WORK_WORDS}`;
}

/** The next step's own work, as /sf-next does it. */
const STEP_WORK_WORDS = 'run `singularity-flow phase enter --compose --for-agent --json` and do the current step\'s own work in this turn, to its own boundary (its publication, its reviewer, its submission, or a person\'s answer).';
/** The person's approval, asked in the same turn; their Yes is theirs, never the agent's. */
const approvalWords = (workId) => `run \`singularity-flow choices begin approve ${workId} --fetch --for-agent --json --review-packet\`, ask its act.ask question exactly with your question tool and, on the person's own Yes (never yours), run its onYes commands in order. In VS Code's own chat open the approval page with #sflowDecide and the workId instead of asking.`;

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
