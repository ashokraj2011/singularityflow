/**
 * The commits that stop a submitted phase's approval, named and routed by kind.
 *
 * Approval binds the exact history that was submitted: only the review-safe kinds (REVIEW_EFFECTS
 * in state.mjs: prior approvals, recorded decisions, intent-amendment records and an exact Auto
 * checkpoint) may follow the review evidence. The refusal used to say only that history changed, so
 * a person could not tell which commit, or why. The common case was an intent amendment proposed
 * while the phase waited for review: the person's next step is deciding that amendment, not
 * repairing the phase. Since SPEC-OAP M2 the proposal holds the approval until a person decides it,
 * and rejecting it lets the phase be approved as submitted.
 */
import { createHash } from 'node:crypto';
import { commitIsAncestor, exactFileAtObject, governedCommitIdentity, head } from './git.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { scopeStepOf } from './phase-roles.mjs';
import { recordSha256 } from './records.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { workDirRelative } from './story-paths.mjs';
import { storyHistoryCommits } from './story-policy-anchor.mjs';
import { SingularityFlowError } from './util.mjs';

/** Commits named in the message and details; every commit stays in `interveningCommits`. */
export const BLOCKING_COMMIT_LIMIT = 10;
const CLASSIFIED_COMMIT_LIMIT = 200;
const AMENDMENT_SUBJECT = /^\[([^\]]+)\]\[intent-amendment:(propose|approve|reject|acknowledge)\] (AMD-\d{3,}|latest)$/u;

const shortCommit = (commit) => String(commit).slice(0, 12);

function clauseList(clauses) {
  const named = clauses.slice(0, 5);
  const more = clauses.length - named.length;
  const words = named.length <= 1 ? named.join('')
    : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
  return more > 0 ? `${words} and ${more} more` : words;
}

/**
 * Each blocking commit, oldest first, with its subject and kind. Only a transaction commit whose
 * subject names an intent-amendment action of this Story counts as one; what the amendment is now
 * comes from the accepted Story state, never from the subject.
 */
export function describeBlockingCommits(root, workflow, commits) {
  const ordered = [...commits].reverse().slice(0, CLASSIFIED_COMMIT_LIMIT);
  if (!ordered.length) return [];
  const subjects = new Map(storyHistoryCommits(root, [
    'log', '--no-walk=unsorted', '--format=%H%x1f%s', ...ordered
  ], 'Subjects of the commits after the review evidence').map((line) => {
    const [commit, subject = ''] = line.split('\u001f');
    return [commit, subject.trim().slice(0, 200)];
  }));
  const amendments = workflow.intentAmendments ?? [];
  return ordered.map((commit) => {
    const subject = subjects.get(commit) ?? '';
    const match = AMENDMENT_SUBJECT.exec(subject);
    const entry = { commit: shortCommit(commit), subject, kind: 'commit' };
    if (!match || match[1] !== workflow.workItem.id || !governedCommitIdentity(root, commit)?.transactionId) return entry;
    const [, , action, id] = match;
    const amendment = amendments.find((candidate) => candidate.id === id);
    return {
      ...entry,
      kind: action === 'propose' ? 'intent-amendment-proposal' : 'intent-amendment-decision',
      amendment: {
        id, action,
        status: amendment?.status ?? 'unknown',
        changedClauses: Array.isArray(amendment?.changedClauses) ? amendment.changedClauses.slice(0, 50) : []
      }
    };
  });
}

/** The Story state keys an intent-amendment record commit may change. */
const AMENDMENT_KEYS = Object.freeze(['intentAmendments', 'history', 'publicationProjections']);
const appendsOne = ({ before, after }, key) => Array.isArray(after[key]) && after[key].length === (before[key] ?? []).length + 1
  && recordSha256(after[key].slice(0, (before[key] ?? []).length)) === recordSha256(before[key] ?? []);
const amendmentFile = (config, workflow, id, suffix) => `${workDirRelative(config, workflow.workItem.id)}/context/intent-amendments/${id}${suffix}`;
const recordAt = (root, object, recordPath) => JSON.parse(exactFileAtObject(root, object, recordPath)?.toString('utf8') ?? 'null');

/** The commits that wrote an amendment's record, newest first, as [commit, subject]; null when Git could not say. */
function amendmentRecordWriters(root, id, recordPath) {
  try {
    return storyHistoryCommits(root, ['log', '--first-parent', '--format=%H%x1f%s', head(root), '--', recordPath],
      `Intent amendment ${id} record history`).map((line) => line.split('\u001f'));
  } catch { return null; }
}

/** Whether a commit's event is this amendment's, of `type`, and is the event its commit names. */
const amendmentEventMatches = ({ event, identity }, type, workflow, id, summary) => event?.type === type
  && event.subject?.id === workflow.workItem.id
  && event.payload?.proposalId === id
  && event.payload?.proposalSha256 === summary.proposalSha256
  && identity.eventSha256 === `sha256:${recordSha256(event)}`;

/** The intent-amendment commits of one action among `commits`, as [commit, amendment ID]; empty when Git could not say. */
function amendmentCommits(root, workflow, commits, action) {
  let subjects;
  try {
    subjects = storyHistoryCommits(root, ['log', '--no-walk=unsorted', '--format=%H%x1f%s', ...commits],
      'Subjects of the commits after the review evidence');
  } catch { return []; }
  return subjects.flatMap((line) => {
    const [commit, subject = ''] = line.split('\u001f');
    const match = AMENDMENT_SUBJECT.exec(subject);
    return match?.[1] === workflow.workItem.id && match[2] === action ? [[commit, match[3]]] : [];
  });
}

/**
 * The rejected intent amendments among the commits after a submission, each with the proposal and
 * rejection commits that may precede its approval [SPEC-OAP decision 1]. reviewHistoryCommits
 * (state.mjs) allows them; approval records them, and the approval check notes them.
 *
 * A rejected amendment changes no clause, specification generation, artifact or source: its proposal
 * adds only its own amendment files and its rejection only records the decision in them. The review
 * packet binds none of those files (the Story's work directory is outside the hashed application
 * tree, and the packet's artifacts are the step's own), so the reviewed inputs are identical. Only a
 * person records a rejection: `story intent-amendment decide` is denied in every agent turn.
 */
