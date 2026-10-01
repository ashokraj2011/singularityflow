/** Exact-plan readiness execution followed by the ordinary governed Story transaction. */
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { changes, head, repoRoot } from '../git.mjs';
import { executeRepositoryReadinessPlan } from '../initialization/runtime-readiness.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { StoryStateStore, storyPublicationPending, workDir } from '../state-stores.mjs';
import { loadStoryTestRecoveryAgreement } from '../state.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { completeTrpReadinessRepair, previewTrpReadinessRepair } from '../test-recovery-repair.mjs';
import { assertTrpRepairCohortRetained, inspectTrpRepairScope } from '../test-recovery-repair-scope.mjs';
import { trpDigest } from '../test-recovery-policy.mjs';
import { appendTrpRepairEvidence, appendTrpReadinessCheckpoint, readTrpOriginalBaseline } from '../test-recovery-store.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { verifyWorkflowSnapshot } from '../workflow-snapshots.mjs';

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const runtime = {
  loadAcceptedStoryExecution, loadStoryTestRecoveryAgreement, verifyWorkflowSnapshot,
  previewTrpReadinessRepair, executeRepositoryReadinessPlan, appendTrpRepairEvidence,
  appendTrpReadinessCheckpoint, storyPublicationPending, withSubjectLock, changes, head, workDir,
  inspectTrpRepairScope, readTrpOriginalBaseline,
  createStore: (root, config) => new StoryStateStore(root, config)
};

async function loadContext(root, workId, dependencies) {
  const loaded = await dependencies.loadAcceptedStoryExecution(root, workId);
  const config = loaded.config ?? loaded.definition;
  const workflow = loaded.workflow;
  const snapshot = await dependencies.verifyWorkflowSnapshot(root, config, workflow, { requireAccepted: true });
  if (!snapshot.enrolled) fail('Readiness repair requires an accepted Story workflow snapshot.', 'TRP_REPAIR_SNAPSHOT_REQUIRED');
  const agreement = await dependencies.loadStoryTestRecoveryAgreement(root, config, workflow);
  if (!agreement) fail('This Story has no accepted Test and Recovery Agreement.', 'TRP_NOT_ENABLED');
  return { root, config, workflow, agreement, workId: workflow.workItem.id,
    workRoot: dependencies.workDir(root, config, workflow.workItem.id) };
}

function legalRecovery(workId) {
  return { id: 'inspect-publication', owner: 'story-owner', label: 'Inspect the exact pending Story publication',
    command: 'recover', args: [workId, '--json'] };
}

