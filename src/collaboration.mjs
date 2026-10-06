import { nextPhaseGeneration } from './phase-generation.mjs';
import { branch, changedFiles, changes, fetchOrigin, hasUpstream, head, pullFastForward, untrackedFiles } from './git.mjs';
import { applicationPathContext, isTransientTestResultPath } from './application-paths.mjs';
import {
  currentPhase, generationResultDigest, generationResultMatches, syncPublication
} from './state-stores.mjs';
import { inspectPendingPublication } from './publication-pending.mjs';
import { recordSha256 } from './records.mjs';
import { inspectPhaseRecovery, inspectPhaseWorktreeScope } from './recovery-plan.mjs';
import { runGovernanceGate } from './governance.mjs';
import { recoveryActionsForFindings } from './gate-recovery.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { worktreeFingerprint } from './worktree-fingerprint.mjs';
import { expectedPhaseEvidencePaths, expectedPreparationContextPaths } from './recovery-preparation-context.mjs';

function actorKey(actor) { return actor?.login ?? actor?.email ?? actor?.name ?? 'unknown'; }

function repositoryRelativePath(value) {
  const relative = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (!relative || relative.startsWith('/') || /^[A-Za-z]:/u.test(relative)
      || relative.split('/').some((part) => !part || part === '..')) return null;
  return relative;
}

function pathWithin(candidate, parent) {
  const path = candidate.toLocaleLowerCase('en-US');
  const root = parent.toLocaleLowerCase('en-US').replace(/\/$/u, '');
  return path === root || path.startsWith(`${root}/`);
}

function recoveryWorktreeDigest(root, config, workflow) {
  const untracked = new Set(untrackedFiles(root));
  const ownership = applicationPathContext(config, workflow);
  const visiblePaths = changedFiles(root).filter((candidate) => !untracked.has(candidate)
    || !isTransientTestResultPath(candidate, ownership));
  return worktreeFingerprint(root, { fresh: true, visiblePaths }).sha256;
}

/**
 * A dirty worktree is never automatically repaired. Separate exact current-phase authoring paths
 * from unrelated changes so a prepared draft does not look like a mandatory manual recovery gate.
 * This is a routing hint, not publication authority: even the workflow aggregate still needs
 * review of its diff before an agent may continue.
 */
