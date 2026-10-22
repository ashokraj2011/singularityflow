/** The receipt's next human action while people review the phase. */
export const RECEIPT_REVIEW_ACTION = 'Review and decide this phase.';

/**
 * The receipt's approval count in words. A phase nobody approves is not "0/0 (exact)": approval
 * mode none needs no approval, and mode policy is completed by its deterministic waiver or, when
 * the waiver does not apply, by people. The receipt's recorded fields, and so its hashes, are unchanged.
 */
export function receiptApprovalText(receipt) {
  const { approvals } = receipt;
  if (approvals.mode === 'none') return 'not required (approval mode none)';
  if (approvals.mode === 'policy') {
    return receipt.nextHumanAction === RECEIPT_REVIEW_ACTION
      ? `${approvals.current} recorded; the low-risk policy did not waive this phase, so it needs human approval`
      : `waived by the deterministic low-risk policy (${approvals.current} human approval${approvals.current === 1 ? '' : 's'} recorded)`;
  }
  return `${approvals.current}/${approvals.required} (${approvals.status})`;
}