async function inspect(context, repositoryId, dependencies) {
  const { root, config, workflow, agreement, workId } = context;
  const required = agreement.repositories.filter(repository => repository.required && repository.codeBearing
    && repository.execution.mode !== 'not-applicable');
  const selected = repositoryId ?? (required.length === 1 ? required[0].repositoryId : null);
  const initial = workflow.resolution?.testRecoveryInitialReadiness;
  const originals = initial?.repositories ?? [];
  const original = originals.find(repository => repository.repositoryId === selected);
  const pending = await dependencies.storyPublicationPending(root, config, workId, { migrate: false });
  const preserved = { originalReadiness: initial ?? null, currentReadiness: workflow.testRecovery.readiness ?? null,
    source: true, documents: true, publicationHistory: true, approvalHistory: true };
  if (pending) return { status: 'publication-pending', workId, repositoryId: selected, preserved,
    pending, legalActions: [legalRecovery(workId)] };
  if (required.length !== 1) return { status: 'external-prerequisite', workId, repositoryId: selected, preserved,
    reason: 'This execution pilot requires one code-bearing delivery repository. A multi-repository repair needs its owning coordinated checkpoint route.',
    owner: 'repository-owner', requiredRepositories: required.map(repository => repository.repositoryId), legalActions: [] };
  if (selected !== required[0].repositoryId || !original) fail('Select the required repository bound to the Story’s immutable initial readiness.',
    'TRP_READINESS_REPOSITORY_INVALID', { requiredRepositories: required.map(repository => repository.repositoryId) });
  const repairCommit = dependencies.head(root);
  const repairScope = dependencies.inspectTrpRepairScope(root, { workflow, workRoot: context.workRoot,
    baseCommit: original.baseCommit, repairCommit });
  if (repairScope.blockers.length) return { status: 'scope-review-required', workId, repositoryId: selected,
    preserved, repairScope, owner: 'story-owner', legalActions: [],
    reason: 'Review the exact source diff. Product edits, changed baseline tests and command changes are not supported by this bounded repair pilot.' };
  const originalBaseline = original.baselineSha256
    ? await dependencies.readTrpOriginalBaseline(context.workRoot, original.baselineSha256) : null;
  let preview;
  try {
    preview = await dependencies.previewTrpReadinessRepair(root, {
      agreement, repositoryId: selected, baseCommit: original.baseCommit, repairCommit
    });
  } catch (error) {
    if (!['REPOSITORY_READINESS_DIRTY', 'REPOSITORY_READINESS_TRACKED_DIRTY', 'REPOSITORY_READINESS_SOURCE_NOT_TRACKED',
      'REPOSITORY_READINESS_UNTRACKED_SOURCE', 'REPOSITORY_READINESS_SOURCE_CHANGED'].includes(error.code)) throw error;
    return { status: 'needs-checkpoint', workId, repositoryId: selected, preserved,
      code: error.code, reason: 'Review and commit only the intended setup/test/document repair paths before execution. No files were cleaned, staged or discarded.',
      owner: 'story-owner', workingTree: dependencies.changes(root), legalActions: [] };
  }
  const cohort = assertTrpRepairCohortRetained(originalBaseline, preview.plan, { preview: true });
  const core = { schemaVersion: 1, workId, repositoryId: selected,
    agreementSha256: agreement.recordSha256, originalBaseCommit: original.baseCommit,
    repairCommit, readinessPlanId: preview.plan.planId,
    priorReadinessSha256: trpDigest(workflow.testRecovery.readiness ?? null),
    repairScopeSha256: trpDigest(repairScope), originalBaselineSha256: original.baselineSha256 ?? null };
  const confirmation = trpDigest(core);
  return { status: preview.plan.blockers?.length ? 'needs-repair' : 'ready-for-confirmation',
    ...core, confirmation, preview, preserved, repairScope, cohort,
    legalActions: preview.plan.blockers?.length ? [] : [{ id: 'execute-readiness-repair', owner: 'story-owner',
      label: 'Run the reviewed dependency/test plan and record its passing checkpoint', command: 'story',
      args: ['test-policy', 'repair', '--work-id', workId, '--repository', selected, '--run', '--confirm', confirmation, '--json'] }] };
}

