/**
 * SF Guard M4 (SPEC-PSS-v1 REQ-030, AC-013): every person record on one Story, re-verified.
 *
 * The final check, the evidence receipt and the remote check never trust a flag a record carries:
 * they re-verify each record's presence signature against the keys the Story's pinned policy chain
 * names, through the same verdict M2 and M3 count with. So a record written with plain Git, edited
 * after signing, or copied from another record counts for nothing anywhere.
 *
 * The remote check also compares a Story with its version on the base of a change
 * (`presenceHistoryProblems`): a person record may gain a withdrawal or an engine's invalidation,
 * which only makes the Story stricter, but it may never disappear, and a withdrawal or invalidation
 * may never be taken back. Neither carries a signature of its own, so only history can show it.
 */
import { canonicalJson } from '../records.mjs';
import { familyRecords, isPersonStepRecord, PERSON_STEP_FAMILIES } from './person-steps.mjs';
import { loadPresenceContext, personRecordVerdict } from './person-records.mjs';

// Fields an engine or a later command adds to a record after it was made. Adding one makes the Story
// stricter (a decision withdrawn, an approval invalidated); removing one could revive a decision.
export const LATER_RECORD_FIELDS = Object.freeze([
  'withdrawnAt', 'withdrawnBy', 'withdrawnReason', 'withdrawnReplacement', 'withdrawnSnapshot', 'supersededBy', 'supersededAt',
  'invalidatedAt', 'invalidationReason', 'invalidatedBy', 'invalidated', 'invalidations', 'resolved', 'resolvedAt', 'resolvedBy',
  'resolvedChangeRequests', 'revokedAt', 'revokedBy'
]);
const TAKEN_BACK = Object.freeze(['withdrawnAt', 'invalidatedAt', 'revokedAt', 'supersededBy', 'supersededAt']);
const APPROVAL_DECISIONS = new Set(['approved', 'rejected']);

/**
 * A Story's person records kept in their own files rather than in workflow.json (SPEC-PSS-v1 §10.7), by
 * their path under the Story's directory. The remote check verifies each one a change adds, and fails a
 * change that removes a signed one.
 */
export const STORY_RECORD_FILES = Object.freeze([
  { id: 'source-review-decision', label: 'source review decision',
    pattern: /^context\/reviews\/(?:specification|planning)\/gen-[1-9][0-9]*\/decisions\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/u,
    route: (workId) => `a person decides the finding again in their own terminal, where it takes their Touch ID: singularity-flow review-source decide … --work-id ${workId ?? '<WORK-ID>'}` }
]);

/** The file store a path under a Story's directory belongs to, or null. */
export function storyRecordFile(relative) {
  return STORY_RECORD_FILES.find((store) => store.pattern.test(String(relative ?? ''))) ?? null;
}

/** One person record's name in a refusal: its list, step and ID. */
export function personRecordName(entry) {
  const id = entry.record?.id ?? entry.record?.presence?.nonce?.slice(0, 12) ?? `#${entry.index}`;
  return entry.list === 'approvals' ? `${entry.phase} ${entry.record?.decision ?? 'decision'} ${id}` : `${entry.list} ${id}`;
}

/**
 * Every person record on `workflow`: each phase's approve and reject decisions (M2) and each person
 * decision in PERSON_STEP_FAMILIES (M3). The final check's in-memory preview decision is left out.
 */
export function storyPersonRecords(workflow) {
  const entries = [];
  for (const phaseId of workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {})) {
    for (const [index, record] of (workflow.phases?.[phaseId]?.approvals ?? []).entries()) {
      if (!record || typeof record !== 'object' || record.preview === true || !APPROVAL_DECISIONS.has(record.decision)) continue;
      entries.push({ list: 'approvals', phase: phaseId, index, record });
    }
  }
  for (const family of PERSON_STEP_FAMILIES) {
    for (const [index, record] of familyRecords(workflow, family).entries()) {
      if (isPersonStepRecord(family.list, record)) entries.push({ list: family.list, phase: record.phase ?? null, index, record });
    }
  }
  return entries;
}

/**
 * Re-verify every person record on `workflow`: `{ workId, applies, required, optedIn, reason,
 * records, summary, elapsedMs }`. `applies` is false for a Story with no pin (a repository that never
 * opted in): nothing is read and nothing changes. `verify` reaches the signature check for tests.
 */
