/**
 * AUT v1 Plan synthesis and exact-hash ratification.
 *
 * A Plan is machine-local and disposable until `ratifyAutoPlan` succeeds. Planning may inspect
 * committed state and may ask a model for a proposal, but it cannot create lifecycle state, refs,
 * worktrees, approvals, or authorization. Every model-proposed field is revalidated here.
 */
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveLifecycleCapability } from '../capability-context.mjs';
import { storyBaseCatalog } from '../capability-start.mjs';
import { previewChangeFlightPlan, readChangeFlightPlan } from '../change-flight-plan.mjs';
import { loadDefinition, resolveWorkType } from '../config.mjs';
import { branch, gitCommonDir, head, identity } from '../git.mjs';
import { generationTaskForPhase } from '../model-tasks.mjs';
import { invokeModel, resolveModelProvider } from '../model-runner.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { exists, nowIso, run, SingularityFlowError } from '../util.mjs';
import {
  AUTO_AUTHORING_TOOLS, effectiveAutoPolicy, parseAutoPace, parseAutoStopSelector,
  selectAutoProfile
} from './auto-policy.mjs';
import { buildAutoPlanPacket } from './auto-plan-packet.mjs';
import { executionUnitDriverDoctor } from './execution-unit-driver.mjs';
import { runRemoteGit } from '../git-execution.mjs';
import {
  assertCredentialFreeRemote, configuredRemoteIdentity, frozenRemoteTransport, remoteFingerprint
} from '../git-remote-diagnostics.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import {
  configurationReadRoot, configurationReadSnapshot
} from '../configuration-read-scope.mjs';
import { readAutoPrivateRecord, writeAutoPrivateRecord } from './auto-private-store.mjs';

const PLAN_ID = /^APL-[A-F0-9]{26}$/;
const PLAN_HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_REQUIREMENT_BYTES = 64 * 1024;

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function localRoot(root) { return path.join(gitCommonDir(root), 'singularity-flow'); }
function planFile(root, planId) { return path.join(localRoot(root), 'auto-plans', `${planId}.json`); }
function authorizationFile(root, planId) { return path.join(localRoot(root), 'auto-authorizations', `${planId}.json`); }
const AUTO_CLAIM_LEASE_MS = 10 * 60 * 1000;

function claimOwnerAlive(owner) {
  // A remote host owns its lease until expiry; on this host, PID liveness lets a crashed start be
  // recovered immediately instead of making the operator wait for the whole lease window.
  if (owner?.host && owner.host !== os.hostname()) return true;
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch { return false; }
}

async function claimedEffects(root, plan, authorization) {
  const flight = authorization.flightId
    ? path.join(localRoot(root), 'auto-flights', authorization.flightId, 'state.json')
    : null;
  const start = path.join(
    localRoot(root), 'change-flight-plans', 'starts', `${plan.bindings.flightPlanId}.json`
  );
  return { flight: Boolean(flight && await exists(flight)), start: await exists(start) };
}

function validatePlanId(value) {
  const id = String(value ?? '').trim();
  if (!PLAN_ID.test(id)) throw new SingularityFlowError(`Invalid Auto Plan ID '${id}'.`, { code: 'AUTO_PLAN_NOT_FOUND' });
  return id;
}

function normalizedRequirement(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new SingularityFlowError('Auto planning requires a non-empty requirement.', { code: 'AUTO_PLAN_INVALID' });
  if (Buffer.byteLength(text) > MAX_REQUIREMENT_BYTES) {
    throw new SingularityFlowError(`Auto requirement exceeds ${MAX_REQUIREMENT_BYTES} bytes.`, { code: 'AUTO_PLAN_INVALID' });
  }
  return text;
}

function cleanTitle(value, requirement) {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (title || requirement.split(/[.!?\n]/)[0].trim() || 'Auto change').slice(0, 160);
}

function stringList(value, label, maximum = 50) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new SingularityFlowError(`Model proposal ${label} must be an array of at most ${maximum} non-empty strings.`, {
      code: 'AUTO_PLAN_INVALID'
    });
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function predictedPathList(value) {
  return stringList(value, 'predictedPaths', 200).map((candidate) => {
    const portable = candidate.replaceAll('\\', '/').replace(/\/$/, '');
    const normalized = path.posix.normalize(portable);
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')
      || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(candidate)
      || /[*?{}[\]\0]/.test(candidate)) {
      throw new SingularityFlowError(
        `Model proposal predictedPaths entry '${candidate}' must be a bounded repository-relative path without traversal or glob syntax.`,
        { code: 'AUTO_PLAN_INVALID' }
      );
    }
    return normalized;
  });
}

function proposalObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('Auto Plan synthesis did not return a JSON object.', { code: 'AUTO_PLAN_INVALID' });
  }
  const allowed = new Set([
    'title', 'workType', 'assumptions', 'unresolvedDecisions', 'predictedPaths',
    'acceptanceCriteria', 'suggestedUntil'
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new SingularityFlowError(`Auto Plan proposal contains unknown field '${key}'.`, { code: 'AUTO_PLAN_INVALID' });
  }
  return {
    title: value.title,
    workType: value.workType == null ? null : String(value.workType).trim(),
    assumptions: stringList(value.assumptions, 'assumptions'),
    unresolvedDecisions: stringList(value.unresolvedDecisions, 'unresolvedDecisions'),
    predictedPaths: predictedPathList(value.predictedPaths),
    acceptanceCriteria: stringList(value.acceptanceCriteria, 'acceptanceCriteria'),
    suggestedUntil: value.suggestedUntil == null ? null : String(value.suggestedUntil).trim()
  };
}

function parseProposalOutput(output) {
  const text = String(output ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  try { return proposalObject(JSON.parse(fenced ? fenced[1] : text)); }
  catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`Auto Plan synthesis returned invalid JSON: ${error.message}`, { code: 'AUTO_PLAN_INVALID' });
  }
}

export function autoPlanPrompt(requirement, definition) {
  const eligible = Object.entries(definition.workTypes ?? {})
    .filter(([, workType]) => workType.auto?.eligibility !== 'disabled')
    .map(([id, workType]) => ({ id, phases: workType.phases }));
  return [
    'You are proposing data for a Singularity Flow Auto Plan. You do not authorize or execute work.',
    'Return one JSON object only. Do not use Markdown and do not add fields.',
    'Allowed fields: title, workType, assumptions, unresolvedDecisions, predictedPaths, acceptanceCriteria, suggestedUntil.',
    'All list fields contain strings. predictedPaths are repository-relative paths or directories, never globs.',
    'Choose workType only from the supplied eligible work types. Use null if none is safely inferable.',
    'suggestedUntil is first-human-boundary, story-complete, or published|submitted|phase-complete:<phase>.',
    `Eligible work types: ${JSON.stringify(eligible)}`,
    `Requirement: ${JSON.stringify(requirement)}`
  ].join('\n');
}

async function synthesizeAutoPlanProposalInScope(root, requirement, { definition = null } = {}) {
  const config = definition ?? await loadDefinition(root);
  if (!config.auto.enabled) throw new SingularityFlowError('Auto mode is disabled by repository policy.', { code: 'AUTO_DISABLED' });
  const provider = resolveModelProvider(config);
  let result;
  try {
    result = await invokeModel({
      ...provider,
      cwd: path.resolve(root),
      allowedRoots: [path.resolve(root)],
      prompt: { text: autoPlanPrompt(normalizedRequirement(requirement), config) },
      channel: 'auto-plan-synthesis',
      subject: { kind: 'auto-plan' },
      tools: { mode: 'none' },
      limits: { timeoutMs: 5 * 60 * 1000, outputBytes: 256 * 1024 }
    });
  } catch (error) {
    throw new SingularityFlowError(
      `Auto Plan synthesis could not use the configured model: ${error.message}`,
      { code: 'AUTO_PLAN_MODEL_UNAVAILABLE', details: { nextAction: 'Configure an allowed model provider, then rerun auto plan.' }, cause: error }
    );
  }
  return { proposal: parseProposalOutput(result.output), invocation: result.invocation, usage: result.usage };
}

export async function synthesizeAutoPlanProposal(root, requirement, options = {}) {
  if (options.definition) return synthesizeAutoPlanProposalInScope(root, requirement, options);
  return withApprovedConfigurationRead(root, async (authority) => {
    if (!authority) throw new SingularityFlowError('Auto Plan requires approved Singularity Flow configuration.', {
      code: 'APPROVED_CONFIGURATION_UNAVAILABLE'
    });
    return synthesizeAutoPlanProposalInScope(root, requirement, {
      ...options, definition: await loadDefinition(root)
    });
  }, { preferAuthority: true });
}

function workIdFor(requirement, config, explicit = null) {
  if (explicit) return String(explicit).trim();
  if (config.auto.workIdAllocator === 'require-explicit') {
    throw new SingularityFlowError('Auto policy requires --work-id ID.', { code: 'AUTO_PLAN_INVALID' });
  }
  return `AUT-${sha256(`${requirement}\0${nowIso()}`).slice(0, 12).toUpperCase()}`;
}