export async function rejectedIntentAmendments(root, config, workflow, commits, range) {
  if (!commits.length || !(workflow.intentAmendments ?? []).some((entry) => entry.status === 'rejected')) return [];
  const state = await import('./state.mjs');
  return amendmentCommits(root, workflow, commits, 'reject').flatMap(([commit, id]) => {
    const pair = id !== 'latest' ? rejectedIntentAmendmentPair(root, config, workflow, id, commit, range, state) : null;
    return pair ? [pair] : [];
  });
}

const SKILL_VERSION_SUBJECT = /^\[([^\]]+)\]\[skill-version:reject\] (\S+)$/u;
// Both transactions stamp the Story's current schema version; every other key is pinned exactly.
const SKILL_VERSION_KEYS = Object.freeze(['skillVersionAmendments', 'history', 'publicationProjections', 'schemaVersion']);

/**
 * The rejected skill-version proposals among the commits after a submission, each as its proposal
 * and rejection [unhappy paths S8, 2026-10-28]. A rejected proposal changes no step, skill or
 * package: the pair adds its own review records and the summary's rejection, and nothing else, so
 * it makes nothing a review saw stale. Each commit is checked as `rejectedIntentAmendmentPair`
 * checks an amendment's: an exact path allowlist, an exact workflow.json key diff and the commit's
 * event hash. A proposal still undecided, or one approved, keeps staling the submission.
 */
export async function rejectedSkillVersionAmendments(root, config, workflow, commits, { evidenceCommit, interveningCommits }) {
  const rejected = new Map((workflow.skillVersionAmendments ?? []).filter((entry) => entry?.status === 'rejected').map((entry) => [entry.id, entry]));
  if (!commits.length || !rejected.size) return [];
  const { governedStateChange, stateChangesOnly } = await import('./state.mjs');
  let subjects;
  try {
    subjects = storyHistoryCommits(root, ['log', '--no-walk=unsorted', '--format=%H%x1f%s', ...commits], 'Subjects of the commits after the review evidence');
  } catch { return []; }
  const event = (change, type, id) => change.event?.type === type && change.event.subject?.id === workflow.workItem.id
    && change.event.payload?.proposalId === id && change.identity.eventSha256 === `sha256:${recordSha256(change.event)}`;
  const newFiles = (change, files) => files.every((file) => change.changed.includes(file) && !exactFileAtObject(root, change.parent, file))
    && change.changed.every((file) => change.ownPaths.includes(file) || files.includes(file));
  const pairs = [];
  for (const line of subjects) {
    const [rejectionCommit, subject = ''] = line.split('\u001f');
    const match = SKILL_VERSION_SUBJECT.exec(subject);
    const summary = match?.[1] === workflow.workItem.id ? rejected.get(match[2]) : null;
    if (!summary?.proposalPath || !summary.impactPath || !summary.rejection?.reviewPath) continue;
    const id = summary.id;
    // The proposal created its record and nothing rewrote it.
    let writers;
    try {
      writers = storyHistoryCommits(root, ['log', '--first-parent', '--format=%H%x1f%s', head(root), '--', summary.proposalPath],
        `Skill-version proposal ${id} record history`).map((entry) => entry.split('\u001f'));
    } catch { continue; }
    if (writers.length !== 1 || writers[0][1] !== `[${workflow.workItem.id}][skill-version:propose] ${id}`) continue;
    const [proposalCommit] = writers[0];
    if (!interveningCommits.includes(proposalCommit) && !commitIsAncestor(root, proposalCommit, evidenceCommit)) continue;
    const proposal = governedStateChange(root, config, workflow, proposalCommit);
    const rejection = governedStateChange(root, config, workflow, rejectionCommit);
    if (!proposal || !rejection) continue;
    // The proposal adds its two records and one proposed summary, and nothing else.
    const added = proposal.after.skillVersionAmendments?.at(-1);
    if (!newFiles(proposal, [summary.proposalPath, summary.impactPath]) || !stateChangesOnly(proposal, SKILL_VERSION_KEYS)
        || !['skillVersionAmendments', 'history', 'publicationProjections'].every((key) => appendsOne(proposal, key))
        || added?.id !== id || added.status !== 'proposed' || added.proposalPath !== summary.proposalPath
        || added.impactPath !== summary.impactPath || added.proposalSha256 !== summary.proposalSha256
        || proposal.after.history.at(-1)?.event !== 'skill_version_proposed'
        || !event(proposal, LIFECYCLE_EVENT.SKILL_AMENDMENT_PROPOSED, id) || proposal.event.payload.proposalSha256 !== summary.proposalSha256) continue;
    // The rejection adds its review record and changes that one summary to rejected, and nothing else.
    const before = rejection.before.skillVersionAmendments ?? [];
    const after = rejection.after.skillVersionAmendments ?? [];
    const index = after.findIndex((entry) => entry?.id === id);
    const undecided = before[index];
    const decided = after[index];
    if (!newFiles(rejection, [summary.rejection.reviewPath]) || !stateChangesOnly(rejection, SKILL_VERSION_KEYS)
        || !['history', 'publicationProjections'].every((key) => appendsOne(rejection, key))
        || index < 0 || before.length !== after.length || undecided?.status !== 'proposed' || decided?.status !== 'rejected'
        || recordSha256({ ...decided, status: 'proposed', decidedAt: undefined, rejection: undefined, schemaVersion: undecided.schemaVersion })
          !== recordSha256(undecided)
        || recordSha256(after.filter((_, at) => at !== index)) !== recordSha256(before.filter((_, at) => at !== index))
        || rejection.after.history.at(-1)?.event !== 'skill_version_rejected'
        || !event(rejection, LIFECYCLE_EVENT.SKILL_AMENDMENT_REJECTED, id)
        || rejection.event.payload.decision !== 'reject' || rejection.event.payload.willApply !== false) continue;
    pairs.push({ id, proposalCommit, rejectionCommit });
  }
  return pairs;
}

/** The document commits that add records only: an upload, or a provider fetch. */
const DOCUMENT_OPERATIONS = Object.freeze({
  [LIFECYCLE_EVENT.EVIDENCE_RECORDED]: 'document-upload',
  [LIFECYCLE_EVENT.EXTERNAL_SYNCHRONIZED]: 'document-fetch'
});
const DOCUMENT_KEYS = Object.freeze(['documents', 'history', 'publicationProjections']);

