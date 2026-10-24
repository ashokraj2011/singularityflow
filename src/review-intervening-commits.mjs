/**
 * The commits that stop a submitted phase's approval, named and routed by kind.
 *
 * Approval binds the exact history that was submitted: only prior approvals, applicability
 * decisions and an exact Auto checkpoint may follow the review evidence. The refusal used to say
 * only that history changed, so a person could not tell which commit, or why. The common case is an
 * intent amendment proposed while the phase waited for review: the person's next step is deciding
 * that amendment, not repairing the phase, and nothing in the refusal said so.
 */
import { governedCommitIdentity } from './git.mjs';
import { scopeStepOf } from './phase-roles.mjs';
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
      + `rejecting it keeps them, but ${phase.id} still needs a fresh submission before it can be approved.`);
  }
  if (decided.length) {
    lines.push(`Decided after the submission: intent amendment ${decided.join(', ')}. Phase '${phase.id}' still needs a fresh submission before it can be approved.`);
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
      + 'Only prior approvals, applicability decisions or an exact Auto human-boundary checkpoint for this submitted phase may precede another approval; submit fresh evidence for every other commit.',
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
 * The commits approval would refuse for, named while the step is reviewed: in the approval packet's
 * readiness and in phase show. Advisory only. It refuses nothing and changes no route; the approval
 * gate still decides, from the same classification (reviewHistoryCommits). Null when nothing blocks
 * or the history cannot be read here.
 */
export async function approvalBlockingCommits(root, config, workflow, phase) {
  if (!config || phase?.status !== 'awaiting_approval' || phase.id !== workflow?.currentPhase) return null;
  try {
    const entry = [...(workflow.lineage?.submissions ?? [])].reverse().find((submission) =>
      submission.phase === phase.id && Number(submission.generation) === Number(phase.generation));
    if (!entry) return null;
    const { readStoryReviewPacket } = await import('./story-lineage.mjs');
    const submittedReview = await readStoryReviewPacket(root, config, workflow, entry.packetSha256);
    if (!/^[0-9a-f]{40,64}$/u.test(String(submittedReview.evidenceCommit ?? ''))) return null;
    const { reviewHistoryCommits } = await import('./state.mjs');
    const history = await reviewHistoryCommits(root, config, workflow, phase, submittedReview, {
      // The risk reviews approval would read. A gate that refuses verifies no review commit here.
      reviewedRisks: async () => {
        const risks = [];
        const reference = phase.deliveryEvidence?.testRecovery;
        if (reference) {
          try {
            risks.push(await (await import('./test-recovery-runtime.mjs')).assertStoryTestRiskGate(root, config, workflow, {
              phaseId: phase.id, operation: 'approve', generation: phase.generation,
              observationSha256: reference.observationSha256, evidenceCommit: submittedReview.evidenceCommit }));
          } catch { /* approval refuses at that gate first */ }
        }
        try {
          risks.push(...await (await import('./trp-document-runtime.mjs')).assertStoryDocumentRiskGates(root, config, workflow, phase, 'approve'));
        } catch { /* approval refuses at that gate first */ }
        return risks;
      }
    });
    if (!history.blocking.length) return null;
    const facts = blockingCommitFacts(root, workflow, phase, history.blocking, submittedReview.evidenceCommit);
    const [first] = facts.pendingIntentAmendments;
    const workId = workflow.workItem.id;
    return {
      advisory: true,
      count: history.blocking.length,
      statement: `Approving ${phase.id} now would be refused: ${history.blocking.length === 1 ? 'a commit' : `${history.blocking.length} commits`} after its submission may not precede approval.`,
      commits: facts.shown,
      lines: facts.lines,
      ...(first ? {
        pendingIntentAmendments: facts.pendingIntentAmendments,
        actions: [
          { label: `See intent amendment ${first.id}.`, command: amendmentStatusCommand(workId) },
          { label: `A person who approves ${facts.scopePhase ?? 'the scope'} decides ${first.id} in their own terminal; an agent cannot.`,
            command: `singularity-flow story intent-amendment decide ${first.id} --decision <approve|reject> --confirm ${first.id} --work-id ${workId}` }
        ]
      } : {})
    };
  } catch { return null; }
}
