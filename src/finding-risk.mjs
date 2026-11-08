/**
 * A person accepts one finding [CQF:REQ-047]: a lint, static-analysis or security finding on new code
 * that the step keeps, or a scanner that cannot run here under enforce [CQF:REQ-046]. Modelled on the
 * test-run risk (src/test-run-risk.mjs): a reason of at least 20 characters, an expiry at most 90 days
 * ahead, append-only, revocable, and never the model's.
 *
 * The decision binds the finding's fingerprint, rule, tool and tool version: the same finding from
 * another tool, another rule or a new tool version is a new finding. Who decides is decision 10's:
 * a security finding by the workflow's security reviewers when it names them, otherwise, like every
 * other finding, by the step's approvers. Pure.
 */
import { recordSha256 } from './records.mjs';
import { countedRecords } from './presence/counted.mjs';
import { testRunRiskAuthorities } from './test-run-risk.mjs';
import { SingularityFlowError } from './util.mjs';

export const MAX_FINDING_RISK_DAYS = 90;
export const SECURITY_REVIEWERS = 'security-reviewers';
const DAY = 24 * 60 * 60 * 1000;
const SECURITY_KINDS = new Set(['vulnerability', 'hotspot', 'dependency']);
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;

/** Whether a finding is a security finding, whose acceptance decision 10 gives to security reviewers. */
export function securityFinding(finding) {
  return finding?.feed === 'security' || SECURITY_KINDS.has(finding?.kind);
}

/**
 * Who may accept `finding` on `phaseId`: the security reviewers for a security finding when the workflow
 * names them, else the step approvers. A finding whose kind is not known (named on another checkout
 * without --kind) is treated as a security finding, so leaving the kind out never moves a decision
 * away from the security reviewers [decision 10].
 */
export function findingRiskAuthorities(workflow, phaseId, finding) {
  const registry = workflow?.resolution?.approvalAuthorities ?? {};
  const security = securityFinding(finding) || !finding?.kind;
  if (security && (registry[SECURITY_REVIEWERS]?.members?.length || registry[SECURITY_REVIEWERS]?.allowAnyGitIdentity === true)) {
    return [SECURITY_REVIEWERS];
  }
  return testRunRiskAuthorities(workflow, phaseId);
}

/** The command a person runs to accept `finding`; every binding it needs is in it, so it works on any checkout. */
export function findingRiskDecisionCommand(workflow, { phaseId, finding }) {
  return `singularity-flow decision finding-risk ${workflow?.workItem?.id ?? '<WORK-ID>'} --phase ${phaseId} --finding ${finding.id}`
    + ` --fingerprint ${finding.fingerprint} --rule ${finding.rule ?? 'none'} --tool ${finding.tool}`
    + (finding.toolVersion ? ` --tool-version ${finding.toolVersion}` : '') + (finding.kind ? ` --kind ${finding.kind}` : '')
    + ' --reason "<why the step may keep it>" --expires <YYYY-MM-DD>';
}

function text(value, minimum, maximum, option, what) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length < minimum || trimmed.length > maximum) {
    throw new SingularityFlowError(`Say ${what} in ${minimum} to ${maximum} characters with ${option}.`, { code: 'FINDING_RISK_INVALID' });
  }
  return trimmed;
}

/** Record an acceptance on the aggregate; the caller checked authority. */
export function recordFindingRisk(workflow, { phaseId, finding, reason, expires, actor, authorityGroup, identityAssurance = null, at }) {
  if (!FINGERPRINT.test(String(finding?.fingerprint ?? '')) || !finding.tool) {
    throw new SingularityFlowError('Name the finding by the fingerprint, rule and tool its refusal or review gave.', { code: 'FINDING_RISK_INVALID' });
  }
  const why = text(reason, 20, 1000, '--reason', 'why the step may keep this finding');
  const expiry = /^\d{4}-\d{2}-\d{2}$/u.test(String(expires ?? '')) ? new Date(`${expires}T23:59:59.999Z`) : null;
  const now = new Date(at);
  if (!expiry || Number.isNaN(expiry.getTime()) || expiry <= now || expiry - now > MAX_FINDING_RISK_DAYS * DAY) {
    throw new SingularityFlowError(`--expires must be a date after today and at most ${MAX_FINDING_RISK_DAYS} days ahead (YYYY-MM-DD).`, { code: 'FINDING_RISK_INVALID' });
  }
  workflow.findingRisks ??= [];
  const decision = {
    id: `FRK-${String(workflow.findingRisks.filter((entry) => !entry.revokes).length + 1).padStart(3, '0')}`,
    phase: phaseId, findingId: finding.id ?? null, fingerprint: finding.fingerprint, rule: finding.rule ?? null, tool: finding.tool,
    toolVersion: finding.toolVersion ?? null, ...(finding.file ? { file: finding.file } : {}), ...(finding.severity ? { severity: finding.severity } : {}),
    ...(finding.kind ? { kind: finding.kind } : {}), security: securityFinding(finding) || !finding.kind,
    reason: why, expiresAt: expiry.toISOString(), actor, authorityGroup, identityAssurance, at
  };
  workflow.findingRisks.push(decision);
  return decision;
}

/** Revoke an acceptance; the record stays, and so does the revocation. */
export function recordFindingRiskRevocation(workflow, { riskId, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const entries = countedRecords(workflow, workflow.findingRisks);
  const target = entries.find((entry) => !entry.revokes && entry.id === riskId);
  if (!target) throw new SingularityFlowError(`This Story has no finding risk decision ${riskId}.`, { code: 'FINDING_RISK_UNKNOWN' });
  if (entries.some((entry) => entry.revokes === riskId)) throw new SingularityFlowError(`${riskId} is already revoked.`, { code: 'FINDING_RISK_REVOKED' });
  const revocation = { revokes: riskId, phase: target.phase, fingerprint: target.fingerprint,
    reason: text(reason, 20, 1000, '--reason', 'why the decision is revoked'), actor, authorityGroup, identityAssurance, at };
  workflow.findingRisks.push(revocation);
  return revocation;
}

/** The active acceptance that covers `finding` on `phaseId` at `at`, or null: same fingerprint, rule, tool and tool version. */
export function coveringFindingRisk(workflow, { phaseId, finding, at = new Date().toISOString() }) {
  const entries = countedRecords(workflow, workflow?.findingRisks);
  const decision = [...entries].reverse().find((entry) => !entry.revokes && entry.phase === phaseId && entry.fingerprint === finding?.fingerprint
    && (entry.rule ?? null) === (finding.rule ?? null) && entry.tool === finding.tool && (entry.toolVersion ?? null) === (finding.toolVersion ?? null)) ?? null;
  if (!decision || entries.some((entry) => entry.revokes === decision.id) || new Date(decision.expiresAt) <= new Date(at)) return null;
  return decision;
}

export function findingRiskBinding(decision) {
  return { id: decision.id, sha256: `sha256:${recordSha256(decision)}`, expiresAt: decision.expiresAt };
}