/**
 * The document uploads and fetches among the commits after a submission that offer nothing to the
 * step under review [unhappy paths S8, 2026-10-28]. Such a commit adds document records the step was
 * never given, so it changes nothing its review saw, yet it made the submission stale and cost a
 * reject and a resubmit. Each is checked as strictly as a rejected skill-version pair: its event and
 * the hash its commit names, a workflow.json diff of only the document counters, one history entry
 * and one projection, a manifest whose earlier records and packages are unchanged, each new record
 * offered only to other steps, and no file but its own records and their exact bytes. A document
 * offered to that step, a package import or anything else still stales the submission.
 */
export async function reviewSafeDocumentAdditions(root, config, workflow, phase, commits) {
  if (!commits.length) return [];
  const { governedStateChange, stateChangesOnly } = await import('./state.mjs');
  const manifestFile = `${workDirRelative(config, workflow.workItem.id)}/documents.json`;
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  return commits.filter((commit) => {
    const change = governedStateChange(root, config, workflow, commit);
    const event = change?.event;
    if (!event || DOCUMENT_OPERATIONS[event.type] !== event.payload?.operation || event.subject?.id !== workflow.workItem.id
        || change.identity.eventSha256 !== `sha256:${recordSha256(event)}`) return false;
    if (!stateChangesOnly(change, DOCUMENT_KEYS) || !['history', 'publicationProjections'].every((key) => appendsOne(change, key))
        || change.after.history.at(-1)?.event !== 'documents_added') return false;
    let before;
    let after;
    try {
      before = recordAt(root, change.parent, manifestFile) ?? { documents: [], packages: [] };
      after = recordAt(root, change.identity.commit, manifestFile);
    } catch { return false; }
    const prior = before.documents ?? [];
    const added = (after?.documents ?? []).slice(prior.length);
    if (!added.length || recordSha256(after.documents.slice(0, prior.length)) !== recordSha256(prior)
        || recordSha256(after.packages ?? []) !== recordSha256(before.packages ?? [])) return false;
    if (added.some((record) => !Array.isArray(record?.phases) || record.phases.includes(phase.id)
        || record.phase !== phase.id || record.origin || record.packageId)) return false;
    const files = new Set([...change.ownPaths, manifestFile]);
    for (const record of added.filter((entry) => entry.storage?.kind === 'git')) {
      const bytes = typeof record.path === 'string' ? exactFileAtObject(root, change.identity.commit, record.path) : null;
      if (!bytes || exactFileAtObject(root, change.parent, record.path) || sha256(bytes) !== record.sha256) return false;
      files.add(record.path);
    }
    return change.changed.every((file) => files.has(file));
  });
}

const BRANCH_LINK_KEYS = Object.freeze(['lineage', 'history', 'publicationProjections']);

/**
 * The child-branch links among the commits after a submission [unhappy paths S8, 2026-10-28]. A link
 * registers one more governed branch for the Story and changes nothing a review saw. Each is its
 * exact record change: the link event and its hash, one appended child branch named by that event
 * with the rest of the lineage unchanged, one history entry and one projection, and no file but the
 * Story's own state.
 */
export async function reviewSafeBranchLinks(root, config, workflow, commits) {
  if (!commits.length) return [];
  const { governedStateChange, stateChangesOnly } = await import('./state.mjs');
  return commits.filter((commit) => {
    const change = governedStateChange(root, config, workflow, commit);
    const event = change?.event;
    if (event?.type !== LIFECYCLE_EVENT.BRANCH_LINKED || event.subject?.id !== workflow.workItem.id
        || change.identity.eventSha256 !== `sha256:${recordSha256(event)}`) return false;
    if (!stateChangesOnly(change, BRANCH_LINK_KEYS) || !['history', 'publicationProjections'].every((key) => appendsOne(change, key))
        || change.after.history.at(-1)?.event !== 'child_branch_attached') return false;
    const prior = change.before.lineage?.childBranches ?? [];
    const next = change.after.lineage?.childBranches ?? [];
    const rest = (lineage) => (lineage ? { ...lineage, childBranches: undefined } : null);
    const createdLineage = { schemaVersion: change.after.lineage?.schemaVersion, canonicalBranch: workflow.workItem.branch,
      parentStoryId: workflow.workItem.id, childBranches: undefined };
    return next.length === prior.length + 1 && recordSha256(next.slice(0, prior.length)) === recordSha256(prior)
      && next.at(-1)?.name === event.payload?.childBranch
      && recordSha256(rest(change.after.lineage)) === recordSha256(change.before.lineage ? rest(change.before.lineage) : createdLineage)
      && change.changed.every((file) => change.ownPaths.includes(file));
  });
}

const APPROVER_REFRESH_KEYS = Object.freeze(['resolution', 'workflowSnapshot', 'approverRefreshes', 'history', 'publicationProjections', 'personSeals']);

/**
 * Approver refreshes among the commits after a submission (2026-10-29). A refresh only adds members
 * to groups this Story already has, so it changes nothing the submitted review saw: each commit is
 * accepted as exactly one refresh, its policy change replayed against its own decision record
 * (assertApproverRefreshScope), its files only the Story's state, the decision and its new snapshot
 * revision. The snapshot chain verifies the revision itself. Anything more stales the submission.
 */
