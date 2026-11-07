/** Native upstream-issue recording. Existing authority, record and transaction semantics are retained. */
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {decidableUpstreamStep,decideUpstreamIssue,raiseUpstreamIssue,upstreamIssueAuthorities,upstreamIssueStates,UPSTREAM_ISSUE_OUTCOMES} from '../upstream-issues.mjs';
import {LIFECYCLE_EVENT} from '../lifecycle-event.mjs';
import {actorKey,assertNoPendingPublication,rejectPhase,transactStory} from '../state-stores.mjs';
import {nowIso,SingularityFlowError} from '../util.mjs';

function refused(message, code = 'UPSTREAM_ISSUE_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

/**
 * An issue raised against a step with no approval group: nobody can decide it, and the Story cannot
 * finish while it is open. Its way out is a superseding issue at a step whose approvers can decide
 * both (they dismiss the old one), named exactly.
 */
export function undecidableIssue(workflow, issue) {
  const instead = decidableUpstreamStep(workflow, issue.phase);
  const workId = workflow.workItem?.id ?? '<WORK-ID>';
  const supersede = instead ? `singularity-flow upstream-issue raise --work-id ${workId} --phase ${instead} --supersedes ${issue.id} --about <ID|SECTION> --problem <TEXT>` : null;
  return [`${issue.phase} has no approval group, so nobody can decide ${issue.id}. `
    + (supersede ? `Raise the same problem against ${instead}, superseding it: ${supersede}. ${instead}'s approvers then decide the new issue.` : 'No earlier step has approvers to take it over.'),
  'UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE', { issue: issue.id, phase: issue.phase, ...(supersede ? { decidableStep: instead, nextAction: { command: supersede } } : {}) }];
}

/**
 * Raise one issue and commit it. One issue per commit, so each is a single appended decision that may
 * sit between a step's submission and its approval without staling either. `raise` and the decision
 * list both raise through this.
 */
export async function commitUpstreamIssue(root, config, workflow, request, { actor, agent = null, authored = 'human' }) {
  const part = upstreamIssuePart(workflow, request, { actor, agent, authored });
  const { value } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
    actor, agent, authorityGroup: null, payload: { decision: 'upstream-issue' }
  }, part.message, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'raise an upstream issue');
    return part.write(aggregate);
  }, { exactWorkItemPaths: [], eventFromResult: (issue) => ({ payload: { decision: 'upstream-issue', issue: issue.id, reviewPacketSha256: null } }) });
  return value;
}

/** One issue to raise, checked and ready to write into a transaction: its own commit's or an approval's [SPEC-OAP M4]. */
export function upstreamIssuePart(workflow, request, { actor, agent = null, authored = 'human' }) {
  raiseUpstreamIssue(structuredClone(workflow), { ...request, authored, agent, raisedBy: actorKey(actor), at: nowIso() });
  return {
    decision: 'upstream-issue', phaseId: workflow.currentPhase ?? null, authority: null,
    message: `[${workflow.workItem.id}][upstream-issue] raise against ${request.phase}`,
    write(aggregate) {
      const issue = raiseUpstreamIssue(aggregate, { ...request, authored, agent, raisedBy: actorKey(actor), at: nowIso() });
      aggregate.history.push({ at: issue.at, actor: issue.raisedBy, agent, event: 'upstream_issue_raised', phase: aggregate.currentPhase ?? null,
        detail: `${issue.id} against ${issue.phase} (${issue.about}): ${issue.problem}${issue.supersedes ? ` It supersedes ${issue.supersedes}.` : ''}` });
      return issue;
    },
    record: (issue) => issue.id
  };
}

/**
 * Decide one issue through the earlier step's approval groups and commit it: a return rejects the
 * current step to the issue's step in the same commit. `decide` and the decision list both decide
 * through this, and every other outcome through `upstreamIssueDecisionPart`, which an approval also
 * writes into its own commit, so authority, validation and the record are the same.
 */
