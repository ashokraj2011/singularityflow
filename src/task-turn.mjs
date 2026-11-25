/**
 * `/sf-task` with no words: "do what comes next" [ITW:REQ-001, REQ-008, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md].
 *
 * The person types one command between steps instead of choosing among /sf-next, /sf-approve and /sf-decide. The turn
 * is recorded as the skill the Story's next action needs, so every existing rule of that turn applies unchanged: a
 * person's approval is an approval-only turn whose Yes is the person's own answer (never the agent's), a decision is a
 * decision-only turn, and the step's own work is /sf-next's turn, bound to that one step as before. A Story with
 * nothing to do, or no Story, keeps the /sf-task turn (it starts a task, or says the task is done).
 *
 * Read in the prompt hook: the Story's guide is pure (src/guide.mjs), so this costs one Story read.
 */

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

/** The skill a typed `/sf-task` with no words takes, from the Story this chat is bound to; null keeps /sf-task. */
export async function taskTurnSkill(payload, {
  resolveRoot = async (value) => (await import('./copilot-repository-boundary.mjs')).resolveCopilotDiscoveryRoot(value),
  load = async (root) => (await import('./accepted-story-execution.mjs')).loadAcceptedStoryExecution(root)
} = {}) {
  if (typedAfterSkill(payload?.prompt)) return null;
  const root = await resolveRoot(payload).catch(() => null);
  if (!root) return null;
  const accepted = await load(root).catch(() => null);
  const workflow = accepted?.workflow;
  if (!workflow) return null;
  const { workflowGuide } = await import('./guide.mjs');
  return taskTurnSkillFor(workflow, workflowGuide(workflow));
}
