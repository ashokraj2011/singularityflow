import { createHash } from 'node:crypto';
import path from 'node:path';
import { identity } from './git.mjs';
import { loadInitiativeBreakdown } from './initiative-repositories.mjs';
import {
  loadInitiative, saveInitiative, secureInitiativePath
} from './initiative-state.mjs';
import {
  SingularityFlowError, nowIso, writeJson, writeText
} from './util.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function actorKey(actor) {
  return actor.email?.toLowerCase() ?? actor.name;
}

function latest(values = []) {
  return [...values].sort((left, right) => String(left.submittedAt ?? left.recordedAt ?? '')
    .localeCompare(String(right.submittedAt ?? right.recordedAt ?? ''))).at(-1) ?? null;
}

function storyReadiness(story, observed) {
  const submission = latest(observed?.submissions);
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
  }
  return {
    planId: story.planId ?? story.id,
    workId: story.workId ?? story.id,
    jiraKey: story.jiraKey ?? null,
    repository: story.repository,
    blocking: story.blocking !== false,
    ready: problems.length === 0,
    problems,
    observedCommit: observed?.observedCommit ?? null,
    packetSha256: submission?.packetSha256 ?? null,
    checkEvidenceSha256: evidence?.evidenceSha256 ?? evidence?.recordSha256 ?? evidence?.sha256 ?? null,
    conformanceTreeSha256: observed?.conformance?.treeSha256 ?? null,
    status: observed?.status ?? 'not_materialized',
    currentPhase: observed?.currentPhase ?? null
  };
}

export async function epicDeliveryReadiness(root, initiativeId) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  if (initiative.resolution.profile !== 'epic-planning') {
    throw new SingularityFlowError(`Epic delivery completion is available only for the epic-planning profile.`);
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
    '| Story | Jira | Repository | Source commit | Review packet | Conformance tree | Result |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const story of record.stories) {
    lines.push(`| ${story.workId} | ${story.jiraKey ?? '—'} | ${story.repository} | ${story.observedCommit?.slice(0, 12) ?? '—'} | ${story.packetSha256?.slice(0, 12) ?? '—'} | ${story.conformanceTreeSha256?.slice(0, 12) ?? '—'} | ${story.ready ? 'matched' : story.blocking ? 'blocking' : 'deferred'} |`);
  }
  lines.push('', '## Governance statement', '');
  lines.push('This decision is bound to the exact canonical Story commits, submitted review packets, GitHub evidence, and conformance tree hashes listed above. Later Story changes make this completion snapshot historical; they do not rewrite it.');
  lines.push('', '> Local Git identity is configurable and is not cryptographic authentication. Self-approval warnings remain visible in the underlying Story approval records.');
  return `${lines.join('\n')}\n`;
}

export async function completeEpicDelivery(root, initiativeId, {
  confirmation,
  actor = null
} = {}) {
  if (confirmation !== initiativeId) {
    throw new SingularityFlowError(`Epic completion requires exact Epic confirmation '${initiativeId}'.`);
  }
  const readiness = await epicDeliveryReadiness(root, initiativeId);
  if (!readiness.ready) {
    throw new SingularityFlowError(`Epic cannot be completed: ${readiness.blockers.join(' | ')}.`);
  }
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  if (initiative.delivery?.status === 'complete') {
    throw new SingularityFlowError(`Epic delivery is already complete at ${initiative.delivery.completedAt}.`);
  }
  const resolvedActor = actor ?? identity(root);
  const base = {
    schemaVersion: 1,
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
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, readiness, record, reportPath: reportPath.relative };
}
