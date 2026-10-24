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
import { safeCommandGuidance } from './safe-command-guidance.mjs';
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
  return APPROVAL_HOLD_OWNERS[code] ?? OWNER_PREFIXES.find(([prefix]) => code.startsWith(prefix))?.[1] ?? 'author-repairs';
}

/**
 * The way through a hold: the route its refusal names for itself (its next action, recovery command,
 * test-run risk renewal or first action), else the one its owner implies: work the author revises is
 * returned for changes, and what Singularity Flow finishes is inspected with recover.
 */
function holdRoute(error, owner, workflow, phase) {
  const details = error.details ?? {};
  const named = [details.nextAction, details.recoveryCommand, details.command, details.testRunRisk?.command, ...(Array.isArray(details.actions) ? details.actions : [])]
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
 * Whether approving the current step would pass, before anyone reviews it: the gate itself, run as a
 * preview (evaluateApproval) for the person looking [SPEC-OAP M1]. `approvalCheck` lists every hold
 * with who clears it; `blockingCommits` names the commits after the submission. Advisory: it refuses
 * nothing and changes no route, and recording runs the same checks again. Null when the step does not
 * await approval or the check could not run here.
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
      ...(checked.warnings.length ? { warnings: checked.warnings.slice(0, 20) } : {})
    };
    return { approvalCheck, ...(intervening ? { blockingCommits: blockingCommitsAdvisory(intervening, workflow, phase) } : {}) };
  } catch { return null; }
}