export async function reviewSafeApproverRefreshes(root, config, workflow, commits) {
  if (!commits.length || !(workflow.approverRefreshes ?? []).length) return [];
  const [{ governedStateChange, stateChangesOnly }, { assertApproverRefreshScope }] = await Promise.all([
    import('./state.mjs'), import('./approver-refresh-contracts.mjs')]);
  return commits.filter((commit) => {
    const change = governedStateChange(root, config, workflow, commit);
    const event = change?.event;
    if (event?.type !== LIFECYCLE_EVENT.DECISION_MADE || event.payload?.decision !== 'approver-refresh'
        || event.subject?.id !== workflow.workItem.id
        || change.identity.eventSha256 !== `sha256:${recordSha256(event)}`) return false;
    if (!stateChangesOnly(change, APPROVER_REFRESH_KEYS)
        || !['approverRefreshes', 'history', 'publicationProjections'].every((key) => appendsOne(change, key))
        || change.after.history.at(-1)?.event !== 'approvers_refreshed') return false;
    // SF Guard (SPEC-PSS-v1 §10.8): on a Story it requires, the refresh's seal is added beside it.
    const seals = (change.after.personSeals ?? []).length - (change.before.personSeals ?? []).length;
    if (seals !== 0 && !(seals === 1 && appendsOne(change, 'personSeals') && change.after.personSeals.at(-1)?.list === 'approverRefreshes')) return false;
    const summary = change.after.approverRefreshes.at(-1);
    const reference = change.after.workflowSnapshot;
    if (reference?.revision !== Number(change.before.workflowSnapshot?.revision) + 1
        || summary?.to?.revision !== reference.revision) return false;
    let decision;
    try {
      decision = JSON.parse(exactFileAtObject(root, commit, summary.decisionPath)?.toString('utf8') ?? 'null');
      assertApproverRefreshScope(change.before.resolution, change.after.resolution, decision);
    } catch { return false; }
    if (decision?.id !== summary.id || `sha256:${recordSha256(decision)}` !== summary.decisionSha256) return false;
    const snapshot = reference.manifestPath.slice(0, reference.manifestPath.lastIndexOf('/') + 1);
    const blobs = `${change.item}/config/wfa/blobs/`;
    return change.changed.every((file) => change.ownPaths.includes(file) || file === summary.decisionPath
      || file.startsWith(snapshot) || file.startsWith(blobs));
  });
}

/**
 * The undecided intent amendments proposed among the commits after a submission, each with its
 * proposal commit [SPEC-OAP M2]. A proposal adds only its own amendment records, so it makes
 * nothing stale: reviewHistoryCommits allows it, and evaluateApproval holds the approval until a
 * person decides it (pendingAmendmentRefusal). Each is verified as the proposal half of a rejected
 * pair is, and no later commit may have touched its record: a partial approval still stales the
 * submission.
 */
export async function pendingIntentAmendmentProposals(root, config, workflow, commits) {
  if (!commits.length || !(workflow.intentAmendments ?? []).some((entry) => entry.status === 'proposed')) return [];
  const state = await import('./state.mjs');
  return amendmentCommits(root, workflow, commits, 'propose').flatMap(([proposalCommit, id]) => {
    const summary = (workflow.intentAmendments ?? []).find((entry) => entry.id === id);
    const recordPath = amendmentFile(config, workflow, id, '.json');
    if (summary?.status !== 'proposed' || summary.recordPath !== recordPath) return [];
    const writers = amendmentRecordWriters(root, id, recordPath);
    if (writers?.length !== 1 || writers[0][0] !== proposalCommit) return [];
    return verifiedProposal(root, config, workflow, id, proposalCommit, summary, state)
      ? [{ id, status: 'proposed', proposalCommit }] : [];
  }).reverse();
}

/**
 * Whether `proposalCommit` is exactly the proposal of amendment `id`, checked as
 * applicabilityDecisionCommit (state.mjs) checks a decision: an exact path allowlist (the
 * amendment's own new files), an exact workflow.json key diff and the commit's event hash. Returns
 * the proposed record, or null.
 */
function verifiedProposal(root, config, workflow, id, proposalCommit, summary, { governedStateChange, stateChangesOnly }) {
  const recordPath = amendmentFile(config, workflow, id, '.json');
  const proposal = governedStateChange(root, config, workflow, proposalCommit);
  if (!proposal) return null;
  const amendmentFiles = [amendmentFile(config, workflow, id, '-before.md'), amendmentFile(config, workflow, id, '-proposed.md'), recordPath];
  let proposedRecord;
  try {
    if (proposal.changed.some((file) => !proposal.ownPaths.includes(file) && !amendmentFiles.includes(file))
        || amendmentFiles.some((file) => !proposal.changed.includes(file) || exactFileAtObject(root, proposal.parent, file))) return null;
    proposedRecord = recordAt(root, proposalCommit, recordPath);
  } catch { return null; }
  if (proposedRecord?.id !== id || proposedRecord.status !== 'proposed'
      || proposedRecord.proposalSha256 !== summary.proposalSha256) return null;
  if (!stateChangesOnly(proposal, AMENDMENT_KEYS) || !AMENDMENT_KEYS.every((key) => appendsOne(proposal, key))
      || proposal.after.history.at(-1)?.event !== 'intent_amendment_proposed') return null;
  const added = proposal.after.intentAmendments.at(-1);
  if (added?.id !== id || added.status !== 'proposed' || added.proposalSha256 !== summary.proposalSha256
      || added.recordPath !== recordPath) return null;
  return amendmentEventMatches(proposal, LIFECYCLE_EVENT.INTENT_AMENDMENT_PROPOSED, workflow, id, summary) ? proposedRecord : null;
}

/**
 * Whether `rejectionCommit` and the proposal before it are exactly one rejected amendment: the
 * proposal verified on its own (verifiedProposal), the rejection by the same rules. Leaving
 * `phases` and the specification's path out of both lists keeps the scope step's generation and
 * bytes as they were. Anything more fails closed; a pending or approved amendment, or a proposal
 * that changed other state, is never one.
 */