async function workingTreeAction(root, config, workflow, phase, status, phaseRecovery) {
  let paths;
  try {
    paths = changedFiles(root);
  } catch {
    paths = [];
  }
  // Structured runner output is local transport state, not authored source. Only a genuinely
  // untracked result is disposable for routing: a tracked result (or any other dirty path) must
  // still be reviewed. This never removes the report or changes Git's index.
  const untracked = new Set(untrackedFiles(root));
  const ownership = applicationPathContext(config, workflow);
  const disposableUntrackedPaths = paths.filter((candidate) => untracked.has(candidate)
    && isTransientTestResultPath(candidate, ownership));
  const relevantPaths = paths.filter((candidate) => !disposableUntrackedPaths.includes(candidate));
  const itemRoot = repositoryRelativePath(
    `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}`
  );
  const current = phase?.id === workflow.currentPhase && phase.status === 'in_progress'
    && branch(root) === workflow.workItem.branch && itemRoot;
  const generation = phase?.generationIntent?.status === 'open'
    ? Number(phase.generationIntent.generation) : nextPhaseGeneration(phase);
  const artifact = repositoryRelativePath(phase?.requiredArtifact?.path);
  const expected = current && artifact && Number.isSafeInteger(generation) && generation > 0
    ? new Set([
      `${itemRoot}/workflow.json`,
      `${itemRoot}/${artifact}`,
      `${itemRoot}/context/inputs-${phase.id}-gen${generation}.json`,
      `${itemRoot}/context/generation-start/${phase.id}-gen${generation}.json`
    ])
    : new Set();
  const protectedPaths = [
    ...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ].map(repositoryRelativePath).filter(Boolean);
  const statusLines = status.split(/\r?\n/u).filter(Boolean);
  // Renames, removals, conflicts, and type changes have an old endpoint or content transition that
  // a name-only roster cannot classify safely. Keep their entire recovery action manual.
  const simpleStatus = statusLines.length === paths.length && statusLines.every((line) =>
    ['??', ' M', 'M ', 'MM', ' A', 'A ', 'AM'].includes(line.slice(0, 2)));
  if (current && simpleStatus && expected.size) {
    for (const relative of await expectedPreparationContextPaths(root, config, workflow, phase, {
      itemRoot, generation, changedPaths: relevantPaths
    })) expected.add(relative);
    for (const relative of await expectedPhaseEvidencePaths(root, config, workflow, phase, {
      itemRoot, generation, changedPaths: relevantPaths
    })) expected.add(relative);
  }
  if (!relevantPaths.length && simpleStatus && statusLines.every((line) => line.startsWith('??'))) {
    return null;
  }
  const applicationScope = current && simpleStatus
    ? await inspectPhaseWorktreeScope(root, config, workflow, phase) : null;
  const applicationPaths = relevantPaths.filter(candidate => applicationScope?.paths.includes(candidate));
  const expectedPaths = relevantPaths.filter((candidate) => (expected.has(candidate) || applicationPaths.includes(candidate))
    && !protectedPaths.some((guard) => pathWithin(candidate, guard)));
  const unexpectedPaths = relevantPaths.filter((candidate) => !expectedPaths.includes(candidate));
  const inPhaseAuthoring = simpleStatus && relevantPaths.length > 0 && unexpectedPaths.length === 0;
  const rollover = phaseRecovery?.actions.find(entry => entry.id === `begin-new-generation:${phase?.id}`
    && entry.mode === 'guided' && typeof entry.command === 'string');
  const successorRequired = applicationScope?.basis === 'published-generation' && applicationPaths.length > 0;
  const guided = inPhaseAuthoring && (!successorRequired || Boolean(rollover));
  const route = guided && applicationPaths.length
    ? successorRequired ? rollover.command : `singularity-flow phase prepublish ${phase.id} --json`
    : null;
  return {
    id: 'working-tree', safe: false, automatic: false,
    mode: guided ? 'guided' : 'manual',
    classification: guided ? successorRequired ? 'successor-generation-review-required'
      : 'current-phase-review-required' : 'review-required',
    reviewRequired: true,
    confirmation: guided ? successorRequired ? 'plan-hash' : 'none' : 'human-authority', command: route,
    ...(route ? { skill: successorRequired ? '/sf-recover' : '/sf-code' } : {}),
    paths: relevantPaths, expectedPaths, unexpectedPaths, disposableUntrackedPaths,
    applicationPaths, applicationScope,
    preserved: ['working-tree bytes', 'Git index', 'published generations', 'approval history'],
    detail: guided && applicationPaths.length
      ? successorRequired
        ? `Review the exact listed application diff since published generation ${applicationScope.publishedGeneration}, then use the returned confirmed rollover command. The prior publication stays immutable; recovery does not commit, stash or discard these edits.`
        : 'Review the listed source, test and documentation changes within the verified open generation, then continue that draft and recheck prepublish. This scope check does not establish authorship or make unfinished artifacts or failing tests valid. Recovery does not commit, stash or discard these edits.'
      : guided
      ? 'Only exact current-phase preparation or planned evidence paths changed. Review their Git diff, especially workflow.json; these are uncommitted authoring bytes, not publication authority. Continue only if the changes match the current phase. Recovery will not discard or stash them.'
      : 'Uncommitted changes include paths or Git operations outside exact current-phase preparation. Review them manually; recovery will not discard or stash them.'
  };
}

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
  const phase = item.currentPhase ? `${item.currentPhase.label} (${item.currentPhase.status})` : 'closed';
  return `${item.workId} — ${item.title}\nPhase: ${phase}\nAssignment: ${item.assignment?.assignee ?? 'unassigned'}${item.reminder ? `\n! Approval reminder: waiting ${item.reminder.waitingHours}h (threshold ${item.reminder.thresholdHours}h)` : ''}\nLast event: ${item.lastEvent?.event ?? 'none'}${item.lastEvent?.detail ? ` — ${item.lastEvent.detail}` : ''}\nUpdated: ${item.updatedAt}\n`;
}

