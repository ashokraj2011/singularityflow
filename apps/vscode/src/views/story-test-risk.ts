/** Build bounded fixed review commands. Returned repository text is never an executable route. */
import type { TestRecoverySubject } from './story-test-recovery.ts';
export type StoryRiskAction = 'risks' | 'accept-risk' | 'revoke-risk' | 'attest-risk';
export interface StoryRiskTerms {
  operation?: 'publish' | 'submit' | 'approve' | 'downstream' | 'replay';
  obligationId?: string;
  issueId?: string; recordSha256?: string; reason?: string; followUpOwner?: string; remediationRef?: string;
}
const digest = /^sha256:[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const riskLabels: Record<string, { title: string; outcome: string }> = {
  'validation-unavailable': { title: 'Review unavailable validation', outcome: 'validation stays unavailable' },
  'new-test-failure': { title: 'Review failed tests', outcome: 'tests stay failed' },
  'known-test-failure': { title: 'Review known failed tests', outcome: 'tests stay failed' },
  'reduced-coverage': { title: 'Review reduced coverage', outcome: 'coverage stays incomplete; skipped cases do not pass' },
  'nonessential-document': { title: 'Review nonessential document gap', outcome: 'document obligation stays unmet' }
};
const supportedRisk = (value: unknown): value is string => typeof value === 'string' && Object.hasOwn(riskLabels, value);
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function storyRiskData(result: unknown): Record<string, unknown> | null {
  const response = object(result);
  return response?.resultType === 'command-result' ? object(response.data) : response;
}
function text(value: unknown, label: string, minimum = 1, maximum = 256): string {
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > maximum
      || /[\x00-\x1f\x7f]/u.test(value)) throw new Error(`${label} needs ${minimum}–${maximum} ordinary characters.`);
  return value.trim();
}
export function storyRiskPreviewArgs(action: StoryRiskAction, subject: TestRecoverySubject, terms: StoryRiskTerms = {}): string[] {
  if (!identifier.test(subject.workId) || subject.workId.includes('..')
      || !identifier.test(subject.phaseId) || subject.phaseId.includes('..')) throw new Error('Refresh the attached Story before reviewing risk.');
  if (!['risks', 'accept-risk', 'revoke-risk', 'attest-risk'].includes(action)) throw new Error('Unsupported risk review action.');
  const args = ['story', 'test-policy', action, '--work-id', subject.workId];
  if (action === 'risks' || action === 'accept-risk') {
    const operation = terms.operation ?? 'publish';
    if (!['publish', 'submit', 'approve', 'downstream', 'replay'].includes(operation)) throw new Error('Unsupported risk transition.');
    args.push('--phase', subject.phaseId, '--operation', operation);
    if (terms.obligationId !== undefined) {
      const obligation = text(terms.obligationId, 'Obligation');
      if (!identifier.test(obligation) || obligation.includes('..')) throw new Error('Select an exact document obligation.');
      args.push('--obligation', obligation);
    }
  }
  if (action === 'accept-risk') {
    const issueId = text(terms.issueId, 'Issue');
    if (!identifier.test(issueId) || issueId.includes('..')) throw new Error('Select an exact current issue.');
    args.push('--issue', issueId, '--reason', text(terms.reason, 'Reason', 15, 2000),
      '--follow-up-owner', text(terms.followUpOwner, 'Follow-up owner'),
      '--remediation', text(terms.remediationRef, 'Remediation', 1, 1000));
  }
  if (action === 'revoke-risk' || action === 'attest-risk') {
    if (terms.recordSha256 !== undefined) {
      if (!digest.test(terms.recordSha256)) throw new Error('Select an exact sealed risk record.');
      args.push('--record-sha256', terms.recordSha256);
    } else if (action === 'revoke-risk') throw new Error('Select the exact decision to revoke.');
    if (action === 'revoke-risk') args.push('--reason', text(terms.reason, 'Reason', 15, 2000));
  }
  return [...args, '--json'];
}

/** A document is a separate obligation, never a synthetic test count or arbitrary report command. */
export function storyRiskObligationChoices(result: unknown, subject: TestRecoverySubject): Array<{
  label: string; description: string; obligationId?: string;
}> {
  const data = storyRiskData(result);
  if (data?.schemaVersion !== 1 || data.workId !== subject.workId || data.phaseId !== subject.phaseId
      || data.executed !== false || data.stateChanged !== false || !Array.isArray(data.documentObligations)) return [];
  const documents = data.documentObligations.slice(0, 64).flatMap(value => {
    const row = object(value);
    return row?.phaseId === subject.phaseId && typeof row.id === 'string' && identifier.test(row.id)
      && !row.id.includes('..') && typeof row.path === 'string' && !/[\x00-\x1f\x7f]/u.test(row.path)
      ? [{ label: `Document: ${row.id}`, description: row.path, obligationId: row.id }] : [];
  });
  return documents.length ? [...(data.testValidationAvailable === true
    ? [{ label: 'Test validation', description: 'Configured test evidence; no document exception' }] : []), ...documents] : [];
}