function rejectedIntentAmendmentPair(root, config, workflow, id, rejectionCommit, { evidenceCommit, interveningCommits }, state) {
  const workId = workflow.workItem.id;
  const summary = (workflow.intentAmendments ?? []).find((entry) => entry.id === id);
  const recordPath = amendmentFile(config, workflow, id, '.json');
  if (summary?.status !== 'rejected' || summary.recordPath !== recordPath) return null;
  // The proposal created the record and the rejection decided it; no other commit touched it, so the
  // record the rejection started from is the one proposed.
  const [decided, proposed, ...more] = amendmentRecordWriters(root, id, recordPath) ?? [];
  if (more.length || decided?.[0] !== rejectionCommit
      || proposed?.[1] !== `[${workId}][intent-amendment:propose] ${id}`) return null;
  const proposalCommit = proposed[0];
  // After the submission, or before its evidence commit: the proposal may also precede it.
  if (!interveningCommits.includes(proposalCommit) && !commitIsAncestor(root, proposalCommit, evidenceCommit)) return null;
  const proposedRecord = verifiedProposal(root, config, workflow, id, proposalCommit, summary, state);
  const rejection = state.governedStateChange(root, config, workflow, rejectionCommit);
  if (!proposedRecord || !rejection) return null;
  let decidedRecord;
  try {
    if (rejection.changed.some((file) => !rejection.ownPaths.includes(file) && file !== recordPath)
        || !rejection.changed.includes(recordPath)) return null;
    decidedRecord = recordAt(root, rejectionCommit, recordPath);
  } catch { return null; }
  // The record keeps its proposal and gains only the rejection.
  if (decidedRecord?.status !== 'rejected' || decidedRecord.decision?.decision !== 'rejected'
      || recordSha256(decidedRecord.decisions) !== recordSha256([...(proposedRecord.decisions ?? []), decidedRecord.decision])
      || recordSha256({ ...decidedRecord, status: 'proposed', decidedAt: undefined, decision: undefined, decisions: undefined })
        !== recordSha256({ ...proposedRecord, decisions: undefined })) return null;
  if (!state.stateChangesOnly(rejection, AMENDMENT_KEYS)
      || !['history', 'publicationProjections'].every((key) => appendsOne(rejection, key))
      || rejection.after.history.at(-1)?.event !== 'intent_amendment_rejected') return null;
  // The rejection sets that entry's status, decision and decision time, and changes nothing else.
  const undecidedList = rejection.before.intentAmendments ?? [];
  const decidedList = rejection.after.intentAmendments;
  const decidedEntry = Array.isArray(decidedList) ? decidedList.find((entry) => entry?.id === id) : null;
  if (decidedEntry?.status !== 'rejected' || decidedEntry.decision?.decision !== 'rejected'
      || recordSha256(decidedList.map((entry) => (entry === decidedEntry
        ? { ...entry, status: 'proposed', decidedAt: undefined, decision: undefined } : entry)))
        !== recordSha256(undecidedList)) return null;
  if (!amendmentEventMatches(rejection, LIFECYCLE_EVENT.INTENT_AMENDMENT_REJECTED, workflow, id, summary)
      || rejection.event.payload.decision !== 'reject') return null;
  return { id, status: 'rejected', proposalCommit, rejectionCommit };
}

/**
 * The acknowledgements of approved intent amendments among the commits after a submission
 * [SPEC-OAP M2]. An acknowledgement adds amendment records only: who acknowledged it, on the
 * amendment's summary and record, and the stamp on the steps the amendment reopened. Approving an
 * amendment reopens the step awaiting approval, so an acknowledgement normally precedes the next
 * submission; one that follows it changes nothing that submission's review saw.
 */
export async function intentAmendmentAcknowledgements(root, config, workflow, commits) {
  if (!commits.length || !(workflow.intentAmendments ?? []).some((entry) => entry.acknowledgedAt)) return [];
  const state = await import('./state.mjs');
  return amendmentCommits(root, workflow, commits, 'acknowledge').flatMap(([commit]) => {
    const acknowledged = verifiedAcknowledgement(root, config, workflow, commit, state);
    return acknowledged ? [acknowledged] : [];
  });
}

const WHO_ACKNOWLEDGED = Object.freeze({ acknowledgedAt: undefined, acknowledgedBy: undefined, acknowledgementRequired: undefined });

function verifiedAcknowledgement(root, config, workflow, commit, { governedStateChange, stateChangesOnly }) {
  const change = governedStateChange(root, config, workflow, commit);
  const prior = change?.before.intentAmendments ?? [];
  const next = change?.after.intentAmendments ?? [];
  if (!change || !Array.isArray(prior) || !Array.isArray(next) || prior.length !== next.length) return null;
  // The one summary it changes gains who acknowledged it, and nothing else.
  const index = next.findIndex((entry, at) => recordSha256(entry) !== recordSha256(prior[at]));
  const was = prior[index];
  const now = next[index];
  const id = now?.id;
  const recordPath = amendmentFile(config, workflow, id, '.json');
  if (index < 0 || !/^AMD-\d{3,}$/u.test(id ?? '') || was?.id !== id || was.status !== 'approved' || was.acknowledgedAt
      || typeof now.acknowledgedAt !== 'string' || now.recordPath !== recordPath
      || recordSha256({ ...now, ...WHO_ACKNOWLEDGED }) !== recordSha256({ ...was, ...WHO_ACKNOWLEDGED })
      || recordSha256(next.filter((_, at) => at !== index)) !== recordSha256(prior.filter((_, at) => at !== index))) return null;
  try {
    if (!change.changed.includes(recordPath) || change.changed.some((file) => !change.ownPaths.includes(file) && file !== recordPath)
        || recordSha256({ ...recordAt(root, commit, recordPath), ...WHO_ACKNOWLEDGED })
          !== recordSha256({ ...recordAt(root, change.parent, recordPath), ...WHO_ACKNOWLEDGED })) return null;
  } catch { return null; }
  // The steps the amendment reopened gain the stamp; nothing else about any step changes.
  const { before, after } = change;
  for (const phaseId of new Set([...Object.keys(before.phases ?? {}), ...Object.keys(after.phases ?? {})])) {
    const step = before.phases?.[phaseId];
    const stamped = after.phases?.[phaseId];
    if (recordSha256(step ?? null) === recordSha256(stamped ?? null)) continue;
    const revalidation = stamped?.intentAmendmentRevalidation;
    if (!step || step.intentAmendmentRevalidation?.id !== id || step.intentAmendmentRevalidation.acknowledgedAt
        || typeof revalidation?.acknowledgedAt !== 'string'
        || recordSha256({ ...stamped, intentAmendmentRevalidation: { ...revalidation, acknowledgedAt: step.intentAmendmentRevalidation.acknowledgedAt } })
          !== recordSha256(step)) return null;
  }
  const { event, identity } = change;
  if (!stateChangesOnly(change, [...AMENDMENT_KEYS, 'phases'])
      || !['history', 'publicationProjections'].every((key) => appendsOne(change, key))
      || after.history.at(-1)?.event !== 'intent_amendment_acknowledged'
      || event?.type !== LIFECYCLE_EVENT.INTENT_AMENDMENT_ACKNOWLEDGED || event.subject?.id !== workflow.workItem.id
      || (event.payload?.proposalId ?? id) !== id || identity.eventSha256 !== `sha256:${recordSha256(event)}`) return null;
  return { id, status: 'approved', acknowledgementCommit: commit };
}

