import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { branch, changedFiles, gitDir, head } from './git.mjs';
import { loadActiveSpecRecords } from './specifications.mjs';
import {
  SingularityFlowError, nowIso, posix, readJson, run, secureRepositoryPath, writeJson
} from './util.mjs';

const SCHEMA_VERSION = 1;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function prefixedHash(value) {
  return `sha256:${hash(value)}`;
}

function generationFor(phase) {
  return Math.max(1, Number(phase?.generation ?? 0) + (phase?.status === 'in_progress' ? 1 : 0));
}

function activePhase(workflow, phaseId = workflow.currentPhase) {
  const phase = workflow.phases?.[phaseId];
  if (!phase) throw new SingularityFlowError(`Story has no phase '${phaseId ?? ''}'.`);
  return phase;
}

export function phaseUsesWorkInterval(phase) {
  return (phase?.writeScope ?? 'artifact-only') === 'source-and-artifact';
}

function intervalRelative(itemRelative, phaseId, generation) {
  return posix(path.join(itemRelative, 'context', 'work-intervals', `${phaseId}-gen${generation}-baseline.json`));
}

function protectedPaths(config, workflow) {
  return [...new Set([
    ...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ].map(posix))].sort();
}

function requiredChecks(workflow) {
  const current = workflow.phases?.[workflow.currentPhase];
  return [...new Set([
    ...(workflow.lineage?.requiredChecks ?? []),
    ...(current?.qualityCommands ?? [])
  ])].sort();
}

function workflowSubjectRevision(workflow, phase) {
  return prefixedHash({
    workItem: workflow.workItem,
    phase,
    currentPhase: workflow.currentPhase,
    resolution: workflow.resolution,
    lineage: workflow.lineage
  });
}

function intervalPolicy(config, workflow, phase) {
  const guards = protectedPaths(config, workflow);
  return {
    protectedPaths: guards,
    approvalPolicy: phase.approvalPolicy ?? {},
    reconciliation: {
      changedPathLimit: Number(phase.approvalPolicy?.maximumChangedPaths ?? 5),
      escalationTarget: workflow.workItem.workType === 'quick-fix' && config.workTypes?.feature ? 'feature' : null,
      localProvidersOnly: true
    }
  };
}

function baselineCore(record) {
  const core = { ...record };
  for (const key of ['baselineSha256', 'createdAt', 'path', 'status']) delete core[key];
  return core;
}

export async function verifyWorkIntervalBaseline(root, config, workflow, {
  phaseId = workflow.currentPhase,
  itemDirectory
} = {}) {
  const phase = activePhase(workflow, phaseId);
  const current = workflow.workIntervals?.current;
  if (!current || current.phaseId !== phase.id || current.status !== 'open') {
    throw new SingularityFlowError(`Phase '${phase.id}' has no open governed work interval.`);
  }
  const itemTarget = await secureRepositoryPath(root, itemDirectory, { label: 'Story directory', type: 'directory' });
  const itemAbsolute = itemTarget.absolute;
  const target = await secureRepositoryPath(root, current.path, { label: 'Work-interval baseline', type: 'file' });
  const relativeToItem = path.relative(itemAbsolute, target.absolute);
  if (!relativeToItem || relativeToItem.startsWith('..') || path.isAbsolute(relativeToItem)) {
    throw new SingularityFlowError(`Work-interval baseline must remain inside the Story directory: ${current.path}`);
  }
  if (!target.exists) throw new SingularityFlowError(`Work-interval baseline does not exist: ${current.path}`);
  const record = await readJson(target.absolute);
  const expectedPolicy = intervalPolicy(config, workflow, phase);
  const expectedChecks = requiredChecks(workflow);
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  expect(record.kind === 'work-interval-baseline', 'record kind changed');
  expect(record.path === current.path, 'record path changed');
  expect(record.workId === workflow.workItem.id, 'work ID changed');
  expect(record.intervalId === current.intervalId, 'interval ID changed');
  expect(record.phaseId === phase.id, 'phase changed');
  expect(Number(record.generation) === Number(current.generation), 'generation changed');
  expect(record.sourceBaseCommit === current.sourceBaseCommit, 'source base commit changed');
  expect(record.baselineSha256 === current.baselineSha256, 'state baseline hash changed');
  expect(record.requiredChecksSha256 === prefixedHash(expectedChecks), 'required-check policy changed');
  expect(record.policySha256 === prefixedHash(expectedPolicy), 'work-interval policy changed');
  expect(record.baselineSha256 === hash(baselineCore(record)), 'baseline content hash cannot be reproduced');
  if (failures.length) {
    throw new SingularityFlowError(`Work-interval baseline integrity check failed for ${current.path}:\n- ${failures.join('\n- ')}`);
  }
  return {
    path: current.path,
    sha256: record.baselineSha256,
    verified: true,
    sourceBaseCommit: record.sourceBaseCommit
  };
}