export async function recoveryPlan(root, config, workflow, { fetch = false, phaseId = null, inspectActivePhase = false, modelEnabled = true } = {}) {
  const actions = [];
  const blockers = [];
  const pending = await inspectPendingPublication(root, {
    kind: 'story', id: workflow.workItem.id, migrate: false,
    roots: { workItemRoot: config.workItemRoot }
  });
  if (branch(root) !== workflow.workItem.branch) actions.push({
    id: 'branch', safe: true, automatic: false,
    command: `singularity-flow resume ${workflow.workItem.id} --fetch`,
    skill: '/sf-resume',
    detail: `Switch to ${workflow.workItem.branch} and attach the governed Story checkout.`
  });
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
  // Explicit recovery inspects the active phase even before its first publication. Lightweight
  // status/next-step consumers keep their transport-only default except at consumed generations.
  const requestedPhase = phaseId ?? (inspectActivePhase || consumedGeneration ? activePhaseId : null);
  const phase = requestedPhase ? workflow.phases?.[requestedPhase] ?? null : null;
  if (phaseId && !phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId}'. Provide a phase ID.`, {
    code: 'RECOVERY_PHASE_UNKNOWN', details: { phaseId }
  });
  const phaseRecovery = phase
    ? await inspectPhaseRecovery(root, config, workflow, phase, {
      modelEnabled,
      generationDigest: async (repositoryRoot, selectedPhase) => await generationResultMatches(
        repositoryRoot, config, workflow, selectedPhase
      )
        ? selectedPhase.generationIntent.publication.resultDigest
        : generationResultDigest(repositoryRoot, config, workflow, selectedPhase)
    })
    : { blockers: [], actions: [], requiresLifecycleRecovery: false };
  blockers.push(...phaseRecovery.blockers);
  actions.push(...phaseRecovery.actions);
  // A completed workflow has no current phase, which used to make `recover` report that nothing was
  // wrong even when the terminal gate named stale conformance, missing AC coverage, or unpublished
  // state. Run that read-only gate here and preserve its explicit phase ownership. The gate cannot
  // mutate state; a reopen remains a reviewed guided action governed by the completion policy.
  let terminalGate = null;
  if (workflow.status === 'closed' && workflow.currentPhase == null) {
    terminalGate = await runGovernanceGate(root, config, workflow, { terminal: true });
    blockers.push(...terminalGate.findings);
    actions.push(...recoveryActionsForFindings(terminalGate.findings));
  }
  const worktreeStatus = changes(root);
  if (worktreeStatus.trim()) {
    const worktreeAction = await workingTreeAction(root, config, workflow, phase ?? activePhase, worktreeStatus, phaseRecovery);
    if (worktreeAction) actions.push(worktreeAction);
  }
  if (!actions.length) actions.push({
    id: 'none', safe: true, automatic: false, mode: 'informational', confirmation: 'none', command: null,
    detail: 'No recoverable publication, branch, synchronization, artifact, projection, or generation problem was found.'
  });
  const revision = {
    branch: branch(root), head: head(root),
    worktree: recoveryWorktreeDigest(root, config, workflow)
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
    phaseRepairRequired: phaseRecovery.blockers.length > 0,
    ...(modelEnabled === false ? { modelEnabled: false } : {}),
    testExecution: phaseRecovery.testExecution ?? { status: 'not-required', commands: [] },
    containment: phase ? {
      scope: 'phase',
      phaseId: phase.id,
      phaseStatus: phase.status,
      generation: phase.generation,
      strategy: pending.status === 'pending' ? 'roll-forward-exact-commit' : 'repair-current-phase',
      publishedGenerationsPreserved: true,
      automaticDiscard: false,
      historyRewrite: false
    } : null,
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
  const plan = { ...core, planId: `sha256:${recordSha256(core)}` };
  return { ...plan, applyCommand: plan.actions.some(item => item.automatic) ? recoveryApplyCommand(plan) : null };
}

