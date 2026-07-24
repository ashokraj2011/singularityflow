import {
  evaluateInitiativePhase, readInitiativeRecords
} from './initiative-evidence.mjs';
import {
  interfaceContractStatus
} from './initiative-contracts.mjs';
import {
  loadInitiativeBreakdown
} from './initiative-repositories.mjs';
import {
  initiativeMilestoneReadiness
} from './initiative-milestones.mjs';
import {
  loadInitiative
} from './initiative-state.mjs';
import { nowIso } from './util.mjs';
import { listEpicSources } from './epic-sources.mjs';

function milliseconds(start, end) {
  const from = Date.parse(start ?? '');
  const to = Date.parse(end ?? '');
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : 0;
}

function humanDuration(value) {
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  if (value < 86_400_000) return `${(value / 3_600_000).toFixed(1)}h`;
  return `${(value / 86_400_000).toFixed(1)}d`;
}

function observedTelemetry(value) {
  if (!value || typeof value !== 'object') return false;
  const records = (Number(value.exactRecords) || 0) + (Number(value.unavailableRecords) || 0);
  return records > 0
    || (Number.isFinite(value.totalTokens) && value.totalTokens > 0)
    || (value.models ?? []).length > 0
    || Number.isFinite(value.providerCost);
}

function aggregateTelemetry(initiative, children) {
  const sources = [initiative.telemetry, ...children.map((story) => story.telemetry)].filter(observedTelemetry);
  const totalTokens = sources.reduce((sum, item) => sum + (Number.isFinite(item.totalTokens) ? item.totalTokens : 0), 0);
  const hasExactTokens = sources.some((item) => (Number(item.exactRecords) || 0) > 0 || (Number.isFinite(item.totalTokens) && item.totalTokens > 0));
  const providerCosts = sources.map((item) => item.providerCost).filter(Number.isFinite);
  const pricedSources = sources.filter((item) => Number.isFinite(item.providerCost)).length;
  return {
    totalTokens: hasExactTokens ? totalTokens : null,
    models: [...new Set(sources.flatMap((item) => item.models ?? []))],
    providerCost: providerCosts.length ? providerCosts.reduce((sum, value) => sum + value, 0) : null,
    costStatus: !providerCosts.length ? 'unavailable' : pricedSources === sources.length ? 'exact' : 'partial'
  };
}