export async function ensureWorkIntervalBaseline(root, config, workflow, {
  phaseId = workflow.currentPhase,
  itemDirectory,
  itemRelative,
  sourceBaseCommit = head(root)
} = {}) {
  if (!phaseId) return null;
  const phase = activePhase(workflow, phaseId);
  if (!phaseUsesWorkInterval(phase)) return null;
  const generation = generationFor(phase);
  workflow.workIntervals ??= { schemaVersion: SCHEMA_VERSION, current: null, history: [], escalations: [] };
  const existing = workflow.workIntervals.current;
  if (existing?.phaseId === phase.id && Number(existing.generation) === generation && existing.status === 'open') {
    return existing;
  }

  const relative = intervalRelative(itemRelative, phase.id, generation);
  const ordinal = (workflow.workIntervals.history?.length ?? 0) + 1;
  const intervalId = `INT-${phase.id}-G${generation}-${String(ordinal).padStart(3, '0')}`;
  const checks = requiredChecks(workflow);
  const policy = intervalPolicy(config, workflow, phase);
  const guards = policy.protectedPaths;
  const core = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'work-interval-baseline',
    intervalId,
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    railId: workflow.workItem.workType,
    phaseId: phase.id,
    generation,
    branch: branch(root),
    sourceBaseCommit,
    configurationSha256: workflow.resolution?.configSha256 ?? null,
    sourceSha256: workflow.resolution?.sourceSha256 ?? null,
    templateSha256: workflow.resolution?.templates?.[phase.id]?.sha256 ?? phase.templateSha256 ?? null,
    workflowSubjectRevision: workflowSubjectRevision(workflow, phase),
    protectedPaths: guards,
    requiredChecks: checks,
    requiredChecksSha256: prefixedHash(checks),
    policySha256: prefixedHash(policy),
    escalationLadderSha256: policy.reconciliation.escalationTarget
      ? prefixedHash([workflow.workItem.workType, policy.reconciliation.escalationTarget])
      : null,
    reconciliationPolicy: policy.reconciliation
  };
  const record = { ...core, baselineSha256: hash(core), createdAt: nowIso(), path: relative, status: 'open' };
  await writeJson(path.join(root, relative), record);
  workflow.workIntervals.current = {
    intervalId,
    phaseId: phase.id,
    generation,
    baselineSha256: record.baselineSha256,
    sourceBaseCommit,
    escalationTarget: policy.reconciliation.escalationTarget,
    path: relative,
    status: 'open'
  };
  workflow.workIntervals.history.push(structuredClone(workflow.workIntervals.current));
  workflow.history.push({
    at: record.createdAt,
    actor: 'system',
    agent: null,
    event: 'work_interval_started',
    phase: phase.id,
    detail: `baseline ${record.baselineSha256.slice(0, 12)} at ${sourceBaseCommit.slice(0, 12)}`
  });
  return workflow.workIntervals.current;
}

function applicationPath(candidate) {
  const normalized = posix(candidate);
  return normalized && normalized !== 'singularity' && !normalized.startsWith('singularity/') && !normalized.startsWith('.git/');
}

function splitNull(value) {
  return value.split('\0').map((item) => item.trim()).filter(Boolean);
}

function pathsSince(root, sourceBaseCommit) {
  const committed = run('git', ['diff', '--name-only', '-z', sourceBaseCommit, 'HEAD'], {
    cwd: root,
    allowFailure: true
  });
  if (committed.status !== 0) {
    throw new SingularityFlowError(`Work interval baseline commit ${sourceBaseCommit} is not available.`);
  }
  return [...new Set([...splitNull(committed.stdout), ...changedFiles(root)].filter(applicationPath))].sort();
}

