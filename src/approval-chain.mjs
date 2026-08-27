import path from 'node:path';
import { approvalPolicyCapacity } from './approval-authority.mjs';

function normalizedPath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function actorName(actor = {}) {
  return actor.name ?? actor.login ?? actor.email ?? 'unknown';
}

function authority(workflow, id) {
  const definition = workflow.resolution?.approvalAuthorities?.[id] ?? {};
  return Object.freeze({ id, label: definition.label ?? id });
}

function matchingArtifact(phase, documentPath) {
  const expected = normalizedPath(documentPath);
  return (phase.artifacts ?? []).find((artifact) => {
    const candidate = normalizedPath(artifact.path);
    return candidate === expected || candidate.endsWith(`/${expected}`) || expected.endsWith(`/${candidate}`);
  }) ?? null;
}

/** The human-readable documents whose bytes a phase decision covers. */
function phaseDocuments(phase) {
  const documents = [];
  const seen = new Set();
  const add = ({ name = null, path: documentPath = null, kind = null, role = null, required = true } = {}) => {
    const normalized = normalizedPath(documentPath);
    if (!normalized) return;
    const key = normalized.toLocaleLowerCase('en-US');
    if (seen.has(key)) return;
    seen.add(key);
    const artifact = matchingArtifact(phase, normalized);
    documents.push(Object.freeze({
      name: name ?? path.posix.basename(normalized),
      path: normalized,
      kind: kind ?? artifact?.kind ?? phase.requiredArtifact?.kind ?? 'document',
      role,
      required,
      status: artifact?.status ?? (phase.generation > 0 ? 'published' : 'not-generated'),
      generation: artifact?.generation ?? (phase.generation || null),
      sha256: artifact?.sha256 ?? null
    }));
  };

  add({
    name: phase.requiredArtifact?.label ?? null,
    path: phase.requiredArtifact?.path,
    kind: phase.requiredArtifact?.kind,
    role: 'required-artifact',
    required: true
  });
  for (const member of phase.artifactSet?.members ?? []) {
    add({
      name: member.member ?? member.label ?? null,
      path: member.path,
      kind: member.kind,
      role: member.role ?? 'bundle-member',
      required: member.authority !== 'advisory'
    });
  }
  return Object.freeze(documents);
}

function approvalState(phase, mode, received, minimum) {
  if (mode === 'none') return 'not-required';
  if (mode === 'policy') return phase.status === 'approved' ? 'policy-approved' : 'policy-pending';
  if (received >= minimum && minimum > 0) return 'approved';
  if (phase.status === 'awaiting_approval') return 'awaiting-approval';
  if (phase.status === 'rejected') return 'returned-for-rework';
  if (phase.status === 'approved') return 'approved';
  return phase.status === 'in_progress' ? 'not-submitted' : 'pending';
}

/**
 * A read-only phase-by-phase approval chain derived entirely from the pinned Story aggregate.
 *
 * The order is the immutable phase order. A phase's required document and artifact-set members are
 * shown beside the exact authority policy and recorded human decisions, so a reader never has to
 * join `status`, `documents`, and `progress` by hand.
 */
