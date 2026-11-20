/**
 * Dispute this finding (owner, 2026-11-20: "yes add a dispute this finding choice").
 *
 * SFlow opens the next version on its own to fix a reviewer's blocking findings (review-findings-opening.mjs), and before
 * this a person had no say on a finding, before or after that start: they could only tell the author while it wrote, or
 * return the step at approval. Now a person who may decide for the step (its approval rules: the author, or an approver)
 * disputes one finding with their own reason, required, since it goes against the reviewer. Never the agent: answer
 * binding and the person-step catalog hold it, and under SF Guard it is signed like every decision on the review.
 *
 * It is the review's own human decision, `dispute:<finding ID>`, beside the review of the published version it answers
 * (source-review-lifecycle.mjs), with who, when, the finding and its version. From then on that finding blocks neither the
 * next version SFlow would start for it nor the step's submission; the same finding raised on a later version shows as
 * already disputed; a version already opened for it stays open (no route withdraws an open version) and its author is
 * told not to make that fix; and the step's approvers see each dispute and its reason, and may still return the step.
 *
 * Read only while the step is being worked on: its published version waits for its review's corrections, or its next
 * version is being written for them.
 */
import { DISPUTE_PREFIX, disputedFindingWords } from './review-dispute-words.mjs';
import { SingularityFlowError } from './util.mjs';

/** The reason a dispute takes: the person's own words, as the decision list's reasons. */
export const DISPUTE_REASON = Object.freeze({ minimum: 20, maximum: 1000 });