async function fileEvidence(root, paths) {
  const entries = [];
  for (const relative of paths) {
    const absolute = path.join(root, relative);
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile()) {
        entries.push({ path: relative, status: stat.isSymbolicLink() ? 'symlink' : 'non-file', sha256: null, bytes: null });
        continue;
      }
      const bytes = await readFile(absolute);
      entries.push({ path: relative, status: 'present', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      entries.push({ path: relative, status: 'deleted', sha256: null, bytes: 0 });
    }
  }
  return entries;
}

async function plannedPaths(itemDirectory, workflow) {
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const claims = Object.assign({}, ...(records.planned ?? []).map((entry) => entry.claims ?? {}));
  const byPath = new Map();
  for (const [clauseId, claim] of Object.entries(claims)) {
    for (const candidate of [...(claim.expectedPaths ?? []), ...(claim.tests ?? [])]) {
      const normalized = posix(candidate);
      if (!byPath.has(normalized)) byPath.set(normalized, []);
      byPath.get(normalized).push(clauseId);
    }
  }
  return byPath;
}

function pathProtected(candidate, guards) {
  return guards.some((guard) => candidate === guard || candidate.startsWith(`${guard.replace(/\/$/, '')}/`));
}

export async function reconcileWorkInterval(root, config, workflow, {
  phaseId = workflow.currentPhase,
  itemDirectory,
  writeLocal = true,
  requireCleanTarget = false
} = {}) {
  const phase = activePhase(workflow, phaseId);
  const current = workflow.workIntervals?.current;
  if (!current || current.phaseId !== phase.id || current.status !== 'open') {
    throw new SingularityFlowError(`Phase '${phase.id}' has no open governed work interval.`);
  }
  const baseline = await verifyWorkIntervalBaseline(root, config, workflow, { phaseId: phase.id, itemDirectory });
  const paths = pathsSince(root, current.sourceBaseCommit);
  const evidence = await fileEvidence(root, paths);
  const planned = await plannedPaths(itemDirectory, workflow);
  const guards = protectedPaths(config, workflow);
  const findings = evidence.map((entry) => ({
    ...entry,
    verdict: planned.has(entry.path) ? 'planned' : 'unplanned',
    clauseIds: [...(planned.get(entry.path) ?? [])].sort(),
    protected: pathProtected(entry.path, guards)
  }));
  const changedPathLimit = Number(phase.approvalPolicy?.maximumChangedPaths ?? 5);
  const reasons = [];
  if (workflow.workItem.workType === 'quick-fix' && findings.length > changedPathLimit) {
    reasons.push(`${findings.length} changed paths exceed the quick-fix limit of ${changedPathLimit}`);
  }
  const protectedChanged = findings.filter((entry) => entry.protected).map((entry) => entry.path);
  if (workflow.workItem.workType === 'quick-fix' && protectedChanged.length) {
    reasons.push(`protected paths changed: ${protectedChanged.join(', ')}`);
  }
  const uncommittedApplicationPaths = changedFiles(root).filter(applicationPath);
  const dirtyTargetBlocked = requireCleanTarget && uncommittedApplicationPaths.length > 0;
  if (dirtyTargetBlocked) {
    reasons.push(`uncommitted application paths remain: ${uncommittedApplicationPaths.join(', ')}`);
  }
  const disposition = reasons.length
    ? (dirtyTargetBlocked ? 'blocked' : 'escalation-required')
    : findings.some((entry) => entry.verdict === 'unplanned') ? 'review' : 'aligned';
  const core = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'work-reconciliation',
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    intervalId: current.intervalId,
    phaseId: phase.id,
    generation: current.generation,
    baselineSha256: current.baselineSha256,
    baseline,
    sourceBaseCommit: current.sourceBaseCommit,
    target: {
      branch: branch(root),
      head: head(root),
      includesWorktree: !requireCleanTarget,
      cleanApplicationTree: uncommittedApplicationPaths.length === 0,
      uncommittedApplicationPaths
    },
    findings,
    summary: {
      changedPaths: findings.length,
      planned: findings.filter((entry) => entry.verdict === 'planned').length,
      unplanned: findings.filter((entry) => entry.verdict === 'unplanned').length,
      protected: protectedChanged.length
    },
    decision: {
      status: disposition,
      summaryStatus: reasons.length ? 'blocked' : findings.some((entry) => entry.verdict === 'unplanned') ? 'attention' : 'clear',
      eligibleForSubmission: reasons.length === 0,
      reasons,
      escalationTarget: reasons.length ? workflow.workIntervals?.current?.escalationTarget ?? (config.workTypes?.feature ? 'feature' : null) : null
    }
  };
  const report = { ...core, reconciliationSha256: hash(core), reconciledAt: nowIso() };
  if (writeLocal) {
    const local = path.join(gitDir(root), 'singularity-flow', 'reconciliations', workflow.workItem.id, `${report.reconciliationSha256}.json`);
    await writeJson(local, report);
    report.localPath = local;
  }
  return report;
}