function remoteHead(root, remote, branchName) {
  const transport = frozenRemoteTransport(assertCredentialFreeRemote(remote));
  const result = runRemoteGit([
    'ls-remote', '--heads', '--', transport.remote, `refs/heads/${branchName}`
  ], {
    cwd: root, operation: 'remote-probe', env: transport.env
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\s+/)[0] || null;
}

function committedFileSha(root, relative) {
  const readRoot = configurationReadRoot(root);
  if (path.resolve(readRoot) !== path.resolve(root)) {
    try {
      return createHash('sha256').update(readFileSync(path.join(readRoot, relative))).digest('hex');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  const result = run('git', ['show', `HEAD:${relative}`], { cwd: root, allowFailure: true, maxBuffer: 8 * 1024 * 1024 });
  return result.status === 0 ? sha256(result.stdout) : null;
}

function autoPolicySha256(definition) {
  const policy = structuredClone(definition);
  // Automatic identity enrollment changes only group membership while Story start is executing.
  // Membership does not change the model, tools, phase rail, ceilings, or required authority
  // groups ratified by an Auto Plan, so bind all configuration except that append-only roster.
  for (const authority of Object.values(policy.approvalAuthorities ?? {})) delete authority.members;
  // Agent files are extracted into a different private temporary directory on every read. Their
  // reviewed content digest and prompt bytes remain in the projection; the machine-local absolute
  // filename is transport metadata and must not make a Plan instantly stale.
  for (const agent of Object.values(policy.agents ?? {})) delete agent.file;
  for (const agent of policy.agentCatalog ?? []) delete agent.file;
  return sha256(policy);
}

function branchExists(root, name, remote) {
  return run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: root, allowFailure: true }).status === 0
    || run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${name}`], { cwd: root, allowFailure: true }).status === 0;
}

function protectedPredictions(proposal, definition, capability) {
  const protectedPaths = [...new Set([
    'singularity/workflow.yml', 'singularity/capabilities.yml',
    ...(definition.governance?.protectedPaths ?? []), ...(capability?.policy?.protectedPaths ?? [])
  ])];
  return proposal.predictedPaths.filter((candidate) => protectedPaths.some((protectedPath) => (
    candidate === protectedPath || candidate.startsWith(`${protectedPath.replace(/\/$/, '')}/`)
  )));
}

function humanStopPoints(phases) {
  return phases.flatMap((phase) => [
    ...(phase.clarification?.mode === 'required' ? [{
      phase: phase.id, kind: 'clarification', authorities: ['requirement-owner']
    }] : []),
    ...(Number(phase.approval?.minimum ?? 0) > 0 ? [{
      phase: phase.id, kind: 'approval', minimum: phase.approval.minimum,
      authorities: [...(phase.approval.authorities ?? [])]
    }] : [])
  ]);
}

function sameActor(left, right) {
  return left?.name === right?.name && left?.email === right?.email && left?.login === right?.login;
}

/**
 * Read the mutable, machine-local authorization receipt without ever treating unreadable bytes as
 * an absent receipt. Ratification recovery makes decisions from `claimedAt` and `consumedAt`, so
 * the family, identity, and complete self-hash must be verified before either field is inspected.
 */
async function readVerifiedAutoAuthorization(root, planIdValue, {
  optional = false, expectedPlanSha256 = null, expectedPacketSha256 = null
} = {}) {
  const planId = validatePlanId(planIdValue);
  const raw = await readAutoPrivateRecord(
    root, authorizationFile(root, planId), 'authorization', { optional }
  );
  if (raw == null) return null;
  const stored = readRecord('auto-authorization', raw).record;
  if (stored.kind !== 'auto-plan-ratification'
      || stored.mode !== 'auto'
      || stored.planId !== planId
      || !PLAN_HASH.test(String(stored.planSha256 ?? ''))
      || stored.confirmationProtocol !== 'packet-v1'
      || !PLAN_HASH.test(String(stored.confirmedSha256 ?? ''))
      || !PLAN_HASH.test(String(stored.packetSha256 ?? ''))
      || !PLAN_HASH.test(String(stored.validationSha256 ?? ''))
      || stored.confirmedSha256 !== stored.packetSha256
      || (expectedPlanSha256 && stored.planSha256 !== expectedPlanSha256)
      || (expectedPacketSha256 && (
        stored.confirmedSha256 !== expectedPacketSha256
        || stored.packetSha256 !== expectedPacketSha256
      ))
      || stored.recordSha256 !== sealAuthorization(stored).recordSha256) {
    throw new SingularityFlowError(
      `Auto authorization for '${planId}' failed its integrity check.`,
      { code: 'AUTO_AUTHORIZATION_CORRUPT' }
    );
  }
  return stored;
}

export function autoPlanHash(plan) {
  const copy = structuredClone(plan);
  delete copy.planSha256;
  return `sha256:${recordSha256(copy)}`;
}

/** Build and persist a Plan from an untrusted proposal. This function never starts governed work. */
async function createAutoPlanInScope(root, requirementValue, proposalValue, options = {}) {
  const requirement = normalizedRequirement(requirementValue);
  const proposal = proposalObject(proposalValue);
  const definition = options.definition ?? await loadDefinition(root);
  if (!definition.auto.enabled) throw new SingularityFlowError('Auto mode is disabled by repository policy.', { code: 'AUTO_DISABLED' });
  const capability = options.capability === undefined
    ? await resolveLifecycleCapability(root, { capabilityId: options.capabilityId, required: false })
    : options.capability;
  const eligible = Object.keys(definition.workTypes).filter((id) => {
    const resolution = resolveWorkType(definition, id);
    return effectiveAutoPolicy(definition.auto, resolution.auto, capability?.policy?.auto).eligibility !== 'disabled';
  });
  const workType = String(options.workType ?? proposal.workType ?? '').trim() || (eligible.length === 1 ? eligible[0] : null);
  if (!workType || !definition.workTypes[workType] || !eligible.includes(workType)) {
    throw new SingularityFlowError(`Auto Plan needs an eligible work type. Eligible: ${eligible.join(', ') || 'none'}.`, {
      code: 'AUTO_WORK_TYPE_INELIGIBLE', details: { eligible }
    });
  }
  const resolution = resolveWorkType(definition, workType);
  const policy = effectiveAutoPolicy(definition.auto, resolution.auto, capability?.policy?.auto);
  const profile = selectAutoProfile(policy, options.profile);
  const pace = parseAutoPace(options.pace ?? definition.auto.defaultPace);
  if (!resolution.auto.allowedPaces.includes(pace.mode)) {
    throw new SingularityFlowError(`Work type '${workType}' does not allow Auto pace '${pace.mode}'.`, { code: 'AUTO_PACE_FORBIDDEN' });
  }
  const until = parseAutoStopSelector(
    options.until ?? proposal.suggestedUntil ?? resolution.auto.defaultUntil ?? definition.auto.defaultUntil,
    resolution.phases.map((phase) => phase.id)
  );
  const workId = workIdFor(requirement, definition, options.workId);
  if (!(new RegExp(definition.idPattern ?? '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')).test(workId)) {
    throw new SingularityFlowError(`Auto Work ID '${workId}' does not match ${definition.idPattern}.`, { code: 'AUTO_PLAN_INVALID' });
  }
  const remote = definition.git?.remote ?? 'origin';
  const rootRemoteIdentity = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
  if (!rootRemoteIdentity.configured || rootRemoteIdentity.ambiguous || !rootRemoteIdentity.url) {
    throw new SingularityFlowError(
      `Auto Plan requires one unambiguous credential-free URL for Git remote '${remote}'.`,
      {
        code: 'AUTO_REPOSITORY_IDENTITY_UNAVAILABLE',
        details: {
          remote, configured: rootRemoteIdentity.configured,
          ambiguous: rootRemoteIdentity.ambiguous,
          nextAction: 'Configure one credential-free remote URL and use a Git credential helper.'
        }
      }
    );
  }
  const catalog = options.baseCatalog ?? await storyBaseCatalog(root, {
    remote,
    defaultBranch: definition.defaultBaseBranch,
    capabilityId: capability?.id,
    configurationSnapshot: configurationReadSnapshot(root)
  });
  if (catalog.unreachable.length) {
    throw new SingularityFlowError('Auto Plan cannot pin published base heads because a repository remote is unreachable.', {
      code: 'AUTO_BASE_INVALID', details: { unreachable: catalog.unreachable }
    });
  }
  const baseBranch = String(options.fromBranch ?? definition.defaultBaseBranch).trim();
  const missing = Object.entries(catalog.published).filter(([, branches]) => !branches.includes(baseBranch)).map(([id]) => id);
  if (missing.length) throw new SingularityFlowError(`Base branch '${baseBranch}' is not published by: ${missing.join(', ')}.`, {
    code: 'AUTO_BASE_INVALID'
  });
  const repositoryAuthorities = Object.fromEntries(catalog.repositories.map((repository) => {
    const repositoryRoot = repository.path ?? root;
    const configured = repository.url
      ? assertCredentialFreeRemote(repository.url)
      : configuredRemoteIdentity(repositoryRoot, remote, { direction: 'fetch' }).url;
    if (!configured) throw new SingularityFlowError(
      `Auto Plan cannot resolve a credential-free remote identity for repository '${repository.id}'.`,
      { code: 'AUTO_REPOSITORY_IDENTITY_UNAVAILABLE' }
    );
    // `assertCredentialFreeRemote` has already rejected persisted credentials. Preserve the exact
    // transport identity here: sanitizing `ssh://git@host/repo` would remove the SSH login and can
    // make a reviewed Plan address a different or unusable transport.
    return [repository.id, { url: configured, fingerprint: remoteFingerprint(configured) }];
  }));
  const baseHeads = Object.fromEntries(catalog.repositories.map((repository) => [
    repository.id,
    remoteHead(repository.path ?? root, repositoryAuthorities[repository.id].url, baseBranch)
  ]));
  if (Object.values(baseHeads).some((value) => !value)) {
    throw new SingularityFlowError(`Auto Plan could not resolve every '${baseBranch}' head.`, { code: 'AUTO_BASE_INVALID' });
  }
  const flightPlan = options.flightPlan ?? await previewChangeFlightPlan(root, {
    intent: requirement, workType, ast: false, persist: true, source: 'auto-plan',
    predictedPaths: proposal.predictedPaths
  });
  const protectedPaths = protectedPredictions(proposal, definition, capability);
  const selectedHost = resolveModelProvider(definition);
  const hostAllowed = policy.execution.allowedHosts.includes(selectedHost.provider);
  const firstPhase = resolution.phases[0]?.id ?? null;
  const driver = await executionUnitDriverDoctor(root, definition, firstPhase);
  const executionHost = {
    id: selectedHost.provider,
    model: selectedHost.model,
    modelTask: firstPhase ? generationTaskForPhase(definition, firstPhase) : null,
    modelAssurance: driver.checks.find((entry) => entry.id === 'model-routed')?.status === 'pass'
      ? 'configured-route' : 'unavailable',
    capabilities: ['artifact-write', 'source-write', ...(driver.cancellation.supported ? ['cancel'] : [])],
    writableRoots: ['managed-worktree'], availableTools: [...AUTO_AUTHORING_TOOLS],
    containment: { managedWorktree: true, networkPolicy: 'host-controlled' },
    cancellation: driver.cancellation.supported,
    driver,
    status: hostAllowed && driver.status === 'available' ? 'available' : 'unavailable'
  };
  const selectorWithinPilot = until.kind === 'first-human-boundary'
    || (until.phase === firstPhase && ['published', 'submitted', 'phase-complete'].includes(until.kind))
    || (until.kind === 'story-complete' && resolution.phases.length === 1);
  const pilotWindow = ['step', 'continuous', 'phase'].includes(pace.mode) && selectorWithinPilot;
  const tokenAssuranceStartable = policy.ceilings.tokenBudget.assurance !== 'exact-required';
  const destinationCollision = branchExists(root, workId, remote);
  const startable = policy.eligibility === 'bounded'
    && catalog.repositories.length === 1
    && protectedPaths.length === 0
    && baseHeads[catalog.repositoryId] === head(root)
    && executionHost.status === 'available'
    && pilotWindow
    && tokenAssuranceStartable
    && !destinationCollision;
  const createdAt = nowIso();
  const expiresAt = new Date(Date.parse(createdAt) + definition.auto.planTtlMinutes * 60 * 1000).toISOString();
  const core = {
    schemaVersion: currentSchemaVersion('auto-plan'),
    kind: 'auto-plan',
    mode: 'auto',
    confirmation: { protocol: 'packet-v1' },
    requirement: { text: requirement, sha256: sha256(requirement) },
    proposal: {
      title: cleanTitle(proposal.title, requirement), assumptions: proposal.assumptions,
      unresolvedDecisions: proposal.unresolvedDecisions, predictedPaths: proposal.predictedPaths,
      acceptanceCriteria: proposal.acceptanceCriteria
    },
    story: { workId, workType, branch: workId, phaseRail: resolution.phases.map((phase) => phase.id) },
    execution: {
      profile, pace, until, ceilings: policy.ceilings, concurrency: policy.concurrency,
      eligibility: policy.eligibility
    },
    humanBoundaries: {
      firstPhaseClarificationRequired: resolution.phases[0]?.clarification?.mode === 'required',
      stopPoints: humanStopPoints(resolution.phases)
    },
    scope: { protectedPaths, status: protectedPaths.length ? 'protected-predicted' : flightPlan.status },
    capability: capability ? { id: capability.id, mapSha256: capability.map.sha256, path: capability.path } : null,
    repositories: catalog.repositories.map((repository) => ({
      id: repository.id, remote,
      remoteUrl: repositoryAuthorities[repository.id].url,
      remoteFingerprint: repositoryAuthorities[repository.id].fingerprint,
      baseBranch, baseCommit: baseHeads[repository.id]
    })),
    executionHost,
    accounting: {
      scope: 'predicted',
      tokens: options.synthesis?.usage?.totalTokens != null ? 'exact' : 'unavailable',
      cost: 'unavailable'
    },
    bindings: {
      repository: rootRemoteIdentity.url,
      repositoryFingerprint: rootRemoteIdentity.fingerprint,
      head: head(root), branch: branch(root),
      workflowSha256: committedFileSha(root, 'singularity/workflow.yml'),
      autoPolicySha256: autoPolicySha256(definition),
      flightPlanId: flightPlan.planId, flightPlanSha256: `sha256:${recordSha256(flightPlan)}`
    },
    safety: {
      startable,
      reasons: [
        ...(policy.eligibility !== 'bounded' ? [`eligibility is ${policy.eligibility}`] : []),
        ...(catalog.repositories.length !== 1 ? ['multi-repository execution is not enabled in this pilot'] : []),
        ...(protectedPaths.length ? ['protected scope is predicted'] : []),
        ...(baseHeads[catalog.repositoryId] !== head(root) ? ['active HEAD does not equal the selected published base'] : []),
        ...(!hostAllowed ? [`execution host '${selectedHost.provider}' is not allowed by policy`] : []),
        ...(driver.status !== 'available'
          ? driver.checks.filter((entry) => entry.status === 'fail').map((entry) => `execution driver ${entry.id}: ${entry.detail}`)
          : []),
        ...(!pilotWindow ? ['Story Auto authorizes only step/phase/continuous pace through the first phase or human boundary in this release'] : []),
        ...(!tokenAssuranceStartable ? ['exact-required token assurance cannot be proven before invocation by this execution host'] : []),
        ...(destinationCollision ? [`destination branch '${workId}' already exists`] : [])
      ]
    },
    createdAt, expiresAt,
    synthesis: options.synthesis ?? null
  };
  const planId = `APL-${sha256(core).slice(0, 26).toUpperCase()}`;
  const plan = { ...core, planId };
  plan.planSha256 = autoPlanHash(plan);
  await writeAutoPrivateRecord(root, planFile(root, planId), 'plan', canonicalJson(plan), {
    immutable: true
  });
  return plan;
}

