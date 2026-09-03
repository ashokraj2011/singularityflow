import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access, lstat, mkdir, open, readFile, readdir, rm, stat, statfs
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertCredentialFreeRemote, frozenRemoteTransport, probeGitRemote, redactDiagnosticText,
  remoteFingerprint, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { workspaceRegistryFile } from './workspace-context.mjs';
import {
  atomicJson, createWorkspaceConfiguration, previewWorkspaceConfiguration, readWorkspace,
  rememberWorkspace, validateWorkspaceCapabilityRegistration, workspaceRepositoryPath,
  workspaceStatus
} from './workspace.mjs';
import { gitWorkerCount, mapLimit, run, SingularityFlowError } from './util.mjs';
import { GitRemoteSession, runRemoteGitAsync } from './git-execution.mjs';
import {
  enterpriseGitEnvironment, withoutGitProcessOverrides
} from './git-enterprise-environment.mjs';
import { healerReceipt } from './workspace-healers.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

export const WORKSPACE_BOOTSTRAP_SCHEMA_VERSION = currentSchemaVersion('workspace-bootstrap');
export const WORKSPACE_BOOTSTRAP_STATUSES = Object.freeze([
  'planned', 'preflighting', 'waiting-user', 'materializing', 'verifying', 'initializing',
  'ready', 'degraded', 'failed', 'abandoned'
]);
const TERMINAL = new Set(['ready', 'abandoned']);
const ACTIVE = new Set(WORKSPACE_BOOTSTRAP_STATUSES.filter((status) => !TERMINAL.has(status)));
const MIN_DISK_BYTES = 1024 * 1024 * 1024;
const LEASE_STALE_MS = 5 * 60 * 1000;
const PREFLIGHT_RECEIPT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_OPERATION_BUDGETS = Object.freeze({
  preflight: Object.freeze({ used: 0, maximum: 3 }),
  materialize: Object.freeze({ used: 0, maximum: 2 }),
  initialize: Object.freeze({ used: 0, maximum: 1 })
});
const liveBootstrapCapabilityValidations = new Map();

function rememberLiveCapabilityValidation(bootstrapId, planHash, validation) {
  if (!validation || typeof validation !== 'object') return;
  const key = `${bootstrapId}:${planHash}`;
  liveBootstrapCapabilityValidations.set(key, validation);
  while (liveBootstrapCapabilityValidations.size > 64) {
    liveBootstrapCapabilityValidations.delete(liveBootstrapCapabilityValidations.keys().next().value);
  }
}

function takeLiveCapabilityValidation(bootstrapId, planHash) {
  const key = `${bootstrapId}:${planHash}`;
  const validation = liveBootstrapCapabilityValidations.get(key) ?? null;
  liveBootstrapCapabilityValidations.delete(key);
  return validation;
}

function nowIso() { return new Date().toISOString(); }

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function integrityFor(record) {
  const copy = structuredClone(record);
  delete copy.integrity;
  return createHash('sha256').update(canonical(copy)).digest('hex');
}

function planHashFor(plan) {
  const projection = {
    workspace: {
      id: plan.workspace.id,
      targetPath: path.resolve(plan.workspace.targetPath),
      leadRepository: plan.workspace.leadRepository,
      capabilities: [...(plan.workspace.capabilities ?? [])].sort()
    },
    capabilityAuthority: plan.createInput?.capabilityAuthority ? {
      remote: sanitizeRemote(plan.createInput.capabilityAuthority.url),
      branch: plan.createInput.capabilityAuthority.branch ?? 'sflow/config'
    } : null,
    repositories: plan.repositories.map((repository) => ({
      id: repository.id,
      remote: sanitizeRemote(repository.remote),
      remoteFingerprint: repository.remoteFingerprint,
      defaultBranch: repository.defaultBranch,
      required: repository.required,
      targetPath: path.resolve(repository.targetPath),
      clone: repository.clone,
      capabilities: [...(plan.createInput.repositories?.[repository.id]?.capabilities ?? [])].sort()
    })),
    initialization: plan.initialization
  };
  return `sha256:${createHash('sha256').update(canonical(projection)).digest('hex')}`;
}

function withIntegrity(record) {
  return {
    ...record,
    integrity: { algorithm: 'sha256', sha256: integrityFor(record) }
  };
}

function verifyIntegrity(record, file) {
  if (record?.integrity?.algorithm !== 'sha256' || record.integrity.sha256 !== integrityFor(record)) {
    throw new SingularityFlowError(`Workspace bootstrap record failed its integrity check: ${file}`, {
      code: 'BOOTSTRAP_INTEGRITY_INVALID', details: { file }
    });
  }
  return record;
}

export function workspaceBootstrapRoot(env = process.env, home = os.homedir()) {
  const configured = env.SINGULARITY_FLOW_BOOTSTRAP_STATE;
  const root = path.resolve(configured || path.join(path.dirname(workspaceRegistryFile(env, home)), 'bootstrap'));
  if (root === path.parse(root).root) {
    throw new SingularityFlowError('The workspace bootstrap state directory cannot be a filesystem root.', {
      code: 'BOOTSTRAP_STATE_PATH_UNSAFE'
    });
  }
  return root;
}

function sessionPath(root, bootstrapId) {
  const id = String(bootstrapId ?? '').trim();
  if (!/^bst_[a-f0-9-]{20,64}$/.test(id)) {
    throw new SingularityFlowError(`Invalid workspace bootstrap ID '${id}'.`, { code: 'BOOTSTRAP_ID_INVALID' });
  }
  return path.join(root, 'sessions', `${id}.json`);
}

function indexPath(root) { return path.join(root, 'index.json'); }
function leasePath(root, bootstrapId) { return path.join(root, 'leases', `${bootstrapId}.lock`); }

async function assertStateRoot(root) {
  const existing = await lstat(root).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new SingularityFlowError(`Workspace bootstrap state cannot be a symbolic link: ${root}`, {
      code: 'BOOTSTRAP_STATE_SYMLINK'
    });
  }
  await mkdir(path.join(root, 'sessions'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, 'leases'), { recursive: true, mode: 0o700 });
}

function summary(session) {
  return {
    bootstrapId: session.bootstrapId,
    status: session.status,
    workspaceId: session.plan?.workspace?.id ?? session.request?.workspaceId ?? null,
    workspaceName: session.plan?.workspace?.name ?? session.request?.workspaceName ?? null,
    targetPath: session.plan?.workspace?.targetPath ?? null,
    updatedAt: session.updatedAt,
    nextAction: session.nextAction,
    recoveryActions: session.recoveryActions ?? [],
    blocking: session.preflight?.findings?.filter((finding) => finding.severity === 'blocker').length ?? 0
  };
}

async function writeIndex(root, session) {
  let current = [];
  try {
    const parsed = readRecord('workspace-bootstrap-index', await readFile(indexPath(root))).record;
    if (Array.isArray(parsed.sessions)) current = parsed.sessions;
  } catch { /* A missing index is rebuilt from the record being written. */ }
  const sessions = [summary(session), ...current.filter((entry) => entry.bootstrapId !== session.bootstrapId)]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 100);
  await atomicJson(indexPath(root), { schemaVersion: currentSchemaVersion('workspace-bootstrap-index'), updatedAt: nowIso(), sessions });
}

async function writeSession(root, record) {
  const session = withIntegrity({ ...record, updatedAt: nowIso() });
  await atomicJson(sessionPath(root, session.bootstrapId), session);
  await writeIndex(root, session);
  return session;
}

export async function readWorkspaceBootstrap(bootstrapId, {
  env = process.env, home = os.homedir()
} = {}) {
  const root = workspaceBootstrapRoot(env, home);
  const file = sessionPath(root, bootstrapId);
  let record;
  try { record = readRecord('workspace-bootstrap', await readFile(file)).record; }
  catch (error) {
    if (error?.code === 'ENOENT') {
      throw new SingularityFlowError(`Workspace bootstrap '${bootstrapId}' was not found.`, {
        code: 'BOOTSTRAP_NOT_FOUND', details: { bootstrapId }
      });
    }
    throw new SingularityFlowError(`Cannot read workspace bootstrap '${bootstrapId}': ${error.message}`, {
      code: 'BOOTSTRAP_RECORD_INVALID'
    });
  }
  return verifyIntegrity(record, file);
}