export async function deriveInitiativeReport(root, initiativeId, { now = nowIso() } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const evidence = await readInitiativeRecords(root, portfolio, initiativeId, 'evidence');
  const approvals = await readInitiativeRecords(root, portfolio, initiativeId, 'approvals');
  const invalidations = await readInitiativeRecords(root, portfolio, initiativeId, 'invalidations');
  const phases = [];
  for (const phaseId of initiative.phaseOrder) {
    const phase = initiative.phases[phaseId];
    const gate = await evaluateInitiativePhase(root, portfolio, initiative, phaseId, { now: new Date(now) });
    const end = phase.approvedAt ?? (phase.status === 'in_progress' || phase.status === 'awaiting_approval' ? now : phase.submittedAt);
    phases.push({
      id: phaseId,
      label: phase.label,
      status: phase.status,
      generation: phase.generation,
      durationMs: milliseconds(phase.startedAt, end),
      duration: humanDuration(milliseconds(phase.startedAt, end)),
      outputs: Object.values(phase.outputs).length,
      publishedOutputs: Object.values(phase.outputs).filter((output) => ['published', 'approved'].includes(output.status)).length,
      checks: gate.checklist,
      errors: gate.errors,
      warnings: gate.warnings,
      bundleSha256: gate.bundleSha256,
      approvedAt: phase.approvedAt
    });
  }
  const plannedIds = new Set(breakdown.stories.map((story) => story.id));
  const children = breakdown.stories.map((story) => {
    const observed = initiative.childStories?.[story.id] ?? null;
    const epic = breakdown.epics.find((candidate) => candidate.id === story.epicId);
    return {
      ...story,
      ...(observed ?? {}),
      planId: story.planId ?? story.id,
      workId: story.workId ?? story.id,
      jiraKey: observed?.jira?.key ?? observed?.jiraKey ?? story.jiraKey ?? null,
      epicJiraKey: epic?.jiraKey ?? observed?.epicJiraKey ?? null,
      materialized: Boolean(observed),
      status: observed?.status ?? 'planned',
      currentPhase: observed?.currentPhase ?? null,
      stale: observed?.stale ?? false,
      blocked: observed?.blocked ?? false,
      progress: observed?.progress ?? { completed: 0, total: 0, percentage: 0 }
    };
  });
  for (const observed of Object.values(initiative.childStories ?? {})) {
    if (!plannedIds.has(observed.id)) children.push({
      ...observed,
      planId: observed.planId ?? observed.id,
      workId: observed.workId ?? observed.id,
      jiraKey: observed.jira?.key ?? observed.jiraKey ?? null,
      materialized: true,
      progress: observed.progress ?? { completed: 0, total: 0, percentage: observed.status === 'complete' ? 100 : 0 }
    });
  }
  const epics = breakdown.epics.map((epic) => {
    const stories = children.filter((story) => story.epicId === epic.id);
    const complete = stories.filter((story) => story.status === 'complete').length;
    const percentages = stories.map((story) => story.progress?.percentage ?? (story.status === 'complete' ? 100 : 0));
    return {
      id: epic.id,
      title: epic.title,
      jiraKey: epic.jiraKey ?? null,
      total: stories.length,
      materialized: stories.filter((story) => story.materialized).length,
      complete,
      blocked: stories.filter((story) => story.blocked).length,
      stale: stories.filter((story) => story.stale).length,
      percentage: percentages.length ? Math.round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length) : 0,
      stories
    };
  });
  const telemetry = aggregateTelemetry(initiative, children);
  const sourceManifest = initiative.resolution.profile === 'epic-planning'
    ? (await listEpicSources(root, initiativeId)).manifest
    : { sources: [] };
  const selfApprovals = approvals.filter((entry) => entry.record.selfApproval).map((entry) => ({
    phase: entry.record.phase,
    subject: `${entry.record.subject.type}/${entry.record.subject.id}`,
    actor: entry.record.actor.email ?? entry.record.actor.name,
    at: entry.record.at
  }));
  return {
    schemaVersion: 1,
    generatedAt: now,
    initiative: initiative.initiative,
    status: initiative.status,
    currentPhase: initiative.currentPhase,
    identityAssurance: 'configured-local',
    phases,
    durationMs: milliseconds(initiative.initiative.createdAt, initiative.status === 'complete' ? phases.at(-1)?.approvedAt ?? now : now),
    duration: humanDuration(milliseconds(initiative.initiative.createdAt, initiative.status === 'complete' ? phases.at(-1)?.approvedAt ?? now : now)),
    evidence: {
      records: evidence.length,
      byAssurance: Object.fromEntries(['machine-verified', 'system-verified', 'human-approved', 'presence-only'].map((assurance) => [assurance, evidence.filter((entry) => entry.record.assurance === assurance).length])),
      stale: phases.flatMap((phase) => phase.checks).filter((check) => check.status === 'stale').length
    },
    approvals: { records: approvals.length, selfApprovals },
    invalidations: invalidations.length,
    contracts: await interfaceContractStatus(root, initiativeId),
    sources: {
      total: sourceManifest.sources.length,
      pinned: sourceManifest.sources.filter((source) => source.status === 'pinned').length,
      records: sourceManifest.sources
    },
    jiraDrift: initiative.jiraDrift ?? null,
    delivery: initiative.delivery ?? null,
    children: {
      total: children.length,
      blocking: children.filter((story) => story.blocking).length,
      stale: children.filter((story) => story.stale).length,
      materialized: children.filter((story) => story.materialized).length,
      complete: children.filter((story) => story.status === 'complete').length,
      epics,
      stories: children
    },
    milestones: {
      construction: initiativeMilestoneReadiness(initiative, 'construction', children),
      delivery: initiativeMilestoneReadiness(initiative, 'delivery', children)
    },
    telemetry
  };
}