function recoveryApplyCommand(plan) {
  return `singularity-flow recover ${plan.workId}${plan.phaseId ? ` --phase ${plan.phaseId}` : ''} --apply --confirm ${plan.planId}${plan.actions.some(item => item.id === 'fast-forward') ? ' --fetch' : ''}${plan.modelEnabled === false ? ' --no-model' : ''}`;
}

export async function applyRecovery(root, config, workflow, plan, { confirm = null } = {}) {
  const automatic = plan.actions.filter((item) => item.automatic);
  if (!automatic.length) throw new SingularityFlowError(
    'This recovery plan has no automatic action. Complete its guided or human-authority step, then inspect again.',
    { code: 'RECOVERY_AUTOMATIC_ACTION_UNAVAILABLE', details: {
      planId: plan.planId, workId: plan.workId, phase: plan.phaseId,
      actions: plan.actions.filter(item => item.id !== 'none' && !item.automatic)
    } }
  );
  if (!confirm || confirm !== plan.planId) throw new SingularityFlowError(
    `Recovery application requires the exact reviewed plan hash. Re-run with --confirm ${plan.planId}.`,
    { code: 'RECOVERY_PLAN_CONFIRMATION_REQUIRED', details: { planId: plan.planId } }
  );
  const current = {
    branch: branch(root), head: head(root),
    worktree: recoveryWorktreeDigest(root, config, workflow)
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
    if (action.id === 'fast-forward') {
      await fetchOrigin(root);
      await pullFastForward(root);
      completed.push({ id: action.id, result: 'fast-forward complete' });
    }
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
  if (plan.containment?.scope === 'phase') {
    lines.push(
      `Containment: ${plan.containment.strategy} in ${plan.containment.phaseId} generation ${plan.containment.generation}.`,
      'Published generations are preserved; recovery never discards authored work or rewrites history.',
      ''
    );
  }
  for (const blocker of plan.blockers ?? []) {
    const location = blocker.path ? `${blocker.path}${blocker.line ? `:${blocker.line}` : ''}` : null;
    lines.push(`BLOCKED ${blocker.code}${location ? ` — ${location}` : ''}`);
    const message = blocker.message ?? blocker.details?.message;
    if (message) lines.push(`  ${message.replaceAll('\n', '\n  ')}`);
  }
  if (plan.blockers?.length) lines.push('');
  for (const action of plan.actions) {
    lines.push(`${action.safe ? '✓' : '!'} ${action.id}: ${action.detail}${action.automatic ? ' [can apply]' : ''}`);
    if (action.command) {
      const guidance = safeCommandGuidance(action);
      if (guidance) {
        lines.push(`  Shell: ${guidance.command}`);
        lines.push(`  Copilot: ${guidance.copilotCommand}`);
      } else lines.push('  Command guidance unavailable: the supplied route was not safe or did not match.');
    }
  }
  if (!plan.applied && plan.actions.some((item) => item.automatic)) {
    const command = plan.applyCommand ?? recoveryApplyCommand(plan);
    const guidance = safeCommandGuidance({ command, skill: '/sf-recover' });
    lines.push('', 'Apply safe actions:');
    if (guidance) {
      lines.push(`  Shell: ${guidance.command}`);
      lines.push(`  Copilot: ${guidance.copilotCommand}`);
    } else lines.push('  Command guidance unavailable: the supplied route was not safe or did not match.');
  }
  if (plan.applied) lines.push('', `Applied ${plan.completed.length} safe action(s). No history was reset or rewritten.`);
  return `${lines.join('\n')}\n`;
}