export async function recordFinalReconciliation(root, workflow, report, { itemRelative } = {}) {
  const relative = posix(path.join(itemRelative, 'context', 'work-intervals', 'reconciliations', `${report.reconciliationSha256}.json`));
  const governed = { ...report, localPath: undefined, final: true, recordedAt: nowIso(), path: relative };
  delete governed.localPath;
  await writeJson(path.join(root, relative), governed);
  workflow.workIntervals.current = {
    ...workflow.workIntervals.current,
    status: 'reconciled',
    finalReconciliation: {
      reconciliationSha256: report.reconciliationSha256,
      path: relative,
      targetHead: report.target.head,
      recordedAt: governed.recordedAt
    }
  };
  workflow.history.push({
    at: governed.recordedAt,
    actor: 'system',
    agent: null,
    event: 'work_interval_reconciled',
    phase: report.phaseId,
    detail: `${report.decision.status}; ${report.summary.changedPaths} changed path(s)`
  });
  return governed;
}

export function closeWorkInterval(workflow, {
  phaseId,
  at = nowIso(),
  actor = 'system',
  agent = null
} = {}) {
  const current = workflow.workIntervals?.current;
  if (!current || current.phaseId !== phaseId || !['open', 'reconciled'].includes(current.status)) return null;
  current.status = 'closed';
  current.closedAt = at;
  workflow.history.push({
    at,
    actor,
    agent,
    event: 'work_interval_closed',
    phase: phaseId,
    detail: `interval ${current.intervalId} closed after phase approval`
  });
  return current;
}

export async function createLocalCheckpoint(root, workflow, { name = null, note = null } = {}) {
  const current = workflow.workIntervals?.current;
  if (!current || current.status !== 'open') throw new SingularityFlowError('The current Story phase has no open governed work interval.');
  const paths = pathsSince(root, current.sourceBaseCommit);
  const evidence = await fileEvidence(root, paths);
  const core = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'work-checkpoint',
    intervalId: current.intervalId,
    durability: 'local',
    workId: workflow.workItem.id,
    phaseId: current.phaseId,
    generation: current.generation,
    baselineSha256: current.baselineSha256,
    branch: branch(root),
    head: head(root),
    hasUncommittedBytes: changedFiles(root).filter(applicationPath).length > 0,
    durabilityNotice: 'This checkpoint stores fingerprints only. Uncommitted source bytes are not remotely durable.',
    name: name?.trim() || null,
    note: note?.trim() || null,
    files: evidence
  };
  const checkpointSha256 = hash(core);
  const checkpoint = {
    ...core,
    checkpointId: `CHK-${checkpointSha256.slice(0, 12)}`,
    checkpointSha256,
    createdAt: nowIso()
  };
  const target = path.join(gitDir(root), 'singularity-flow', 'checkpoints', workflow.workItem.id, `${checkpoint.checkpointSha256}.json`);
  await writeJson(target, checkpoint);
  return { ...checkpoint, path: target };
}

export function escalationPlan(config, workflow, { target = null } = {}) {
  const current = workflow.workIntervals?.current;
  if (!current) throw new SingularityFlowError('This Story has no governed work interval to escalate.');
  const requested = target ?? (config.workTypes?.feature ? 'feature' : null);
  if (!requested || !config.workTypes?.[requested]) {
    throw new SingularityFlowError(`No escalation workflow '${requested ?? ''}' is configured.`);
  }
  const core = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'work-rail-escalation-plan',
    workId: workflow.workItem.id,
    fromWorkType: workflow.workItem.workType,
    toWorkType: requested,
    branch: workflow.lineage?.canonicalBranch ?? workflow.workItem.branch,
    baselineSha256: current.baselineSha256,
    preserves: ['branch history', 'source changes', 'local checkpoints', 'governed artifacts'],
    action: 'start a new governed Story on the same source branch using the stronger workflow; the current immutable work type is not rewritten'
  };
  return { ...core, planSha256: hash(core) };
}
