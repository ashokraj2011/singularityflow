/**
 * SF Guard at test-recovery intake (SPEC-PSS-v1 §10.10). The agreement and each accepted baseline risk
 * decision are reviewed before the Story exists, on the Story's start-time pin: each gets a review entry
 * in the new Story (`testRecovery.riskReviews`, action `intake-accepted`), signed with the reviewer's one
 * touch before anything is written. On a Story SF Guard requires, such a record counts only while a
 * review entry naming it carries a verified signature; the route for one that does not is its re-review
 * (`story test-policy baseline-admission … --apply`). A refusal names its route and creates no Story.
 */
import { countedRecords, presenceRequires } from './counted.mjs';

const reference = ({ kind, id, recordSha256 }) => ({ kind, id, recordSha256 });

/** Sign and add the intake review entries; `receipts[i]` is the authority receipt of `records[i]`. */
export async function signTrpIntakeReviews(root, workflow, records, receipts, planDigest) {
  const entries = records.map((record, index) => ({ action: 'intake-accepted', planDigest, record: reference(record),
    authorityReceipt: receipts[index] ? reference(receipts[index]) : null, reviewedAt: receipts[index]?.issuedAt ?? new Date().toISOString() }));
  const { signPersonRecords } = await import('./person-steps.mjs');
  await signPersonRecords(root, workflow, entries.map((record) => ({ label: 'Test risk review', action: 'story.test-risk', record })));
  workflow.testRecovery.riskReviews ??= [];
  workflow.testRecovery.riskReviews.push(...entries);
}

/** Whether an intake record counts: always where SF Guard does not require the Story; there, only signed. */
export function reviewedTrpRecord(workflow, record) {
  if (!presenceRequires(workflow)) return true;
  return countedRecords(workflow, (workflow.testRecovery?.riskReviews ?? []).filter((review) => review?.record?.recordSha256 === record.recordSha256)).length > 0;
}