export async function createAutoPlan(root, requirementValue, proposalValue, options = {}) {
  if (options.definition) return createAutoPlanInScope(root, requirementValue, proposalValue, options);
  return withApprovedConfigurationRead(root, async (authority) => {
    if (!authority) throw new SingularityFlowError('Auto Plan requires approved Singularity Flow configuration.', {
      code: 'APPROVED_CONFIGURATION_UNAVAILABLE'
    });
    return createAutoPlanInScope(root, requirementValue, proposalValue, {
      ...options, definition: await loadDefinition(root)
    });
  }, { preferAuthority: true });
}

export async function readAutoPlan(root, planIdValue) {
  const planId = validatePlanId(planIdValue);
  const raw = await readAutoPrivateRecord(root, planFile(root, planId), 'plan', { optional: true });
  if (raw == null) {
    throw new SingularityFlowError(`Auto Plan '${planId}' is not available in this repository.`, {
      code: 'AUTO_PLAN_NOT_FOUND'
    });
  }
  let loaded;
  try {
    loaded = readRecord('auto-plan', raw);
  } catch (error) {
    if (error?.code !== 'SCHEMA_VERSION_ARCHIVED') throw error;
    throw new SingularityFlowError(
      `Auto Plan '${planId}' uses retired schema version 1 and cannot authorize execution.`,
      {
        code: 'AUTO_PLAN_LEGACY_UNSUPPORTED',
        details: {
          storedVersion: 1,
          nextAction: 'Create and review a new Auto Plan; legacy Plan-SHA confirmation is retired.'
        },
        cause: error
      }
    );
  }
  const plan = loaded.record;
  if (plan.kind !== 'auto-plan' || plan.mode !== 'auto'
      || plan.confirmation?.protocol !== 'packet-v1'
      || plan.planId !== planId || plan.planSha256 !== autoPlanHash(plan)) {
    throw new SingularityFlowError(`Auto Plan '${planId}' failed its integrity check.`, { code: 'AUTO_PLAN_CORRUPT' });
  }
  // Recheck every persisted transport before rendering or executing the Plan. This protects
  // upgraded repositories as well as records copied from another machine.
  try {
    if (plan.bindings?.repository) assertCredentialFreeRemote(plan.bindings.repository);
    for (const repository of plan.repositories ?? []) {
      if (repository.remoteUrl) assertCredentialFreeRemote(repository.remoteUrl);
    }
  } catch (error) {
    throw new SingularityFlowError(`Auto Plan '${planId}' contains an unsafe repository authority.`, {
      code: 'AUTO_PLAN_REMOTE_UNSAFE', cause: error
    });
  }
  return plan;
}

