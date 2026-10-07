/** Review-document exceptions apply by responsibility, never by a built-in phase name. */
import { recordSha256, canonicalJson } from './records.mjs';
import { phaseAuthoredReviewArtifacts, inspectPhaseAuthoredReviewContent, artifactFindingMessage } from './publication-preflight.mjs';
import { isArtifactQualityFinding, phaseFindingIdentity } from './phase-finding-policy.mjs';
import { phaseInspectionGeneration, requiresProspectivePhaseInspection } from './code-submission-evidence.mjs';
import { effectivePhasePublicationProducer } from './manual-authorship.mjs';
import { isConvergencePhase } from './phase-roles.mjs';
import { humanReviewOriginPresent } from './human-review-origin.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';
import { ArtifactRiskPacketSchema } from './phase-artifact-risk-schema.mjs';
import { terminalTransitionAt } from './workflow-terminal-time.mjs';

const digest = value => `sha256:${recordSha256(value)}`;
const fail = message => { throw new SingularityFlowError(message, { code: 'PHASE_QUALITY_RISK_NOT_ELIGIBLE' }); };
const identities = findings => [...new Map(findings.map(finding => {
  const value = phaseFindingIdentity(finding);
  return [canonicalJson(value), value];
})).values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));

export async function artifactQualityBinding(root, config, workflow, phase, { generation = null } = {}) {
  const documents = await phaseAuthoredReviewArtifacts(root, config, workflow, phase);
  const order = workflow.phaseOrder ?? [];
  const prior = order.slice(0, order.indexOf(phase.id)).map(id => ({ id, phase: workflow.phases[id] }));
  return { workId: workflow.workItem.id, phaseId: phase.id,
    // Allocation watermarks can move inside a publication transaction. The open intent or the
    // kernel's exact event generation owns that identity, not a second allocation via next().
    generation: generation ?? (phase.generationIntent?.status === 'open'
      ? Number(phase.generationIntent.generation) : phaseInspectionGeneration(workflow, phase)), contentSha256: documents.fingerprint,
    upstreamSha256: digest(prior), policySha256: digest({ resolution: workflow.resolution ?? null,
      snapshot: workflow.workflowSnapshot ?? null, approvalPolicy: phase.approvalPolicy ?? null,
      requiredArtifact: phase.requiredArtifact }) };
}

/** No exceptions for absence, malformed records, unclosed comments or kernel projections. */
export async function artifactQualityStatus(root, config, workflow, phase, findings, {
  transition = 'publish', at = null, generation = null
} = {}) {
  at ??= transition === 'terminal' ? terminalTransitionAt(workflow) : nowIso();
  const producer = effectivePhasePublicationProducer(phase);
  const eligible = !isConvergencePhase(phase) && producer !== 'deterministic'
    ? identities(findings.filter(isArtifactQualityFinding)) : [];
  const entries = workflow.qualityRiskDecisions ?? [];
  const relevant = entries.filter(record => record?.gate === 'PHASE_ARTIFACT_QUALITY'
    && record.binding?.phaseId === phase.id);
  if (!eligible.length && !relevant.length) return { eligible: false, excepted: false,
    findings: [], remaining: [], accepted: [], items: [], testsWaived: false, phaseApproved: false };
  const binding = await artifactQualityBinding(root, config, workflow, phase, { generation });
  const { retainedQualityRiskRecords } = await import('./phase-quality-risk.mjs');
  const retained = await retainedQualityRiskRecords(root, config, workflow);
  const revoked = new Set(retained.filter(record => record.revokes).map(record => record.revokes));
  const accepted = new Set(); const items = [];
  for (const record of retained.filter(record => record.gate === 'PHASE_ARTIFACT_QUALITY'
      && record.binding.phaseId === phase.id)) {
    const stillObserved = record.findings.every(finding => eligible.some(current => canonicalJson(current) === canonicalJson(finding)));
    const status = revoked.has(record.id) ? 'revoked'
      : Date.parse(record.expiresAt) <= Date.parse(at) ? 'expired'
        : canonicalJson(record.binding) !== canonicalJson(binding) ? 'stale'
          : !record.transitions.includes(transition) ? 'out-of-scope'
            : !stillObserved ? 'observation-changed'
              : !await humanReviewOriginPresent(root, record) ? 'needs-reattestation' : 'active';
    if (status === 'active') record.findings.forEach(finding => accepted.add(canonicalJson(finding)));
    items.push({ id: record.id, gate: record.gate, clauses: [], status, findings: record.findings, reason: record.reason,
      expiresAt: record.expiresAt, actor: record.actor, authorityGroup: record.authorityGroup,
      transitions: record.transitions, decisionSha256: digest(record), packetSha256: record.packetSha256 });
  }
  const remaining = eligible.filter(finding => !accepted.has(canonicalJson(finding)));
  return { eligible: eligible.length > 0, binding, findings: eligible, remaining,
    accepted: eligible.filter(finding => accepted.has(canonicalJson(finding))), items,
    excepted: eligible.length > 0 && remaining.length === 0, testsWaived: false, phaseApproved: false };
}

