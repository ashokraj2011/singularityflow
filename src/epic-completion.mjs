import { createHash } from 'node:crypto';
import path from 'node:path';
import { identity } from './git.mjs';
import { authorityDescription, isAuthorized } from './initiative-evidence.mjs';
import { loadInitiativeBreakdown } from './initiative-repositories.mjs';
import {
  loadInitiative, secureInitiativePath
} from './state-stores.mjs';
import {
  SingularityFlowError, nowIso, writeJson, writeText
} from './util.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';

const EPIC_COMPLETION_AUTHORITY = 'product-approvers';
const EPIC_COMPLETION_AUTHORITY_CODES = new Set([
  'EPIC_COMPLETION_AUTHORITY_MISSING',
  'EPIC_COMPLETION_AUTHORITY_INVALID',
  'EPIC_COMPLETION_UNAUTHORIZED'
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function actorKey(actor) {
  return actor?.email?.toLowerCase() ?? actor?.name;
}

function completionApprovalPolicy(initiative) {
  const policy = initiative.resolution?.phases
    ?.find((phase) => phase.id === 'epic-planning')?.bundleApproval;
  if (!policy || policy.mode === 'none') {
    throw new SingularityFlowError(
      `Epic '${initiative.initiative.id}' has no configured Product Owner approval authority in its immutable epic-planning resolution; completion is refused.`,
      {
        code: 'EPIC_COMPLETION_AUTHORITY_MISSING',
        details: {
          initiativeId: initiative.initiative.id,
          requiredAuthority: EPIC_COMPLETION_AUTHORITY,
          resolutionSha256: initiative.resolution?.resolutionSha256 ?? null
        }
      }
    );
  }
  const authorities = new Set([
    ...(policy.authorities ?? []),
    ...(policy.chain ?? []).map((step) => step.authority)
  ]);
  if (!authorities.has(EPIC_COMPLETION_AUTHORITY)) {
    throw new SingularityFlowError(
      `Epic '${initiative.initiative.id}' immutable epic-planning resolution does not assign completion to '${EPIC_COMPLETION_AUTHORITY}'; completion is refused.`,
      {
        code: 'EPIC_COMPLETION_AUTHORITY_INVALID',
        details: {
          initiativeId: initiative.initiative.id,
          requiredAuthority: EPIC_COMPLETION_AUTHORITY,
          configuredAuthorities: [...authorities].sort(),
          resolutionSha256: initiative.resolution?.resolutionSha256 ?? null
        }
      }
    );
  }
  return policy;
}

export async function assertEpicCompletionAuthorized(root, initiativeId, {
  actor = null,
  initiative: suppliedInitiative = null
} = {}) {
  const initiative = suppliedInitiative ?? (await loadInitiative(root, initiativeId)).initiative;
  if (initiative.resolution.profile !== 'epic-planning') {
    throw new SingularityFlowError('Epic delivery completion is available only for the epic-planning profile.', {
      code: 'EPIC_COMPLETION_PROFILE_REQUIRED',
      details: { initiativeId, profile: initiative.resolution.profile }
    });
  }
  const resolvedActor = actor ?? identity(root);
  const policy = completionApprovalPolicy(initiative);
  // Completion is the final Product Owner decision, not another signature in the planning chain.
  // A chain check without decision history deliberately accepts the union for other callers; that
  // would let (for example) an architecture reviewer complete an Epic. Narrow this decision to the
  // immutable Product Owner authority instead.
  const completionPolicy = {
    mode: 'required',
    authorities: [EPIC_COMPLETION_AUTHORITY],
    minimum: 1,
    chain: null
  };
  if (!isAuthorized(initiative.resolution, completionPolicy, resolvedActor)) {
    throw new SingularityFlowError(
      `${actorKey(resolvedActor) ?? 'Unconfigured local Git identity'} is not authorized to record the Product Owner completion decision for Epic '${initiativeId}'. Required authority: ${authorityDescription(completionPolicy)}.`,
      {
        code: 'EPIC_COMPLETION_UNAUTHORIZED',
        details: {
          initiativeId,
          actor: actorKey(resolvedActor) ?? null,
          requiredAuthority: EPIC_COMPLETION_AUTHORITY,
          resolutionSha256: initiative.resolution?.resolutionSha256 ?? null
        }
      }
    );
  }
  return { actor: resolvedActor, policy: completionPolicy, planningPolicy: policy };
}

export async function epicCompletionAuthorizationStatus(root, initiativeId, options = {}) {
  try {
    const authorization = await assertEpicCompletionAuthorized(root, initiativeId, options);
    return {
      ready: true,
      code: null,
      actor: actorKey(authorization.actor),
      requiredAuthority: EPIC_COMPLETION_AUTHORITY,
      identityAssurance: 'configured-local',
      warning: 'Local Git identity is configurable and is not cryptographic authentication.'
    };
  } catch (error) {
    if (!EPIC_COMPLETION_AUTHORITY_CODES.has(error?.code)) throw error;
    return {
      ready: false,
      code: error.code,
      actor: error.details?.actor ?? null,
      requiredAuthority: EPIC_COMPLETION_AUTHORITY,
      identityAssurance: 'configured-local',
      message: error.message,
      warning: 'Local Git identity is configurable and is not cryptographic authentication.'
    };
  }
}

function latest(values = []) {
  return [...values].sort((left, right) => String(left.submittedAt ?? left.finalizedAt ?? left.recordedAt ?? '')
    .localeCompare(String(right.submittedAt ?? right.finalizedAt ?? right.recordedAt ?? ''))).at(-1) ?? null;
}

function storyReadiness(story, observed) {
  const submission = latest(observed?.submissions);
  const finalization = latest(observed?.finalizations);
  const evidence = submission
    ? latest((observed?.reviewEvidence ?? []).filter((item) => item.packetSha256 === submission.packetSha256))
    : null;
  const problems = [];
  if (!observed) problems.push('canonical Story branch has not been synchronized');
  else {
    if (observed.stale) problems.push('Story context is stale');
    if (observed.blocked) problems.push('Story has a blocking dependency or invalid workflow');
    if (observed.status !== 'complete') problems.push(`Story workflow is ${observed.status ?? 'not started'}`);
    if (!observed.milestones?.conformance || observed.conformance?.status !== 'approved') {
      problems.push('approved spec-to-code conformance is missing');
    }
    if (!observed.conformance?.treeSha256) problems.push('conformance source/test tree hash is missing');
    if (!submission) problems.push('no hash-bound review packet was submitted');
    else if (!evidence?.ready) problems.push('exact-SHA Product Owner checks are missing or failed');
    if (!finalization || observed.deliveryStatus !== 'finalized_for_review') {
      problems.push('developer finalization packet is missing');
    } else if (finalization.reviewPacketSha256 !== submission?.packetSha256) {
      problems.push('developer finalization does not reference the latest review packet');
    }
  }
  return {
    planId: story.planId ?? story.id,
    workId: story.workId ?? story.id,
    jiraKey: story.jiraKey ?? null,
    repository: story.repository,
    parentMode: story.parentMode ?? 'managed',
    metadata: story.metadata ?? {},
    blocking: story.blocking !== false,
    ready: problems.length === 0,
    problems,
    observedCommit: observed?.observedCommit ?? null,
    packetSha256: submission?.packetSha256 ?? null,
    finalizationSha256: finalization?.packetSha256 ?? null,
    checkEvidenceSha256: evidence?.evidenceSha256 ?? evidence?.recordSha256 ?? evidence?.sha256 ?? null,
    conformanceTreeSha256: observed?.conformance?.treeSha256 ?? null,
    status: observed?.status ?? 'not_materialized',
    currentPhase: observed?.currentPhase ?? null
  };
}

export async function epicDeliveryReadiness(root, initiativeId, {
  portfolio: suppliedPortfolio = null,
  initiative: suppliedInitiative = null
} = {}) {
  const loaded = suppliedInitiative && suppliedPortfolio
    ? { portfolio: suppliedPortfolio, initiative: suppliedInitiative }
    : await loadInitiative(root, initiativeId, suppliedPortfolio);
  const { portfolio, initiative } = loaded;
  if (initiative.resolution.profile !== 'epic-planning') {
    throw new SingularityFlowError('Epic delivery completion is available only for the epic-planning profile.', {
      code: 'EPIC_COMPLETION_PROFILE_REQUIRED',
      details: { initiativeId, profile: initiative.resolution.profile }
    });
  }
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const stories = breakdown.stories.map((story) => storyReadiness(story, initiative.childStories?.[story.id]));
  const required = stories.filter((story) => story.blocking);
  const planningComplete = initiative.status === 'complete';
  const materialized = initiative.materialization?.status === 'complete';
  const ready = planningComplete && materialized && required.length > 0 && required.every((story) => story.ready);
  const blockers = [
    ...(!planningComplete ? ['Epic planning governance is not complete'] : []),
    ...(!materialized ? ['Jira/Git Story materialization is not complete'] : []),
    ...(!required.length ? ['No blocking Stories are defined'] : []),
    ...required.filter((story) => !story.ready).map((story) => `${story.workId}: ${story.problems.join('; ')}`)
  ];
  return {
    initiativeId,
    status: initiative.delivery?.status ?? 'tracking',
    ready,
    planningComplete,
    materialized,
    requiredStories: required.length,
    readyStories: required.filter((story) => story.ready).length,
    stories,
    blockers,
    completion: initiative.delivery?.completion ?? null
  };
}

export function renderEpicCompletionReport(record) {
  const lines = [
    `# Epic Spec-to-Code Completion — ${record.initiativeId}`, '',
    `- Decision: **complete**`,
    `- Decision hash: \`${record.sha256}\``,
    `- Completed at: ${record.completedAt}`,
    `- Product Owner identity: ${record.completedBy}`,
    `- Identity assurance: **configured-local**`,
    `- Blocking Stories: ${record.readyStories}/${record.requiredStories} ready`, '',
    '## Exact Story evidence', '',
    '| Story | Jira | Lineage | Repository | Source commit | Review packet | Conformance tree | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const story of record.stories) {
    lines.push(`| ${story.workId} | ${story.jiraKey ?? '—'} | ${story.parentMode === 'external' ? 'direct / external parent' : 'managed Epic child'} | ${story.repository} | ${story.observedCommit?.slice(0, 12) ?? '—'} | ${story.packetSha256?.slice(0, 12) ?? '—'} | ${story.conformanceTreeSha256?.slice(0, 12) ?? '—'} | ${story.ready ? 'matched' : story.blocking ? 'blocking' : 'deferred'} |`);
  }
  lines.push('', '## Governance statement', '');
  lines.push('This decision is bound to the exact canonical Story commits, submitted review packets, GitHub evidence, and conformance tree hashes listed above. Later Story changes make this completion snapshot historical; they do not rewrite it.');
  lines.push('', '> Local Git identity is configurable and is not cryptographic authentication. Self-approval warnings remain visible in the underlying Story approval records.');
  return `${lines.join('\n')}\n`;
}

export async function completeEpicDelivery(root, initiativeId, {
  confirmation,
  actor = null,
  portfolio: suppliedPortfolio = null,
  initiative: suppliedInitiative = null
} = {}) {
  if (confirmation !== initiativeId) {
    throw new SingularityFlowError(`Epic completion requires exact Epic confirmation '${initiativeId}'.`, {
      code: 'EPIC_COMPLETION_CONFIRMATION_REQUIRED',
      details: { initiativeId }
    });
  }
  const loaded = suppliedInitiative && suppliedPortfolio
    ? { portfolio: suppliedPortfolio, initiative: suppliedInitiative }
    : await loadInitiative(root, initiativeId, suppliedPortfolio);
  const { portfolio, initiative } = loaded;
  const authorization = await assertEpicCompletionAuthorized(root, initiativeId, { actor, initiative });
  const readiness = await epicDeliveryReadiness(root, initiativeId, { portfolio, initiative });
  if (!readiness.ready) {
    throw new SingularityFlowError(`Epic cannot be completed: ${readiness.blockers.join(' | ')}.`, {
      code: 'EPIC_COMPLETION_NOT_READY',
      details: { initiativeId, blockers: readiness.blockers }
    });
  }
  if (initiative.delivery?.status === 'complete') {
    throw new SingularityFlowError(`Epic delivery is already complete at ${initiative.delivery.completedAt}.`, {
      code: 'EPIC_COMPLETION_ALREADY_COMPLETE',
      details: { initiativeId, completedAt: initiative.delivery.completedAt }
    });
  }
  const resolvedActor = authorization.actor;
  const base = {
    schemaVersion: currentSchemaVersion('epic-completion-decision'),
    initiativeId,
    decision: 'complete',
    completedAt: nowIso(),
    completedBy: actorKey(resolvedActor),
    identityAssurance: 'configured-local',
    requiredStories: readiness.requiredStories,
    readyStories: readiness.readyStories,
    stories: readiness.stories
  };
  const record = { ...base, sha256: hash(base) };
  const recordPath = await secureInitiativePath(
    root,
    portfolio,
    initiativeId,
    path.join('delivery', 'records', `${record.sha256}.json`),
    { label: `Epic '${initiativeId}' delivery completion` }
  );
  const reportPath = await secureInitiativePath(
    root,
    portfolio,
    initiativeId,
    path.join('artifacts', 'delivery', 'spec-to-code-completion.md'),
    { label: `Epic '${initiativeId}' spec-to-code completion report` }
  );
  await writeJson(recordPath.absolute, record);
  await writeText(reportPath.absolute, renderEpicCompletionReport(record));
  initiative.delivery = {
    status: 'complete',
    completedAt: record.completedAt,
    completedBy: record.completedBy,
    completion: {
      sha256: record.sha256,
      recordPath: recordPath.relative,
      reportPath: reportPath.relative
    }
  };
  initiative.history.push({
    at: record.completedAt,
    actor: record.completedBy,
    event: 'epic_delivery_completed',
    phase: null,
    detail: `${readiness.readyStories}/${readiness.requiredStories} blocking Stories matched; ${record.sha256.slice(0, 12)}`
  });
  // The caller owns persistence. Production callers run this transition inside
  // commitInitiativeChange.beforeStateWrite, whose revision CAS, subject lock, full-directory
  // preimage, and rollback keep the record, report, and state one atomic publication unit.
  return { portfolio, initiative, readiness, record, reportPath: reportPath.relative };
}