export async function listWorkspaceBootstraps({
  env = process.env, home = os.homedir(), includeTerminal = true
} = {}) {
  const root = workspaceBootstrapRoot(env, home);
  const directory = path.join(root, 'sessions');
  const files = await readdir(directory).catch(() => []);
  const records = [];
  for (const file of files.filter((name) => /^bst_[a-f0-9-]{20,64}\.json$/.test(name))) {
    try {
      const parsed = readRecord('workspace-bootstrap', await readFile(path.join(directory, file))).record;
      records.push(verifyIntegrity(parsed, path.join(directory, file)));
    } catch (error) {
      if (String(error?.code ?? '').startsWith('SCHEMA_')) throw error;
      // A corrupt record is not omitted by doctor, which scans the directory separately. The normal
      // list remains usable so one broken receipt cannot hide every healthy recovery.
    }
  }
  return records
    .filter((record) => includeTerminal || ACTIVE.has(record.status))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export async function latestWorkspaceBootstrap(options = {}) {
  return (await listWorkspaceBootstraps({ ...options, includeTerminal: false }))[0] ?? null;
}

async function acquireLease(root, bootstrapId, { recoveredStale = false } = {}) {
  await assertStateRoot(root);
  const file = leasePath(root, bootstrapId);
  try {
    const handle = await open(file, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: nowIso() })}\n`);
    return {
      recoveredStale,
      release: async () => { await handle.close(); await rm(file, { force: true }); }
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const info = await stat(file).catch(() => null);
    if (info && Date.now() - info.mtimeMs > LEASE_STALE_MS) {
      await rm(file, { force: true });
      return acquireLease(root, bootstrapId, { recoveredStale: true });
    }
    throw new SingularityFlowError(`Workspace bootstrap '${bootstrapId}' is already being changed by another process.`, {
      code: 'BOOTSTRAP_LEASE_BUSY', details: { bootstrapId }
    });
  }
}

async function withLease(root, bootstrapId, operation) {
  const lease = await acquireLease(root, bootstrapId);
  try {
    if (lease.recoveredStale) {
      const file = sessionPath(root, bootstrapId);
      const current = verifyIntegrity(JSON.parse(await readFile(file, 'utf8')), file);
      const repairedAt = nowIso();
      await writeSession(root, {
        ...current,
        status: 'waiting-user',
        revision: Number(current.revision ?? 0) + 1,
        healers: [...(current.healers ?? []), healerReceipt('expired-bootstrap-lease', {
          appliedAt: repairedAt,
          effects: ['removed-expired-machine-local-lease'],
          postconditions: [{ id: 'bootstrap-lease-acquired', status: 'pass' }],
          proof: { bootstrapId, expiredLeaseRemoved: true }
        })],
        nextAction: current.nextAction ?? {
          command: `singularity-flow workspace bootstrap status ${bootstrapId}`,
          skill: `/sf-workspace-bootstrap ${bootstrapId}`
        }
      });
    }
    return await operation({ recoveredStaleLease: lease.recoveredStale });
  } finally { await lease.release(); }
}

function operationBudgets(session) {
  const stored = session.operationBudgets ?? {};
  return Object.fromEntries(Object.entries(DEFAULT_OPERATION_BUDGETS).map(([name, defaults]) => [name, {
    used: Number(stored[name]?.used ?? defaults.used),
    maximum: Number(stored[name]?.maximum ?? defaults.maximum)
  }]));
}

function consumeBudget(session, operation) {
  const budgets = operationBudgets(session);
  const budget = budgets[operation];
  if (!budget) throw new SingularityFlowError(`Unknown bootstrap attempt budget '${operation}'.`, {
    code: 'BOOTSTRAP_BUDGET_UNKNOWN'
  });
  if (budget.used >= budget.maximum) {
    throw new SingularityFlowError(
      `Workspace bootstrap '${session.bootstrapId}' exhausted its ${operation} attempt budget (${budget.maximum}). `
      + 'Inspect the recorded fault and prepare a new plan generation after correcting the input.',
      {
        code: 'BOOTSTRAP_ATTEMPT_BUDGET_EXHAUSTED',
        details: { bootstrapId: session.bootstrapId, operation, ...budget }
      }
    );
  }
  budgets[operation] = { ...budget, used: budget.used + 1 };
  return budgets;
}

function safeFailureMessage(error) {
  return redactDiagnosticText(error?.message ?? error ?? 'Unknown bootstrap failure').slice(0, 1_000);
}

function bootstrapStatusAction(bootstrapId) {
  return {
    id: 'inspect', label: 'Inspect preserved setup',
    command: `singularity-flow workspace bootstrap status ${bootstrapId} --json`,
    skill: `/sf-workspace-bootstrap ${bootstrapId}`
  };
}

function bootstrapResumeAction(session) {
  return {
    id: 'resume', label: 'Recheck and resume the same plan',
    command: `singularity-flow workspace bootstrap resume ${session.bootstrapId} --confirm ${session.plan.workspace.confirmation} --json`,
    skill: `/sf-workspace-bootstrap ${session.bootstrapId}`
  };
}

function bootstrapRetryAction(session) {
  return {
    id: 'renew-attempts', label: 'Authorize another bounded recovery generation',
    command: `singularity-flow workspace bootstrap retry ${session.bootstrapId} --confirm ${session.plan.workspace.confirmation} --reason "corrected the reported blocker" --json`,
    skill: `/sf-workspace-bootstrap ${session.bootstrapId}`
  };
}

function bootstrapRecoveryActions(session, blockers = []) {
  const inspect = bootstrapStatusAction(session.bootstrapId);
  const resume = bootstrapResumeAction(session);
  if (!blockers.length) return [resume, inspect];
  return [
    ...(blockers.some((entry) => entry.retryable) ? [resume] : []),
    ...blockers.map((entry) => ({
      id: `resolve:${entry.id}`,
      label: entry.retryable ? 'Correct blocker and retry' : 'Correct input and prepare replacement',
      finding: entry.id,
      instruction: entry.action,
      command: entry.retryable ? resume.command : inspect.command,
      skill: `/sf-workspace-bootstrap ${session.bootstrapId}`
    })),
    inspect
  ];
}

function uniqueFaults(current, additions) {
  const existing = new Set((current ?? []).map((fault) => fault.faultKey));
  return [...(current ?? []), ...additions.filter((fault) => !existing.has(fault.faultKey))];
}

function bootstrapFault({
  bootstrapId, operationFamily, stage, attempt, inputHash, classification,
  scope = 'workspace-bootstrap', repository = null, retryable = false,
  summary, evidence = null, stepId = null, createdPaths = []
}) {
  const faultKey = createHash('sha256').update(canonical({
    bootstrapId, operationFamily, stage, inputHash, classification, repository
  })).digest('hex');
  return {
    schemaVersion: 1,
    faultKey,
    scope: { kind: scope, bootstrapId, repositoryId: repository },
    bootstrapId,
    stepId,
    operationFamily,
    stage,
    attempt,
    inputHash,
    platform: { os: process.platform, architecture: process.arch, node: process.versions.node },
    commandIdentity: null,
    exitCode: evidence?.exitCode ?? null,
    signal: evidence?.signal ?? null,
    classification,
    retryable: retryable === true,
    summary: redactDiagnosticText(summary).slice(0, 1_000),
    createdPaths: [...createdPaths],
    evidence,
    occurredAt: nowIso()
  };
}

function beginStep(steps, { operationId, attempt, inputHash }) {
  const step = {
    stepId: `step_${randomUUID()}`,
    operationId,
    attempt,
    inputHash,
    startedAt: nowIso(),
    completedAt: null,
    observedPostcondition: null,
    result: 'running',
    errorReference: null,
    nextAction: null
  };
  return { step, steps: [...(steps ?? []), step] };
}

function finishStep(steps, stepId, update) {
  return (steps ?? []).map((step) => step.stepId === stepId
    ? { ...step, completedAt: nowIso(), ...update }
    : step);
}

function normalizeCreateInput(input) {
  const preview = previewWorkspaceConfiguration(input);
  const repositories = Object.fromEntries(Object.entries(preview.manifest.repositories).map(([id, repository]) => {
    const url = String(repository.url).trim();
    // This also rejects credential-bearing HTTP(S) URLs before the durable plan is written.
    probeCredentialFree(url);
    return [id, {
      url,
      defaultBranch: repository.defaultBranch,
      required: repository.required,
      path: repository.path,
      clone: repository.clone,
      metadata: repository.metadata,
      jira: repository.jira,
      capabilities: repository.capabilities
    }];
  }));
  return {
    createInput: {
      baseDirectory: path.resolve(input.baseDirectory),
      // `previewWorkspaceConfiguration` derives the persisted workspace ID from this local anchor
      // key. Feeding its derived ID back through the function would prefix `local--` again on every
      // resume (`demo` -> `local--demo` -> `local--local--demo`).
      id: preview.manifest.anchor.key,
      name: preview.manifest.name,
      repositories,
      leadRepository: preview.manifest.leadRepository,
      capabilityAuthority: preview.manifest.capabilityAuthority,
      capabilities: preview.manifest.capabilities
    },
    preview
  };
}

function probeCredentialFree(url) {
  // Use the same validation as the real probe without dialing the network.
  assertCredentialFreeRemote(url);
}

function planFromInput(input, { initialize = false, stateBranch = 'state', inferDefaultRepositories = [] } = {}) {
  const { createInput, preview } = normalizeCreateInput(input);
  return {
    workspace: {
      id: preview.manifest.id,
      confirmation: preview.manifest.anchor.key,
      name: preview.manifest.name,
      targetPath: preview.root,
      leadRepository: preview.manifest.leadRepository,
      capabilities: preview.manifest.capabilities
    },
    repositories: preview.operations.map((operation) => ({
      id: operation.repository,
      remote: sanitizeRemote(operation.url),
      remoteFingerprint: remoteFingerprint(operation.url),
      defaultBranch: operation.branch,
      required: operation.required,
      targetPath: operation.target,
      clone: operation.clone
    })),
    createInput,
    inferDefaultRepositories: [...new Set(inferDefaultRepositories)],
    initialization: { enabled: initialize === true, stateBranch: String(stateBranch || 'state') }
  };
}

export async function prepareWorkspaceBootstrap({
  source,
  createInput,
  initialize = false,
  stateBranch = 'state',
  inferDefaultRepositories = []
}, { env = process.env, home = os.homedir(), runCommand = run } = {}) {
  const root = workspaceBootstrapRoot(env, home);
  await assertStateRoot(root);
  const plan = planFromInput(createInput, { initialize, stateBranch, inferDefaultRepositories });
  const bootstrapId = `bst_${randomUUID()}`;
  const createdAt = nowIso();
  const record = await writeSession(root, {
    schemaVersion: WORKSPACE_BOOTSTRAP_SCHEMA_VERSION,
    bootstrapId,
    status: 'planned',
    revision: 0,
    createdAt,
    requestedAt: createdAt,
    scope: {
      kind: 'workspace-bootstrap',
      workspaceId: plan.workspace.id,
      repositoryId: null,
      storyId: null
    },
    request: {
      source: String(source?.kind ?? 'generated'),
      reference: source?.reference ? sanitizeRemote(source.reference) : null,
      referenceFingerprint: source?.reference ? remoteFingerprint(source.reference) : null,
      workspaceId: plan.workspace.confirmation,
      workspaceName: plan.workspace.name
    },
    plan,
    planHash: planHashFor(plan),
    preflight: null,
    steps: [],
    faults: [],
    createdPaths: [],
    attemptBudget: { used: 0, maximum: 3 },
    operationBudgets: structuredClone(DEFAULT_OPERATION_BUDGETS),
    attempts: [],
    healers: [],
    workspaceJournal: null,
    result: null,
    fault: null,
    nextAction: { command: `singularity-flow workspace bootstrap resume ${bootstrapId} --confirm ${plan.workspace.confirmation} --json`, skill: `/sf-workspace-bootstrap ${bootstrapId}` },
    recoveryActions: [
      {
        id: 'resume', label: 'Preflight and materialize the reviewed plan',
        command: `singularity-flow workspace bootstrap resume ${bootstrapId} --confirm ${plan.workspace.confirmation} --json`,
        skill: `/sf-workspace-bootstrap ${bootstrapId}`
      },
      bootstrapStatusAction(bootstrapId)
    ]
  });
  return preflightWorkspaceBootstrap(record.bootstrapId, { env, home, runCommand });
}

function finding({
  id, scope, severity = 'blocker', classification, message, action, retryable = false,
  repository = null, evidence = null
}) {
  return { id, scope, severity, classification, message, action, retryable, repository, evidence };
}

const WINDOWS_RESERVED_PATH = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Pure platform-path checks so native behavior is testable without pretending another OS. */
export function portableWorkspacePathFindings(target, { platform = process.platform } = {}) {
  const value = String(target ?? '');
  const findings = [];
  if (platform !== 'win32') return findings;
  const segments = value.replace(/^[A-Za-z]:/, '').split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    if (WINDOWS_RESERVED_PATH.test(segment)) findings.push(finding({
      id: 'machine.path.reserved-device', scope: 'workspace', classification: 'platform-path-invalid',
      message: `The planned Windows workspace path contains reserved device name '${segment}'.`,
      action: 'Choose a workspace ID and base directory without Windows reserved device names.'
    }));
    if (/[. ]$/.test(segment)) findings.push(finding({
      id: 'machine.path.trailing-character', scope: 'workspace', classification: 'platform-path-invalid',
      message: `The planned Windows workspace path contains a segment ending in a dot or space: '${segment}'.`,
      action: 'Choose a workspace ID and base directory whose path segments do not end in dots or spaces.'
    }));
  }
  if (value.length > 220) findings.push(finding({
    id: 'machine.path.long', scope: 'workspace', severity: 'warning', classification: 'platform-path-risk',
    message: `The planned Windows workspace path is ${value.length} characters long.`,
    action: 'Prefer a shorter workspace base to avoid tool-specific path limits.'
  }));
  return findings;
}

const ENTERPRISE_GIT_CONFIG_PATTERN = String.raw`^(http(\..+)?\.(proxy|proxyauthmethod|sslcainfo|sslcapath|sslbackend|schannelusesslcainfo)|credential(\..+)?\.(helper|usehttppath))$`;

function enterpriseGitConfigSources(runCommand, env) {
  const sources = {
    proxy: [], certificateAuthority: [], tlsBackend: [], credentialHelper: []
  };
  for (const scope of ['system', 'global']) {
    // `--name-only` is deliberate: proxy credentials, CA paths, helper commands, usernames and
    // provider URLs must never enter the diagnostics result or an error. One bounded query per
    // scope covers both unscoped and URL-scoped forms without an N-key subprocess loop.
    const result = runCommand('git', [
      'config', `--${scope}`, '--includes', '--name-only', '--get-regexp',
      ENTERPRISE_GIT_CONFIG_PATTERN
    ], { env, allowFailure: true, timeoutMs: 10_000, maxBuffer: 256 * 1024 });
    if (result.status !== 0) continue;
    const keys = String(result.stdout ?? '').split(/\r?\n/)
      .map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    const source = (category) => `git-${scope}:${category}`;
    if (keys.some((key) => /\.(?:proxy|proxyauthmethod)$/.test(key))) {
      sources.proxy.push(source('http-proxy'));
    }
    if (keys.some((key) => /\.(?:sslcainfo|sslcapath|schannelusesslcainfo)$/.test(key))) {
      sources.certificateAuthority.push(source('certificate-authority'));
    }
    if (keys.some((key) => /\.sslbackend$/.test(key))) {
      sources.tlsBackend.push(source('tls-backend'));
    }
    if (keys.some((key) => /^credential\..*\.(?:helper|usehttppath)$/.test(key)
      || /^credential\.(?:helper|usehttppath)$/.test(key))) {
      sources.credentialHelper.push(source('credential-helper'));
    }
  }
  return sources;
}

/** Report only configuration sources, never proxy URLs, certificate paths, or credentials. */
export function enterpriseGitDiagnostics({ env = process.env, runCommand = run } = {}) {
  const configured = enterpriseGitConfigSources(runCommand, env);
  const proxySources = [
    ...[
      'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'
    ].filter((name) => Boolean(env[name])),
    ...configured.proxy
  ];
  const proxyBypassSources = ['NO_PROXY', 'no_proxy'].filter((name) => Boolean(env[name]));
  const caSources = [
    ...[
      'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
      'NODE_EXTRA_CA_CERTS'
    ].filter((name) => Boolean(env[name])),
    ...configured.certificateAuthority
  ];
  return {
    proxy: { configured: proxySources.length > 0, sources: proxySources },
    proxyBypass: {
      configured: proxyBypassSources.length > 0,
      sources: proxyBypassSources
    },
    certificateAuthority: { configured: caSources.length > 0, sources: caSources },
    tlsBackend: {
      configured: configured.tlsBackend.length > 0,
      sources: configured.tlsBackend
    },
    credentialHelper: {
      configured: configured.credentialHelper.length > 0,
      sources: configured.credentialHelper
    },
    credentialOwnership: 'git-or-operating-system',
    guidance: 'Use organisation-approved Git, proxy, and certificate configuration. Singularity Flow never disables TLS or stores credentials.'
  };
}

async function nearestExisting(target) {
  let current = path.resolve(target);
  while (!(await lstat(current).catch(() => null))) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

async function probeWritableDirectory(directory) {
  const probe = path.join(directory, `.sflow-write-probe-${process.pid}-${randomUUID()}`);
  let handle = null;
  try {
    handle = await open(probe, 'wx', 0o600);
    await handle.writeFile('workspace bootstrap writability probe\n');
    await handle.sync();
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
    await rm(probe, { force: true }).catch(() => {});
  }
}

async function machinePreflight(plan, { env = process.env, home = os.homedir(), runCommand = run } = {}) {
  const checks = [];
  const findings = [];
  const supportedPlatform = ['darwin', 'linux', 'win32'].includes(process.platform);
  checks.push({
    id: 'platform', status: supportedPlatform ? 'pass' : 'fail',
    observed: { platform: process.platform, architecture: process.arch }
  });
  if (!supportedPlatform) findings.push(finding({
    id: 'machine.platform.unsupported', scope: 'machine', classification: 'platform-unsupported',
    message: `The ${process.platform}/${process.arch} runtime is not in the supported workspace bootstrap platform set.`,
    action: 'Use the packaged macOS, Linux, or Windows build, then resume.'
  }));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ id: 'node-runtime', status: nodeMajor >= 20 ? 'pass' : 'fail', observed: process.versions.node, required: '>=20' });
  if (nodeMajor < 20) findings.push(finding({
    id: 'machine.node.unsupported', scope: 'machine', classification: 'runtime-unsupported',
    message: `Node.js ${process.versions.node} is installed; Singularity Flow requires Node.js 20 or newer.`,
    action: 'Install an approved Node.js 20+ runtime, then resume this bootstrap.'
  }));

  const git = runCommand('git', ['--version'], { allowFailure: true, timeoutMs: 10_000 });
  const gitVersion = String(git.stdout ?? '').match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;
  const gitSupported = git.status === 0 && gitVersion && (gitVersion[0] > 2 || (gitVersion[0] === 2 && gitVersion[1] >= 25));
  checks.push({
    id: 'git-runtime', status: gitSupported ? 'pass' : 'fail',
    observed: git.status === 0 ? String(git.stdout).trim() : null, required: '>=2.25'
  });
  if (!gitSupported) findings.push(finding({
    id: 'machine.git.unavailable', scope: 'machine', classification: 'git-unavailable',
    message: git.status === 0
      ? `The installed ${String(git.stdout).trim()} is older than the supported Git 2.25 minimum.`
      : 'Git is not available to create the planned repository checkouts.',
    action: 'Install an approved Git 2.25+ runtime and ensure it is on PATH, then resume.'
  }));

  const identityName = String(runCommand('git', ['config', '--get', 'user.name'], { allowFailure: true }).stdout ?? '').trim();
  const identityEmail = String(runCommand('git', ['config', '--get', 'user.email'], { allowFailure: true }).stdout ?? '').trim();
  const identityRequired = plan.initialization.enabled;
  checks.push({
    id: 'git-identity', status: identityName && identityEmail ? 'pass' : (identityRequired ? 'fail' : 'warn'),
    observed: identityName && identityEmail ? 'configured' : 'incomplete', required: identityRequired
  });
  if ((!identityName || !identityEmail) && identityRequired) findings.push(finding({
    id: 'machine.git.identity-missing', scope: 'machine', classification: 'identity-required',
    message: 'The planned repository initialization needs both Git user.name and user.email.',
    action: 'Configure the contributor Git identity, then resume.'
  }));

  const target = path.resolve(plan.workspace.targetPath);
  const ancestor = await nearestExisting(path.dirname(target));
  const ancestorInfo = await lstat(ancestor).catch(() => null);
  let writable = false;
  if (ancestorInfo?.isDirectory() && !ancestorInfo.isSymbolicLink()) {
    writable = await access(ancestor, fsConstants.W_OK).then(() => true).catch(() => false)
      && await probeWritableDirectory(ancestor);
  }
  checks.push({ id: 'workspace-base', status: writable ? 'pass' : 'fail', observed: ancestor });
  if (!writable) findings.push(finding({
    id: 'machine.workspace-base.unwritable', scope: 'workspace', classification: 'path-unwritable',
    message: `The nearest existing workspace parent is not a writable regular directory: ${ancestor}`,
    action: 'Choose a writable workspace base directory, or correct its permissions, then prepare a new session.'
  }));

  const targetInfo = await lstat(target).catch(() => null);
  if (targetInfo) {
    let resumable = false;
    if (targetInfo.isDirectory() && !targetInfo.isSymbolicLink()) {
      const workspace = await readWorkspace(target).catch(() => null);
      resumable = workspace?.id === plan.workspace.id;
    }
    checks.push({ id: 'workspace-target', status: resumable ? 'pass' : 'fail', observed: resumable ? 'matching-workspace' : 'occupied' });
    if (!resumable) findings.push(finding({
      id: 'workspace.target.occupied', scope: 'workspace', classification: 'target-occupied',
      message: `The planned workspace target is already occupied and is not the matching managed workspace: ${target}`,
      action: 'Choose a different workspace ID or base directory. Existing files will not be adopted automatically.'
    }));
  } else {
    checks.push({ id: 'workspace-target', status: 'pass', observed: 'absent' });
  }

  let availableBytes = null;
  try {
    const disk = await statfs(ancestor);
    availableBytes = Number(disk.bavail) * Number(disk.bsize);
  } catch { /* Some network filesystems do not expose statfs; disclose unknown rather than fail. */ }
  const floor = Number(env.SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES ?? MIN_DISK_BYTES);
  checks.push({
    id: 'disk-space', status: availableBytes == null ? 'warn' : (availableBytes >= floor ? 'pass' : 'fail'),
    observedBytes: availableBytes, requiredBytes: floor
  });
  if (availableBytes != null && availableBytes < floor) findings.push(finding({
    id: 'machine.disk.insufficient', scope: 'machine', classification: 'disk-insufficient',
    message: `The workspace volume has ${availableBytes} bytes available; the configured safety floor is ${floor}.`,
    action: 'Free disk space or choose another workspace base, then resume.'
  }));

  const registry = workspaceRegistryFile(env, home);
  const registryAncestor = await nearestExisting(path.dirname(registry));
  const registryWritable = await access(registryAncestor, fsConstants.W_OK).then(() => true).catch(() => false)
    && await probeWritableDirectory(registryAncestor);
  checks.push({ id: 'workspace-registry', status: registryWritable ? 'pass' : 'fail', observed: registry });
  if (!registryWritable) findings.push(finding({
    id: 'machine.registry.unwritable', scope: 'machine', classification: 'registry-unwritable',
    message: `The machine workspace registry cannot be updated atomically at ${registry}.`,
    action: 'Correct the registry path or permissions, then resume.'
  }));

  findings.push(...portableWorkspacePathFindings(target));
  checks.push({
    id: 'path-portability',
    status: findings.some((entry) => entry.id.startsWith('machine.path.') && entry.severity === 'blocker') ? 'fail'
      : findings.some((entry) => entry.id.startsWith('machine.path.')) ? 'warn' : 'pass',
    observed: { platform: process.platform, characters: target.length }
  });
  return { checks, findings };
}

function rebuiltPlan(plan, branchUpdates) {
  if (!branchUpdates.size) return plan;
  const input = structuredClone(plan.createInput);
  for (const [repositoryId, branch] of branchUpdates) input.repositories[repositoryId].defaultBranch = branch;
  return planFromInput(input, {
    initialize: plan.initialization.enabled,
    stateBranch: plan.initialization.stateBranch,
    inferDefaultRepositories: []
  });
}

async function asynchronousRemoteProbe(remote, {
  branch = null, env = process.env, session = new GitRemoteSession({ env })
} = {}) {
  const url = assertCredentialFreeRemote(remote);
  const observed = await session.observeAsync(url, { includeHead: true, includeAllHeads: true });
  const branches = observed.branches;
  const defaultBranch = observed.defaultBranch;
  const base = {
    remote: sanitizeRemote(url), remoteFingerprint: remoteFingerprint(url),
    defaultBranch, branches
  };
  if (!observed.ok) return { ...base, ok: false, failure: observed.failure };
  if (branch && !branches.includes(branch)) {
    return {
      ...base, ok: false,
      failure: {
        classification: 'branch-not-found', code: 'REMOTE_BRANCH_NOT_FOUND',
        retryable: false, branch,
        advice: `Create or select a branch that exists on '${sanitizeRemote(url)}', then retry.`
      }
    };
  }
  return { ...base, ok: true, failure: null };
}

async function remotePreflight(plan, { env = process.env, runCommand = run } = {}) {
  const checks = [];
  const findings = [];
  const branchUpdates = new Map();
  let liveCapabilityValidation = null;
  // One operation-scoped observation cache lets duplicate repository URLs and the capability
  // authority reuse a single broad HEAD + heads inventory. The final materialization boundary
  // still performs its separate exact-ref freshness check through the branded validation receipt.
  const gitEnv = runCommand === run
    ? enterpriseGitEnvironment(env)
    // An injected deterministic probe is not a real Git installation and cannot answer system /
    // global config queries. It still receives the executable-free half of the boundary.
    : withoutGitProcessOverrides(env);
  const remoteSession = new GitRemoteSession({ env: gitEnv });
  const observations = await mapLimit(
    plan.repositories, gitWorkerCount(plan.repositories.length, { env }), async (repository) => {
    const actualUrl = plan.createInput.repositories[repository.id].url;
    const inferDefault = plan.inferDefaultRepositories.includes(repository.id);
    const probe = runCommand === run
      ? await asynchronousRemoteProbe(actualUrl, {
          branch: inferDefault ? null : repository.defaultBranch, env: gitEnv, session: remoteSession
        })
      : probeGitRemote(actualUrl, {
          branch: inferDefault ? null : repository.defaultBranch, runCommand, env: gitEnv
        });
    return { repository, actualUrl, inferDefault, probe };
  });
  for (const { repository, inferDefault, probe } of observations) {
    const chosenBranch = inferDefault ? probe.defaultBranch : repository.defaultBranch;
    if (probe.ok && inferDefault && chosenBranch) branchUpdates.set(repository.id, chosenBranch);
    const missingDefault = probe.ok && inferDefault && !chosenBranch;
    checks.push({
      id: `remote:${repository.id}`,
      repository: repository.id,
      status: probe.ok && !missingDefault ? 'pass' : (repository.required ? 'fail' : 'warn'),
      remote: probe.remote,
      remoteFingerprint: probe.remoteFingerprint,
      defaultBranch: probe.defaultBranch,
      selectedBranch: chosenBranch,
      branchCount: probe.branches.length,
      classification: probe.failure?.classification ?? (missingDefault ? 'branch-not-found' : null)
    });
    if (!probe.ok || missingDefault) {
      const failure = probe.failure ?? {
        classification: 'branch-not-found', retryable: false,
        advice: 'Set an explicit default branch that exists on the remote, then prepare a new session.'
      };
      findings.push(finding({
        id: `remote.${repository.id}.${failure.classification}`,
        scope: 'transport',
        severity: repository.required ? 'blocker' : 'warning',
        classification: failure.classification,
        message: missingDefault
          ? `Repository '${repository.id}' did not advertise a default branch.`
          : `Repository '${repository.id}' failed its non-interactive remote preflight (${failure.classification}).`,
        action: failure.advice,
        retryable: failure.retryable,
        repository: repository.id,
        evidence: failure.evidence ?? null
      }));
    }
  }
  const manifest = previewWorkspaceConfiguration(plan.createInput).manifest;
  const requestedCapabilities = [...new Set([
    ...(manifest.capabilities ?? []),
    ...Object.values(manifest.repositories ?? {}).flatMap((repository) => repository.capabilities ?? [])
  ])].sort();
  if (requestedCapabilities.length) {
    try {
      const validation = await validateWorkspaceCapabilityRegistration(manifest, {
        env: gitEnv, remoteSession
      });
      liveCapabilityValidation = validation;
      checks.push({
        id: 'configuration:capability-catalog',
        status: 'pass',
        leadRepository: manifest.leadRepository,
        branch: validation.branch,
        path: validation.path,
        capabilities: validation.requested,
        // Session data is public diagnostics, never the live authority proof. The exact branded
        // receipt is returned separately to the module-private cache below.
        capabilityValidation: structuredClone(validation)
      });
    } catch (error) {
      const classification = error?.code === 'WORKSPACE_CAPABILITY_UNKNOWN'
        ? 'capability-unknown' : 'capability-catalog-unavailable';
      checks.push({
        id: 'configuration:capability-catalog',
        status: 'fail',
        leadRepository: manifest.leadRepository,
        capabilities: requestedCapabilities,
        classification
      });
      findings.push(finding({
        id: `configuration.capability-catalog.${classification}`,
        scope: 'configuration',
        classification,
        message: error?.message || String(error),
        action: 'Map and approve every selected capability on the lead repository sflow/config branch, then prepare a new workspace session.',
        retryable: false,
        repository: manifest.leadRepository,
        evidence: {
          capabilities: requestedCapabilities,
          branch: error?.details?.branch ?? 'sflow/config',
          path: error?.details?.path ?? 'singularity/capabilities.yml'
        }
      }));
    }
  }
  return { checks, findings, plan: rebuiltPlan(plan, branchUpdates), liveCapabilityValidation };
}

export async function preflightWorkspaceBootstrap(bootstrapId, {
  env = process.env, home = os.homedir(), runCommand = run
} = {}) {
  const root = workspaceBootstrapRoot(env, home);
  return withLease(root, bootstrapId, async () => {
    let session = await readWorkspaceBootstrap(bootstrapId, { env, home });
    if (TERMINAL.has(session.status)) return session;
    if (session.preflight && session.planHash !== planHashFor(session.plan)) {
      throw new SingularityFlowError(
        `Workspace bootstrap '${bootstrapId}' no longer matches its reviewed plan. Prepare a new bootstrap session.`,
        { code: 'BOOTSTRAP_PLAN_HASH_INVALID', details: {
          bootstrapId, preserved: ['bootstrap-record', 'workspace-target'],
          nextAction: bootstrapStatusAction(bootstrapId)
        } }
      );
    }
    const previousCheckedAt = Date.parse(session.preflight?.checkedAt ?? '');
    const targetStillAbsent = !(await lstat(session.plan.workspace.targetPath).catch(() => null));
    if (session.preflight?.ready === true
        && session.preflight.planHash === session.planHash
        && targetStillAbsent
        && Number.isFinite(previousCheckedAt)
        && Date.now() - previousCheckedAt <= PREFLIGHT_RECEIPT_TTL_MS) {
      // A confirmed resume immediately follows preview in the UI. Re-running disk, Git, and
      // capability checks here doubled office-network latency. Workspace creation still validates
      // capability registration and each clone remains bounded/recoverable, so this short-lived
      // exact-plan receipt is safe to reuse.
      return session;
    }
    const preflightAttempt = (session.steps ?? [])
      .filter((step) => step.operationId === 'bootstrap.preflight').length + 1;
    let budgets;
    try {
      budgets = consumeBudget(session, 'preflight');
    } catch (error) {
      if (error?.code !== 'BOOTSTRAP_ATTEMPT_BUDGET_EXHAUSTED') throw error;
      const retry = bootstrapRetryAction(session);
      return writeSession(root, {
        ...session,
        status: 'waiting-user',
        revision: session.revision + 1,
        fault: { classification: 'attempt-budget-exhausted', message: error.message, occurredAt: nowIso() },
        nextAction: retry,
        recoveryActions: [retry, bootstrapStatusAction(bootstrapId)]
      });
    }
    const started = beginStep(session.steps, {
      operationId: 'bootstrap.preflight', attempt: preflightAttempt, inputHash: session.planHash
    });
    session = await writeSession(root, {
      ...session, status: 'preflighting', revision: session.revision + 1, fault: null,
      operationBudgets: budgets,
      steps: started.steps
    });
    const [machine, remote] = await Promise.all([
      machinePreflight(session.plan, { env, home, runCommand }),
      remotePreflight(session.plan, { env, runCommand })
    ]);
    const findings = [...machine.findings, ...remote.findings];
    const blockers = findings.filter((entry) => entry.severity === 'blocker');
    const checkedAt = nowIso();
    const planHash = planHashFor(remote.plan);
    rememberLiveCapabilityValidation(bootstrapId, planHash, remote.liveCapabilityValidation);
    const faults = blockers.map((entry) => bootstrapFault({
      bootstrapId,
      operationFamily: entry.scope === 'transport' ? 'remote.inspect' : 'machine.preflight',
      stage: 'preflight',
      attempt: preflightAttempt,
      inputHash: planHash,
      classification: entry.classification,
      scope: entry.scope,
      repository: entry.repository,
      retryable: entry.retryable,
      summary: entry.message,
      evidence: entry.evidence,
      stepId: started.step.stepId,
      createdPaths: session.createdPaths
    }));
    const recoveryActions = bootstrapRecoveryActions(session, blockers);
    const nextAction = blockers.length
      ? recoveryActions.find((entry) => entry.id === 'resume') ?? recoveryActions[0]
      : recoveryActions[0];
    return writeSession(root, {
      ...session,
      status: 'waiting-user',
      revision: session.revision + 1,
      plan: remote.plan,
      planHash,
      faults: uniqueFaults(session.faults, faults),
      steps: finishStep(session.steps, started.step.stepId, {
        inputHash: planHash,
        observedPostcondition: { ready: blockers.length === 0, checksCompleted: machine.checks.length + remote.checks.length },
        result: blockers.length ? 'needs-user' : 'succeeded',
        errorReference: blockers[0]?.id ?? null,
        nextAction
      }),
      preflight: {
        schemaVersion: 1,
        checkedAt,
        planHash,
        reuseUntil: new Date(Date.parse(checkedAt) + PREFLIGHT_RECEIPT_TTL_MS).toISOString(),
        ready: blockers.length === 0,
        checks: [...machine.checks, ...remote.checks],
        findings
      },
      nextAction,
      recoveryActions
    });
  });
}

export async function resumeWorkspaceBootstrap(bootstrapId, {
  confirmation,
  env = process.env,
  home = os.homedir(),
  runCommand = run
} = {}) {
  let session = await preflightWorkspaceBootstrap(bootstrapId, { env, home, runCommand });
  if (session.status === 'ready') return session;
  if (session.status === 'abandoned') {
    throw new SingularityFlowError(`Workspace bootstrap '${bootstrapId}' was abandoned and cannot be resumed.`, {
      code: 'BOOTSTRAP_ABANDONED', details: { bootstrapId, nextAction: bootstrapStatusAction(bootstrapId) }
    });
  }
  if (session.planHash !== planHashFor(session.plan)) {
    throw new SingularityFlowError(
      `Workspace bootstrap '${bootstrapId}' no longer matches its reviewed plan. Prepare a new bootstrap session.`,
      { code: 'BOOTSTRAP_PLAN_HASH_INVALID', details: {
        bootstrapId, preserved: ['bootstrap-record', 'workspace-target'],
        nextAction: bootstrapStatusAction(bootstrapId)
      } }
    );
  }
  if (confirmation !== session.plan.workspace.confirmation) {
    const nextAction = bootstrapResumeAction(session);
    throw new SingularityFlowError(
      `Workspace bootstrap requires exact workspace confirmation '${session.plan.workspace.confirmation}'. Nothing was changed. Re-run: ${nextAction.command}`,
      { code: 'BOOTSTRAP_CONFIRMATION_REQUIRED', details: {
        bootstrapId, confirmation: session.plan.workspace.confirmation,
        preserved: ['bootstrap-record', 'reviewed-plan', 'workspace-target'], nextAction
      } }
    );
  }
  if (!session.preflight?.ready) return session;

  const root = workspaceBootstrapRoot(env, home);
  return withLease(root, bootstrapId, async () => {
    session = await readWorkspaceBootstrap(bootstrapId, { env, home });
    let budgets;
    try {
      budgets = consumeBudget(session, 'materialize');
    } catch (error) {
      if (error?.code !== 'BOOTSTRAP_ATTEMPT_BUDGET_EXHAUSTED') throw error;
      const retry = bootstrapRetryAction(session);
      return writeSession(root, {
        ...session,
        status: 'waiting-user',
        revision: session.revision + 1,
        fault: { classification: 'attempt-budget-exhausted', message: error.message, occurredAt: nowIso() },
        nextAction: retry,
        recoveryActions: [retry, bootstrapStatusAction(bootstrapId)]
      });
    }
    const attempt = { number: session.attempts.length + 1, startedAt: nowIso(), completedAt: null, status: 'running' };
    const materializing = beginStep(session.steps, {
      operationId: 'bootstrap.materialize', attempt: attempt.number, inputHash: session.planHash
    });
    let activeStepId = materializing.step.stepId;
    session = await writeSession(root, {
      ...session,
      status: 'materializing',
      revision: session.revision + 1,
      attemptBudget: {
        ...session.attemptBudget,
        used: Number(session.attemptBudget?.used ?? 0) + 1,
        maximum: Number(session.attemptBudget?.maximum ?? 2)
      },
      operationBudgets: budgets,
      attempts: [...session.attempts, attempt],
      steps: materializing.steps,
      nextAction: null
    });
    try {
      const materialized = await createWorkspaceConfiguration(session.plan.createInput, {
        confirmation: session.plan.workspace.confirmation,
        clone: true,
        bootstrapId,
        env,
        capabilityValidation: takeLiveCapabilityValidation(bootstrapId, session.planHash)
          ?? session.preflight?.checks
            ?.find((check) => check.id === 'configuration:capability-catalog')?.capabilityValidation
          ?? null
      });
      const journalPath = path.join(
        materialized.workspace.path, materialized.workspace.directories.logs, 'workspace-materialization.json'
      );
      const verifying = beginStep(finishStep(session.steps, activeStepId, {
        observedPostcondition: { workspaceManifest: true, materializationJournal: true },
        result: 'succeeded'
      }), {
        operationId: 'bootstrap.verify', attempt: attempt.number, inputHash: session.planHash
      });
      activeStepId = verifying.step.stepId;
      session = await writeSession(root, {
        ...session,
        status: 'verifying',
        revision: session.revision + 1,
        workspaceJournal: { path: journalPath, bootstrapId },
        steps: verifying.steps,
        result: { workspace: materialized.workspace, materialization: materialized.materialization ?? materialized.repair ?? [] }
      });
      const status = materialized.status ?? await workspaceStatus(materialized.workspace.path);
      await rememberWorkspace(workspaceRegistryFile(env, home), materialized.workspace, status);
      session = {
        ...session,
        steps: finishStep(session.steps, activeStepId, {
          observedPostcondition: {
            workspaceReady: status.healthy === true,
            requiredRepositoriesReady: status.repositories
              ?.filter((repository) => repository.required !== false)
              .every((repository) => repository.state === 'ready') ?? false
          },
          result: status.healthy === true ? 'succeeded' : 'degraded'
        })
      };

      let initialization = null;
      if (session.plan.initialization.enabled) {
        let initializationBudgets;
        const continuingInitialization = (session.steps ?? []).some((step) =>
          step.operationId === 'bootstrap.initialize' && step.result === 'needs-user');
        if (continuingInitialization) {
          // Resume the same initialization after its explicit transport recovery. This is a
          // postcondition continuation, not a second authorization or a reset of the one-attempt
          // initialization budget.
          initializationBudgets = operationBudgets(session);
        } else {
          try {
            initializationBudgets = consumeBudget(session, 'initialize');
          } catch (error) {
            if (error?.code !== 'BOOTSTRAP_ATTEMPT_BUDGET_EXHAUSTED') throw error;
            initialization = { error: error.message, budgetExhausted: true };
          }
        }
        if (initialization?.budgetExhausted) {
          session = { ...session, operationBudgets: operationBudgets(session) };
        } else {
          const initializing = beginStep(session.steps, {
            operationId: 'bootstrap.initialize', attempt: attempt.number, inputHash: session.planHash
          });
          activeStepId = initializing.step.stepId;
          session = await writeSession(root, {
            ...session, status: 'initializing', revision: session.revision + 1,
            operationBudgets: initializationBudgets,
            steps: initializing.steps
          });
          const { initializeWorkspaceState } = await import('./organisation.mjs');
          const lead = materialized.workspace.repositories[materialized.workspace.leadRepository];
          try {
            initialization = await initializeWorkspaceState(workspaceRepositoryPath(materialized.workspace, lead), {
              branch: session.plan.initialization.stateBranch,
              transport: { env, home, runCommand }
            });
          } catch (error) {
            initialization = {
              error: safeFailureMessage(error),
              publicationIntent: error?.details?.intentId
                ? { intentId: error.details.intentId, status: error.details.status ?? 'needs-user' }
                : null
            };
          }
          if (!initialization?.error && initialization?.publicationError) {
            initialization = { ...initialization, error: initialization.publicationError };
          }
          session = {
            ...session,
            steps: finishStep(session.steps, activeStepId, {
              observedPostcondition: { initialized: !initialization?.error },
              result: initialization?.error ? 'needs-user' : 'succeeded',
              errorReference: initialization?.error ? 'initialization-failed' : null
            })
          };
        }
      }

      const finalStatus = initialization?.error || !status.healthy ? 'degraded' : 'ready';
      const completedAt = nowIso();
      const attempts = session.attempts.map((entry) => entry.number === attempt.number
        ? { ...entry, completedAt, status: finalStatus }
        : entry);
      const nextAction = initialization?.error
        ? (initialization.publicationIntent?.intentId
          ? { id: 'recover-push', label: 'Recover exact state publication', command: `singularity-flow push status ${initialization.publicationIntent.intentId}`, skill: '/sf-push' }
          : bootstrapResumeAction(session))
        : { id: 'select', label: 'Select the ready workspace', command: `singularity-flow workspace use ${session.plan.workspace.id} --json`, skill: '/sf-workspace' };
      return writeSession(root, {
        ...session,
        status: finalStatus,
        revision: session.revision + 1,
        attempts,
        steps: session.steps,
        createdPaths: [...new Set([...(session.createdPaths ?? []), materialized.workspace.path])],
        result: { ...session.result, status, initialization },
        fault: initialization?.error ? {
          classification: 'initialization-failed', message: initialization.error, occurredAt: completedAt
        } : null,
        nextAction,
        recoveryActions: initialization?.error
          ? [nextAction, bootstrapStatusAction(bootstrapId)]
          : [nextAction]
      });
    } catch (error) {
      const failedAt = nowIso();
      const attempts = session.attempts.map((entry) => entry.number === attempt.number
        ? { ...entry, completedAt: failedAt, status: 'failed' }
        : entry);
      const journalPath = path.join(
        session.plan.workspace.targetPath, 'logs', 'workspace-materialization.json'
      );
      const workspaceExists = Boolean(await lstat(path.join(session.plan.workspace.targetPath, 'workspace.json')).catch(() => null));
      const faultRecord = bootstrapFault({
        bootstrapId,
        operationFamily: 'git.clone',
        stage: 'materialize',
        attempt: attempt.number,
        inputHash: session.planHash,
        classification: workspaceExists ? 'materialization-interrupted' : 'materialization-refused',
        retryable: true,
        summary: safeFailureMessage(error),
        stepId: activeStepId,
        createdPaths: workspaceExists
          ? [...new Set([...(session.createdPaths ?? []), session.plan.workspace.targetPath])]
          : session.createdPaths
      });
      const nextAction = bootstrapResumeAction(session);
      return writeSession(root, {
        ...session,
        status: workspaceExists ? 'degraded' : 'waiting-user',
        revision: session.revision + 1,
        attempts,
        steps: finishStep(session.steps, activeStepId, {
          observedPostcondition: { workspaceManifest: workspaceExists },
          result: 'needs-user',
          errorReference: faultRecord.faultKey,
          nextAction: {
            command: nextAction.command,
            skill: `/sf-workspace-bootstrap ${bootstrapId}`
          }
        }),
        workspaceJournal: workspaceExists ? { path: journalPath, bootstrapId } : null,
        createdPaths: workspaceExists
          ? [...new Set([...(session.createdPaths ?? []), session.plan.workspace.targetPath])]
          : session.createdPaths,
        faults: uniqueFaults(session.faults, [faultRecord]),
        fault: {
          classification: workspaceExists ? 'materialization-interrupted' : 'materialization-refused',
          message: safeFailureMessage(error),
          occurredAt: failedAt
        },
        nextAction,
        recoveryActions: [nextAction, bootstrapStatusAction(bootstrapId)]
      });
    }
  });
}

/**
 * Explicitly authorize another bounded recovery generation without widening or replacing the plan.
 *
 * Retry budgets keep a broken unattended loop from cloning forever, but exhaustion must not make a
 * human-correctable network, credential, disk, or partial-clone failure permanent. This operation
 * resets only the attempt counters. It refuses any occupied target unless both the managed
 * workspace identity and its materialization journal bind it to this exact bootstrap receipt.
 */
export async function retryWorkspaceBootstrap(bootstrapId, {
  confirmation, reason, env = process.env, home = os.homedir()
} = {}) {
  const explanation = String(reason ?? '').trim();
  if (!explanation) throw new SingularityFlowError('Retrying a workspace bootstrap requires --reason.', {
    code: 'BOOTSTRAP_RETRY_REASON_REQUIRED',
    details: { bootstrapId, nextAction: bootstrapStatusAction(bootstrapId) }
  });
  const root = workspaceBootstrapRoot(env, home);
  return withLease(root, bootstrapId, async () => {
    const session = await readWorkspaceBootstrap(bootstrapId, { env, home });
    if (session.status === 'ready') {
      throw new SingularityFlowError(`Workspace bootstrap '${bootstrapId}' is already ready.`, {
        code: 'BOOTSTRAP_ALREADY_READY', details: { bootstrapId, nextAction: session.nextAction }
      });
    }
    if (session.status === 'abandoned') {
      throw new SingularityFlowError(`Workspace bootstrap '${bootstrapId}' was abandoned and cannot be retried.`, {
        code: 'BOOTSTRAP_ABANDONED', details: { bootstrapId }
      });
    }
    if (confirmation !== session.plan.workspace.confirmation) {
      const nextAction = bootstrapRetryAction(session);
      throw new SingularityFlowError(
        `Workspace bootstrap retry requires exact workspace confirmation '${session.plan.workspace.confirmation}'. Nothing was changed.`,
        { code: 'BOOTSTRAP_CONFIRMATION_REQUIRED', details: { bootstrapId, nextAction } }
      );
    }
    if (session.planHash !== planHashFor(session.plan)) {
      throw new SingularityFlowError(
        `Workspace bootstrap '${bootstrapId}' no longer matches its reviewed plan. Nothing was changed.`,
        { code: 'BOOTSTRAP_PLAN_HASH_INVALID', details: { bootstrapId, nextAction: bootstrapStatusAction(bootstrapId) } }
      );
    }

    const currentBudgets = operationBudgets(session);
    const exhaustedOperations = Object.entries(currentBudgets)
      .filter(([, budget]) => budget.used >= budget.maximum)
      .map(([operation]) => operation);
    if (!exhaustedOperations.length) {
      const nextAction = bootstrapResumeAction(session);
      throw new SingularityFlowError(
        `Workspace bootstrap '${bootstrapId}' still has bounded attempts available. Resume the preserved plan instead of resetting its safety budget.`,
        {
          code: 'BOOTSTRAP_RETRY_NOT_REQUIRED',
          details: {
            bootstrapId,
            operationBudgets: currentBudgets,
            preserved: ['bootstrap-record', 'reviewed-plan', 'workspace-target'],
            nextAction
          }
        }
      );
    }

    const target = session.plan.workspace.targetPath;
    const targetInfo = await lstat(target).catch(() => null);
    if (targetInfo) {
      const workspace = !targetInfo.isSymbolicLink() && targetInfo.isDirectory()
        ? await readWorkspace(target).catch(() => null) : null;
      const journalFile = workspace
        ? path.join(target, workspace.directories.logs, 'workspace-materialization.json') : null;
      const journal = journalFile
        ? await readFile(journalFile, 'utf8').then(JSON.parse).catch(() => null) : null;
      if (workspace?.id !== session.plan.workspace.id || journal?.bootstrapId !== bootstrapId) {
        throw new SingularityFlowError(
          `Workspace bootstrap retry refused the occupied target because it is not owned by '${bootstrapId}': ${target}. Nothing was changed.`,
          {
            code: 'BOOTSTRAP_RETRY_TARGET_UNPROVEN',
            details: { bootstrapId, target, nextAction: bootstrapStatusAction(bootstrapId) }
          }
        );
      }
    }

    const nextAction = bootstrapResumeAction(session);
    return writeSession(root, {
      ...session,
      status: 'waiting-user',
      revision: session.revision + 1,
      recoveryGeneration: Number(session.recoveryGeneration ?? 0) + 1,
      operationBudgets: structuredClone(DEFAULT_OPERATION_BUDGETS),
      fault: null,
      recoveryAuthorizations: [...(session.recoveryAuthorizations ?? []), {
        authorizedAt: nowIso(), generation: Number(session.recoveryGeneration ?? 0) + 1,
        effects: ['reset-bounded-attempt-counters'],
        proof: {
          bootstrapId, planHash: session.planHash,
          reviewedPlanUnchanged: true, targetOwnershipProven: true,
          exhaustedOperations,
          reason: explanation.slice(0, 1_000), targetExisted: Boolean(targetInfo)
        }
      }],
      nextAction,
      recoveryActions: [nextAction, bootstrapStatusAction(bootstrapId)]
    });
  });
}

export async function abandonWorkspaceBootstrap(bootstrapId, {
  reason, env = process.env, home = os.homedir()
} = {}) {
  const explanation = String(reason ?? '').trim();
  if (!explanation) throw new SingularityFlowError('Abandoning a workspace bootstrap requires --reason.', {
    code: 'BOOTSTRAP_ABANDON_REASON_REQUIRED'
  });
  const root = workspaceBootstrapRoot(env, home);
  return withLease(root, bootstrapId, async () => {
    const session = await readWorkspaceBootstrap(bootstrapId, { env, home });
    if (session.status === 'ready') {
      throw new SingularityFlowError(`Ready workspace bootstrap '${bootstrapId}' cannot be abandoned. Forget or archive the workspace instead.`, {
        code: 'BOOTSTRAP_ALREADY_READY'
      });
    }
    if (session.status === 'abandoned') return session;
    return writeSession(root, {
      ...session,
      status: 'abandoned',
      revision: session.revision + 1,
      abandonedAt: nowIso(),
      abandonReason: explanation.slice(0, 1_000),
      nextAction: null
    });
  });
}

export async function workspaceBootstrapDoctor({
  network = false, repositoryUrls = [], env = process.env, home = os.homedir(), runCommand = run
} = {}) {
  const explicitRepositories = (Array.isArray(repositoryUrls) ? repositoryUrls : [repositoryUrls])
    .filter((value) => value != null)
    .map((value) => assertCredentialFreeRemote(value));
  const root = workspaceBootstrapRoot(env, home);
  const stateInfo = await lstat(root).catch(() => null);
  const recordsDirectory = path.join(root, 'sessions');
  const files = await readdir(recordsDirectory).catch(() => []);
  const corruptRecords = [];
  const sessions = [];
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    try {
      const parsed = readRecord('workspace-bootstrap', await readFile(path.join(recordsDirectory, file))).record;
      sessions.push(verifyIntegrity(parsed, path.join(recordsDirectory, file)));
    } catch (error) {
      corruptRecords.push({ file: path.join(recordsDirectory, file), error: safeFailureMessage(error) });
    }
  }
  const synthetic = sessions[0]?.plan ?? {
    workspace: { targetPath: path.join(home, 'Singularity Workspaces', '.preflight') },
    initialization: { enabled: false }
  };
  const machine = await machinePreflight(synthetic, { env, home, runCommand });
  const remotes = [];
  if (network) {
    const unique = new Map();
    const addTarget = ({ repository = null, actual, branch = null, explicit = false }) => {
      const exact = assertCredentialFreeRemote(actual);
      const requestedBranch = branch == null ? null : String(branch).trim() || null;
      // A URL can legitimately occur in several bootstrap plans with different required branches.
      // Deduplicating the URL alone hid a missing branch whenever another session happened to be
      // read later. Explicit doctor targets have no required branch and are therefore a distinct
      // observation from a session-bound URL + branch pair.
      const key = JSON.stringify([remoteFingerprint(exact), requestedBranch]);
      const existing = unique.get(key);
      if (existing) {
        if (repository && !existing.repositories.includes(repository)) {
          existing.repositories.push(repository);
        }
        existing.explicit ||= explicit;
        return;
      }
      unique.set(key, {
        repository,
        repositories: repository ? [repository] : [],
        actual: exact,
        branch: requestedBranch,
        explicit
      });
    };
    for (const session of sessions.filter((entry) => ACTIVE.has(entry.status))) {
      for (const repository of session.plan.repositories) {
        const actual = session.plan.createInput.repositories[repository.id].url;
        addTarget({ repository: repository.id, actual, branch: repository.defaultBranch });
      }
    }
    for (const actual of explicitRepositories) addTarget({ actual, explicit: true });
    // Match capability inspection's boundary: retain reviewed system/global enterprise transport
    // and credential-helper configuration, while stripping repository selectors, executable Git
    // overrides, URL rewrites, trace sinks, and other ambient process authority. Build it once for
    // the whole doctor run so every target sees the same configuration snapshot.
    const gitEnv = unique.size
      ? enterpriseGitEnvironment(env, { runCommand })
      : env;
    for (const entry of unique.values()) {
      const probe = probeGitRemote(entry.actual, {
        branch: entry.branch, env: gitEnv, runCommand
      });
      remotes.push({
        repository: entry.repository,
        repositories: entry.repositories,
        explicit: entry.explicit,
        remote: probe.remote,
        remoteFingerprint: probe.remoteFingerprint,
        branch: entry.branch,
        ok: probe.ok,
        classification: probe.failure?.classification ?? null,
        advice: probe.failure?.advice ?? null
      });
    }
  }
  const active = sessions.filter((entry) => ACTIVE.has(entry.status));
  return {
    schemaVersion: 1,
    checkedAt: nowIso(),
    healthy: machine.findings.every((entry) => entry.severity !== 'blocker')
      && corruptRecords.length === 0 && remotes.every((entry) => entry.ok),
    state: {
      root,
      exists: Boolean(stateInfo),
      symbolicLink: Boolean(stateInfo?.isSymbolicLink()),
      records: sessions.length,
      active: active.length,
      corrupt: corruptRecords
    },
    machine,
    enterpriseGit: enterpriseGitDiagnostics({ env, runCommand }),
    networkChecked: network,
    remotes,
    sessions: active.map(summary)
  };
}
