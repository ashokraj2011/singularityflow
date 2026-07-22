import { branch, changes, fetchOrigin, hasUpstream, pullFastForward } from './git.mjs';
import { currentPhase, pendingPublicationPath, saveWorkflow, syncPublication } from './state.mjs';
import { exists, nowIso } from './util.mjs';

function actorKey(actor) { return actor?.login ?? actor?.email ?? actor?.name ?? 'unknown'; }

export async function assignPhase(root, config, workflow, phaseId, assignee, session) {
  const phase = workflow.phases[phaseId];
  if (!phase) throw new Error(`Unknown phase '${phaseId}'.`);
  if (!assignee?.trim()) throw new Error('Assignee must not be empty.');
  workflow.collaboration ??= { assignments: {}, notifications: [] };
  const record = { phase: phaseId, assignee: assignee.trim(), assignedAt: nowIso(), assignedBy: session?.actor ?? null, persona: session?.persona ?? null };
  workflow.collaboration.assignments[phaseId] = record;
  workflow.collaboration.notifications.push({ at: record.assignedAt, type: 'assignment', phase: phaseId, message: `${phase.label} assigned to ${record.assignee}`, read: false });
  workflow.history.push({ at: record.assignedAt, actor: actorKey(session?.actor), persona: session?.persona ?? null, event: 'phase_assigned', phase: phaseId, detail: record.assignee });
  await saveWorkflow(root, config, workflow);
  return record;
}

export function watchSnapshot(workflow) {
  const phase = currentPhase(workflow);
  const assignment = phase ? workflow.collaboration?.assignments?.[phase.id] ?? null : null;
  const lastEvent = workflow.history.at(-1) ?? null;
  const reminderHours = workflow.resolution?.collaboration?.approvalReminderAfterHours;
  const waitingHours = phase?.status === 'awaiting_approval' && phase.submittedAt ? (Date.now() - Date.parse(phase.submittedAt)) / 3600000 : 0;
  const reminderDue = Number.isFinite(reminderHours) && phase?.status === 'awaiting_approval' && waitingHours >= reminderHours;
  return { workId: workflow.workItem.id, title: workflow.workItem.title, status: workflow.status, currentPhase: phase ? { id: phase.id, label: phase.label, status: phase.status, generation: phase.generation } : null, assignment, reminder: reminderDue ? { type: 'approval_wait', waitingHours: Math.round(waitingHours * 10) / 10, thresholdHours: reminderHours } : null, lastEvent, updatedAt: lastEvent?.at ?? workflow.workItem.createdAt };
}

export function watchText(item) {
  const phase = item.currentPhase ? `${item.currentPhase.label} (${item.currentPhase.status})` : 'complete';
  return `${item.workId} — ${item.title}\nPhase: ${phase}\nAssignment: ${item.assignment?.assignee ?? 'unassigned'}${item.reminder ? `\n! Approval reminder: waiting ${item.reminder.waitingHours}h (threshold ${item.reminder.thresholdHours}h)` : ''}\nLast event: ${item.lastEvent?.event ?? 'none'}${item.lastEvent?.detail ? ` — ${item.lastEvent.detail}` : ''}\nUpdated: ${item.updatedAt}\n`;
}

export async function recoveryPlan(root, config, workflow, { fetch = false } = {}) {
  const actions = [];
  const pending = await exists(pendingPublicationPath(root, config, workflow.workItem.id));
  if (branch(root) !== workflow.workItem.branch) actions.push({ id: 'branch', safe: true, automatic: false, detail: `Switch to ${workflow.workItem.branch} with singularity-flow resume ${workflow.workItem.id} --fetch.` });
  if (pending) actions.push({ id: 'publish', safe: true, automatic: true, detail: 'Retry the retained lifecycle commit with singularity-flow sync.' });
  if (fetch && branch(root) === workflow.workItem.branch && hasUpstream(root) && !changes(root).trim()) actions.push({ id: 'fast-forward', safe: true, automatic: true, detail: 'Fetch and fast-forward the current work-item branch.' });
  if (changes(root).trim()) actions.push({ id: 'working-tree', safe: false, automatic: false, detail: 'Uncommitted changes are present. Review them; recovery will not discard or stash them.' });
  if (!actions.length) actions.push({ id: 'none', safe: true, automatic: false, detail: 'No recoverable publication, branch, or synchronization problem was found.' });
  return { workId: workflow.workItem.id, branch: branch(root), targetBranch: workflow.workItem.branch, pendingPublication: pending, actions };
}

export async function applyRecovery(root, config, workflow, plan) {
  const completed = [];
  for (const action of plan.actions.filter((item) => item.automatic)) {
    if (action.id === 'publish') { completed.push({ id: action.id, result: await syncPublication(root, config, workflow) }); continue; }
    if (action.id === 'fast-forward') { fetchOrigin(root); pullFastForward(root); completed.push({ id: action.id, result: 'fast-forward complete' }); }
  }
  return { ...plan, applied: true, completed };
}

export function recoveryText(plan) {
  const lines = [`Recovery plan — ${plan.workId}`, `Current branch: ${plan.branch}`, `Target branch: ${plan.targetBranch}`, ''];
  for (const action of plan.actions) lines.push(`${action.safe ? '✓' : '!'} ${action.id}: ${action.detail}${action.automatic ? ' [can apply]' : ''}`);
  if (!plan.applied && plan.actions.some((item) => item.automatic)) lines.push('', `Apply safe actions: singularity-flow recover ${plan.workId} --apply${plan.actions.some((item) => item.id === 'fast-forward') ? ' --fetch' : ''}`);
  if (plan.applied) lines.push('', `Applied ${plan.completed.length} safe action(s). No history was reset or rewritten.`);
  return `${lines.join('\n')}\n`;
}