async function revalidateAutoPlanInScope(root, plan) {
  const changed = [];
  if (Date.parse(plan.expiresAt) <= Date.now()) throw new SingularityFlowError(`Auto Plan '${plan.planId}' expired.`, {
    code: 'AUTO_PLAN_EXPIRED', details: { nextAction: 'Create and review a new Auto Plan.' }
  });
  if (head(root) !== plan.bindings.head) changed.push('HEAD changed');
  if (branch(root) !== plan.bindings.branch) changed.push('branch changed');
  if (plan.bindings.autoPolicySha256) {
    const definition = await loadDefinition(root);
    if (autoPolicySha256(definition) !== plan.bindings.autoPolicySha256) changed.push('Auto policy changed');
  } else if (committedFileSha(root, 'singularity/workflow.yml') !== plan.bindings.workflowSha256) {
    changed.push('workflow changed');
  }
  if (plan.capability) {
    const capability = await resolveLifecycleCapability(root, { capabilityId: plan.capability.id, required: true });
    if (capability.map.sha256 !== plan.capability.mapSha256) changed.push('capability map changed');
  }
  const configuredRoot = configuredRemoteIdentity(root, plan.repositories[0]?.remote ?? 'origin', {
    direction: 'fetch'
  });
  if (!configuredRoot.url || configuredRoot.ambiguous
      || (plan.bindings.repositoryFingerprint
        && configuredRoot.fingerprint !== plan.bindings.repositoryFingerprint)) {
    changed.push('root repository remote identity changed');
  }
  for (const repository of plan.repositories) {
    let remoteUrl;
    try {
      remoteUrl = repository.remoteUrl
        ? assertCredentialFreeRemote(repository.remoteUrl)
        : configuredRoot.url;
    }
    catch { remoteUrl = null; }
    if (!remoteUrl || (repository.remoteFingerprint
        && remoteFingerprint(remoteUrl) !== repository.remoteFingerprint)) {
      changed.push(`${repository.id} remote identity changed`);
      continue;
    }
    const published = remoteHead(root, remoteUrl, repository.baseBranch);
    if (published !== repository.baseCommit) changed.push(`${repository.id} published base changed`);
  }
  const flightPlan = await readChangeFlightPlan(root, plan.bindings.flightPlanId);
  if (`sha256:${recordSha256(flightPlan)}` !== plan.bindings.flightPlanSha256) changed.push('Change Flight Plan changed');
  if (changed.length) throw new SingularityFlowError(`Auto Plan '${plan.planId}' is stale: ${changed.join(', ')}.`, {
    code: 'AUTO_PLAN_STALE', details: { changed, nextAction: 'Create and review a new Auto Plan.' }
  });
  return { valid: true, checkedAt: nowIso() };
}

