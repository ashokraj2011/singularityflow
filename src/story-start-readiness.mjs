/**
 * Read-only Story-start readiness projection shared by CLI, VS Code, and programmatic starts.
 *
 * The callers own network observation and configuration loading. This module deliberately performs
 * no I/O: it turns those already-verified facts into one bounded result that can be shown before a
 * Story mutation and recomputed immediately before the mutation. It is not durable authority and it
 * can never authorize an upgrade, enrollment, checkout, commit, or push.
 */
import { createHash } from 'node:crypto';

import { BUILD_INFO } from './build-info.mjs';
import { assertPlannedClaimsReady, resolveWorkType } from './config.mjs';
import { SingularityFlowError } from './util.mjs';
import { VERSION } from './version.mjs';

// This is an ephemeral projection contract, not a durable stored-record schema. Keep its wire
// version explicit without registering it in the durable migration registry.
export const STORY_START_READINESS_FORMAT_VERSION = 1;

export function requiredRepositoryReadinessScope(definition = {}) {
  const policy = {
    ...(definition?.repositoryReadiness ?? {}),
    ...(definition?.initialization?.proof?.preStory ?? {})
  };
  return (policy.build ?? 'off') !== 'off' || (policy.applicationStart ?? 'off') !== 'off'
    ? 'full'
    : 'dependency-test';
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function check(id, status, code, message) {
  return Object.freeze({ id, status, code, message });
}

function configurationIdentity(snapshot) {
  if (!snapshot) return null;
  const assets = [...(snapshot.assets ?? [])]
    .map((entry) => ({ path: entry.relative, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    branch: snapshot.authority?.branch ?? null,
    commit: snapshot.sourceCommit ?? snapshot.authority?.commit ?? null,
    filesSha256: digest(assets)
  });
}

function runtimeIdentity() {
  return Object.freeze({
    version: VERSION,
    build: BUILD_INFO.commit ?? BUILD_INFO.sourceSha256 ?? null,
    stamped: Boolean(BUILD_INFO.commit || BUILD_INFO.sourceSha256)
  });
}

/**
 * Project the exact facts already proven by Story-start preflight.
 *
 * `repositories` must contain only normalized identifiers and commit/ref evidence. Remote URLs and
 * machine paths are intentionally excluded so this result is safe for logs and editor rendering.
 */
export function inspectStoryStartReadiness({
  workId,
  definition,
  configurationSnapshot = null,
  workType = null,
  capabilityId = null,
  baseBranch = null,
  repositories = [],
  repositoryReadiness = null,
  publicationRequired = true,
  surface = 'shell'
} = {}) {
  const checks = [];
  const configuration = configurationIdentity(configurationSnapshot);

  if (configuration?.commit && configuration?.filesSha256) {
    checks.push(check(
      'configuration-authority', 'pass', 'CONFIGURATION_AUTHORITY_VALID',
      `Approved configuration ${configuration.branch ?? 'authority'} is pinned to one exact revision.`
    ));
  } else {
    checks.push(check(
      'configuration-authority', 'warning', 'CONFIGURATION_AUTHORITY_LEGACY_FALLBACK',
      'No shared configuration snapshot is pinned yet; the selected base must carry the validated workflow.'
    ));
  }

  let resolved = null;
  if (!workType) {
    checks.push(check(
      'workflow', 'warning', 'STORY_WORKFLOW_SELECTION_PENDING',
      'Choose a Story workflow before the final start.'
    ));
  } else {
    try {
      resolved = assertPlannedClaimsReady(resolveWorkType(definition, workType));
      checks.push(check(
        'workflow', 'pass', 'STORY_WORKFLOW_VALID',
        `Workflow '${workType}' resolves to ${resolved.phases.length} governed phase(s).`
      ));
      const invalid = resolved.phases.find((phase) => !phase.defaultAgent
        || !definition.agents?.[phase.defaultAgent]);
      checks.push(invalid
        ? check(
            'governed-agents', 'block', 'STORY_PHASE_DEFAULT_AGENT_INVALID',
            `Phase '${invalid.id}' does not resolve to exactly one installed default governed agent.`
          )
        : check(
            'governed-agents', 'pass', 'STORY_PHASE_DEFAULT_AGENTS_VALID',
            'Every phase resolves to an installed default governed agent.'
          ));
    } catch (error) {
      checks.push(check(
        'workflow', 'block', error?.code ?? 'STORY_WORKFLOW_INVALID',
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  const normalizedRepositories = repositories.map((entry, index) => Object.freeze({
    id: String(entry.id ?? entry.repository ?? `repository-${index + 1}`),
    baseBranch: entry.baseBranch ?? baseBranch ?? null,
    baseCommit: entry.baseCommit ?? null,
    destinationRef: entry.destinationRef ?? null,
    publishRequired: entry.publishRequired ?? publicationRequired
  }));
  const invalidRepository = normalizedRepositories.find((entry) => !entry.baseBranch
    || !entry.baseCommit || !entry.destinationRef);
  if (!baseBranch || !normalizedRepositories.length || invalidRepository) {
    checks.push(check(
      'git-publication', 'block', 'STORY_GIT_PREFLIGHT_INCOMPLETE',
      'The selected base and exact destination publication have not been proven for every required repository.'
    ));
  } else {
    checks.push(check(
      'git-publication', 'pass', 'STORY_GIT_PREFLIGHT_VALID',
      `Base '${baseBranch}' and the Story destination are ready in ${normalizedRepositories.length} repository/repositories.`
    ));
  }

  const repositoryReadinessPolicy = {
    ...(definition?.repositoryReadiness ?? {}),
    ...(definition?.initialization?.proof?.preStory ?? {})
  };
  const repositoryReadinessRequired = repositoryReadinessPolicy.requiredBeforeStory === true;
  const readinessScope = requiredRepositoryReadinessScope(definition);
  if (repositoryReadinessRequired) {
    const receipts = repositoryReadiness?.repositories
      ?? (normalizedRepositories.length === 1 && repositoryReadiness
        ? { [normalizedRepositories[0].id]: repositoryReadiness } : {});
    const invalid = normalizedRepositories.find((entry) => {
      const receipt = receipts[entry.id];
      if (receipt?.status !== 'pass'
          || (receipt?.sourceCommit ?? receipt?.sourceHead) !== entry.baseCommit) return true;
      const passedPurposes = new Set((receipt.commandResults ?? [])
        .filter((result) => result.status === 'pass').map((result) => result.purpose));
      if (repositoryReadinessPolicy.dependencyHydration === 'required'
          && !passedPurposes.has('dependency')) return true;
      if (repositoryReadinessPolicy.build === 'required' && !passedPurposes.has('build')) return true;
      if (repositoryReadinessPolicy.applicationStart === 'required'
          && !passedPurposes.has('start')) return true;
      const structuredTests = repositoryReadinessPolicy.structuredTests;
      const codeDetected = (receipt.detectedStacks?.length ?? 0) > 0
        || [...passedPurposes].some((purpose) => ['dependency', 'build', 'test'].includes(purpose));
      if (structuredTests === 'required'
          && receipt.structuredTestContract?.status !== 'available') return true;
      return structuredTests === 'required-for-code' && codeDetected
        && receipt.structuredTestContract?.status !== 'available';
    });
    const complete = normalizedRepositories.length > 0 && !invalid;
    checks.push(complete
      ? check(
          'repository-execution', 'pass', 'STORY_REPOSITORY_READINESS_VALID',
          'Locked dependency and existing structured-test readiness is policy-complete for the exact Story base.'
        )
      : check(
          'repository-execution', 'block', 'STORY_REPOSITORY_READINESS_REQUIRED',
          'The selected base lacks a current policy-complete repository-readiness receipt. Run the pre-Story readiness plan before creating a Story worktree.'
        ));
  }

  checks.push(check(
    'optional-intelligence', 'pass', 'STORY_OPTIONAL_INTELLIGENCE_NON_BLOCKING',
    'World Model, AST, model-provider, telemetry, and Copilot availability do not block Story creation.'
  ));

  const blocking = checks.filter((entry) => entry.status === 'block');
  const warnings = checks.filter((entry) => entry.status === 'warning');
  const status = blocking.length ? 'blocked' : warnings.length ? 'ready-with-warnings' : 'ready';
  const authority = configuration ?? Object.freeze({ branch: null, commit: null, filesSha256: null });
  const receiptFacts = {
    workId: String(workId ?? ''), workType, capabilityId, baseBranch,
    configurationCommit: authority.commit,
    repositoryReadinessSha256: repositoryReadiness?.repositories
      ? Object.fromEntries(Object.entries(repositoryReadiness.repositories)
        .map(([id, receipt]) => [id, receipt?.receiptSha256 ?? null]))
      : repositoryReadiness?.receiptSha256 ?? null,
    baseCommits: Object.fromEntries(normalizedRepositories.map((entry) => [entry.id, entry.baseCommit])),
    destinationRefs: Object.fromEntries(normalizedRepositories.map((entry) => [entry.id, entry.destinationRef]))
  };

  return Object.freeze({
    schemaVersion: STORY_START_READINESS_FORMAT_VERSION,
    resultType: 'story-start-readiness',
    status,
    ready: blocking.length === 0,
    provisional: true,
    surface,
    workId: String(workId ?? ''),
    workType,
    capabilityId,
    authority,
    base: Object.freeze({ branch: baseBranch, repositories: Object.freeze(normalizedRepositories) }),
    runtime: runtimeIdentity(),
    repositoryExecution: Object.freeze({
      required: repositoryReadinessRequired,
      scope: readinessScope
    }),
    checks: Object.freeze(checks),
    blockers: Object.freeze(blocking),
    warnings: Object.freeze(warnings),
    upgrade: Object.freeze({
      mode: 'prompt',
      status: 'review-on-request',
      automatic: 'compatible records are migrated in memory; shared configuration is never silently rewritten',
      safeToApply: false,
      planId: null,
      shell: 'singularity-flow workspace reinitialize --dry-run --json',
      copilot: '/sf-admin'
    }),
    receipt: Object.freeze({
      configurationCommit: authority.commit,
      baseCommits: Object.freeze(receiptFacts.baseCommits),
      readinessSha256: digest(receiptFacts)
    })
  });
}

export function assertStoryStartReady(readiness) {
  if (readiness?.ready) return readiness;
  const first = readiness?.blockers?.[0];
  const configurationRepair = ['configuration-authority', 'workflow', 'governed-agents']
    .includes(first?.id);
  const repositoryRepair = first?.id === 'repository-execution';
  const repositoryScope = readiness?.repositoryExecution?.scope ?? 'dependency-test';
  const repositorySkill = repositoryScope === 'full' ? '/sf-ready --full' : '/sf-ready';
  throw new SingularityFlowError(first?.message ?? 'Story-start readiness failed.', {
    code: first?.code ?? 'STORY_START_NOT_READY',
    details: {
      readiness,
      ...(configurationRepair ? {
        nextAction: readiness.upgrade?.shell ?? null,
        nextSkill: readiness.upgrade?.copilot ?? null,
        recoveryCommands: [readiness.upgrade?.shell].filter(Boolean)
      } : repositoryRepair ? {
        nextAction: `singularity-flow precheck --run --scope ${repositoryScope} --json`,
        nextSkill: repositorySkill,
        recoveryCommands: [`singularity-flow precheck --run --scope ${repositoryScope} --json`]
      } : {})
    }
  });
}