export function renderInitiativeReport(report) {
  const lines = [
    `# Initiative report — ${report.initiative.id}`, '',
    `- Title: ${report.initiative.title}`,
    `- Profile: ${report.initiative.profileLabel}`,
    `- Status: **${report.status}**`,
    `- Current phase: ${report.currentPhase ?? 'complete'}`,
    `- Elapsed: ${report.duration}`,
    `- Identity assurance: **${report.identityAssurance}** (local Git configuration; not cryptographically verified)`, '',
    '| Phase | Status | Duration | Generation | Outputs | Gate |',
    '|---|---|---:|---:|---:|---|'
  ];
  for (const phase of report.phases) lines.push(`| ${phase.label} | ${phase.status} | ${phase.duration} | ${phase.generation} | ${phase.publishedOutputs}/${phase.outputs} | ${phase.errors.length ? `${phase.errors.length} blocking` : phase.warnings.length ? `${phase.warnings.length} warning` : 'ready'} |`);
  lines.push('', '## Evidence and governance', '');
  lines.push(`- Evidence records: ${report.evidence.records}`);
  for (const [assurance, count] of Object.entries(report.evidence.byAssurance)) lines.push(`- ${assurance}: ${count}`);
  lines.push(`- Stale checklist items: ${report.evidence.stale}`);
  lines.push(`- Invalidations: ${report.invalidations}`);
  lines.push(`- Self-approvals: ${report.approvals.selfApprovals.length}${report.approvals.selfApprovals.length ? ' ⚠ not independent review' : ''}`);
  lines.push('', '## Cross-repository delivery', '');
  lines.push(`- Epics: ${report.children.epics.length}`);
  lines.push(`- Stories: ${report.children.total} planned; ${report.children.materialized} materialized; ${report.children.complete} complete; ${report.children.blocking} blocking; ${report.children.stale} stale`);
  lines.push(`- Construction: ${report.milestones.construction.readyStories}/${report.milestones.construction.blockingStories} blocking stories ready`);
  lines.push(`- Delivery: ${report.milestones.delivery.readyStories}/${report.milestones.delivery.blockingStories} blocking stories ready`);
  lines.push(`- Interface contracts: ${report.contracts.length}`);
  for (const epic of report.children.epics) {
    lines.push('', `### ${epic.id}${epic.jiraKey ? ` / ${epic.jiraKey}` : ''} — ${epic.title}`, '');
    lines.push(`Progress: ${epic.percentage}% · ${epic.complete}/${epic.total} stories complete`);
    lines.push('', '| Work ID | Jira ID | Repository | Status | Phase | Progress |', '|---|---|---|---|---|---:|');
    for (const story of epic.stories) lines.push(`| ${story.workId} | ${story.jiraKey ?? 'not created'} | ${story.repository} | ${story.status} | ${story.currentPhase ?? (story.materialized ? 'seeded' : 'planned')} | ${story.progress?.percentage ?? 0}% |`);
  }
  if (report.sources.total) lines.push('', '## Epic source lineage', '', `- Pinned source versions: ${report.sources.pinned}/${report.sources.total}`);
  if (report.jiraDrift) lines.push(`- Latest Jira observation: ${report.jiraDrift.observedAt}; ${report.jiraDrift.drifted} drifted issue(s)`);
  if (report.initiative.profile === 'epic-planning') {
    lines.push(`- Epic delivery decision: ${report.delivery?.status ?? 'tracking'}${report.delivery?.completion?.sha256 ? ` (${report.delivery.completion.sha256.slice(0, 12)})` : ''}`);
  }
  lines.push('', '## Copilot usage and cost', '');
  lines.push(`- Models: ${report.telemetry.models.join(', ') || 'unavailable'}`);
  lines.push(`- Tokens: ${report.telemetry.totalTokens ?? 'unavailable'}`);
  lines.push(`- Provider cost: ${report.telemetry.providerCost == null ? 'unavailable' : `$${report.telemetry.providerCost.toFixed(6)}`} (${report.telemetry.costStatus})`);
  lines.push('', '> Durations are wall-clock elapsed time. Local Git identity is configurable and can be impersonated; reports do not describe it as cryptographic authentication.');
  return `${lines.join('\n')}\n`;
}

