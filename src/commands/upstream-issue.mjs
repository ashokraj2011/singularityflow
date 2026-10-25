/**
 * `upstream-issue raise|list|decide`: record a defect in an earlier step without stopping the
 * current one, and let that step's approvers decide it. `[UIF-M2]`
 */
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { repoRoot } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { loadSession } from '../session.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { workDirRelative } from '../story-paths.mjs';
import { assertNoPendingPublication, actorKey, decideForwardAmendment, proposeForwardAmendment, rejectPhase, revalidateAfterForwardAmendment, transactStory } from '../state-stores.mjs';
import { persistGenerationPublicationRecord } from '../generation-publication-store.mjs';
import { nextForwardAmendmentProposal, pendingAmendmentRevalidations, revalidateCommand } from '../forward-amendments.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { discrepancySteps, upstreamDiscrepanciesFromMarkdown } from '../phase-upstream-discrepancies.mjs';
import {
  decideUpstreamIssue, discrepancyIssueRequests, raiseUpstreamIssue, upstreamIssueAuthorities, upstreamIssueDecideCommand,
  upstreamIssueStates, UPSTREAM_ISSUE_OUTCOMES, UPSTREAM_ISSUE_PROBLEM_MAXIMUM, UPSTREAM_ISSUE_PROPOSALS
} from '../upstream-issues.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { actionActor } from './kernel.mjs';

export const UPSTREAM_ISSUE_ACTIONS = Object.freeze(['raise', 'list', 'decide', 'propose-amendment', 'decide-amendment', 'revalidate']);
const ALLOWED = {
  raise: ['phase', 'about', 'problem', 'assumption', 'impact', 'proposed', 'authored', 'from-artifact', 'supersedes'],
  list: ['open'],
  decide: ['outcome', 'reason', 'link', 'expires'],
  'propose-amendment': ['phase', 'reason', 'file', 'issue'],
  'decide-amendment': ['decision', 'reason', 'confirm'],
  revalidate: ['amendment', 'outcome', 'reason']
};

