/**
 * The gate's replay of an automatic approval (approve twice, automatic-approval.mjs), loaded only for a step SFlow
 * approved itself. It holds the record to the Story's committed records, as the quick fix's waiver replay does:
 * 1. the pinned workflow still says `automatic: when-ready` for this step, by a rule this build knows, with one
 *    approver, self-approval allowed, no group that must approve, no source changes, and no signature on the Story;
 * 2. the record binds this version's immutable submission, whose packet verifies, and whose checks are the step's and
 *    all passed;
 * 3. the reviewer's committed report for this version is the one the record names; for a convergence step (owner,
 *    2026-11-21), the committed convergence record it names, which found nothing to decide;
 * 4. the committed Story record holds this same automatic approval and exactly one history event for it (inside the
 *    transition that records it, the event in the transition's own state).
 * It cannot re-prove that nothing was open: the list's digest is recorded, as a person's approval records the packet
 * it saw. Writing these records by hand is the same-user gap only SF Guard closes.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from './records.mjs';
import { readStoryReviewPacket } from './story-lineage.mjs';
import { exactFileAtObject, head } from './git.mjs';
import { AUTOMATIC_APPROVAL_RULE, approvesAutomatically } from './approval-authority.mjs';
import { editsSource, isConvergencePhase } from './phase-roles.mjs';
import { storyLocation } from './story-paths.mjs';

const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`;
const committedJson = (root, commit, relative) => {
  const bytes = exactFileAtObject(root, commit, relative, { maximumBytes: 16 * 1024 * 1024 });
  return bytes ? JSON.parse(bytes.toString('utf8')) : null;
};
const eventOf = (history, phase, record) => (history ?? []).filter((event) => event?.event === 'phase-approved-automatically'
  && event.phase === phase.id && event.at === record.at && Number(event.generation) === Number(phase.generation));

/** `{ valid, errors, pending? }` for `phase`, whose disposition is `approved_automatically`. */
export async function verifyAutomaticApproval(root, config, workflow, phase, { pendingTransition = false } = {}) {
  try {
    const record = phase.automaticApproval;
    const policy = phase.approvalPolicy;
    const pinned = workflow.resolution?.phases?.find((candidate) => candidate.id === phase.id) ?? null;
    if (!record || record.rule !== AUTOMATIC_APPROVAL_RULE || Number(record.generation) !== Number(phase.generation)) {
      throw new Error('the record is not one this build replays for this version');
    }
    if (!approvesAutomatically(policy) || canonicalJson(pinned?.approval) !== canonicalJson(policy)) {
      throw new Error('the Story\'s pinned workflow does not approve this step automatically');
    }
    if (policy.allowSelfApproval === false || (policy.minimum ?? 1) !== 1 || (policy.requiredAuthorities ?? []).length
        || workflow.resolution?.presence || editsSource(pinned)) {
      throw new Error('this step needs a person\'s approval under its pinned policy');
    }
    if (!Object.keys(record.predicates ?? {}).length || !Object.values(record.predicates).every((value) => value === true)) {
      throw new Error('not every fact it checked was true');
    }
    const entry = [...(workflow.lineage?.submissions ?? [])].reverse().find((candidate) =>
      candidate.phase === phase.id && Number(candidate.generation) === Number(phase.generation));
    if (!entry || entry.packetSha256 !== record.reviewPacketSha256) throw new Error('it does not bind this version\'s submission');
    const packet = await readStoryReviewPacket(root, config, workflow, entry.packetSha256);
    if (packet.workId !== workflow.workItem.id || packet.phase !== phase.id || Number(packet.generation) !== Number(phase.generation)
        || canonicalJson(packet.checks ?? []) !== canonicalJson(phase.checks ?? []) || digest(phase.checks ?? []) !== record.checksSha256
        || (packet.checks ?? []).some((check) => check?.status !== 'passed')) {
      throw new Error('the submitted checks differ from the step\'s, or did not all pass');
    }
    const commit = head(root);
    if (isConvergencePhase(pinned) || isConvergencePhase(phase)) {
      // Convergence has no reviewer: its own check, the sealed record it names, is what SFlow approved it by.
      const named = record.convergence;
      if (!named?.path || !named.convergenceSha256) throw new Error('it names no convergence check');
      const bytes = exactFileAtObject(root, commit, named.path, { maximumBytes: 16 * 1024 * 1024 });
      if (!bytes) throw new Error('the convergence record it names is not committed');
      const { decodeConvergenceRecord } = await import('./convergence.mjs');
      const projection = decodeConvergenceRecord(bytes, { workId: workflow.workItem.id, iteration: named.iteration });
      if (projection.convergenceSha256 !== named.convergenceSha256) throw new Error('the committed convergence record is not the one it names');
      if ((projection.facts ?? []).length || (projection.candidates ?? []).length || (projection.findings ?? []).length
          || (projection.unresolvedBlockers ?? []).length) {
        throw new Error('the convergence check it names found something to decide');
      }
    } else {
      if (record.review?.status !== 'ready' || !record.review.reportPath) throw new Error('it names no ready review');
      const report = committedJson(root, commit, record.review.reportPath);
      if (!report || report.reportSha256 !== record.review.reportSha256 || report.phase !== phase.id || Number(report.generation) !== Number(phase.generation)) {
        throw new Error('the reviewer\'s committed report is not the one it names');
      }
    }
    const relative = storyLocation(null, config, workflow.workItem.id).record('workflow.json');
    const retained = committedJson(root, commit, relative);
    const historical = retained?.phases?.[phase.id];
    if (historical?.approvalDisposition === 'approved_automatically' && canonicalJson(historical.automaticApproval) === canonicalJson(record)) {
      if (eventOf(retained.history, phase, record).length !== 1) throw new Error('the committed Story history does not hold it exactly once');
      return { valid: true, errors: [] };
    }
    // Inside the transition that records it, the commit is still being made: its own state holds the event.
    if (pendingTransition && eventOf(workflow.history, phase, record).length === 1) return { valid: true, pending: true, errors: [] };
    throw new Error('the committed Story records do not hold it');
  } catch (error) {
    return { valid: false, errors: [error.message] };
  }
}
