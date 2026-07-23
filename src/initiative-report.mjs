import {
  evaluateInitiativePhase, readInitiativeRecords
} from './initiative-evidence.mjs';
import {
  interfaceContractStatus
} from './initiative-contracts.mjs';
import {
  initiativeMilestoneReadiness
} from './initiative-repositories.mjs';
import {
  loadInitiative
} from './initiative-state.mjs';
import { nowIso } from './util.mjs';

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

export async function deriveInitiativeReport(root, initiativeId, { now = nowIso() } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
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
  const children = Object.values(initiative.childStories ?? {});
  const childTelemetry = children.map((story) => story.telemetry).filter(Boolean);
  const totalTokens = (initiative.telemetry?.totalTokens ?? 0) + childTelemetry.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0);
  const providerCosts = [initiative.telemetry?.providerCost, ...childTelemetry.map((item) => item.providerCost)].filter((value) => Number.isFinite(value));
  const costComplete = childTelemetry.length > 0 && childTelemetry.every((item) => Number.isFinite(item.providerCost));
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
    children: {
      total: children.length,
      blocking: children.filter((story) => story.blocking).length,
      stale: children.filter((story) => story.stale).length,
      stories: children
    },
    milestones: {
      construction: initiativeMilestoneReadiness(initiative, 'construction'),
      delivery: initiativeMilestoneReadiness(initiative, 'delivery')
    },
    telemetry: {
      totalTokens: totalTokens || null,
      models: [...new Set(childTelemetry.flatMap((item) => item.models ?? []))],
      providerCost: providerCosts.length ? providerCosts.reduce((sum, value) => sum + value, 0) : null,
      costStatus: providerCosts.length ? (costComplete ? 'exact' : 'partial') : 'unavailable'
    }
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
  lines.push(`- Stories: ${report.children.total} total; ${report.children.blocking} blocking; ${report.children.stale} stale`);
  lines.push(`- Construction: ${report.milestones.construction.readyStories}/${report.milestones.construction.blockingStories} blocking stories ready`);
  lines.push(`- Delivery: ${report.milestones.delivery.readyStories}/${report.milestones.delivery.blockingStories} blocking stories ready`);
  lines.push(`- Interface contracts: ${report.contracts.length}`);
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
    command: `singularity-flow initiative report ${initiativeId}`,
    reason: 'The initiative is complete; review final conformance, evidence assurance, time, tokens, and cost.'
  }];
  const phase = initiative.phases[initiative.currentPhase];
  const materializationPhase = initiative.phaseOrder.includes('elaboration') ? 'elaboration' : 'plan';
  if (initiative.phases[materializationPhase]?.status === 'approved' && initiative.materialization.status !== 'complete') return [{
    action: 'materialize',
    command: `singularity-flow initiative materialize ${initiativeId} --dry-run`,
    reason: 'The story plan is approved but repository branches have not been fully materialized.'
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