export async function initiativeNextActions(root, initiativeId) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  if (initiative.status === 'complete') return [{
    action: 'report',
    command: initiative.resolution.lifecycleMode === 'planning-only'
      ? `singularity-flow epic report ${initiativeId}`
      : `singularity-flow initiative report ${initiativeId}`,
    reason: initiative.resolution.lifecycleMode === 'planning-only'
      ? 'Epic planning governance is complete; the read-only dashboard now tracks accepted canonical Story results.'
      : 'The initiative is complete; review final conformance, evidence assurance, time, tokens, and cost.'
  }];
  const phase = initiative.phases[initiative.currentPhase];
  if (initiative.resolution.profile === 'epic-planning' && phase.id === 'epic-intake') {
    const sources = await listEpicSources(root, initiativeId);
    if (!sources.manifest.sources.length) return [{
      action: 'add-sources',
      command: `singularity-flow epic sources add --epic ${initiativeId} --file <PATH>`,
      reason: 'Pin the Epic requirements, research, designs, or other source material before generating intake artifacts.'
    }];
  }
  const materializationPhase = initiative.phaseOrder.includes('epic-spec')
    ? 'epic-spec'
    : initiative.phaseOrder.includes('epic-plan')
      ? 'epic-plan'
    : initiative.phaseOrder.includes('elaboration') ? 'elaboration' : 'plan';
  if (initiative.phases[materializationPhase]?.status === 'approved' && initiative.materialization.status !== 'complete') return [{
    action: 'materialize',
    command: initiative.resolution.profile === 'epic-planning'
      ? `singularity-flow epic create-stories --epic ${initiativeId}`
      : `singularity-flow initiative materialize ${initiativeId} --dry-run`,
    reason: initiative.resolution.profile === 'epic-planning' && initiative.phaseOrder.includes('epic-spec')
      ? 'The Story plan and high-level specification are approved but Jira Stories and canonical repository branches have not been fully materialized.'
      : 'The Story plan is approved but repository Story branches have not been fully materialized.'
  }];
  if (phase.status === 'in_progress') {
    const outputs = Object.values(phase.outputs);
    if (outputs.some((output) => output.status === 'not_generated')) return [{
      action: 'prepare',
      command: `singularity-flow initiative phase ${phase.id}`,
      reason: 'Create the configured output documents for the active phase.'
    }];
    return [{
      action: 'author-and-publish',
      command: `singularity-flow initiative phase publish ${phase.id}`,
      reason: 'Review and complete every generated output, then publish the generation.'
    }];
  }
  if (phase.status === 'awaiting_approval') {
    const gate = await evaluateInitiativePhase(root, portfolio, initiative, phase.id);
    if (gate.errors.length) return gate.errors.map((reason) => ({
      action: reason.includes('approval') ? 'approve-output' : 'add-evidence',
      command: reason.includes('approval')
        ? `singularity-flow initiative approve ${reason.match(/output [^/]+\/([^ ]+)/)?.[1] ?? '<OUTPUT>'}`
        : `singularity-flow initiative checklist ${phase.id}`,
      reason
    }));
    return [{
      action: 'approve-phase',
      command: `singularity-flow initiative approve phase`,
      reason: `All ${phase.id} outputs and checklist gates are ready for exact bundle approval.`
    }];
  }
  return [{ action: 'status', command: `singularity-flow initiative status ${initiativeId}`, reason: `Initiative phase ${phase.id} has status ${phase.status}.` }];
}