const words = (values) => (values.length <= 1 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`);
const stepWords = (workflow, phaseId) => workflow.phases?.[phaseId]?.label ?? phaseId;
const fail = (message, code, details) => { throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) }); };

/**
 * When the step's review findings may be disputed: it is the Story's current step, being worked on, and either its
 * published version waits on its review (no next version open, nothing returned) or its next version is being written for
 * that review's findings (`open`: that version and the findings SFlow started it for, when SFlow started it). Null otherwise.
 */
export async function disputeWindow(workflow, phase) {
  if (!phase || workflow?.currentPhase !== phase.id || phase.status !== 'in_progress' || workflow.status === 'cancelled') return null;
  const { stepDecisionOf } = await import('./step-decision.mjs');
  const { version, next } = stepDecisionOf(workflow, phase);
  if (!(Number(version?.published) >= 1)) return null;
  if (version.writing != null) {
    // Being written for something else (a change the person asked for, a return): that review is not what it fixes.
    if (phase.versionOpening?.reason !== 'review-corrections' || Number(phase.versionOpening?.version) !== Number(version.writing)) return null;
    const started = (workflow.settledDecisions ?? []).findLast((entry) => entry?.kind === 'review-corrections' && entry.phase === phase.id
      && Number(entry.effect?.toGeneration) === Number(version.writing));
    return { open: { version: Number(version.writing), ...(started ? { startedFor: [...(started.effect?.findings ?? [])], settled: started.id } : {}) } };
  }
  // Returned, or changed since its publication: its next version comes first, and the review of this one is history. Read
  // without the review, the kernel names a version only for those.
  if (['open-version', 'build-version', 'author-version', 'repair-version'].includes(next?.operation)) return null;
  return { open: null };
}

/**
 * The review's findings as the decision list shows them, for the step the list is about: its blocking findings, each with
 * its dispute or none, and the version being written for them. While the step awaits approval, the disputes alone, for its
 * approvers. Null when nothing applies or the review cannot be read here (the gates still read it themselves).
 */
export async function reviewDisputeFacts(root, config, workflow, phase) {
  try {
    if (!phase || workflow?.currentPhase !== phase.id) return null;
    const { sourceReviewRequired } = await import('./source-review-policy.mjs');
    if (!sourceReviewRequired(workflow, phase.id)) return null;
    const awaiting = phase.status === 'awaiting_approval';
    const window = awaiting ? null : await disputeWindow(workflow, phase);
    if (!awaiting && !window) return null;
    const read = await (await import('./source-review-lifecycle.mjs')).reviewFindingDisputes(root, config, workflow, phase.id);
    if (!read?.findings?.length) return null;
    const findings = awaiting ? read.findings.filter((entry) => entry.disputed) : read.findings;
    if (!findings.length) return null;
    return { phase: phase.id, generation: read.generation, reportSha256: read.reportSha256, status: phase.status, findings,
      ...(window?.open ? { open: { ...window.open, allDisputed: forFindings(window.open, read.findings).every((entry) => entry.disputed) } } : {}) };
  } catch { return null; }
}

/** The findings a version being written was opened for: those SFlow started it for, else every blocking finding of the review. */
function forFindings(open, findings) {
  const named = new Set(open?.startedFor ?? []);
  const listed = named.size ? findings.filter((entry) => named.has(entry.id)) : findings;
  return listed.length ? listed : findings;
}

/**
 * Record a person's dispute of the reviewer's blocking finding `findingId` on `phaseId`, with their reason, under the step's
 * approval rules, in its own Story commit. `reportSha256`, from the decision list, refuses a review that changed since the
 * person read it. Returns what it recorded and, in plain words, what it changes.
 */
export async function commitReviewDispute(root, config, workflow, { phaseId, findingId, reason, reportSha256 = null }, { actor }) {
  const workId = workflow.workItem.id;
  const phase = workflow.phases?.[phaseId] ?? null;
  const name = stepWords(workflow, phaseId);
  const { storyNextDetails } = await import('./sequence.mjs');
  if (!phase) fail(`Story ${workId} has no step '${phaseId}'; its steps are ${(workflow.phaseOrder ?? []).join(', ')}.`, 'REVIEW_DISPUTE_STEP_UNKNOWN', storyNextDetails(workflow));
  const window = await disputeWindow(workflow, phase);
  if (!window) {
    fail(phase.status === 'awaiting_approval' || phase.status === 'approved'
      ? `${name} was submitted, so its review's findings are not disputed now: its approvers see each dispute and its reason when they approve it, and may return the step.`
      : `${name} is not waiting on its review now, so there is no finding of it to dispute.`, 'REVIEW_DISPUTE_NOT_OPEN', storyNextDetails(workflow));
  }
  const lifecycle = await import('./source-review-lifecycle.mjs');
  const read = await lifecycle.reviewFindingDisputes(root, config, workflow, phaseId);
  // The list in the person's terminal, never /sf-decide again: a dispute is that chat's own step [no loops, owner 2026-11-19].
  const listRoute = { command: `singularity-flow decisions ${workId}`, label: 'See what the review found, on the decision list' };
  if (!read) fail(`The published version of ${name} has no retained review, so there is no finding to dispute.`, 'REVIEW_DISPUTE_NO_REVIEW', storyNextDetails(workflow));
  if (reportSha256 && reportSha256 !== read.reportSha256) {
    fail(`The review of ${name} changed since this list was read, so nothing was recorded. Read the list again and choose again.`, 'DECISIONS_PACKET_CHANGED', { nextAction: listRoute });
  }
  const finding = read.findings.find((entry) => entry.id === findingId);
  if (!finding) {
    fail(`The review of version ${read.generation} of ${name} has no blocking finding ${findingId}${read.findings.length ? `; its blocking findings are ${words(read.findings.map((entry) => entry.id))}` : ''}.`,
      'REVIEW_DISPUTE_FINDING_UNKNOWN', { findings: read.findings.map((entry) => entry.id), nextAction: listRoute });
  }
  if (finding.disputed) fail(`${disputedFindingWords(findingId, finding.disputed)} Nothing else to record.`, 'REVIEW_DISPUTE_ALREADY_RECORDED', { nextAction: listRoute });
  const said = String(reason ?? '').replace(/\s+/gu, ' ').trim();
  if (said.length < DISPUTE_REASON.minimum || said.length > DISPUTE_REASON.maximum) {
    fail(`A dispute says why the reviewer is wrong, in your own words: ${DISPUTE_REASON.minimum} to ${DISPUTE_REASON.maximum} characters (this one has ${said.length}). Nothing was recorded.`,
      'REVIEW_DISPUTE_REASON_REQUIRED', { nextAction: listRoute });
  }
  // The step's approval rules decide who may dispute its review: never an identity they do not name.
  const { requireApprovalAuthority } = await import('./approval-authority.mjs');
  const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities, phase.approvalPolicy, actor);
  const [{ assertNoPendingPublication, transactStory }, { LIFECYCLE_EVENT }, { withFreshSourceReviewSnapshot }, { loadStoryAggregate }] = await Promise.all([
    import('./story-publication-store.mjs'), import('./lifecycle-event.mjs'), import('./source-review-snapshot.mjs'), import('./story-aggregate-read.mjs')]);
  await assertNoPendingPublication(root, config, workflow, 'record a dispute of a review finding');
  const id = `${DISPUTE_PREFIX}${findingId}`;
  let retained;
  const { publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, phaseId, generation: phase.generation, actor, agent: null, authorityGroup: authority.authorityGroup,
    payload: { kind: 'source-review-disposition', reportSha256: read.reportSha256, findingId: id }
  }, `[${workId}][phase:${phaseId}][source-review-decision] ${id}`, async (aggregate, publicationEvent) => {
    const current = await withFreshSourceReviewSnapshot(root, () => lifecycle.reviewFindingDisputes(root, config, aggregate, phaseId));
    if (current?.reportSha256 !== read.reportSha256) {
      fail(`The review of ${name} changed before the dispute was recorded, so nothing was recorded. Read the list again.`, 'SOURCE_REVIEW_BINDING_STALE', { nextAction: listRoute });
    }
    retained = await lifecycle.retainSourceReviewDispute(root, config, aggregate, phaseId, current, findingId, said, actor, authority, publicationEvent);
    return retained;
  });
  const updated = await loadStoryAggregate(root, config, workId);
  const after = await lifecycle.reviewFindingDisputes(root, config, updated, phaseId).catch(() => null) ?? read;
  const status = await lifecycle.readSourceReviewStatus(root, config, updated, phaseId).catch(() => null);
  const by = after.findings.find((entry) => entry.id === findingId)?.disputed?.by ?? actor?.name ?? actor?.login ?? actor?.email ?? null;
  const left = after.findings.filter((entry) => !entry.disputed).map((entry) => entry.id);
  const lines = [disputedFindingWords(findingId, { by, reason: said })];
  if (window.open) {
    const opened = forFindings(window.open, after.findings);
    const all = opened.every((entry) => entry.disputed);
    lines.push(all
      ? `Version ${window.open.version} of ${name} stays open: an open version can't be withdrawn. Every finding it was started for is disputed now, so its author is told not to make ${opened.length === 1 ? 'that fix' : 'those fixes'}; it writes version ${window.open.version} without ${opened.length === 1 ? 'it' : 'them'}, and the reviewer reviews that version.`
      : `Version ${window.open.version} of ${name} stays open, and its author is told not to make the fix for ${findingId}; it still fixes ${words(left)}.`);
  } else {
    lines.push(left.length ? `${words(left)} still ${left.length === 1 ? 'blocks' : 'block'} ${name}: its author fixes ${left.length === 1 ? 'it' : 'them'} in the next version.`
      : `Nothing the reviewer found blocks version ${after.generation} of ${name} now.`);
  }
  lines.push(`${name}'s approvers see the dispute and its reason when they approve it, and may still return the step.`);
  return { schemaVersion: 1, resultType: 'source-review-dispute', workId, phase: phaseId, generation: after.generation, finding: findingId, id,
    disputed: { by, reason: said }, blocking: left, ...(window.open ? { openVersion: { version: window.open.version, allDisputed: forFindings(window.open, after.findings).every((entry) => entry.disputed) } } : {}),
    words: lines.join(' '), decision: retained, commit: publication?.sha ?? null, pushed: publication?.pushed ?? false,
    effects: { decisionRecorded: true, phaseAdvanced: false, approvalRecorded: false }, ...(status?.continuation ? { continuation: status.continuation } : {}) };
}