export async function resolveArtifactQualityFindings(root, config, workflow, phase, findings, options = {}) {
  const risks = await artifactQualityStatus(root, config, workflow, phase, findings, options);
  const accepted = new Set(risks.accepted.map(finding => canonicalJson(finding)));
  return { findings: findings.filter(finding => !accepted.has(canonicalJson(phaseFindingIdentity(finding)))),
    acceptedFindings: findings.filter(finding => accepted.has(canonicalJson(phaseFindingIdentity(finding)))), risks };
}

/** An expired/narrow exception is not permission to consume an incomplete approved document. */
export async function approvedArtifactQualityFindings(root, config, workflow, options = {}) {
  const phaseIds = new Set((workflow.qualityRiskDecisions ?? [])
    .filter(record => record?.gate === 'PHASE_ARTIFACT_QUALITY').map(record => record.binding?.phaseId));
  const findings = [];
  for (const phaseId of phaseIds) {
    const phase = workflow.phases?.[phaseId];
    if (!phase || phase.status !== 'approved') continue;
    const raw = await inspectPhaseAuthoredReviewContent(root, config, workflow, phase, { resolveRisks: false });
    const resolved = await resolveArtifactQualityFindings(root, config, workflow, phase, raw,
      { transition: 'consume', ...options });
    for (const finding of resolved.findings.filter(isArtifactQualityFinding)) findings.push({ ...finding,
      phaseId, message: `${artifactFindingMessage(finding)} Approved phase '${phaseId}' needs a fresh exact human risk review for this transition, or an authorized successor; its old approval is preserved.` });
  }
  return findings;
}

export async function prepareArtifactQualityRisk(root, config, workflow, phase, {
  findings: selectedCodes = [], transitions = ['publish', 'submit', 'approve', 'consume', 'terminal'], expires, reason
} = {}) {
  const observed = await inspectPhaseAuthoredReviewContent(root, config, workflow, phase, { resolveRisks: false });
  const status = await artifactQualityStatus(root, config, workflow, phase, observed,
    { transition: requiresProspectivePhaseInspection(workflow, phase) ? 'publish'
      : phase.status === 'awaiting_approval' ? 'approve' : phase.status === 'approved' ? 'consume' : 'submit' });
  if (!status.eligible || !status.remaining.length) fail('No eligible review-document quality gap exists. Preserve work and follow the registered repair/owner route.');
  const selected = selectedCodes.length ? status.remaining.filter(finding => selectedCodes.includes(finding.code)) : status.remaining;
  if (!selected.length || selectedCodes.some(code => !selected.some(finding => finding.code === code))) fail('Select only exact currently observed quality finding codes.');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(expires ?? '')) fail('Give a valid risk expiry as YYYY-MM-DD within 90 days.');
  const expiresAt = `${expires}T23:59:59.999Z`; const time = Date.parse(expiresAt);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== expires
      || time <= Date.now() || time - Date.now() > 90 * 86400000) fail('Risk expiry must be a future date within 90 days.');
  const core = { schemaVersion: 2, kind: 'phase-quality-risk', binding: status.binding,
    gateMode: 'soft', enablesPilotForPhase: workflow.resolution?.qualityGateMode !== 'soft',
    gate: 'PHASE_ARTIFACT_QUALITY', clauses: [], findings: selected,
    transitions: [...new Set(transitions)].sort(), expiresAt, reason: typeof reason === 'string' ? reason.trim() : reason,
    observationSha256: digest(selected) };
  return ArtifactRiskPacketSchema.parse({ ...core, packetSha256: digest(core) });
}