export async function revalidateAutoPlan(root, plan) {
  return withApprovedConfigurationRead(root, async (authority) => {
    if (!authority) throw new SingularityFlowError('Auto Plan cannot revalidate without approved configuration.', {
      code: 'APPROVED_CONFIGURATION_UNAVAILABLE'
    });
    return revalidateAutoPlanInScope(root, plan);
  }, { preferAuthority: true });
}

export async function ratifyAutoPlan(root, planIdValue, confirmation) {
  const plan = await readAutoPlan(root, planIdValue);
  const packet = buildAutoPlanPacket(plan);
  const packetSha256 = packet.packetSha256;
  const suppliedConfirmation = String(confirmation ?? '');
  if (!PLAN_HASH.test(suppliedConfirmation) || suppliedConfirmation !== packetSha256) {
    throw new SingularityFlowError(`Starting Auto requires --confirm ${packetSha256}.`, {
      code: 'AUTO_PLAN_CONFIRMATION_REQUIRED',
      details: {
        planId: plan.planId,
        expected: packetSha256
      }
    });
  }
  if (!plan.safety.startable) throw new SingularityFlowError(`Auto Plan '${plan.planId}' is not startable: ${plan.safety.reasons.join('; ')}.`, {
    code: 'AUTO_PLAN_NOT_STARTABLE', details: { reasons: plan.safety.reasons }
  });
  await revalidateAutoPlan(root, plan);
  let existing = await readVerifiedAutoAuthorization(root, plan.planId, {
    optional: true,
    expectedPlanSha256: plan.planSha256,
    expectedPacketSha256: packetSha256
  });
  if (existing?.consumedAt) {
    throw new SingularityFlowError(`Auto Plan '${plan.planId}' authorization was already consumed.`, {
      code: 'AUTO_AUTHORIZATION_CONSUMED', details: { flightId: existing.flightId ?? null }
    });
  }
  if (existing?.claimedAt) {
    const leaseExpired = Date.parse(existing.claimExpiresAt ?? existing.expiresAt) <= Date.now();
    if (!leaseExpired && claimOwnerAlive(existing.claimOwner)) throw new SingularityFlowError(`Auto Plan '${plan.planId}' authorization is claimed by an active start.`, {
      code: 'AUTO_AUTHORIZATION_CONSUMED', details: { flightId: existing.flightId ?? null, claimExpiresAt: existing.claimExpiresAt ?? null }
    });
    const effects = await claimedEffects(root, plan, existing);
    if (effects.flight) {
      const consumed = sealAuthorization({ ...existing, consumedAt: nowIso(), claimExpiresAt: null });
      await writeAutoPrivateRecord(
        root, authorizationFile(root, plan.planId), 'authorization', canonicalJson(consumed)
      );
      throw new SingularityFlowError(`Auto Plan '${plan.planId}' already created flight '${existing.flightId}'.`, {
        code: 'AUTO_AUTHORIZATION_CONSUMED', details: { flightId: existing.flightId, recovered: true }
      });
    }
    if (effects.start) return { plan, authorization: { ...existing, recovery: 'reconstruct-flight' } };
    existing = sealAuthorization({
      ...existing, claimedAt: null, claimExpiresAt: null, claimOwner: null, claimId: null, flightId: null
    });
    await writeAutoPrivateRecord(
      root, authorizationFile(root, plan.planId), 'authorization', canonicalJson(existing)
    );
  }
  const actor = identity(root, { offline: true });
  if (existing?.planSha256 === plan.planSha256) {
    if (!sameActor(existing.actor, actor)) throw new SingularityFlowError(
      `Auto Plan '${plan.planId}' was ratified by another configured identity.`,
      { code: 'AUTO_AUTHORIZATION_STALE' }
    );
    return { plan, authorization: existing };
  }
  const authorization = sealAuthorization({
    schemaVersion: currentSchemaVersion('auto-authorization'), kind: 'auto-plan-ratification', mode: 'auto',
    planId: plan.planId, planSha256: plan.planSha256,
    confirmationProtocol: 'packet-v1',
    confirmedSha256: suppliedConfirmation,
    packetSha256,
    validationSha256: packet.validationSha256,
    actor: { name: actor.name, email: actor.email, login: actor.login },
    identityAssurance: 'configured-local', ratifiedAt: nowIso(), expiresAt: plan.expiresAt,
    claimedAt: null, consumedAt: null, flightId: null
  });
  await writeAutoPrivateRecord(
    root, authorizationFile(root, plan.planId), 'authorization', canonicalJson(authorization)
  );
  return { plan, authorization };
}

