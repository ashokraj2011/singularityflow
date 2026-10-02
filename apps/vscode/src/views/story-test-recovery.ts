/** Read-only recovery cards. A UI selection never substitutes for terminal review. */
export type TestRecoveryAction = 'show' | 'amend' | 'attest' | 'risks';
export interface TestRecoverySubject { workId: string; phaseId: string }
const digest = /^sha256:[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function testRecoveryPreviewArgs(action: TestRecoveryAction, subject: TestRecoverySubject, reason?: string): string[] {
  if (!identifier.test(subject.workId) || !identifier.test(subject.phaseId)
      || subject.workId.includes('..') || subject.phaseId.includes('..')) throw new Error('Refresh the current Story before reviewing test recovery.');
  if (!['show', 'amend', 'attest', 'risks'].includes(action)) throw new Error('Unsupported test-recovery action.');
  const args = ['story', 'test-policy', action, '--work-id', subject.workId];
  if (action === 'risks') args.push('--phase', subject.phaseId);
  if (action === 'amend') {
    const explanation = reason?.trim() ?? '';
    if (explanation.length < 15 || explanation.length > 2000 || /[\x00-\x1f\x7f]/u.test(explanation)) {
      throw new Error('Give a reason of 15–2000 ordinary characters.');
    }
    args.push('--phase', subject.phaseId, '--reason', explanation);
  }
  return [...args, '--json'];
}

/** Rebuild a fixed CLI action; never execute returned free-text commands or arbitrary args. */
export function testRecoveryReviewActions(result: unknown, action: TestRecoveryAction,
  subject: TestRecoverySubject, reason?: string): Array<{ label: string; args: string[] }> {
  const response = object(result);
  const data = response?.resultType === 'command-result' ? object(response.data) : response;
  if (!data || data.workId !== subject.workId || data.stateChanged === true || data.executed === true) return [];
  if (action === 'amend') {
    if (data.schemaVersion !== 1 || data.resultType !== 'test-command-amendment-preview'
        || data.status !== 'ready' || data.phaseId !== subject.phaseId
        || typeof data.planSha256 !== 'string' || !digest.test(data.planSha256)) return [];
    return [{ label: 'Review exact runner amendment in terminal',
      args: [...testRecoveryPreviewArgs(action, subject, reason).filter(arg => arg !== '--json'),
        '--apply', '--confirm', data.planSha256] }];
  }
  if (action === 'attest' && Array.isArray(data.reviews)) {
    return data.reviews.slice(0, 100).flatMap(value => {
      const row = object(value);
      const review = object(row?.review);
      if (row?.originPresent !== false || typeof row.sha256 !== 'string' || !digest.test(row.sha256)
          || review?.workId !== subject.workId) return [];
      return [{ label: `Re-attest review ${row.sha256.slice(7, 19)} as its original reviewer`,
        args: ['story', 'test-policy', 'attest', '--work-id', subject.workId, '--apply', '--confirm', row.sha256] }];
    });
  }
  return [];
}
