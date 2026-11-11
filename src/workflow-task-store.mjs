/** Local atomic progress; portable records are batched into the existing Story publication. */
import path from 'node:path';
import { lstat, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { repositoryGitDirectory } from './git-directory.mjs';
import { gitCommonDir } from './git.mjs';
import { readRecord } from './schema-migrations.mjs';
import { readPrivateSidecar, writeMutablePrivateSidecar, writeImmutablePrivateSidecar } from './private-sidecar.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { workflowTaskIdentity, workflowTaskInputSha256, validateWorkflowTask, updateWorkflowTask,
  mergeWorkflowTasks, workflowTaskResume, workflowTaskApplies, workflowTaskHasGeneration } from './workflow-task.mjs';
import { assertConfirmation, recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { phaseInspectionGeneration } from './phase-inspection-generation.mjs';

const directory = root => path.join(gitCommonDir(root), 'singularity-flow', 'workflow-tasks');
const fileFor = (root, id, base = directory(root)) => path.join(base, `${id}.json`);
const claimFor = (root, id, attempt, base = directory(root)) => path.join(base, `${id}.continuation-${attempt}`);

async function spendAllTaskClaims(root, id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let claim;
    try { claim = await open(claimFor(root, id, attempt), 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try { await claim.writeFile('spent-by-task-progress-recovery'); await claim.sync(); }
    finally { await claim.close(); }
  }
}

async function withTaskLock(root, identity, action) {
  for (let attempt = 0; ; attempt++) {
    try { return await withSubjectLock(root, { kind: 'workflow-task', id: identity.id }, action); }
    catch (error) {
      if (error.code !== 'SUBJECT_LOCK_BUSY' || attempt >= 3) throw error;
      await delay(20 * (attempt + 1));
    }
  }
}

async function withClaimBudget(root, record) {
  if (record.progressQuarantined) return record; // All automation stays spent; old claims remain preserved and inert.
  let consumed = record.continuations;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const entry = await lstat(claimFor(root, record.id, attempt)).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new SingularityFlowError(
      'A task continuation claim is not a regular file; preserve it for inspection.', { code: 'WORKFLOW_TASK_CLAIM_INVALID' });
    if (entry) consumed = Math.max(consumed, attempt);
  }
  const identity = Object.fromEntries(['id', 'workId', 'phaseId', 'generation', 'role', 'repositoryIdentity', 'storyIdentity'].map(key => [key, record[key]]));
  return consumed === record.continuations ? record : updateWorkflowTask(identity, record, { continuations: consumed });
}

async function localRecord(root, identity) {
  try {
    const raw = await readPrivateSidecar(root, fileFor(root, identity.id), { maximumBytes: 65536 });
    return await withClaimBudget(root, validateWorkflowTask(readRecord('workflow-task-record', raw).record, identity));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new SingularityFlowError(`Workflow task progress could not be read: ${error.message}`, {
      code: error.code ?? 'WORKFLOW_TASK_READ_FAILED', cause: error,
      details: { path: fileFor(root, identity.id), nextAction: String(error.code ?? '').startsWith('SCHEMA_VERSION_')
        ? 'singularity-flow about --json'
        : ['WORKFLOW_TASK_RECORD_INVALID', 'WORKFLOW_TASK_CLAIM_INVALID', 'SCHEMA_RECORD_INVALID', 'PRIVATE_SIDECAR_PATH_UNSAFE', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)
          ? taskQuarantineRoute(identity).command : `singularity-flow recover ${identity.workId} --phase ${identity.phaseId} --for-agent --json` }
    });
  }
}

const taskQuarantineRoute = (identity, confirmation = null) => safeCommandGuidance({ argv: ['appeal', 'task-quarantine',
  '--work-id', identity.workId, '--phase', identity.phaseId, '--role', identity.role,
  ...(confirmation ? ['--confirm', confirmation] : []), '--json'] });

/** Exact metadata-only recovery, preserving the damaged bytes and spending all automation. */
export async function quarantineWorkflowTaskProgress(root, workflow, phase, { role = 'author', confirm = null } = {}) {
  if (workflow.currentPhase !== phase.id || workflow.status !== 'in_progress') throw new SingularityFlowError(
    'Task progress recovery belongs to the current active phase.', { code: 'WORKFLOW_TASK_RECOVERY_SCOPE' });
  const identity = workflowTaskIdentity(workflow, phase, role);
  return withTaskLock(root, identity, async () => {
    let raw;
    try { raw = await readPrivateSidecar(root, fileFor(root, identity.id), { maximumBytes: 65536, optional: true }); }
    catch (error) {
      if (confirm) throw error;
      return { schemaVersion: 1, resultType: 'workflow-task-quarantine', status: 'owner-required',
        operationId: identity.id, filesChanged: false, code: error.code ?? 'WORKFLOW_TASK_READ_FAILED',
        message: error.message, path: fileFor(root, identity.id),
        manualRecovery: { owner: 'filesystem-owner', instruction: 'Restore access to this exact file/directory, then retry the current task. No unreadable record was overwritten and no budget was reset.' } };
    }
    const shared = workflow.taskOperations?.[identity.id] ?? null;
    const capture = { local: raw?.toString('base64') ?? null, shared };
    const confirmation = recordSha256(capture);
    const next = taskQuarantineRoute(identity, confirmation);
    const backupPath = path.join(path.dirname(directory(root)), 'workflow-tasks-quarantine', `${identity.id}-${confirmation}.json`);
    const preview = { schemaVersion: 1, resultType: 'workflow-task-quarantine', status: 'confirmation-required',
      operationId: identity.id, phase: phase.id, role, confirmation, backupDestination: backupPath,
      commandGuidance: next, automaticBudgetsAfterRecovery: 0, filesChanged: false,
      instruction: 'Preserve the exact damaged progress bytes. This recovery changes task metadata only; it never edits source, artifacts, reviews, evidence, approvals or application configuration. Automatic repair stays spent for this operation; owned draft correction and fresh checks remain available.' };
    if (!confirm) return preview;
    assertConfirmation(confirm, confirmation, { code: 'WORKFLOW_TASK_RECOVERY_STALE',
      fail: (message, code, details) => { throw new SingularityFlowError(message, { code, details }); },
      message: 'Task progress changed after preview. Inspect its current exact bytes before confirming recovery.',
      details: { nextAction: taskQuarantineRoute(identity).command } });
    await writeImmutablePrivateSidecar(root, backupPath, Buffer.from(JSON.stringify(capture)), { maximumBytes: 196608 });
    const record = updateWorkflowTask(identity, null, { inputSha256: workflowTaskInputSha256(workflow, phase),
      state: role === 'author' ? 'author-draft' : 'author-report', maximumContinuations: 0,
      continuations: 3, repairConsumed: 3, progressQuarantined: true, blockedCode: 'TASK_PROGRESS_QUARANTINED' });
    await writeMutablePrivateSidecar(root, fileFor(root, identity.id), Buffer.from(JSON.stringify(record)), { maximumBytes: 65536, renameAttempts: 4 });
    await spendAllTaskClaims(root, identity.id);
    return { ...preview, status: 'quarantined', backupPath, localFilesChanged: true, filesChanged: true,
      commandGuidance: safeCommandGuidance({ argv: role === 'author'
        ? ['phase', 'enter', phase.id, '--work-id', identity.workId, '--compose', '--for-agent', '--json']
        : ['review-source', 'context', phase.id, '--for-agent', '--json'] }) };
  });
}

const sharedTaskPath = identity => `workflow-tasks/${identity.storyIdentity}/${identity.id}.json`;

/** Read only the selected task blobs from the already fetched state ref, never branch/history scans. */
async function sharedTaskRecords(root, workflow, identities) {
  const raw = workflow.resolution?.ledger;
  if (!raw?.enabled || !identities.length) return new Map();
  const { readRefTreeResult } = await import('./git-ref-tree.mjs');
  const ref = `refs/remotes/${raw.remote ?? 'origin'}/${raw.branch ?? 'state'}`;
  const observed = readRefTreeResult(root, ref, identities.map(sharedTaskPath), { maxObjectBytes: 65536, maxBatchBytes: 131072 });
  if (observed.status !== 'ok') throw new SingularityFlowError(`The selected task checkpoint state at '${ref}' could not be read. ${observed.errors[0]?.message ?? ''}`, {
    code: 'WORKFLOW_TASK_STATE_UNAVAILABLE', details: { ref, status: observed.status, errors: observed.errors,
      nextAction: 'singularity-flow ledger status --json' }
  });
  return new Map([...observed.contents]
    .map(([file, content]) => [file, Buffer.from(content)]));
}

async function preserveUnreadableSharedTask(root, workflow, phase, identity, bytes, error) {
  const digest = recordSha256({ bytes: bytes.toString('base64') });
  const backupPath = path.join(path.dirname(directory(root)), 'workflow-tasks-quarantine', `${identity.id}-shared-${digest}.json`);
  await writeImmutablePrivateSidecar(root, backupPath, bytes, { maximumBytes: 65536 });
  const record = await observeWorkflowTask(root, workflow, phase, {
    state: identity.role === 'author' ? 'author-draft' : 'author-report', continuations: 3,
    maximumContinuations: 0, repairConsumed: 3, progressQuarantined: true, blockedCode: 'SHARED_TASK_PROGRESS_UNREADABLE'
  }, { role: identity.role, generation: identity.generation });
  await spendAllTaskClaims(root, identity.id);
  return { record, warning: { code: error.code ?? 'WORKFLOW_TASK_RECORD_INVALID', message: error.message,
    backupPath, automaticBudgetsSpent: true, nextAction: safeCommandGuidance({ argv: String(error.code ?? '').startsWith('SCHEMA_VERSION_')
      ? ['about', '--json'] : ['appeal', 'task-checkpoint', '--work-id', identity.workId, '--phase', phase.id, '--role', identity.role, '--json'] }) } };
}

/** Explicit portable handoff of metadata only; never stages or commits a dirty application tree. */
export async function shareWorkflowTaskProgress(root, workflow, phase, { role = 'author' } = {}) {
  if (workflow.currentPhase !== phase.id || workflow.status !== 'in_progress') throw new SingularityFlowError(
    'Checkpoint only the selected active phase.', { code: 'WORKFLOW_TASK_CHECKPOINT_SCOPE' });
  const identity = workflowTaskIdentity(workflow, phase, role);
  const local = await readWorkflowTask(root, workflow, phase, { role });
  if (!local) throw new SingularityFlowError('Enter the task once before sharing its progress.', {
    code: 'WORKFLOW_TASK_CHECKPOINT_MISSING', details: { nextAction: role === 'author'
      ? `singularity-flow phase enter ${phase.id} --work-id ${identity.workId} --compose --for-agent --json`
      : `singularity-flow review-source context ${phase.id} --for-agent --json` }
  });
  const raw = workflow.resolution?.ledger;
  const effects = { sourceShared: false, attachmentsShared: false, phaseAdvanced: false, approved: false };
  const commandGuidance = safeCommandGuidance({ argv: role === 'author'
    ? ['phase', 'enter', phase.id, '--work-id', identity.workId, '--compose', '--for-agent', '--json']
    : ['review-source', 'context', phase.id, '--for-agent', '--json'] });
  if (!raw?.enabled || workflow.resolution?.git?.publish === 'off') return {
    schemaVersion: 1, resultType: 'workflow-task-checkpoint', status: 'local-only', shared: false,
    operationId: identity.id, recordSha256: local.recordSha256, effects, commandGuidance,
    instruction: 'Progress is retained on this laptop. Shared state publication is disabled in this Story; no portable checkpoint was published.'
  };
  const { refreshLedgerRemoteView, publishToStateBranch } = await import('./ledger.mjs');
  await refreshLedgerRemoteView(root, raw);
  const file = sharedTaskPath(identity);
  const existing = (await sharedTaskRecords(root, workflow, [identity])).get(file);
  let remote = null;
  let recovered = null;
  if (existing) {
    try { remote = validateWorkflowTask(readRecord('workflow-task-record', existing).record, identity); }
    catch (error) {
      if (!['WORKFLOW_TASK_RECORD_INVALID', 'SCHEMA_RECORD_INVALID'].includes(error.code)) throw new SingularityFlowError(
        error.message, { code: error.code, cause: error, details: { ...error.details, nextAction: 'singularity-flow about --json' } });
      recovered = await preserveUnreadableSharedTask(root, workflow, phase, identity, existing, error);
    }
  }
  const record = recovered?.record ?? mergeWorkflowTasks(remote, local, identity);
  const bytes = Buffer.from(JSON.stringify(record));
  const { createHash } = await import('node:crypto');
  const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  const precondition = existing ? { condition: 'exact', bytes: existing.length,
    sha256: digest(existing), gitMode: '100644' } : { condition: 'absent' };
  const publication = existing && existing.equals(bytes) ? null : await publishToStateBranch(root, raw,
    { [file]: bytes }, `[${identity.workId}][phase:${phase.id}] checkpoint task progress`, {
      pathPreconditions: { [file]: precondition }, exactBlobSha256: { [file]: digest(bytes) }
    });
  await withTaskLock(root, identity, async () => {
    const current = await readWorkflowTask(root, workflow, phase, { role });
    const merged = mergeWorkflowTasks(record, current, identity);
    if (current?.recordSha256 !== merged.recordSha256) await writeMutablePrivateSidecar(root, fileFor(root, identity.id), Buffer.from(JSON.stringify(merged)), { maximumBytes: 65536, renameAttempts: 4 });
  });
  return { schemaVersion: 1, resultType: 'workflow-task-checkpoint', status: publication ? 'shared' : 'already-shared',
    shared: true, operationId: identity.id, recordSha256: record.recordSha256, commandGuidance,
    stateReference: { kind: 'git-state-blob', ref: `refs/heads/${raw.branch ?? 'state'}`, entry: file },
    commit: publication?.commit ?? publication?.sha ?? null, effects,
    stateChanged: Boolean(publication), publication: publication ? { ...publication, pushed: true } : null,
    ...(recovered ? { warnings: [recovered.warning] } : {}),
    instruction: 'Only task progress is shared. Uncommitted drafts need an explicit content handoff. Local attachments must be re-uploaded on the receiving laptop; its fresh phase entry issues new paths and checks all bindings.' };
}

/** Attach imports two exact optional blobs at most, using the state snapshot it already fetched. */
export async function importSharedWorkflowTaskProgress(root, workflow, phase, { refresh = false } = {}) {
  if (!phase || !workflow.resolution?.ledger?.enabled) return { status: 'not-required', imported: 0 };
  if (refresh) await (await import('./ledger.mjs')).refreshLedgerRemoteView(root, workflow.resolution.ledger);
  const identities = ['author', ...(phase.generation > 0 ? ['source-reviewer'] : [])]
    .filter(role => workflowTaskApplies(phase, role) && workflowTaskHasGeneration(workflow, phase, role))
    .map(role => workflowTaskIdentity(workflow, phase, role));
  const records = await sharedTaskRecords(root, workflow, identities);
  let imported = 0;
  const warnings = [];
  for (const identity of identities) {
    const bytes = records.get(sharedTaskPath(identity));
    if (!bytes) continue;
    let shared;
    try { shared = validateWorkflowTask(readRecord('workflow-task-record', bytes).record, identity); }
    catch (error) {
      const preserved = await preserveUnreadableSharedTask(root, workflow, phase, identity, bytes, error);
      warnings.push(preserved.warning);
      continue;
    }
    await withTaskLock(root, identity, async () => {
      const local = await readWorkflowTask(root, workflow, phase, { role: identity.role, generation: identity.generation });
      const merged = mergeWorkflowTasks(shared, local, identity);
      await writeMutablePrivateSidecar(root, fileFor(root, identity.id), Buffer.from(JSON.stringify(merged)), { maximumBytes: 65536, renameAttempts: 4 });
    });
    imported++;
  }
  return { status: 'imported', imported, ...(warnings.length ? { warnings } : {}) };
}

/** A failed progress import must disclose its recovery without losing a successful attachment. */
export async function attachWorkflowTaskProgress(root, workflow, phase) {
  try {
    const taskProgressImport = await importSharedWorkflowTaskProgress(root, workflow, phase, { refresh: true });
    return { taskProgressImport, taskResume: await readWorkflowTaskResume(root, workflow, phase) };
  } catch (error) {
    return { taskProgressImport: { status: 'unavailable', code: error.code ?? 'WORKFLOW_TASK_IMPORT_FAILED',
      message: error.message, details: error.details ?? null }, taskResume: { state: 'tracking-unavailable', complete: false,
      error: { code: error.code ?? 'WORKFLOW_TASK_IMPORT_FAILED', message: error.message },
      nextAction: safeCommandGuidance(error.details?.nextAction) ?? safeCommandGuidance({ argv: ['recover', workflow.workItem.id,
        '--phase', phase.id, '--for-agent', '--json'] }), automaticContinuationAllowed: false } };
  }
}

export async function readWorkflowTask(root, workflow, phase, { role = 'author', generation = null } = {}) {
  const identity = workflowTaskIdentity(workflow, phase, role, generation);
  const local = await localRecord(root, identity);
  try { return mergeWorkflowTasks(workflow.taskOperations?.[identity.id] ?? null, local, identity); }
  catch (error) { throw new SingularityFlowError(error.message, { code: error.code ?? 'WORKFLOW_TASK_RECORD_INVALID', cause: error,
    details: { operationId: identity.id, nextAction: taskQuarantineRoute(identity).command } }); }
}

export async function observeWorkflowTask(root, workflow, phase, observation, { role = 'author', generation = null } = {}) {
  if (!workflowTaskApplies(phase, role)) return null;
  const identity = workflowTaskIdentity(workflow, phase, role, generation);
  return withTaskLock(root, identity, async () => {
    const previous = await readWorkflowTask(root, workflow, phase, { role, generation: identity.generation });
    let record = updateWorkflowTask(identity, previous, { inputSha256: workflowTaskInputSha256(workflow, phase),
      maximumContinuations: role === 'source-reviewer' ? 2 : phase.repairBudget?.maxAttempts ?? 3, ...observation });
    const raw = await readPrivateSidecar(root, fileFor(root, identity.id), { maximumBytes: 65536, optional: true });
    if (!raw) record = await withClaimBudget(root, record);
    const stored = raw ? readRecord('workflow-task-record', raw).record : null;
    if (stored?.recordSha256 !== record.recordSha256) await writeMutablePrivateSidecar(root, fileFor(root, identity.id),
      Buffer.from(JSON.stringify(record)), { maximumBytes: 65536, renameAttempts: 4 });
    return record;
  });
}

export async function readWorkflowTaskResume(root, workflow, phase, options = {}) {
  if (!workflowTaskApplies(phase, options.role)) return null;
  if (options.published === true && phase.generation > 0 && options.generation == null) options = { ...options, generation: phase.generation };
  if (!workflowTaskHasGeneration(workflow, phase, options.role, options.generation)) return null;
  const record = await readWorkflowTask(root, workflow, phase, options);
  return workflowTaskResume(workflow, phase, { ...options, record });
}

/** Entry refreshes the available facts, never the operation's consumed budget. */
export async function resumeWorkflowTask(root, workflow, phase, options = {}) {
  if (!workflowTaskApplies(phase, options.role)) return null;
  if (options.published === true && phase.generation > 0 && options.generation == null) options = { ...options, generation: phase.generation };
  if (!workflowTaskHasGeneration(workflow, phase, options.role, options.generation)) return null;
  const previous = await readWorkflowTask(root, workflow, phase, options);
  const resume = workflowTaskResume(workflow, phase, { ...options, record: previous });
  const record = await observeWorkflowTask(root, workflow, phase, {
    inputSha256: options.inputSha256 ?? workflowTaskInputSha256(workflow, phase),
    state: resume.state === 'inspect-interrupted-operation' ? previous.state : resume.state,
    blockedCode: options.blocked?.code ?? null
  }, options);
  return { ...resume, continuationBudget: { consumed: record.continuations, maximum: record.maximumContinuations } };
}

/** The stop hook spends a task-scoped budget once; a new chat does not replenish it. */
export async function reserveWorkflowTaskContinuation(root, id, expected) {
  if (!/^WT-[a-f0-9]{64}$/u.test(id ?? '')) throw new Error('Invalid workflow task ID.');
  // Stop hooks use filesystem observations only. Exclusive claims survive crashes and overlap;
  // the next CLI checkpoint folds them into the portable record under its ordinary short lock.
  const common = repositoryGitDirectory(root);
  if (!common) throw new SingularityFlowError('Task claim Git storage is unavailable.', { code: 'WORKFLOW_TASK_CLAIM_INVALID' });
  const base = path.join(common, 'singularity-flow', 'workflow-tasks');
  for (const candidate of [common, path.join(common, 'singularity-flow'), base]) {
    const parent = await lstat(candidate);
    if (!parent.isDirectory() || parent.isSymbolicLink() || candidate === base
        && process.platform !== 'win32' && (parent.mode & 0o077)) {
      throw new SingularityFlowError('Task claim directory is unsafe.', { code: 'WORKFLOW_TASK_CLAIM_INVALID' });
    }
  }
  const file = fileFor(root, id, base);
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 65536) throw new SingularityFlowError(
    'Task claim has no bounded regular task record.', { code: 'WORKFLOW_TASK_CLAIM_INVALID' });
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let record;
  try {
    const opened = await handle.stat();
    if (opened.ino !== entry.ino || opened.dev !== entry.dev || opened.size > 65536) throw new Error('Task record changed during observation.');
    record = validateWorkflowTask(readRecord('workflow-task-record', await handle.readFile()).record, { id, ...expected });
  } finally { await handle.close(); }
  for (let attempt = record.continuations + 1; attempt <= record.maximumContinuations; attempt++) {
    let claim;
    try { claim = await open(claimFor(root, id, attempt, base), 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try { await claim.writeFile(record.recordSha256); await claim.sync(); }
    finally { await claim.close(); }
    return { allowed: true, consumed: attempt, maximum: record.maximumContinuations };
  }
  return { allowed: false };
}

/** Called only by an existing kernel write. Nothing pushes, commits, reads history or edits source. */
export async function batchWorkflowTaskProgress(root, workflow, event = null) {
  const phases = event?.phaseId ? [workflow.phases[event.phaseId]].filter(Boolean)
    : [workflow.phases?.[workflow.currentPhase]].filter(Boolean);
  const records = { ...(workflow.taskOperations ?? {}) };
  for (const phase of phases) {
    for (const role of ['author', 'source-reviewer']) {
      if (!workflowTaskApplies(phase, role)) continue;
      const generation = role === 'source-reviewer' ? phase.generation
        : event?.generation > 0 ? event.generation : phaseInspectionGeneration(workflow, phase);
      if (!Number.isSafeInteger(generation) || generation < 1) continue;
      const identity = workflowTaskIdentity(workflow, phase, role, generation);
      let record = await readWorkflowTask(root, workflow, phase, { role, generation });
      const published = role === 'author' && event?.type === LIFECYCLE_EVENT.ARTIFACT_GENERATED;
      const retained = role === 'source-reviewer' && event?.payload?.kind === 'source-grounded-review';
      if (published || retained) record = updateWorkflowTask(identity, record, {
        inputSha256: record?.inputSha256 ?? workflowTaskInputSha256(workflow, phase),
        state: 'complete', checkpoint: published ? 'publication' : 'retained-review',
        fingerprint: recordSha256({ eventId: event.eventId, phaseId: phase.id, generation, payload: event.payload })
      });
      if (record) records[identity.id] = record;
    }
  }
  if (Object.keys(records).length) workflow.taskOperations = records;
}

/** Observe gate facts without retaining file bodies, native paths, issue prose or commands. */
export async function observeWorkflowTaskCheck(root, workflow, phase, result, { role = 'author', generation = result.generation, inputSha256 = null } = {}) {
  if (!workflowTaskApplies(phase, role) || !Number.isInteger(generation) || generation < 1) return null;
  const ready = role === 'author' ? result.status === 'ready' : result.retentionReady === true;
  const state = role === 'author' ? ready ? 'publish-ready' : result.correction?.sameTurn ? 'repair-draft' : 'blocked'
    : ready ? 'retain-report' : 'repair-report';
  const fingerprint = recordSha256({ fingerprint: result.draftFingerprint ?? null,
    artifacts: result.artifacts?.map(artifact => ({ path: artifact.path, sha256: artifact.sha256 })) ?? null,
    report: result.reportSha256 ?? null, findings: result.findings?.map(finding => ({ code: finding.code, field: finding.field })) ?? null });
  return observeWorkflowTask(root, workflow, phase, { state, ...(inputSha256 ? { inputSha256 } : {}), checkpoint: role === 'author' ? 'validation' : 'review-check',
    fingerprint, condition: ready ? null : fingerprint,
    repairConsumed: result.repairLoop?.consumed ?? 0,
    blockedCode: state === 'blocked' ? result.findings?.find(finding => /^[A-Za-z0-9_.:-]+$/u.test(finding.code ?? ''))?.code ?? 'OWNER_REVIEW_REQUIRED' : null }, { role, generation });
}
