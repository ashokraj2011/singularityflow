import { branch, changes, fetchOrigin, hasUpstream, head, pullFastForward } from './git.mjs';
import { currentPhase, generationResultDigest, syncPublication } from './state-stores.mjs';
import { inspectPendingPublication } from './publication-pending.mjs';
import { recordSha256 } from './records.mjs';
import { inspectPhaseRecovery } from './recovery-plan.mjs';
import { runGovernanceGate } from './governance.mjs';
import { recoveryActionsForFindings } from './gate-recovery.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';
import { worktreeFingerprint } from './worktree-fingerprint.mjs';

function actorKey(actor) { return actor?.login ?? actor?.email ?? actor?.name ?? 'unknown'; }

/**
 * Apply an assignment to the in-memory Story aggregate.
 *
 * Persistence belongs to the publication transaction. Keeping this reducer pure
 * prevents a failed commit or push from leaving workflow.json ahead of Git.
 */
export function assignPhase(workflow, phaseId, assignee, session) {
  const phase = workflow.phases[phaseId];
  if (!phase) throw new Error(`Unknown phase '${phaseId}'.`);
  if (!assignee?.trim()) throw new Error('Assignee must not be empty.');
  workflow.collaboration ??= { assignments: {}, notifications: [] };
  const record = { phase: phaseId, assignee: assignee.trim(), assignedAt: nowIso(), assignedBy: session?.actor ?? null, agent: session?.agent ?? null };
  workflow.collaboration.assignments[phaseId] = record;
  workflow.collaboration.notifications.push({ at: record.assignedAt, type: 'assignment', phase: phaseId, message: `${phase.label} assigned to ${record.assignee}`, read: false });
  workflow.history.push({ at: record.assignedAt, actor: actorKey(session?.actor), agent: session?.agent ?? null, event: 'phase_assigned', phase: phaseId, detail: record.assignee });
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

export async function recoveryPlan(root, config, workflow, { fetch = false, phaseId = null } = {}) {
  const actions = [];
  const blockers = [];
  const pending = await inspectPendingPublication(root, {
    kind: 'story', id: workflow.workItem.id, migrate: false,
    roots: { workItemRoot: config.workItemRoot }
  });
  if (branch(root) !== workflow.workItem.branch) actions.push({ id: 'branch', safe: true, automatic: false, detail: `Switch to ${workflow.workItem.branch} with singularity-flow resume ${workflow.workItem.id} --fetch.` });
  if (pending.status === 'pending') {
    blockers.push({
      code: 'publication.pending', category: 'transport', blocking: true,
      phase: workflow.currentPhase ?? null, generation: null, path: pending.path,
      line: null, value: null,
      details: { recoveryStage: pending.record?.recoveryStage ?? null, commit: pending.record?.commit ?? null }
    });
    actions.push({
      id: 'publish', safe: true, automatic: true, mode: 'automatic',
      confirmation: 'plan-hash', command: 'singularity-flow sync',
      detail: 'Retry the retained lifecycle commit with singularity-flow sync.'
    });
  } else if (pending.status === 'unreadable') {
    blockers.push({
      code: 'publication.marker.unreadable', category: 'transport', blocking: true,
      phase: workflow.currentPhase ?? null, generation: null, path: pending.path,
      line: null, value: null, details: { message: pending.error }
    });
    actions.push({
      id: 'publication-marker', safe: false, automatic: false, mode: 'manual',
      confirmation: 'human-authority', command: 'singularity-flow doctor --json',
      detail: 'The publication recovery marker is unreadable. Diagnose it without clearing or replacing it.'
    });
  }
  if (fetch && branch(root) === workflow.workItem.branch && hasUpstream(root) && !changes(root).trim()) actions.push({ id: 'fast-forward', safe: true, automatic: true, detail: 'Fetch and fast-forward the current work-item branch.' });
  const activePhaseId = workflow.currentPhase;
  const activePhase = activePhaseId ? workflow.phases?.[activePhaseId] ?? null : null;
  const consumedGeneration = activePhase?.generationIntent?.status === 'consumed'
    && Number(activePhase.generationIntent.generation) === Number(activePhase.generation);
  // Preserve the established repository/transport-only default. Phase publication inspection is
  // explicit, except for a consumed generation where ordinary next-step selection would otherwise
  // retry or submit bytes that no longer match their lifecycle receipt.
  const requestedPhase = phaseId ?? (consumedGeneration ? activePhaseId : null);
  const phase = requestedPhase ? workflow.phases?.[requestedPhase] ?? null : null;
  if (phaseId && !phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId}'. Provide a phase ID.`, {
    code: 'RECOVERY_PHASE_UNKNOWN', details: { phaseId }
  });
  const phaseRecovery = phase
    ? await inspectPhaseRecovery(root, config, workflow, phase, {
      generationDigest: (repositoryRoot, selectedPhase) => generationResultDigest(
        repositoryRoot, config, workflow, selectedPhase
      )
    })
    : { blockers: [], actions: [], requiresLifecycleRecovery: false };
  blockers.push(...phaseRecovery.blockers);
  actions.push(...phaseRecovery.actions);
  // A completed workflow has no current phase, which used to make `recover` report that nothing was
  // wrong even when the terminal gate named stale conformance, missing AC coverage, or unpublished
  // state. Run that read-only gate here and preserve its explicit phase ownership. The gate cannot
  // mutate state; a reopen remains a reviewed guided action governed by the completion policy.
  let terminalGate = null;
  if (workflow.status === 'complete' && workflow.currentPhase == null) {
    terminalGate = await runGovernanceGate(root, config, workflow, { terminal: true });
    blockers.push(...terminalGate.findings);
    actions.push(...recoveryActionsForFindings(terminalGate.findings));
  }
  if (changes(root).trim()) actions.push({
    id: 'working-tree', safe: false, automatic: false, mode: 'manual',
    confirmation: 'human-authority', command: null,
    detail: 'Uncommitted changes are present. Review them; recovery will not discard or stash them.'
  });
  if (!actions.length) actions.push({
    id: 'none', safe: true, automatic: false, mode: 'informational', confirmation: 'none', command: null,
    detail: 'No recoverable publication, branch, synchronization, artifact, projection, or generation problem was found.'
  });
  const revision = {
    branch: branch(root), head: head(root),
    worktree: worktreeFingerprint(root, { fresh: true }).sha256
  };
  const core = {
    schemaVersion: currentSchemaVersion('recovery-plan'),
    workId: workflow.workItem.id,
    phaseId: phase?.id ?? null,
    branch: revision.branch,
    targetBranch: workflow.workItem.branch,
    pendingPublication: pending.status === 'pending',
    publicationRecovery: pending.status === 'absent' ? null : pending,
    terminalGate: terminalGate ? {
      valid: terminalGate.errors.length === 0,
      errors: terminalGate.errors,
      warnings: terminalGate.warnings,
      findings: terminalGate.findings
    } : null,
    revision,
    blockers,
    // Publication-pending and a terminal remote gate can describe the same retained sync. Collapse
    // automatic commands so --apply never replays one recovery operation twice.
    actions: [...new Map(actions.map((entry) => [
      entry.automatic && entry.command ? `automatic:${entry.command}` : entry.id,
      entry
    ])).values()],
    requiresRecovery: pending.status !== 'absent'
      || phaseRecovery.requiresLifecycleRecovery
      || Boolean(terminalGate?.errors.length)
  };
  return { ...core, planId: `sha256:${recordSha256(core)}` };
}