export function storyRiskChoices(result: unknown, subject: TestRecoverySubject): Array<{
  label: string; description: string; action: StoryRiskAction; terms: StoryRiskTerms;
}> {
  const data = storyRiskData(result);
  if (data?.schemaVersion !== 1 || data.resultType !== 'story-test-risk-plan' || data.workId !== subject.workId
      || data.phaseId !== subject.phaseId || data.executed !== false || data.stateChanged !== false
      || data.status === 'publication-pending') return [];
  const choices: ReturnType<typeof storyRiskChoices> = [];
  const agreement = object(data.agreementAuthorization);
  if (agreement?.status === 'review-required' && typeof agreement.recordSha256 === 'string' && digest.test(agreement.recordSha256)) {
    choices.push({ label: 'Review agreement authorization', description: 'Requires a live delegated reviewer; no phase is advanced',
      action: 'attest-risk', terms: { recordSha256: agreement.recordSha256 } });
  }
  if (Array.isArray(data.issues)) for (const value of data.issues.slice(0, 100)) {
    const row = object(value);
    if (row?.riskEligible !== true || row.severity !== 'noncritical' || typeof row.id !== 'string'
        || !identifier.test(row.id) || row.id.includes('..') || !supportedRisk(row.category)) continue;
    // Only qualified exact-observation adapters are presented; no generic skip or pass button.
    const operation = data.operation;
    if (!['publish', 'submit', 'approve', 'downstream', 'replay'].includes(String(operation))) continue;
    const obligationId = typeof data.obligationId === 'string' ? data.obligationId : undefined;
    if (row.category === 'nonessential-document' && (!obligationId || !identifier.test(obligationId)
        || obligationId.includes('..'))) continue;
    choices.push({ label: `${riskLabels[row.category]!.title} ${row.id}`,
      description: `Exact candidate and transition only; ${riskLabels[row.category]!.outcome}`,
      action: 'accept-risk', terms: { issueId: row.id, operation: operation as StoryRiskTerms['operation'],
        ...(obligationId ? { obligationId } : {}) } });
  }
  if (Array.isArray(data.decisions)) for (const value of data.decisions.slice(0, 100)) {
    const row = object(value);
    const recordSubject = object(row?.subject);
    if (row?.kind !== 'phase-risk-decision' || recordSubject?.workId !== subject.workId
        || typeof row.recordSha256 !== 'string' || !digest.test(row.recordSha256)) continue;
    choices.push({ label: `Review revocation ${row.recordSha256.slice(7, 19)}`, description: 'Keep history; withdraw this exact exception for future transitions',
      action: 'revoke-risk', terms: { recordSha256: row.recordSha256 } });
    choices.push({ label: `Restore risk review ${row.recordSha256.slice(7, 19)}`, description: 'Original reviewer required after a clone or host change',
      action: 'attest-risk', terms: { recordSha256: row.recordSha256 } });
  }
  return choices;
}

export function storyRiskApplyArgs(result: unknown, action: StoryRiskAction,
  subject: TestRecoverySubject, terms: StoryRiskTerms): string[] | null {
  const data = storyRiskData(result);
  if (action === 'risks' || !data || data.schemaVersion !== 1 || data.workId !== subject.workId
      || data.status !== 'ready' || data.ready !== true || data.executed !== false || data.stateChanged !== false
      || typeof data.planDigest !== 'string' || !digest.test(data.planDigest)) return null;
  if (action === 'accept-risk') {
    const decision = object(data.decision);
    if (!decision || data.resultType !== 'story-test-risk-plan' || data.phaseId !== subject.phaseId
        || data.operation !== (terms.operation ?? 'publish') || decision.issueId !== terms.issueId
        || (data.obligationId ?? undefined) !== terms.obligationId
        || !supportedRisk(decision.category) || decision.reason !== terms.reason?.trim()
        || decision.followUpOwner !== terms.followUpOwner?.trim() || decision.remediationRef !== terms.remediationRef?.trim()) return null;
  } else if (data.resultType !== 'story-test-risk-record-plan'
      || data.action !== (action === 'revoke-risk' ? 'revoked' : 'attested')
      || data.recordSha256 !== terms.recordSha256
      || action === 'revoke-risk' && data.reason !== terms.reason?.trim()) return null;
  return [...storyRiskPreviewArgs(action, subject, terms).filter(arg => arg !== '--json'), '--apply', '--confirm', data.planDigest];
}