function commitNote(entry) {
  const amendment = entry.amendment;
  if (!amendment) return '';
  if (entry.kind === 'intent-amendment-proposal') {
    return amendment.status === 'proposed' ? ` (intent amendment ${amendment.id}, still waiting for a decision)`
      : ` (intent amendment ${amendment.id}, now ${amendment.status})`;
  }
  return amendment.action === 'acknowledge' ? ` (acknowledgement of intent amendment ${amendment.id})`
    : ` (decision on intent amendment ${amendment.id})`;
}

/**
 * What the refusal and the advisory both say about the blocking commits: each one named (short
 * commit and subject, bounded), the undecided amendments among them, and what deciding them means.
 */
function blockingCommitFacts(root, workflow, phase, blocking, evidenceCommit) {
  // Naming only explains; a failed read of the subjects must not replace the refusal with another.
  let described;
  try { described = describeBlockingCommits(root, workflow, blocking); }
  catch { described = [...blocking].reverse().map((commit) => ({ commit: shortCommit(commit), subject: '(subject unavailable)', kind: 'commit' })); }
  const shown = described.slice(0, BLOCKING_COMMIT_LIMIT);
  const pending = described.filter((entry) => entry.kind === 'intent-amendment-proposal'
    && entry.amendment.status === 'proposed');
  const decided = [...new Set(described.filter((entry) => entry.kind === 'intent-amendment-proposal'
    && entry.amendment.status !== 'proposed').map((entry) => `${entry.amendment.id} (${entry.amendment.status})`))];
  const scopePhase = scopeStepOf(workflow)?.id ?? null;
  // One item per line in a terminal; JSON flattens the lines, so each item ends its own clause.
  const items = [
    ...shown.map((entry) => `${entry.commit} ${entry.subject || '(no subject)'}${commitNote(entry)}`),
    ...(blocking.length > shown.length ? [`… and ${blocking.length - shown.length} more`] : [])
  ];
  const lines = [
    `${blocking.length === 1 ? 'This commit' : `These ${blocking.length} commits`} after the submission (evidence ${shortCommit(evidenceCommit)}) may not precede approval:`,
    ...items.map((item, index) => `- ${item}${index === items.length - 1 ? '.' : ';'}`)
  ];
  for (const entry of pending) {
    const clauses = entry.amendment.changedClauses;
    lines.push(`Intent amendment ${entry.amendment.id}${clauses.length ? ` changes ${clauseList(clauses)} and` : ''} is still waiting for a decision by a person who approves ${scopePhase ?? 'the scope'}. `
      + `Approving it changes ${clauses.length ? 'those clauses' : 'the approved clauses'}, so ${phase.id} must be revised and submitted again; `
      + `rejecting it keeps them, but these commits record more than its proposal and rejection, so ${phase.id} still needs a fresh submission before it can be approved.`);
  }
  if (decided.length) {
    // A rejection whose commits are exactly propose and reject is allowed (rejectedIntentAmendments), so one named here recorded more.
    lines.push(`Decided after the submission: intent amendment ${decided.join(', ')}. Only a rejected amendment whose proposal and rejection change nothing else may precede approval; `
      + `phase '${phase.id}' still needs a fresh submission before it can be approved.`);
  }
  return {
    shown, scopePhase, lines,
    pendingIntentAmendments: pending.map((entry) => ({
      id: entry.amendment.id, commit: entry.commit, changedClauses: entry.amendment.changedClauses
    }))
  };
}

const amendmentStatusCommand = (workId) => `singularity-flow story intent-amendment status --work-id ${workId} --json`;

/**
 * The refusal for commits that may not precede approval, with an undecided amendment among them
 * routed to its decision first.
 */
export function interveningCommitRefusal(root, workflow, phase, {
  blocking, interveningCommits, priorApprovalCommits, allowedReviewCommits, evidenceCommit, currentHead
}) {
  const facts = blockingCommitFacts(root, workflow, phase, blocking, evidenceCommit);
  const [first] = facts.pendingIntentAmendments;
  return new SingularityFlowError([
    `Phase '${phase.id}' repository history changed after its immutable review evidence was recorded. `
      + 'Only prior approvals, recorded decisions, intent-amendment proposals, rejections and acknowledgements, or an exact Auto human-boundary checkpoint for this submitted phase may precede another approval; submit fresh evidence for every other commit.',
    ...facts.lines
  ].join('\n'), {
    code: 'STORY_REVIEW_INTERVENING_COMMIT',
    details: {
      workId: workflow.workItem.id,
      phase: phase.id,
      generation: phase.generation,
      evidenceCommit,
      currentHead,
      interveningCommits,
      priorApprovalCommits,
      allowedReviewCommits,
      blockingCommitCount: blocking.length,
      blockingCommits: facts.shown,
      ...(facts.scopePhase ? { scopePhase: facts.scopePhase } : {}),
      ...(first ? {
        pendingIntentAmendments: facts.pendingIntentAmendments,
        nextAction: {
          command: amendmentStatusCommand(workflow.workItem.id),
          label: `See intent amendment ${first.id}, which a person decides before ${phase.id} can be approved.`
        }
      } : {})
    }
  });
}

/**
 * The hold for intent amendments proposed after the submission and still undecided [SPEC-OAP M2]:
 * a person who approves the scope decides each one first. Rejecting it keeps this submission, so
 * the step is then approved as it is; approving it changes the clauses and reopens the step.
 * `proposals` are the verified proposals (pendingIntentAmendmentProposals), oldest first.
 */
