/**
 * AUT v1 Plan synthesis and exact-hash ratification.
 *
 * A Plan is machine-local and disposable until `ratifyAutoPlan` succeeds. Planning may inspect
 * committed state and may ask a model for a proposal, but it cannot create lifecycle state, refs,
 * worktrees, approvals, or authorization. Every model-proposed field is revalidated here.
 */
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
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
import { exists, nowIso, run, SingularityFlowError, writeAtomic } from '../util.mjs';
import {
  AUTO_AUTHORING_TOOLS, effectiveAutoPolicy, parseAutoPace, parseAutoStopSelector
} from './auto-policy.mjs';
import { executionUnitDriverDoctor } from './execution-unit-driver.mjs';
import { runRemoteGit } from '../git-execution.mjs';

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

export async function synthesizeAutoPlanProposal(root, requirement, { definition = null } = {}) {
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

function workIdFor(requirement, config, explicit = null) {
  if (explicit) return String(explicit).trim();
  if (config.auto.workIdAllocator === 'require-explicit') {
    throw new SingularityFlowError('Auto policy requires --work-id ID.', { code: 'AUTO_PLAN_INVALID' });
  }
  return `AUT-${sha256(`${requirement}\0${nowIso()}`).slice(0, 12).toUpperCase()}`;
}

function remoteHead(root, remote, branchName) {
  const result = runRemoteGit(['ls-remote', '--heads', '--', remote, `refs/heads/${branchName}`], {
    cwd: root, operation: 'remote-probe'
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\s+/)[0] || null;
}

function committedFileSha(root, relative) {
  const result = run('git', ['show', `HEAD:${relative}`], { cwd: root, allowFailure: true, maxBuffer: 8 * 1024 * 1024 });
  return result.status === 0 ? sha256(result.stdout) : null;
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

export function autoPlanHash(plan) {
  const copy = structuredClone(plan);
  delete copy.planSha256;
  return `sha256:${recordSha256(copy)}`;
}

/** Build and persist a Plan from an untrusted proposal. This function never starts governed work. */
export async function createAutoPlan(root, requirementValue, proposalValue, options = {}) {
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
  const catalog = options.baseCatalog ?? await storyBaseCatalog(root, {
    remote, defaultBranch: definition.defaultBaseBranch, capabilityId: capability?.id
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
  const baseHeads = Object.fromEntries(catalog.repositories.map((repository) => [
    repository.id,
    remoteHead(repository.path ?? root, repository.url || remote, baseBranch)
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
  const pilotWindow = ['continuous', 'phase'].includes(pace.mode) && selectorWithinPilot;
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
    requirement: { text: requirement, sha256: sha256(requirement) },
    proposal: {
      title: cleanTitle(proposal.title, requirement), assumptions: proposal.assumptions,
      unresolvedDecisions: proposal.unresolvedDecisions, predictedPaths: proposal.predictedPaths,
      acceptanceCriteria: proposal.acceptanceCriteria
    },
    story: { workId, workType, branch: workId, phaseRail: resolution.phases.map((phase) => phase.id) },
    execution: {
      pace, until, ceilings: policy.ceilings, concurrency: policy.concurrency,
      eligibility: policy.eligibility
    },
    humanBoundaries: {
      firstPhaseClarificationRequired: resolution.phases[0]?.clarification?.mode === 'required',
      stopPoints: humanStopPoints(resolution.phases)
    },
    scope: { protectedPaths, status: protectedPaths.length ? 'protected-predicted' : flightPlan.status },
    capability: capability ? { id: capability.id, mapSha256: capability.map.sha256, path: capability.path } : null,
    repositories: catalog.repositories.map((repository) => ({
      id: repository.id, remote, remoteUrl: repository.url ?? null,
      baseBranch, baseCommit: baseHeads[repository.id]
    })),
    executionHost,
    accounting: {
      scope: 'predicted',
      tokens: options.synthesis?.usage?.totalTokens != null ? 'exact' : 'unavailable',
      cost: 'unavailable'
    },
    bindings: {
      repository: run('git', ['config', '--get', 'remote.origin.url'], { cwd: root, allowFailure: true }).stdout.trim() || path.resolve(root),
      head: head(root), branch: branch(root), workflowSha256: committedFileSha(root, 'singularity/workflow.yml'),
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
        ...(!pilotWindow ? ['the thin pilot authorizes only continuous/phase pace through the first phase or human boundary'] : []),
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
  await writeAtomic(planFile(root, planId), canonicalJson(plan), { mode: 0o600 });
  return plan;
}

export async function readAutoPlan(root, planIdValue) {
  const planId = validatePlanId(planIdValue);
  let raw;
  try { raw = await readFile(planFile(root, planId), 'utf8'); }
  catch (error) {
    throw new SingularityFlowError(`Auto Plan '${planId}' is not available in this repository.`, {
      code: 'AUTO_PLAN_NOT_FOUND', cause: error
    });
  }
  const plan = readRecord('auto-plan', raw).record;
  if (plan.planId !== planId || plan.planSha256 !== autoPlanHash(plan)) {
    throw new SingularityFlowError(`Auto Plan '${planId}' failed its integrity check.`, { code: 'AUTO_PLAN_CORRUPT' });
  }
  return plan;
}

export async function revalidateAutoPlan(root, plan) {
  const changed = [];
  if (Date.parse(plan.expiresAt) <= Date.now()) throw new SingularityFlowError(`Auto Plan '${plan.planId}' expired.`, {
    code: 'AUTO_PLAN_EXPIRED', details: { nextAction: 'Create and review a new Auto Plan.' }
  });
  if (head(root) !== plan.bindings.head) changed.push('HEAD changed');
  if (branch(root) !== plan.bindings.branch) changed.push('branch changed');
  if (committedFileSha(root, 'singularity/workflow.yml') !== plan.bindings.workflowSha256) changed.push('workflow changed');
  if (plan.capability) {
    const capability = await resolveLifecycleCapability(root, { capabilityId: plan.capability.id, required: true });
    if (capability.map.sha256 !== plan.capability.mapSha256) changed.push('capability map changed');
  }
  for (const repository of plan.repositories) {
    const published = remoteHead(root, repository.remoteUrl || repository.remote, repository.baseBranch);
    if (published !== repository.baseCommit) changed.push(`${repository.id} published base changed`);
  }
  const flightPlan = await readChangeFlightPlan(root, plan.bindings.flightPlanId);
  if (`sha256:${recordSha256(flightPlan)}` !== plan.bindings.flightPlanSha256) changed.push('Change Flight Plan changed');
  if (changed.length) throw new SingularityFlowError(`Auto Plan '${plan.planId}' is stale: ${changed.join(', ')}.`, {
    code: 'AUTO_PLAN_STALE', details: { changed, nextAction: 'Create and review a new Auto Plan.' }
  });
  return { valid: true, checkedAt: nowIso() };
}

export async function ratifyAutoPlan(root, planIdValue, confirmation) {
  const plan = await readAutoPlan(root, planIdValue);
  if (!PLAN_HASH.test(String(confirmation ?? '')) || confirmation !== plan.planSha256) {
    throw new SingularityFlowError(`Starting Auto requires --confirm ${plan.planSha256}.`, {
      code: 'AUTO_PLAN_CONFIRMATION_REQUIRED', details: { planId: plan.planId, expected: plan.planSha256 }
    });
  }
  if (!plan.safety.startable) throw new SingularityFlowError(`Auto Plan '${plan.planId}' is not startable: ${plan.safety.reasons.join('; ')}.`, {
    code: 'AUTO_PLAN_NOT_STARTABLE', details: { reasons: plan.safety.reasons }
  });
  await revalidateAutoPlan(root, plan);
  let existing = null;
  try { existing = readRecord('auto-authorization', await readFile(authorizationFile(root, plan.planId), 'utf8')).record; }
  catch { /* first ratification */ }
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
      await writeAtomic(authorizationFile(root, plan.planId), canonicalJson(consumed), { mode: 0o600 });
      throw new SingularityFlowError(`Auto Plan '${plan.planId}' already created flight '${existing.flightId}'.`, {
        code: 'AUTO_AUTHORIZATION_CONSUMED', details: { flightId: existing.flightId, recovered: true }
      });
    }
    if (effects.start) return { plan, authorization: { ...existing, recovery: 'reconstruct-flight' } };
    existing = sealAuthorization({
      ...existing, claimedAt: null, claimExpiresAt: null, claimOwner: null, claimId: null, flightId: null
    });
    await writeAtomic(authorizationFile(root, plan.planId), canonicalJson(existing), { mode: 0o600 });
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
    actor: { name: actor.name, email: actor.email, login: actor.login },
    identityAssurance: 'configured-local', ratifiedAt: nowIso(), expiresAt: plan.expiresAt,
    claimedAt: null, consumedAt: null, flightId: null
  });
  await writeAtomic(authorizationFile(root, plan.planId), canonicalJson(authorization), { mode: 0o600 });
  return { plan, authorization };
}

function sealAuthorization(value) {
  const record = structuredClone(value);
  delete record.recordSha256;
  delete record.authorizationSha256;
  record.authorizationSha256 = `sha256:${recordSha256({
    schemaVersion: record.schemaVersion, kind: record.kind, mode: record.mode,
    planId: record.planId, planSha256: record.planSha256,
    actor: record.actor, identityAssurance: record.identityAssurance,
    ratifiedAt: record.ratifiedAt, expiresAt: record.expiresAt
  })}`;
  record.recordSha256 = recordSha256(record);
  return record;
}

export async function claimAutoAuthorization(root, plan, authorization, flightId) {
  return withSubjectLock(root, { kind: 'auto-plan', id: plan.planId }, async () => {
    const stored = readRecord('auto-authorization', await readFile(authorizationFile(root, plan.planId), 'utf8')).record;
    if (stored.planSha256 !== plan.planSha256 || stored.recordSha256 !== sealAuthorization(stored).recordSha256) {
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
        await writeAtomic(authorizationFile(root, plan.planId), canonicalJson(renewed), { mode: 0o600 });
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
    await writeAtomic(authorizationFile(root, plan.planId), canonicalJson(claimed), { mode: 0o600 });
    return claimed;
  });
}

export async function finishAutoAuthorization(root, planIdValue, flightId, { success }) {
  const planId = validatePlanId(planIdValue);
  return withSubjectLock(root, { kind: 'auto-plan', id: planId }, async () => {
    const stored = readRecord('auto-authorization', await readFile(authorizationFile(root, planId), 'utf8')).record;
    if (stored.flightId !== flightId || !stored.claimedAt || stored.consumedAt) {
      throw new SingularityFlowError(`Auto authorization for '${planId}' is not claimed by '${flightId}'.`, { code: 'AUTO_AUTHORIZATION_STALE' });
    }
    const next = success
      ? sealAuthorization({ ...stored, consumedAt: nowIso(), claimExpiresAt: null })
      : sealAuthorization({
          ...stored, claimedAt: null, claimExpiresAt: null, claimOwner: null, claimId: null, flightId: null
        });
    await writeAtomic(authorizationFile(root, planId), canonicalJson(next), { mode: 0o600 });
    return next;
  });
}