function sealAuthorization(value) {
  const record = structuredClone(value);
  delete record.recordSha256;
  delete record.authorizationSha256;
  const authority = {
    schemaVersion: record.schemaVersion, kind: record.kind, mode: record.mode,
    planId: record.planId, planSha256: record.planSha256,
    actor: record.actor, identityAssurance: record.identityAssurance,
    ratifiedAt: record.ratifiedAt, expiresAt: record.expiresAt
  };
  for (const field of [
    'confirmationProtocol', 'confirmedSha256', 'packetSha256', 'validationSha256'
  ]) {
    if (record[field] != null) authority[field] = record[field];
  }
  record.authorizationSha256 = `sha256:${recordSha256(authority)}`;
  record.recordSha256 = recordSha256(record);
  return record;
}

export async function claimAutoAuthorization(root, plan, authorization, flightId) {
  return withSubjectLock(root, { kind: 'auto-plan', id: plan.planId }, async () => {
    const packetSha256 = buildAutoPlanPacket(plan).packetSha256;
    const stored = await readVerifiedAutoAuthorization(root, plan.planId, {
      expectedPlanSha256: plan.planSha256,
      expectedPacketSha256: packetSha256
    });
    if (stored.planSha256 !== plan.planSha256) {
      throw new SingularityFlowError(`Auto authorization for '${plan.planId}' failed its integrity check.`, { code: 'AUTO_AUTHORIZATION_CORRUPT' });
    }
    if (stored.consumedAt) throw new SingularityFlowError(`Auto Plan '${plan.planId}' authorization was already consumed.`, {
      code: 'AUTO_AUTHORIZATION_CONSUMED', details: { flightId: stored.flightId }
    });
    if (stored.claimedAt) {
      if (stored.flightId === flightId && authorization.recovery === 'reconstruct-flight') {
        const renewed = sealAuthorization({
          ...stored,
          claimExpiresAt: new Date(Date.now() + AUTO_CLAIM_LEASE_MS).toISOString()
        });
        await writeAutoPrivateRecord(
          root, authorizationFile(root, plan.planId), 'authorization', canonicalJson(renewed)
        );
        return renewed;
      }
      throw new SingularityFlowError(`Auto Plan '${plan.planId}' authorization is already claimed.`, {
        code: 'AUTO_AUTHORIZATION_CONSUMED', details: { flightId: stored.flightId }
      });
    }
    if (authorization.recordSha256 !== stored.recordSha256) throw new SingularityFlowError('Auto authorization changed before start.', { code: 'AUTO_AUTHORIZATION_STALE' });
    if (!sameActor(stored.actor, identity(root, { offline: true }))) {
      throw new SingularityFlowError('Auto authorization identity changed before start.', { code: 'AUTO_AUTHORIZATION_STALE' });
    }
    const claimed = sealAuthorization({
      ...stored,
      claimedAt: nowIso(),
      claimExpiresAt: new Date(Date.now() + AUTO_CLAIM_LEASE_MS).toISOString(),
      claimId: randomUUID(),
      claimOwner: { host: os.hostname(), pid: process.pid },
      flightId
    });
    await writeAutoPrivateRecord(
      root, authorizationFile(root, plan.planId), 'authorization', canonicalJson(claimed)
    );
    return claimed;
  });
}

export async function finishAutoAuthorization(root, planIdValue, flightId, { success }) {
  const planId = validatePlanId(planIdValue);
  return withSubjectLock(root, { kind: 'auto-plan', id: planId }, async () => {
    const plan = await readAutoPlan(root, planId);
    const packetSha256 = buildAutoPlanPacket(plan).packetSha256;
    const stored = await readVerifiedAutoAuthorization(root, planId, {
      expectedPlanSha256: plan.planSha256,
      expectedPacketSha256: packetSha256
    });
    if (stored.flightId !== flightId || !stored.claimedAt || stored.consumedAt) {
      throw new SingularityFlowError(`Auto authorization for '${planId}' is not claimed by '${flightId}'.`, { code: 'AUTO_AUTHORIZATION_STALE' });
    }
    const next = success
      ? sealAuthorization({ ...stored, consumedAt: nowIso(), claimExpiresAt: null })
      : sealAuthorization({
          ...stored, claimedAt: null, claimExpiresAt: null, claimOwner: null, claimId: null, flightId: null
        });
    await writeAutoPrivateRecord(
      root, authorizationFile(root, planId), 'authorization', canonicalJson(next)
    );
    return next;
  });
}