export function pendingAmendmentRefusal(workflow, phase, proposals) {
  const scopePhase = scopeStepOf(workflow)?.id ?? null;
  const pending = proposals.map(({ proposalCommit: commit, id }) => {
    const summary = (workflow.intentAmendments ?? []).find((entry) => entry.id === id);
    return { id, commit: shortCommit(commit),
      changedClauses: Array.isArray(summary?.changedClauses) ? summary.changedClauses.slice(0, 50) : [] };
  });
  const [first] = pending;
  const one = pending.length === 1;
  return new SingularityFlowError([
    `Approving ${phase.id} waits for ${one ? `intent amendment ${first.id}` : `${pending.length} intent amendments`} to be decided.`,
    ...pending.map((entry) => `Intent amendment ${entry.id}${entry.changedClauses.length ? ` changes ${clauseList(entry.changedClauses)} and` : ''} was proposed after ${phase.id} was submitted (${entry.commit}); `
      + `a person who approves ${scopePhase ?? 'the scope'} decides it.`),
    `Rejecting ${one ? 'it' : 'them'} keeps this submission, and ${phase.id} can then be approved as it is; `
      + `approving ${one ? 'it' : 'one'} changes the approved clauses, so ${phase.id} reopens to be revised and submitted again.`
  ].join('\n'), {
    code: 'APPROVAL_INTENT_AMENDMENT_PENDING',
    details: {
      workId: workflow.workItem.id,
      phase: phase.id,
      generation: phase.generation,
      ...(scopePhase ? { scopePhase } : {}),
      pendingIntentAmendments: pending,
      nextAction: {
        command: amendmentStatusCommand(workflow.workItem.id),
        label: `See intent amendment ${first.id}, which a person decides before ${phase.id} can be approved.`
      }
    }
  });
}

/**
 * Who can clear each refusal approval can raise [SPEC-OAP M1]: the approver now (`you-decide`),
 * another person or group (`someone-decides`), the author with a fresh submission (`author-repairs`),
 * or Singularity Flow itself (`machine`). Every code the gate throws is listed; the guard in
 * test/oap-m1-approval-check.test.mjs fails on a new one.
 */
export const APPROVAL_HOLD_OWNERS = Object.freeze({
  STORY_ARCHIVED_BY_REBUILD: 'someone-decides',
  READ_ONLY_AGENT_CANNOT_MUTATE: 'you-decide',
  SOURCE_REVIEW_REVIEWER_CANNOT_APPROVE: 'you-decide',
  INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED: 'you-decide',
  SOURCE_REVIEW_AUTHOR_COLLISION: 'author-repairs',
  TCA_AMENDMENT_STALE: 'machine',
  STORY_PUBLICATION_PENDING: 'machine',
  PHASE_ALREADY_APPROVED: 'machine',
  DECISION_REQUIRED: 'someone-decides',
  PHASE_REPAIR_RECHECK_REQUIRED: 'author-repairs',
  PHASE_REPAIR_JOURNAL_INVALID: 'author-repairs',
  PHASE_APPEAL_REVIEW_REQUIRED: 'someone-decides',
  PHASE_APPEAL_INTEGRITY: 'someone-decides',
  TRP_DOCUMENT_GATE_BLOCKED: 'someone-decides',
  TRP_PHASE_GATE_BLOCKED: 'someone-decides',
  SKP_HOST_ENFORCEMENT_UNAVAILABLE: 'someone-decides',
  SKP_HOST_DELIVERY_UNCONFIRMED: 'someone-decides',
  CONFORMANCE_REPORT_INCOMPLETE: 'author-repairs',
  PRIOR_CODE_TEST_EVIDENCE_REQUIRED: 'author-repairs',
  PRIOR_CODE_TEST_EVIDENCE_STALE: 'author-repairs',
  PUBLICATION_SNAPSHOT_CHANGED: 'machine',
  ARTIFACT_AUTHORING_INCOMPLETE: 'author-repairs',
  SOURCE_REVIEW_REQUIRED: 'author-repairs',
  STORY_REVIEW_EVIDENCE_REQUIRED: 'author-repairs',
  STORY_REVIEW_EVIDENCE_INVALID: 'author-repairs',
  STORY_REVIEW_EVIDENCE_STALE: 'author-repairs',
  TCA_EPOCH_VALIDATION_REQUIRED: 'author-repairs',
  STORY_REVIEW_SOURCE_BINDING_REQUIRED: 'author-repairs',
  STORY_REVIEW_SOURCE_CHANGED: 'author-repairs',
  STORY_REVIEW_TEST_INPUT_CHANGED: 'author-repairs',
  STORY_REVIEW_INTERVENING_COMMIT: 'author-repairs',
  PHASE_VALIDATION_FAILED: 'author-repairs',
  CODE_DELIVERY_VALIDATION_REQUIRED: 'author-repairs',
  CODE_DELIVERY_VALIDATION_STALE: 'author-repairs',
  SPEC_COVERAGE_INCOMPLETE: 'author-repairs',
  CONFORMANCE_BLOCKING_VERDICTS: 'someone-decides',
  STORY_COMPLETION_REFUSED: 'someone-decides',
  APPROVAL_AGENT_BRIEF_INVALID: 'author-repairs',
  APPROVAL_IDENTITY_NOT_AUTHORIZED: 'someone-decides',
  APPROVAL_IDENTITY_MISSING: 'someone-decides',
  APPROVAL_IDENTITY_ALREADY_RECORDED: 'someone-decides',
  APPROVAL_CHECKLIST_INCOMPLETE: 'you-decide',
  WEL_WITNESS_MAPPING_STALE: 'author-repairs',
  WEL_WITNESS_MAPPING_UNREVIEWED: 'you-decide',
  APPROVAL_SELF_APPROVAL_PROHIBITED: 'someone-decides',
  APPROVAL_INTENT_AMENDMENT_PENDING: 'someone-decides',
  SPEC_PLANNED_CLAIM_MAP_REQUIRED: 'author-repairs'
});
const OWNER_PREFIXES = Object.freeze([['IMPLEMENTATION_BINDING_', 'you-decide'], ['CONVERGENCE_', 'machine']]);
const OWNER_WORDS = Object.freeze({ 'you-decide': 'You decide', 'someone-decides': 'Someone else decides',
  'author-repairs': 'The author revises it', machine: 'Singularity Flow finishes it' });

/** Who clears a refusal, by its code and what it says: a pending amendment or a lapsed test-run risk waits for a person. */
export function approvalHoldOwner(error) {
  const code = String(error?.code ?? '');
  if (code === 'STORY_REVIEW_INTERVENING_COMMIT' && error.details?.pendingIntentAmendments?.length) return 'someone-decides';
  if (['PHASE_VALIDATION_FAILED', 'CODE_DELIVERY_VALIDATION_REQUIRED'].includes(code) && error.details?.testRunRisk) return 'someone-decides';
  // A coverage gap every clause of which an open upstream issue names is that issue's approvers' to decide.
  if (code === 'SPEC_COVERAGE_INCOMPLETE' && error.details?.upstreamDecision?.complete === true) return 'someone-decides';
  return APPROVAL_HOLD_OWNERS[code] ?? OWNER_PREFIXES.find(([prefix]) => code.startsWith(prefix))?.[1] ?? 'author-repairs';
}

