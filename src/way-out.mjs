/**
 * The one way on, said plainly [owner, 2026-11-28: "No one should get stuck, and every decision should be easy for people
 * to understand why they are making that decision"]. From any state of a Story, three lines: where it is, why it waits,
 * and the one thing to do, with who does it:
 *
 *   by: 'sflow'   SFlow's own action (a saved push, a recovery it can make safely): the turn runs `command` itself;
 *   by: 'agent'   the step's own work: the turn does it now, as /sf-next does;
 *   by: 'person'  a person decides (`kind`: approval, decision, return, answer, terminal, reload, start, done; on an Epic,
 *                 sign-off and epic-step): `words` say what and where, never a command for them to type.
 *
 * nextsteps returns it beside its actions (nextsteps.mjs), so /sf-next and every older name that now does the same, the
 * VS Code Continue button and a refusal's last line read one answer. Pure: it reads only the snapshot nextsteps already
 * built and the Story's own record. Generic: it reads what each step's state and next action are, never its workflow.
 */

import { adviceForStep } from './step-advice.mjs';

/** The step's advice by what it is for, never by its workflow (step-advice.mjs); its generic lines when unknown. */
const advice = (workflow, phaseId) => adviceForStep(workflow, phaseId);

const oneLine = (value, limit = 240) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) return '';
  const first = text.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? text;
  return first.length > limit ? `${first.slice(0, limit - 1).trimEnd()}…` : first;
};

const SKILL = (value) => String(value ?? '').trim().split(/\s+/u)[0].replace(/^\/sflow-/u, '/sf-');
const PERSON_KINDS = Object.freeze({ '/sf-approve': 'approval', '/sf-decide': 'decision', '/decide': 'decision', '/sf-reject': 'return',
  '/sf-confirm': 'answer', '/sf-amend': 'return' });

/** The step's name as the person reads it. */
function stepName(workflow, phaseId) {
  const phase = workflow?.phases?.[phaseId] ?? null;
  const resolved = (workflow?.resolution?.phases ?? []).find((entry) => entry?.id === phaseId) ?? null;
  return String(phase?.label ?? resolved?.label ?? phaseId ?? 'the step');
}

/** Where the Story is, in one line. */
function whereLine(snapshot, workflow) {
  const id = snapshot?.workId ?? workflow?.workItem?.id ?? null;
  if (snapshot?.state === 'not_initialized') return 'SFlow is not set up in this repository yet.';
  if (!id || !workflow) return 'No Story is open in this chat.';
  if (workflow.status === 'closed') return `${id} is done: every step is decided.`;
  const phaseId = workflow.currentPhase;
  const phase = phaseId ? workflow.phases?.[phaseId] ?? null : null;
  if (!phase) return `${id} has no step open.`;
  const version = Number(phase.generation ?? 0);
  const state = phase.status === 'awaiting_approval' ? 'submitted, waiting for approval'
    : phase.status === 'approved' ? 'approved'
      : version > 0 || (phase.artifacts ?? []).length ? 'written, not yet submitted' : 'not written yet';
  return `${id} is at ${stepName(workflow, phaseId)}${version > 0 ? ` (version ${version})` : ''}: ${state}.`;
}

/**
 * What one first action is, and who does it: a person's decision by its route, SFlow's own push or recovery, the step's
 * own work for the agent. `action` is a nextsteps action (copilotCommand, command, skill, label, reason).
 */
function nextOf(action, snapshot, workflow) {
  if (!action) return null;
  const skill = SKILL(action.skill ?? action.copilotCommand);
  const command = typeof action.command === 'string' ? action.command : null;
  const label = oneLine(action.label ?? action.reason ?? '') || 'Go on with the Story';
  const kind = PERSON_KINDS[skill] ?? null;
  if (kind === 'approval') return { by: 'person', kind, words: `${label.replace(/[.\s]+$/u, '')}: SFlow asks you here; in VS Code it opens the approval page.` };
  if (kind === 'decision') return { by: 'person', kind, words: `${label.replace(/[.\s]+$/u, '')}: decide it on the Decide card.` };
  if (kind) return { by: 'person', kind, words: `${label.replace(/[.\s]+$/u, '')}.` };
  if (/^singularity-flow (?:sync|push)\b/u.test(command ?? '')) return { by: 'sflow', kind: 'push', command, words: 'SFlow sends the commits it saved here, then goes on.' };
  // A recovery is the kernel's own route, run as returned (never one built here).
  if (/^singularity-flow recover\b/u.test(command ?? '')) return { by: 'sflow', kind: 'recover', command, words: 'SFlow checks what is left over and repairs what it safely can, then goes on.' };
  if (/^singularity-flow (?:resume|session (?:attach|open))\b/u.test(command ?? '')) return { by: 'sflow', kind: 'attach', command, words: 'SFlow opens the Story in this chat, then goes on; it asks which one only when several are open.' };
  if (/^singularity-flow (?:init|start)\b/u.test(command ?? '') || ['/sf-init', '/sf-start', '/sf-story-start'].includes(skill)) {
    return { by: 'person', kind: 'start', words: 'Say what you want done with /sf-task and your words; SFlow starts the Story.' };
  }
  return { by: 'agent', kind: 'work', words: `${label.replace(/[.\s]+$/u, '')}: SFlow's agent does it now, in this turn.` };
}