export async function decideUpstreamIssueRecord(root, config, workflow, issueId, {
  outcome, reason = '', link = null, expires = null
}, { actor, agent = null }) {
  if (outcome !== 'return') {
    const part = upstreamIssueDecisionPart(root, config, workflow, issueId, { outcome, reason, link, expires }, { actor, agent });
    const { value } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: part.authority.authorityGroup, payload: { decision: 'upstream-issue' }
    }, part.message, async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'decide an upstream issue');
      return part.write(aggregate);
    }, { exactWorkItemPaths: [], eventFromResult: (recorded) => ({ authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
      payload: { decision: 'upstream-issue', issue: recorded.issue, reviewPacketSha256: null } }) });
    return { value, authority: part.authority };
  }
  const state = upstreamIssueStates(workflow).find((entry) => entry.issue.id === issueId);
  if (!state) refused(`${issueId || 'That issue'} is not an upstream issue of this Story. List them with upstream-issue list.`, 'UPSTREAM_ISSUE_NOT_FOUND');
  const groups = upstreamIssueAuthorities(workflow, state.issue.phase);
  if (!groups.length) refused(...undecidableIssue(workflow, state.issue));
  const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  const decision = (aggregate, recordLink = link) => decideUpstreamIssue(aggregate, {
    issue: issueId, outcome, reason, link: recordLink, expiresAt: expires,
    actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null, at: nowIso()
  });
  // Check everything except the change request a return opens before anything is written.
  decision(structuredClone(workflow), 'CR-999');
  const record = (aggregate, recorded) => {
    aggregate.history.push({ at: recorded.at, actor: recorded.actor, agent, event: 'upstream_issue_decided', phase: aggregate.currentPhase ?? null,
      detail: `${recorded.issue}: ${recorded.outcome}${recorded.link ? ` (${recorded.link})` : ''}. ${recorded.reason}` });
    return recorded;
  };
  const current = workflow.phases?.[workflow.currentPhase];
  if (!current || !['in_progress', 'awaiting_approval'].includes(current.status)) {
    refused('A return needs a current step in progress or awaiting approval.', 'UPSTREAM_ISSUE_RETURN_UNAVAILABLE');
  }
  const target = state.issue.phase;
  const { value } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.PHASE_REJECTED, phaseId: current.id, generation: current.generation, actor, agent,
    payload: { targetPhaseId: target }
  }, `[${workflow.workItem.id}][upstream-issue] ${issueId} returns to ${target}`, async (aggregate) => {
    const returned = await rejectPhase(root, config, aggregate, { phaseId: current.id, target, reason, actor, agent,
      channel: 'terminal', upstreamIssue: { id: issueId } });
    return { ...record(aggregate, decision(aggregate, returned.changeRequest.id)), changeRequest: returned.changeRequest };
  }, { eventFromResult: (result) => ({ payload: { targetPhaseId: target, changeRequestId: result.changeRequest.id } }) });
  return { value, authority };
}

/**
 * One decision on an upstream issue that only records it (every outcome but a return, which rejects
 * the current step), checked and ready to write into an approval's transaction [SPEC-OAP M4].
 */
export function upstreamIssueDecisionPart(root, config, workflow, issueId, { outcome, reason = '', link = null, expires = null }, { actor, agent = null }) {
  if (outcome === 'return') refused(`Returning ${issueId} rejects the current step, so it is not recorded with an approval. Record it with upstream-issue decide.`, 'UPSTREAM_ISSUE_RETURN_UNAVAILABLE');
  const state = upstreamIssueStates(workflow).find((entry) => entry.issue.id === issueId);
  if (!state) refused(`${issueId || 'That issue'} is not an upstream issue of this Story. List them with upstream-issue list.`, 'UPSTREAM_ISSUE_NOT_FOUND');
  if (!UPSTREAM_ISSUE_OUTCOMES.includes(outcome)) refused(`--outcome must be one of ${UPSTREAM_ISSUE_OUTCOMES.join(', ')}.`);
  const groups = upstreamIssueAuthorities(workflow, state.issue.phase);
  if (!groups.length) refused(...undecidableIssue(workflow, state.issue));
  const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  const decision = (aggregate) => decideUpstreamIssue(aggregate, {
    issue: issueId, outcome, reason, link, expiresAt: expires,
    actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null, at: nowIso()
  });
  decision(structuredClone(workflow));
  return {
    decision: 'upstream-issue', phaseId: workflow.currentPhase ?? null, authority,
    message: `[${workflow.workItem.id}][upstream-issue] ${issueId} ${outcome}`,
    write(aggregate) {
      const recorded = decision(aggregate);
      aggregate.history.push({ at: recorded.at, actor: recorded.actor, agent, event: 'upstream_issue_decided', phase: aggregate.currentPhase ?? null,
        detail: `${recorded.issue}: ${recorded.outcome}${recorded.link ? ` (${recorded.link})` : ''}. ${recorded.reason}` });
      return recorded;
    },
    record: (recorded) => `${recorded.issue} ${recorded.outcome}`
  };
}