/**
 * The way through a hold: the route its refusal names for itself (its next action, recovery command,
 * test-run risk renewal or first action), else the one its owner implies: work the author revises is
 * returned for changes, and what Singularity Flow finishes is inspected with recover.
 */
function holdRoute(error, owner, workflow, phase) {
  const details = error.details ?? {};
  const named = [details.nextAction, details.recoveryCommand, details.command, details.testRunRisk?.command,
    ...(Array.isArray(details.recoveryCommands) ? details.recoveryCommands : []), ...(Array.isArray(details.actions) ? details.actions : [])]
    .map((entry) => (typeof entry === 'string' ? { command: entry } : entry))
    .find((entry) => typeof entry?.command === 'string' && safeCommandGuidance({ command: entry.command }));
  if (named) return { label: String(named.label ?? named.detail ?? '').slice(0, 400), command: safeCommandGuidance({ command: named.command }).command };
  const workId = workflow.workItem.id;
  if (owner === 'author-repairs') return { label: `An approver returns ${phase.id} for changes; its author revises it and submits it again.`,
    command: `singularity-flow reject ${phase.id} --work-id ${workId} --fetch --reason <REASON>` };
  if (owner === 'machine') return { label: 'See what Singularity Flow finishes first.', command: `singularity-flow recover ${workId} --phase ${phase.id} --json` };
  return null;
}

/** One hold as every surface shows it: who clears it, its first sentence, and its route. */
function approvalHold(error, workflow, phase) {
  const owner = approvalHoldOwner(error);
  const route = holdRoute(error, owner, workflow, phase);
  return {
    code: String(error.code ?? 'SINGULARITY_FLOW_ERROR'), owner, who: OWNER_WORDS[owner],
    summary: String(error.message ?? '').split('\n')[0].slice(0, 400),
    ...(route ? { action: route } : {}),
    ...(APPROVAL_HOLD_OWNERS[error.code] || OWNER_PREFIXES.some(([prefix]) => String(error.code ?? '').startsWith(prefix)) ? {} : { unclassified: true })
  };
}

/** The commits-after-submission advisory, from the gate's own refusal for them. */
function blockingCommitsAdvisory(error, workflow, phase) {
  const details = error.details ?? {};
  const count = details.blockingCommitCount ?? details.blockingCommits?.length ?? 0;
  const [first] = details.pendingIntentAmendments ?? [];
  const workId = workflow.workItem.id;
  return {
    advisory: true,
    count,
    statement: `Approving ${phase.id} now would be refused: ${count === 1 ? 'a commit' : `${count} commits`} after its submission may not precede approval.`,
    commits: details.blockingCommits ?? [],
    lines: String(error.message ?? '').split('\n').slice(1),
    ...(first ? {
      pendingIntentAmendments: details.pendingIntentAmendments,
      actions: [
        { label: `See intent amendment ${first.id}.`, command: amendmentStatusCommand(workId) },
        { label: `A person who approves ${details.scopePhase ?? 'the scope'} decides ${first.id} in their own terminal; an agent cannot.`,
          command: `singularity-flow story intent-amendment decide ${first.id} --decision <approve|reject> --confirm ${first.id} --work-id ${workId}` }
      ]
    } : {})
  };
}

/**
 * Rejected amendments decided while the step waited: allowed before approval, and still named so the
 * approver sees what happened after the submission.
 */
function decidedAfterSubmission(rejected = []) {
  const amendments = rejected.map(({ id, status, proposalCommit, rejectionCommit }) => ({
    id, status, proposalCommit: shortCommit(proposalCommit), rejectionCommit: shortCommit(rejectionCommit) }));
  return amendments.length ? {
    decidedAfterSubmission: amendments,
    notes: amendments.map((entry) => `Decided after the submission: ${entry.id} rejected (proposal ${entry.proposalCommit}, `
      + `rejection ${entry.rejectionCommit}); the reviewed inputs are unchanged.`)
  } : {};
}

/**
 * Whether approving the current step would pass, before anyone reviews it: the gate itself, run as a
 * preview (evaluateApproval) for the person looking [SPEC-OAP M1]. `approvalCheck` lists every hold
 * with who clears it, and notes each rejected amendment decided since the submission;
 * `blockingCommits` names the commits after the submission that approval would refuse for.
 * Advisory: it refuses nothing and changes no route, and recording runs the same checks again. Null
 * when the step does not await approval or the check could not run here.
 */
export async function approvalAdvisories(root, config, workflow, phase) {
  if (!config || phase?.status !== 'awaiting_approval' || phase.id !== workflow?.currentPhase) return null;
  try {
    const { evaluateApproval } = await import('./state.mjs');
    const checked = await evaluateApproval(root, config, structuredClone(workflow), { phaseId: phase.id, preview: true });
    const holds = checked.holds.map((error) => approvalHold(error, workflow, phase));
    const blocking = holds.filter((hold) => hold.owner !== 'you-decide');
    const intervening = checked.holds.find((error) => error.code === 'STORY_REVIEW_INTERVENING_COMMIT');
    const approvalCheck = {
      advisory: true,
      ready: !blocking.length,
      statement: !holds.length ? `Approving ${phase.id} would pass every check.`
        : !blocking.length ? `Approving ${phase.id} needs your own answers first: ${holds.length === 1 ? 'one' : holds.length} in the approval itself.`
          : `Approving ${phase.id} now would be refused until ${blocking.length === 1 ? 'one hold is' : `${blocking.length} holds are`} cleared.`,
      holds,
      ...decidedAfterSubmission(checked.rejectedIntentAmendments),
      ...(checked.warnings.length ? { warnings: checked.warnings.slice(0, 20) } : {})
    };
    return { approvalCheck, ...(intervening ? { blockingCommits: blockingCommitsAdvisory(intervening, workflow, phase) } : {}) };
  } catch { return null; }
}