/** Why the Story waits, in one plain line. */
function whyLine(snapshot, workflow, next) {
  if (snapshot?.state === 'not_initialized') return 'A repository is set up once before its first Story.';
  if (!workflow) return 'A Story is opened or started before work goes on.';
  if (snapshot?.state === 'publication_pending') return 'Its last change is committed here but not sent yet.';
  if (snapshot?.state === 'recovery_required') return oneLine(snapshot.recovery?.reason ?? snapshot.recovery?.summary ?? '') || 'Something was left half done and is checked before going on.';
  if (workflow.status === 'closed') return 'Nothing is open, so nothing waits.';
  const phase = workflow.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
  if (workflow.pendingDecision) return oneLine(workflow.pendingDecision.question ?? workflow.pendingDecision.title ?? '') || 'A decision is open before the Story goes on.';
  // What the person decides at this step and why they are asked: the per-intent advice every approval surface reads.
  if (next?.kind === 'approval' && phase) return advice(workflow, phase.id).decides;
  if (next?.kind === 'decision') return oneLine(next.reason ?? '') || 'A choice is open that only a person makes.';
  if (next?.by === 'agent') return phase?.status === 'in_progress' && Number(phase.generation ?? 0) > 0
    ? 'Its work is not finished: what is left is SFlow\'s agent\'s.' : 'Its work is SFlow\'s agent\'s, and nothing waits for a person.';
  return 'Its next action is ready.';
}

/** The way on for a nextsteps snapshot and its Story, or for a chat whose hooks did not run (`gap`). */
export function storyWayOut(snapshot, workflow = null, { gap = null } = {}) {
  const where = whereLine(snapshot, workflow);
  if (gap) return { where, why: oneLine(gap.message, 400) || 'SFlow\'s guard is off in this chat.', next: { by: 'person', kind: 'reload', words: oneLine(gap.fix, 400) } };
  const now = (snapshot?.actions ?? []).find((entry) => entry && entry.timing === 'now') ?? null;
  const next = workflow?.status === 'closed' ? { by: 'person', kind: 'done', words: 'Nothing is needed now; say what you want done next with /sf-task.' }
    : nextOf(now, snapshot, workflow) ?? (!workflow ? { by: 'person', kind: 'start', words: 'Say what you want done with /sf-task and your words, or open a Story with /sf-session.' }
      : { by: 'person', kind: 'answer', words: 'Nothing can go on yet; the Story says why above.' });
  const why = whyLine(snapshot, workflow, { ...next, reason: now?.reason });
  return { where, why, next };
}

/**
 * The way on for an Epic or an Initiative (an Epic is one), read from its own next actions (initiative-report.mjs
 * initiativeNextActions) [owner, 2026-11-28: its next, status and resume are /sf-next too]: where it is, why it waits
 * (its first action's reason), and that action, a person's: an approval on its card, any other step by the skill that
 * does it. No Story binds an Epic's checkout, so no turn of /sf-next writes it. `actions` keep each action's `skill`.
 */
export function initiativeWayOut({ initiativeId = null, currentPhase = null, actions = [] } = {}) {
  const id = initiativeId ?? 'The Epic';
  const where = currentPhase ? `${id} is at its ${currentPhase} step.` : `${id} has no step open.`;
  const now = actions.find((entry) => entry?.command) ?? null;
  const why = oneLine(now?.reason ?? '') || 'Nothing waits.';
  if (!now) return { where, why, next: { by: 'person', kind: 'done', words: `Nothing is needed on ${id} now.` } };
  // Its own fallback skill is the one way on itself (/sf-initiative-next is /sf-next's older name): no skill to name.
  const skill = /^\/sf-(?:initiative|epic)-next$/u.test(SKILL(now.skill)) ? null : SKILL(now.skill) || null;
  const does = (skill ?? '') && ` ${skill} does it.`;
  if (/^singularity-flow (?:initiative|epic) approve\b/u.test(now.command)) {
    return { where, why, next: { by: 'person', kind: 'sign-off', words: `A person approves its outputs: on the Needs-you card in VS Code${skill ? `, or with ${skill}` : ''}.` } };
  }
  return { where, why, next: { by: 'person', kind: 'epic-step', words: `${oneLine(now.reason ?? '').replace(/[.\s]+$/u, '') || 'Its next step'}.${does}` } };
}

/** The way on as one plain paragraph: where, why, and what happens next. */
export function wayOutLine(wayOut) {
  if (!wayOut?.where) return '';
  return [wayOut.where, wayOut.why, wayOut.next?.words ? `Next: ${wayOut.next.words}` : null].filter(Boolean).join(' ');
}