export async function storyPresenceReport(root, workflow, { verify } = {}) {
  const started = performance.now();
  const workId = workflow?.workItem?.id ?? null;
  if (!workflow?.resolution?.presence) {
    return { workId, applies: false, required: false, optedIn: false, reason: 'no-pin', records: [], summary: summarize([]), elapsedMs: 0 };
  }
  const context = await loadPresenceContext(root, workflow, verify ? { verify } : {});
  const records = storyPersonRecords(workflow).map((entry) => {
    const verdict = personRecordVerdict(context, entry.record, { workflow });
    return { list: entry.list, phase: entry.phase, index: entry.index, name: personRecordName(entry), active: !takenBack(entry.record),
      state: verdict.state, counts: verdict.counts, code: verdict.code, label: verdict.label, reason: verdict.reason, signer: verdict.signer };
  });
  return { workId, applies: true, required: Boolean(context.required), optedIn: Boolean(context.optedIn), reason: context.reason,
    chainId: context.chainId, records, summary: summarize(records), elapsedMs: Math.round((performance.now() - started) * 100) / 100 };
}

function takenBack(record) {
  return TAKEN_BACK.some((field) => record?.[field] != null);
}

function summarize(records) {
  const count = (state) => records.filter((entry) => entry.state === state).length;
  return { total: records.length, signed: count('signed'), bypass: count('bypass'), preSigning: count('pre-signing'),
    notRequired: count('not-required'), invalid: count('invalid') };
}

/** The person route that replaces a record which does not count: redo it in the person's own terminal. */
export function personRecordRoute(workflow, entry) {
  const workId = workflow?.workItem?.id ?? '<WORK-ID>';
  if (entry.list === 'approvals') {
    return entry.record?.decision === 'rejected'
      ? `the approver rejects it again in their own terminal: singularity-flow reject ${entry.phase} --work-id ${workId} --reason "<why>"`
      : `the approver approves it again in their own terminal: singularity-flow approve ${entry.phase} --work-id ${workId}`;
  }
  const again = {
    testCommandAmendments: `the approver records the test-policy amendment again in their own terminal: singularity-flow story test-policy amend --work-id ${workId} --reason "<why>" --apply --confirm <PLAN-DIGEST>`,
    approverRefreshes: `an approver refreshes the approvers again in their own terminal: singularity-flow story approvers refresh ${workId} --reason "<why>"`,
    'testRecovery.selectionConfirmations': `the reviewer confirms the test selection again in their own terminal: singularity-flow story test-policy confirm --work-id ${workId} --phase <PHASE> --confirm <PLAN-DIGEST>`,
    'testRecovery.riskReviews': `the reviewer records the test risk decision again in their own terminal: singularity-flow story test-policy accept-risk --work-id ${workId} … (or attest-risk / revoke-risk)`
  }[entry.list];
  return again ?? 'the person records the decision again in their own terminal, where SF Guard takes their Touch ID';
}

/**
 * A record's identity across versions, or null: its signature, or for a record an exception covers
 * its presence block. A record with neither (made before SF Guard) has no stable identity, since an
 * engine may add fields to it, so history is not compared for it.
 */
function recordIdentity(entry) {
  const presence = entry.record?.presence;
  if (!presence || typeof presence !== 'object') return null;
  if (typeof presence.signature === 'string') return `${entry.list}\0sig\0${presence.signature}\0${presence.nonce ?? ''}`;
  if (typeof presence.bypass === 'string') return `${entry.list}\0${entry.phase ?? ''}\0bypass\0${canonicalJson(presence)}`;
  return null;
}

/**
 * What changed in `head`'s person records against `base` (the same Story on the base of a change):
 * `{ removed, revived, withdrawn }`. A removed record or a revived (un-withdrawn, un-invalidated) one
 * is refused by the remote check; a newly withdrawn one is shown, since it only makes the Story stricter.
 */
export function presenceHistoryProblems(base, head) {
  const identified = (workflow) => new Map(storyPersonRecords(workflow).map((entry) => [recordIdentity(entry), entry]).filter(([identity]) => identity));
  const baseEntries = identified(base);
  const headEntries = identified(head);
  const removed = [];
  const revived = [];
  const withdrawn = [];
  for (const [identity, before] of baseEntries) {
    const after = headEntries.get(identity);
    if (!after) { removed.push({ name: personRecordName(before), list: before.list, phase: before.phase }); continue; }
    for (const field of TAKEN_BACK) {
      if (before.record[field] != null && after.record[field] == null) revived.push({ name: personRecordName(before), list: before.list, phase: before.phase, field });
      if (before.record[field] == null && after.record[field] != null) withdrawn.push({ name: personRecordName(before), list: before.list, phase: before.phase, field });
    }
  }
  return { removed, revived, withdrawn };
}