function refused(message, code = 'UPSTREAM_ISSUE_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function emit(options, workflow, action, { slots = {}, body = {}, changed = false }) {
  emitCommandResult(commandResult({
    operation: { id: `upstream-issue.${action}`, classification: action === 'list' ? 'read' : 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id }, outcome: succeeded(`upstream-issue.${action}.succeeded`, slots),
    effects: changed ? effects({ stateChanged: true, filesChanged: true, publicationCreated: true }) : noEffects(),
    data: body
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

/** The current step's Markdown: registered artifacts, its required artifact and its draft folder. */
async function stepDocuments(root, config, workflow, phase) {
  const item = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const paths = new Set((phase.artifacts ?? []).map((artifact) => artifact.path).filter(Boolean));
  if (phase.requiredArtifact?.path) paths.add(path.posix.join(item, phase.requiredArtifact.path));
  const folder = path.posix.join(item, 'artifacts', phase.id);
  for (const entry of (await readdir(path.join(root, folder), { withFileTypes: true }).catch(() => [])).slice(0, 50)) {
    if (entry.isFile()) paths.add(path.posix.join(folder, entry.name));
  }
  return [...paths].filter((file) => /\.(?:md|markdown)$/iu.test(file)).sort();
}

/**
 * Items the current step's own documents list under `## Upstream discrepancies`, not yet raised.
 * An item is raised only against the one earlier step it names as its owner; the rest come back
 * with the command that raises them once the author names the step.
 */
async function recordedDiscrepancies(root, config, workflow) {
  const current = workflow.phases?.[workflow.currentPhase];
  if (!current) refused('The Story has no current step whose artifacts could list discrepancies.');
  const steps = discrepancySteps(workflow);
  const order = steps.map((step) => step.id);
  const earlier = order.slice(0, Math.max(0, order.indexOf(current.id)));
  const entries = [];
  for (const file of await stepDocuments(root, config, workflow, current)) {
    const content = await readFile(path.join(root, file), 'utf8').catch(() => null);
    if (content == null) continue;
    for (const item of upstreamDiscrepanciesFromMarkdown(content, steps, { earlier })) entries.push({ path: file, item });
  }
  const sorted = discrepancyIssueRequests(workflow, entries);
  const workId = workflow.workItem.id;
  const produced = earlier.filter((id) => Number(workflow.phases?.[id]?.generation) > 0 && workflow.phases[id].status !== 'not_started');
  const unowned = sorted.unowned.map(({ path: file, text, owner, about }) => ({
    path: file, text, owner,
    reason: owner.status === 'conflicting' ? `it names more than one owning step (${owner.named.join(', ')})`
      : owner.status === 'not-earlier' ? `it names ${owner.named[0]}, which is not a step before ${current.id}`
        : owner.status === 'unknown-step' ? `its owner field names "${owner.value}", which is not a step of this Story`
          : owner.status === 'not-run' ? `it names ${owner.named[0]}, which has not produced anything`
          : 'it does not name its owning step',
    command: `singularity-flow upstream-issue raise --work-id ${workId} --phase ${produced.length ? produced.join('|') : '<EARLIER>'} --about "${about.replaceAll('"', "'")}" --problem "<this item's text>"`,
    rerun: `singularity-flow upstream-issue raise --from-artifact --work-id ${workId}`
  }));
  return { ...sorted, unowned };
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

async function raise(root, config, workflow, options) {
  const fromArtifact = optionBoolean(options, 'from-artifact');
  const chosen = optionString(options, 'proposed');
  if (chosen != null && !UPSTREAM_ISSUE_PROPOSALS.includes(chosen)) refused(`--proposed must be one of ${UPSTREAM_ISSUE_PROPOSALS.join(', ')}.`);
  const authored = optionString(options, 'authored') ?? 'human';
  if (!['human', 'governed-agent'].includes(authored)) refused('--authored must be human or governed-agent.');
  const manual = fromArtifact ? ['phase', 'about', 'problem', 'assumption', 'impact', 'supersedes'].filter((key) => options[key] !== undefined) : [];
  if (manual.length) {
    refused(`--from-artifact reads each item's owning step and text from the artifact, so it takes no --${manual.join(' or --')}. `
      + 'Raise one item yourself with --phase and --problem, without --from-artifact.', 'UPSTREAM_ISSUE_OPTIONS_INVALID');
  }
  const recorded = fromArtifact ? await recordedDiscrepancies(root, config, workflow) : null;
  if (recorded?.tooLong.length) {
    refused(`${recorded.tooLong.length} recorded item(s) are longer than the ${UPSTREAM_ISSUE_PROBLEM_MAXIMUM}-character limit of an upstream issue's problem, so nothing was raised: `
      + `${recorded.tooLong.map((entry) => `${entry.path} (${entry.length} characters: "${entry.text.slice(0, 60)}…")`).join('; ')}. `
      + `Split each into shorter items under \`## Upstream discrepancies\`, or raise it with --phase, a --problem of at most ${UPSTREAM_ISSUE_PROBLEM_MAXIMUM} characters, and --assumption and --impact.`,
    'UPSTREAM_ISSUE_PROBLEM_TOO_LONG', { maximum: UPSTREAM_ISSUE_PROBLEM_MAXIMUM, items: recorded.tooLong });
  }
  const requests = recorded
    ? recorded.requests.map((request) => ({ ...request, proposed: chosen ?? request.proposed }))
    : [{ phase: optionString(options, 'phase'), about: optionString(options, 'about'), problem: optionString(options, 'problem'),
      assumption: optionString(options, 'assumption') ?? null, impact: optionString(options, 'impact') ?? null, proposed: chosen ?? 'unknown',
      source: null, supersedes: optionString(options, 'supersedes') ?? null }];
  if (!fromArtifact && !requests[0].phase) refused('Name the earlier step with --phase.');
  const actor = actionActor(root);
  const session = await loadSession(root, { required: false });
  const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
  // Validate every item before the first commit, so a malformed one records nothing.
  for (const request of requests) raiseUpstreamIssue(structuredClone(workflow), { ...request, authored, agent,
    raisedBy: actorKey(actor), at: nowIso() });
  const raised = [];
  for (const request of requests) raised.push(await commitUpstreamIssue(root, config, workflow, request, { actor, agent, authored }));
  const unowned = recorded?.unowned ?? [];
  if (!optionBoolean(options, 'json')) {
    if (!raised.length && !unowned.length) console.log('No unraised upstream discrepancies are recorded in this step\'s artifacts.');
    for (const issue of raised) {
      console.log(`Raised ${issue.id} against ${issue.phase}: ${issue.about}. This step continues; ${issue.phase}'s approvers decide it:`);
      console.log(`  ${upstreamIssueDecideCommand(workflow.workItem.id, issue)}`);
      const prior = issue.supersedes ? workflow.upstreamIssues?.find((entry) => entry.id === issue.supersedes) : null;
      if (prior) console.log(`${issue.id} supersedes ${prior.id}, recorded against ${prior.phase}: it no longer blocks anything and stays in the history.`);
    }
    if (unowned.length) console.log(`Not raised: ${unowned.length} item(s) name no single earlier owning step, and an owner is never guessed.`);
    for (const item of unowned) {
      const text = item.text.replace(/\s*\n\s*/gu, ' ');
      console.log(`  - ${item.path}: ${text.length > 160 ? `${text.slice(0, 159)}…` : text}`);
      console.log(`    Not raised because ${item.reason}. Raise it against its owning step:`);
      console.log(`    ${item.command}`);
      console.log(`    Or start the item with that step (for example "planning: …") or add "Owner: <step>", then rerun: ${item.rerun}`);
    }
  }
  emit(options, workflow, 'raise', { slots: { count: String(raised.length), unowned: String(unowned.length) },
    body: { issues: raised, unowned }, changed: raised.length > 0 });
}

function list(workflow, options) {
  const states = upstreamIssueStates(workflow).filter((entry) => !optionBoolean(options, 'open') || ['open', 'expired'].includes(entry.status));
  if (!optionBoolean(options, 'json')) {
    if (!states.length) console.log(optionBoolean(options, 'open') ? 'No open upstream issues.' : 'No upstream issues.');
    for (const { issue, decision, status, supersededBy } of states) {
      console.log(`${issue.id} [${status}] ${issue.phase} — ${issue.about}: ${issue.problem}`);
      if (issue.supersedes) console.log(`  supersedes ${issue.supersedes}`);
      if (supersededBy) console.log(`  superseded by ${supersededBy}${status === 'decided' ? '' : '; it no longer blocks anything'}`);
      if (decision) console.log(`  ${decision.outcome}${decision.link ? ` (${decision.link})` : ''} by ${decision.actor}: ${decision.reason}`);
      else if (status !== 'superseded') console.log(`  ${upstreamIssueDecideCommand(workflow.workItem.id, issue)}`);
    }
  }
  emit(options, workflow, 'list', {
    slots: { count: String(states.length) },
    body: { issues: states.map(({ issue, decision, status, supersededBy }) => ({ ...issue, status, decision, supersededBy })) }
  });
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
  if (!groups.length) refused(`${state.issue.phase} has no approval group, so nobody can decide this issue.`, 'UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE');
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
  if (!groups.length) refused(`${state.issue.phase} has no approval group, so nobody can decide this issue.`, 'UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE');
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

async function decide(root, config, workflow, issueId, options) {
  const state = upstreamIssueStates(workflow).find((entry) => entry.issue.id === issueId);
  if (!state) refused(`${issueId || 'That issue'} is not an upstream issue of this Story. List them with upstream-issue list.`, 'UPSTREAM_ISSUE_NOT_FOUND');
  const outcome = optionString(options, 'outcome');
  if (!UPSTREAM_ISSUE_OUTCOMES.includes(outcome)) refused(`--outcome must be one of ${UPSTREAM_ISSUE_OUTCOMES.join(', ')}.`);
  const groups = upstreamIssueAuthorities(workflow, state.issue.phase);
  if (!groups.length) refused(`${state.issue.phase} has no approval group, so nobody can decide this issue.`, 'UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE');
  const actor = actionActor(root);
  const session = await loadSession(root, { required: false });
  const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
  const { value, authority } = await decideUpstreamIssueRecord(root, config, workflow, issueId, {
    outcome, reason: optionString(options, 'reason') ?? '', link: optionString(options, 'link') ?? null, expires: optionString(options, 'expires') ?? null
  }, { actor, agent });
  if (!optionBoolean(options, 'json')) {
    console.log(`Decided ${issueId} through ${authority.authorityGroup}: ${outcome}${value.link ? ` (${value.link})` : ''}.`);
    if (outcome === 'return') console.log(`${value.changeRequest.id} returned the Story to ${value.changeRequest.targetPhase}; the current step's working files are kept.`);
  }
  const { changeRequest, ...recorded } = value;
  emit(options, workflow, 'decide', { slots: { issue: issueId, outcome },
    body: { decision: recorded, ...(changeRequest ? { changeRequestId: changeRequest.id } : {}) }, changed: true });
}

/** Save corrected bytes of an earlier step for its approvers [UIF-M3]. */
async function proposeAmendment(root, config, workflow, options) {
  const actor = actionActor(root);
  const session = await loadSession(root, { required: false });
  const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
  const phaseId = optionString(options, 'phase');
  if (!phaseId) refused('Name the earlier step with --phase.');
  const issue = optionString(options, 'issue') ?? null;
  if (issue && !upstreamIssueStates(workflow).some((entry) => entry.issue.id === issue && entry.issue.phase === phaseId)) {
    refused(`${issue} is not an upstream issue about ${phaseId}.`);
  }
  const target = workflow.phases?.[phaseId];
  if (!target?.requiredArtifact?.path) refused(`${phaseId} is not a step with one document to amend.`);
  const expected = nextForwardAmendmentProposal(workDirRelative(config, workflow.workItem.id), workflow,
    `${workDirRelative(config, workflow.workItem.id)}/${target.requiredArtifact.path}`);
  // The amended step's document is reset to its approved bytes in the same transaction; listing it in
  // exactWorkItemPaths lets a refused transaction restore the person's edit instead of leaving it reset.
  const { value: proposal } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
    actor, agent, authorityGroup: null, payload: { decision: 'forward-amendment', stage: 'proposed' }
  }, `[${workflow.workItem.id}][forward-amendment] propose ${phaseId}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'propose a forward amendment');
    return proposeForwardAmendment(root, config, aggregate, { phaseId, reason: optionString(options, 'reason'),
      file: optionString(options, 'file') ?? null, actor, agent, upstreamIssue: issue });
  }, { exactWorkItemPaths: [expected.proposedPath, `${workDirRelative(config, workflow.workItem.id)}/${target.requiredArtifact.path}`],
    eventFromResult: (result) => ({ payload: { decision: 'forward-amendment', stage: 'proposed', amendment: result.id, reviewPacketSha256: null } }) });
  const decide = `singularity-flow upstream-issue decide-amendment ${proposal.id} --work-id ${workflow.workItem.id} --decision approve|reject --reason "<why>" --confirm ${proposal.id}`;
  if (!optionBoolean(options, 'json')) {
    console.log(`Proposed ${proposal.id}: ${phaseId} generation ${proposal.fromGeneration + 1} from ${proposal.proposedPath}. ${phaseId}'s approvers decide it:`);
    console.log(`  ${decide}`);
  }
  emit(options, workflow, 'propose-amendment', { slots: { amendment: proposal.id, phase: phaseId }, body: { proposal, decide }, changed: true });
}

/** The amended step's approvers install the proposal as its next approved generation, or reject it. */
async function decideAmendment(root, config, workflow, amendmentId, options) {
  if (optionString(options, 'confirm') !== amendmentId) refused(`Confirm the exact amendment: --confirm ${amendmentId}.`, 'FORWARD_AMENDMENT_CONFIRMATION_REQUIRED');
  const proposal = (workflow.forwardAmendments ?? []).find((entry) => entry.id === amendmentId);
  if (!proposal) refused(`${amendmentId || 'That amendment'} is not a forward amendment of this Story.`, 'FORWARD_AMENDMENT_NOT_FOUND');
  const actor = actionActor(root);
  const decision = optionString(options, 'decision');
  const { value } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: proposal.phase, generation: null,
    actor, agent: null, authorityGroup: null, payload: { decision: 'forward-amendment', amendment: amendmentId }
  }, `[${workflow.workItem.id}][forward-amendment] ${decision} ${amendmentId}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'decide a forward amendment');
    return decideForwardAmendment(root, config, aggregate, { amendmentId, decision, reason: optionString(options, 'reason'), actor, agent: null });
  }, {
    eventFromResult: (result) => result.applied ? {
      actor: result.approval.actor, agent: result.approval.agent, authorityGroup: result.approval.authorityGroup,
      identityAssurance: result.approval.identityAssurance, phaseId: proposal.phase, generation: result.approval.generation,
      payload: { decision: 'forward-amendment', amendment: amendmentId, decisionSha256: result.decisionSha256, reviewPacketSha256: null }
    } : { authorityGroup: result.decision.authorityGroup,
      payload: { decision: 'forward-amendment', amendment: amendmentId, outcome: 'rejected', reviewPacketSha256: null } },
    afterEventFinalize: async (publicationEvent, transactionContext, result) => {
      if (!result?.applied) return;
      await persistGenerationPublicationRecord(root, workflow, workflow.phases[proposal.phase], {
        publicationEvent, transactionId: transactionContext.transactionId, expectedHead: transactionContext.expectedHead,
        workDirectory: workDirRelative(config, workflow.workItem.id)
      });
    }
  });
  const owed = value.applied ? pendingAmendmentRevalidations(workflow).filter((entry) => entry.amendment === amendmentId) : [];
  if (!optionBoolean(options, 'json')) {
    if (!value.applied) console.log(`Rejected ${amendmentId}; ${proposal.phase} keeps generation ${proposal.fromGeneration}.`);
    else {
      console.log(`Approved ${amendmentId}: ${proposal.phase} is now generation ${value.approval.generation}; no step was reset.`);
      if (value.refreshed) console.log(`${value.refreshed} reads the amended ${proposal.phase} from its next composition; its draft text is kept.`);
      for (const entry of owed) console.log(`  Revalidate ${entry.phase}: ${revalidateCommand(workflow.workItem.id, entry)}`);
    }
  }
  emit(options, workflow, 'decide-amendment', { slots: { amendment: amendmentId, decision: value.decision.decision },
    body: { decision: value.decision, revalidate: owed.map((entry) => entry.phase), refreshed: value.refreshed ?? null }, changed: true });
}

/** A later step's approvers record that it holds under the amended input, or return the Story to it. */
async function revalidate(root, config, workflow, phaseId, options) {
  const amendmentId = optionString(options, 'amendment');
  const outcome = optionString(options, 'outcome');
  const reason = optionString(options, 'reason');
  const actor = actionActor(root);
  const session = await loadSession(root, { required: false });
  const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
  let value;
  if (outcome === 'return') {
    const current = workflow.phases?.[workflow.currentPhase];
    if (!current || !['in_progress', 'awaiting_approval'].includes(current.status)) {
      refused('A return needs a current step in progress or awaiting approval.', 'UPSTREAM_ISSUE_RETURN_UNAVAILABLE');
    }
    ({ value } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.PHASE_REJECTED, phaseId: current.id, generation: current.generation, actor, agent,
      payload: { targetPhaseId: phaseId }
    }, `[${workflow.workItem.id}][forward-amendment] ${amendmentId} returns to ${phaseId}`, async (aggregate) => {
      const entry = await revalidateAfterForwardAmendment(root, config, aggregate, { amendmentId, phaseId, outcome, reason, actor, agent });
      const returned = await rejectPhase(root, config, aggregate, { phaseId: current.id, target: phaseId, reason, actor, agent,
        channel: 'terminal', upstreamIssue: { id: amendmentId } });
      entry.link = returned.changeRequest.id;
      return entry;
    }, { eventFromResult: (entry) => ({ payload: { targetPhaseId: phaseId, changeRequestId: entry.link } }) }));
  } else {
    ({ value } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: null, payload: { decision: 'forward-amendment' }
    }, `[${workflow.workItem.id}][forward-amendment] ${phaseId} revalidated after ${amendmentId}`, async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'revalidate a step');
      return revalidateAfterForwardAmendment(root, config, aggregate, { amendmentId, phaseId, outcome, reason, actor, agent });
    }, { exactWorkItemPaths: [], eventFromResult: (entry) => ({ authorityGroup: entry.authorityGroup, identityAssurance: entry.identityAssurance,
      payload: { decision: 'forward-amendment', amendment: amendmentId, revalidated: phaseId, reviewPacketSha256: null } }) }));
  }
  if (!optionBoolean(options, 'json')) {
    console.log(outcome === 'return'
      ? `${value.link} returned the Story to ${phaseId} after ${amendmentId}.`
      : `Recorded that ${phaseId} holds under ${amendmentId}; its approval stands.`);
  }
  emit(options, workflow, 'revalidate', { slots: { phase: phaseId, outcome }, body: { revalidation: value }, changed: true });
}

export async function run(argv, { positionals = argv, options = {} } = {}) {
  const action = positionals[1] ?? 'list';
  if (options.help === true) {
    console.log('Usage: singularity-flow upstream-issue raise|list|decide [--work-id WORK-ID] [--json]\n'
      + 'raise: --phase EARLIER --about ID|SECTION --problem TEXT [--assumption TEXT] [--impact TEXT] [--proposed KIND] [--authored human|governed-agent] [--supersedes UPI-ID], or --from-artifact\n'
      + '  --from-artifact raises each item against the step it names as its owner (its leading label, such as "planning:", or an "Owner: <step>" field); an item naming none, or two, is listed with the command that raises it. An item once filed against another step supersedes that issue. --supersedes replaces an open issue raised against the wrong step; its approvers dismiss it.\n'
      + 'list: [--open]\n'
      + 'decide UPI-ID --outcome plan-correction|amend|return|accept-risk|dismiss --reason TEXT [--link PRC-ID|FAM-ID] [--expires YYYY-MM-DD]\n'
      + 'propose-amendment --phase EARLIER --reason TEXT [--file DRAFT] [--issue UPI-ID]; decide-amendment FAM-ID --decision approve|reject --reason TEXT --confirm FAM-ID\n'
      + 'revalidate PHASE --amendment FAM-ID --outcome unchanged|return --reason TEXT\n'
      + 'Raising never stops the current step; the earlier step\'s approvers decide, and the Story completes only when every issue is decided.');
    return;
  }
  if (!UPSTREAM_ISSUE_ACTIONS.includes(action)) {
    refused(`Unknown upstream-issue action '${action}'. Use ${UPSTREAM_ISSUE_ACTIONS.join(', ')}.`, 'UPSTREAM_ISSUE_ACTION_INVALID');
  }
  const allowed = new Set(['json', 'help', 'no-model', 'work-id', ...ALLOWED[action]]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) refused(`Unsupported upstream-issue ${action} option --${key}.`, 'UPSTREAM_ISSUE_OPTIONS_INVALID');
  }
  if (positionals.length > (['decide', 'decide-amendment', 'revalidate'].includes(action) ? 3 : 2)) refused('Unexpected upstream-issue arguments. Use --work-id for the Story.');
  const root = repoRoot();
  const { workflow, definition: config } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  if (action === 'list') return list(workflow, options);
  if (workflow.status !== 'in_progress') {
    refused(`Story ${workflow.workItem.id} is ${workflow.status}; upstream issues are raised and decided while it is in progress.`, 'UPSTREAM_ISSUE_STORY_CLOSED');
  }
  if (action === 'raise') return raise(root, config, workflow, options);
  if (action === 'propose-amendment') return proposeAmendment(root, config, workflow, options);
  if (action === 'decide-amendment') return decideAmendment(root, config, workflow, positionals[2], options);
  if (action === 'revalidate') return revalidate(root, config, workflow, positionals[2], options);
  return decide(root, config, workflow, positionals[2], options);
}