export function approvalChainSnapshot(workflow) {
  const phases = (workflow.phaseOrder ?? []).map((id, index) => {
    const phase = workflow.phases[id];
    const policy = phase.approvalPolicy ?? {};
    const mode = policy.mode ?? 'required';
    const minimum = ['none', 'policy'].includes(mode) ? 0 : (policy.minimum ?? 1);
    const decisions = (phase.approvals ?? []).map((decision) => Object.freeze({
      decision: decision.decision ?? 'unknown',
      actor: actorName(decision.actor),
      authorityGroup: decision.authorityGroup ?? null,
      authorityLabel: decision.authorityGroup
        ? authority(workflow, decision.authorityGroup).label : null,
      at: decision.at ?? null,
      generation: decision.generation ?? null,
      selfApproval: decision.selfApproval === true,
      active: !decision.invalidatedAt,
      invalidatedAt: decision.invalidatedAt ?? null
    }));
    const activeApprovals = decisions.filter((entry) => entry.active && entry.decision === 'approved');
    const authorities = Object.freeze((policy.authorities ?? []).map((id) => authority(workflow, id)));
    const capacity = approvalPolicyCapacity(workflow.resolution?.approvalAuthorities, policy);
    return Object.freeze({
      order: index + 1,
      id,
      label: phase.label ?? id,
      phaseStatus: phase.status,
      generation: phase.generation ?? 0,
      documents: phaseDocuments(phase),
      approval: Object.freeze({
        mode,
        state: approvalState(phase, mode, activeApprovals.length, minimum),
        minimum,
        received: activeApprovals.length,
        remaining: Math.max(0, minimum - activeApprovals.length),
        configurationBlocked: phase.status !== 'approved' && !capacity.attainable,
        capacity: Object.freeze(capacity),
        authorities,
        approvedBy: Object.freeze(activeApprovals.map((entry) => Object.freeze({
          name: entry.actor,
          authorityGroup: entry.authorityGroup,
          authorityLabel: entry.authorityLabel,
          at: entry.at,
          selfApproval: entry.selfApproval
        }))),
        decisions: Object.freeze(decisions)
      })
    });
  });
  const approvalsRequired = phases.reduce((sum, phase) => sum + phase.approval.minimum, 0);
  const approvalsReceived = phases.reduce((sum, phase) => sum + phase.approval.received, 0);
  return Object.freeze({
    schemaVersion: 1,
    workItem: Object.freeze({
      id: workflow.workItem.id,
      title: workflow.workItem.title,
      workType: workflow.workItem.workType,
      branch: workflow.workItem.branch,
      status: workflow.status,
      currentPhase: workflow.currentPhase ?? null
    }),
    summary: Object.freeze({
      phases: phases.length,
      documents: phases.reduce((sum, phase) => sum + phase.documents.length, 0),
      approvalsRequired,
      approvalsReceived,
      approvalsRemaining: Math.max(0, approvalsRequired - approvalsReceived),
      phasesAwaitingApproval: phases.filter((phase) => phase.approval.state === 'awaiting-approval').length
    }),
    phases: Object.freeze(phases)
  });
}

function names(documents) {
  return documents.length ? documents.map((document) => document.name).join(', ') : 'none';
}

function requirement(approval) {
  if (approval.mode === 'none') return 'not required';
  if (approval.mode === 'policy') return approval.state.replaceAll('-', ' ');
  return `${approval.received}/${approval.minimum}`;
}

function approvedBy(approval) {
  if (!approval.approvedBy.length) return '—';
  return approval.approvedBy.map((entry) => `${entry.name}${entry.selfApproval ? ' ⚠ self' : ''}`).join(', ');
}

/** Narrow-terminal rendering for the command-result output boundary. */
export function approvalChainText(snapshot) {
  const invalidated = snapshot.phases.reduce(
    (sum, phase) => sum + phase.approval.decisions.filter((decision) => !decision.active).length, 0
  );
  const lines = [
    '',
    `Approval chain — ${snapshot.workItem.id}: ${snapshot.workItem.title}`,
    `Story status: ${snapshot.workItem.status} · current phase: ${snapshot.workItem.currentPhase ?? 'complete'}`,
    ''
  ];
  for (const phase of snapshot.phases) {
    lines.push(
      `${phase.order}. ${phase.label} (${phase.id}) — ${phase.phaseStatus.replaceAll('_', ' ')}`,
      `   Documents: ${names(phase.documents)}`,
      `   Approvals: ${requirement(phase.approval)} · ${phase.approval.state.replaceAll('-', ' ')}`,
      ...(phase.approval.configurationBlocked
        ? ['   Blocker: pinned approval policy cannot reach its threshold; refresh configuration and reopen this phase.']
        : []),
      `   Authority: ${phase.approval.authorities.map((entry) => entry.label).join(', ') || '—'}`,
      `   Approved by: ${approvedBy(phase.approval)}`,
      ''
    );
  }
  lines.push(
    `${snapshot.summary.approvalsReceived}/${snapshot.summary.approvalsRequired} required human approval(s) recorded; ${snapshot.summary.approvalsRemaining} remaining.`
  );
  if (invalidated) lines.push(`${invalidated} earlier decision(s) were invalidated and remain available in --json history.`);
  return `${lines.join('\n')}\n`;
}