export async function applyRecovery(root, config, workflow, plan, { confirm = null } = {}) {
  const automatic = plan.actions.filter((item) => item.automatic);
  if (!automatic.length) throw new SingularityFlowError(
    'This recovery plan has no automatic action. Complete its guided or human-authority step, then inspect again.',
    { code: 'RECOVERY_AUTOMATIC_ACTION_UNAVAILABLE', details: { planId: plan.planId } }
  );
  if (!confirm || confirm !== plan.planId) throw new SingularityFlowError(
    `Recovery application requires the exact reviewed plan hash. Re-run with --confirm ${plan.planId}.`,
    { code: 'RECOVERY_PLAN_CONFIRMATION_REQUIRED', details: { planId: plan.planId } }
  );
  const current = {
    branch: branch(root), head: head(root),
    worktree: worktreeFingerprint(root, { fresh: true }).sha256
  };
  if (JSON.stringify(current) !== JSON.stringify(plan.revision)) throw new SingularityFlowError(
    'The repository changed after the recovery plan was inspected. Generate and review a new plan.',
    { code: 'RECOVERY_PLAN_STALE', details: { planned: plan.revision, current } }
  );
  const completed = [];
  for (const action of automatic) {
    if (action.id === 'publish' || action.command === 'singularity-flow sync') {
      completed.push({ id: action.id, result: await syncPublication(root, config, workflow) });
      continue;
    }
    if (action.id === 'fast-forward') { fetchOrigin(root); pullFastForward(root); completed.push({ id: action.id, result: 'fast-forward complete' }); }
  }
  const pending = await inspectPendingPublication(root, {
    kind: 'story', id: workflow.workItem.id, migrate: false,
    roots: { workItemRoot: config.workItemRoot }
  });
  const postconditions = [
    ...(automatic.some((item) => item.id === 'publish' || item.command === 'singularity-flow sync')
      ? [{ id: 'publication-cleared', met: pending.status === 'absent', observed: pending.status }]
      : []),
    ...(automatic.some((item) => item.id === 'fast-forward')
      ? [{ id: 'branch-fast-forwarded', met: true, observed: head(root) }]
      : [])
  ];
  return {
    ...plan, applied: true, completed, postconditions,
    postconditionsMet: postconditions.every((entry) => entry.met)
  };
}

export function recoveryText(plan) {
  const lines = [
    `Recovery plan — ${plan.workId}`,
    `Plan: ${plan.planId}`,
    `Current branch: ${plan.branch}`,
    `Target branch: ${plan.targetBranch}`,
    plan.phaseId ? `Phase: ${plan.phaseId}` : null,
    ''
  ].filter((line) => line !== null);
  for (const blocker of plan.blockers ?? []) {
    const location = blocker.path ? `${blocker.path}${blocker.line ? `:${blocker.line}` : ''}` : null;
    lines.push(`BLOCKED ${blocker.code}${location ? ` — ${location}` : ''}`);
    if (blocker.details?.message) lines.push(`  ${blocker.details.message.replaceAll('\n', '\n  ')}`);
  }
  if (plan.blockers?.length) lines.push('');
  for (const action of plan.actions) {
    lines.push(`${action.safe ? '✓' : '!'} ${action.id}: ${action.detail}${action.automatic ? ' [can apply]' : ''}`);
    if (action.command) lines.push(`  Run: ${action.command}`);
    if (action.skill) lines.push(`  In Copilot: ${action.skill}`);
  }
  if (!plan.applied && plan.actions.some((item) => item.automatic)) lines.push('', `Apply safe actions: singularity-flow recover ${plan.workId} --apply --confirm ${plan.planId}${plan.actions.some((item) => item.id === 'fast-forward') ? ' --fetch' : ''}`);
  if (plan.applied) lines.push('', `Applied ${plan.completed.length} safe action(s). No history was reset or rewritten.`);
  return `${lines.join('\n')}\n`;
}