/** Dependencies are trusted runtime/test seams and are never read from CLI options or records. */
export async function repairStoryTestReadiness({ root, workId = null, repositoryId = null,
  execute = false, confirmation = null } = {}, overrides = {}) {
  const dependencies = { ...runtime, ...overrides };
  if (execute && !/^sha256:[a-f0-9]{64}$/u.test(confirmation ?? '')) {
    fail('Review the repair plan first, then pass its exact --confirm digest with --run.', 'TRP_REPAIR_CONFIRMATION_REQUIRED');
  }
  const initial = await loadContext(root, workId, dependencies);
  if (!execute) return inspect(initial, repositoryId, dependencies);
  return dependencies.withSubjectLock(root, { kind: 'story', id: initial.workId }, async () => {
    const context = await loadContext(root, initial.workId, dependencies);
    const { config, workflow, agreement, workRoot } = context;
    const prior = workflow.testRecovery.lastReadinessRepair;
    const store = dependencies.createStore(root, config);
    if (prior?.confirmation === confirmation
      && prior.checkpointSha256 === workflow.testRecovery.readiness?.checkpointSha256
      && (!repositoryId || repositoryId === prior.repositoryId)) {
      const pending = await dependencies.storyPublicationPending(root, config, initial.workId, { migrate: false });
      const publication = pending ? await store.sync(workflow) : null;
      return { status: publication?.pending ? 'publication-pending' : 'already-recorded',
        workId: initial.workId, checkpoint: workflow.testRecovery.readiness,
        publication, reused: true, executed: false };
    }
    const plan = await inspect(context, repositoryId, dependencies);
    if (plan.status !== 'ready-for-confirmation') fail('Resolve the returned readiness-repair prerequisite before execution.',
      'TRP_REPAIR_PREREQUISITE', { plan });
    if (confirmation !== plan.confirmation) fail('The repair plan changed. Review the new exact plan before execution.',
      'TRP_REPAIR_CONFIRMATION_MISMATCH', { plan });
    // The existing runner rechecks the exact source/command plan and preserves reports on failure.
    // It writes only its bounded local execution evidence; it never advances the Story itself.
    const execution = await dependencies.executeRepositoryReadinessPlan(root, {
      confirmation: plan.readinessPlanId, scope: 'dependency-test'
    });
    const originalBaseline = plan.originalBaselineSha256
      ? await dependencies.readTrpOriginalBaseline(workRoot, plan.originalBaselineSha256) : null;
    assertTrpRepairCohortRetained(originalBaseline, execution.receipt);
    if (dependencies.head(root) !== plan.repairCommit) fail('The repository moved while readiness ran; evidence was preserved and the Story was not changed.',
      'TRP_REPAIR_CHECKPOINT_STALE');
    const checkpoint = completeTrpReadinessRepair({ agreement,
      currentReadiness: { repositories: [{ repositoryId: plan.repositoryId, receipt: execution.receipt }] },
      baseCommit: plan.originalBaseCommit, repairCommit: plan.repairCommit,
      requiredRepositories: [plan.repositoryId], originalReadiness: workflow.resolution.testRecoveryInitialReadiness });
    const transaction = await store.transact(workflow, {
      type: 'test-readiness-repaired', phaseId: workflow.currentPhase,
      payload: { agreementSha256: agreement.recordSha256, checkpointSha256: checkpoint.checkpointSha256,
        repositoryId: plan.repositoryId, confirmation }
    }, `Record readiness repair for ${initial.workId}`, async (current) => {
      await dependencies.appendTrpRepairEvidence(workRoot, execution.receipt);
      const stored = await dependencies.appendTrpReadinessCheckpoint(workRoot, checkpoint);
      current.testRecovery.readinessHistory ??= [];
      current.testRecovery.readinessHistory.push(structuredClone(current.testRecovery.readiness));
      current.testRecovery.readiness = structuredClone(checkpoint);
      current.testRecovery.lastReadinessRepair = { confirmation, checkpointSha256: checkpoint.checkpointSha256,
        checkpointPath: stored.relativePath, receiptSha256: execution.receipt.receiptSha256,
        repositoryId: plan.repositoryId, repairCommit: plan.repairCommit };
      return { checkpointSha256: checkpoint.checkpointSha256, receiptSha256: execution.receipt.receiptSha256 };
    }, { expectedLocalHead: plan.repairCommit });
    const pending = await dependencies.storyPublicationPending(root, config, initial.workId, { migrate: false });
    return { status: pending ? 'publication-pending' : 'recorded', workId: initial.workId,
      checkpoint, publication: transaction.publication, pending: pending ?? null,
      executed: true, reused: false, evidencePurpose: 'baseline-admission-only',
      legalActions: pending ? [legalRecovery(initial.workId)] : [] };
  });
}

export async function run(argv, { options = {} } = {}) {
  if (optionBoolean(options, 'plan') && optionBoolean(options, 'run')) {
    fail('Choose read-only --plan or explicitly confirmed --run.', 'TRP_REPAIR_MODE_INVALID');
  }
  if (argv.length > 1) fail('Supply at most one Story ID.', 'TRP_REPAIR_ARGUMENT_INVALID');
  const positional = argv[0] ?? null;
  const optionId = optionString(options, 'work-id');
  if (positional && optionId && positional !== optionId) fail('The positional Story ID and --work-id disagree.', 'TRP_REPAIR_ARGUMENT_INVALID');
  const execute = optionBoolean(options, 'run');
  const data = await repairStoryTestReadiness({ root: repoRoot(), workId: optionId ?? positional,
    repositoryId: optionString(options, 'repository'), execute, confirmation: optionString(options, 'confirm') });
  return emitCommandResult(commandResult({
    operation: { id: 'story.test-policy.repair', classification: execute ? 'mutation' : 'read' },
    outcome: succeeded(execute && (data.executed || data.publication)
      ? 'story.test-policy.repair-recorded' : 'story.test-policy.repair-reported', { status: data.status }),
    effects: execute && (data.executed || data.publication)
      ? effects({ stateChanged: true, filesChanged: Boolean(data.executed),
        publicationCreated: Boolean(data.executed), externalSystemsChanged: Boolean(data.publication?.pushed) }) : noEffects(),
    restState: data.status === 'recorded' || data.status === 'already-recorded' ? 'complete' : 'informational',
    data
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}
