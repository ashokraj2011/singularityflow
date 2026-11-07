/**
 * `decision visual-profile`: a person in the group that approves a visual verification step records
 * that one of its verification profiles (screen sizes) does not apply to this Story, or revokes such
 * a decision. See src/visual-profile-decisions.mjs.
 *
 *   singularity-flow decision visual-profile [WORK-ID] --phase VISUAL-STEP --profile PROFILE-ID --not-applicable --reason TEXT
 *   singularity-flow decision visual-profile [WORK-ID] --revoke VPD-001 --reason TEXT
 *
 * Coverage then lists the profile as not applicable with the reason, who decided and the decision
 * ID, never as passed. A profile the step does not check, or the last one left to evidence, is
 * refused. The Copilot guard refuses this command, like approve: an agent may name the route,
 * never decide it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { requireApprovalAuthority } from '../kernel/approval-policy.mjs';
import { repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { isVisualVerificationPhase } from '../kernel/phase-policy.mjs';
import { loadSession } from '../session.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory } from '../state-stores.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { assertVisualProfileDecidable, recordVisualProfileDecision, recordVisualProfileRevocation,
  visualProfileDecision } from '../visual-profile-decisions.mjs';
import { actionActor } from './kernel.mjs';
import { testRunRiskAuthorities } from './decision-test-risk.mjs';

/**
 * Who may decide a visual step's profiles: the groups that approve that step, exactly as for a
 * test-run risk (a step nobody approves is answered for by the next approving step).
 */
export function visualProfileAuthorities(workflow, phaseId) {
  return testRunRiskAuthorities(workflow, phaseId);
}

/**
 * That one verification profile of a visual step does not apply to this Story, or the revocation
 * named by `revoke`, checked and ready to write into a transaction. Its own commit and an approval's
 * both write it [SPEC-OAP M4], so the checks, authority and record are the same.
 */
export async function visualProfileDecisionPart(root, config, workflow, { phaseId, profileId = null, revoke = null, reason = '' }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  // Checked before authority, so a refusal names what is wrong with the decision first.
  if (!revoke) assertVisualProfileDecidable(workflow, { phaseId, profileId });
  const groups = visualProfileAuthorities(workflow, phaseId);
  if (!groups.length) {
    throw new SingularityFlowError(`Step ${phaseId} has no approval group, so nobody can decide which screen sizes apply to it.`, { code: 'VISUAL_PROFILE_AUTHORITY_UNAVAILABLE' });
  }
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const common = { reason: reason ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso() };
  const decide = (aggregate) => revoke
    ? recordVisualProfileRevocation(aggregate, { decisionId: revoke, ...common })
    : recordVisualProfileDecision(aggregate, { phaseId, profileId, ...common });
  decide(structuredClone(workflow));
  return {
    decision: 'visual-profile', phaseId, authority,
    message: `[${id}][visual-profile:${revoke ? 'revoke' : 'not-applicable'}] ${revoke ?? `${phaseId} ${profileId}`}`,
    write(aggregate) {
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'visual_profile_decided', phase: phaseId,
        detail: recorded.revokes
          ? `${recorded.revokes} (${recorded.profileId} for ${recorded.phase}) revoked; the profile needs a screenshot again. ${recorded.reason}`
          : `${recorded.id}: verification profile ${recorded.profileId} (${recorded.profileLabel}) does not apply to this Story for ${recorded.phase}. ${recorded.reason}`
      });
      return recorded;
    },
    record: (recorded) => recorded.revokes ?? recorded.id
  };
}

/**
 * Record that one verification profile of a visual step does not apply to this Story, or the
 * revocation named by `revoke`, and commit it. The command and the decision list both record through
 * this; an approval writes the same part into its own commit [SPEC-OAP M4].
 */
export async function recordVisualProfileDecisionFor(root, config, workflow, request, { actor, agent = null }) {
  const part = await visualProfileDecisionPart(root, config, workflow, request, { actor, agent });
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: part.phaseId, generation: null,
      actor, agent, authorityGroup: part.authority.authorityGroup, payload: { decision: 'visual-profile' }
    },
    part.message,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a visual-profile decision');
      return part.write(aggregate);
    },
    {
      // A decision made while the step's draft and captures are still open commits only itself: the
      // publication that follows commits those [narrow decision transaction].
      exactWorkItemPaths: [],
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'visual-profile', record: recorded.revokes ?? recorded.id, revoked: Boolean(recorded.revokes), reviewPacketSha256: null }
      })
    }
  );
  return { record, publication };
}

export async function decisionVisualProfileCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  // The Story's own branch, which need not be named after its ID.
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') {
    throw new SingularityFlowError(`Story ${id} is ${workflow.status}; which screen sizes apply is decided while it is in progress.`, { code: 'VISUAL_PROFILE_STORY_CLOSED' });
  }
  const revoke = optionString(options, 'revoke') ?? null;
  const requestedPhase = optionString(options, 'phase') ?? null;
  const profileId = optionString(options, 'profile') ?? null;
  const notApplicable = optionBoolean(options, 'not-applicable');
  if (revoke ? Boolean(requestedPhase || profileId || notApplicable) : !(requestedPhase && profileId && notApplicable)) {
    throw new SingularityFlowError('Name the step and the profile that does not apply with --phase VISUAL-STEP --profile PROFILE-ID --not-applicable, or a decision to revoke with --revoke VPD-...', { code: 'VISUAL_PROFILE_DECISION_INVALID' });
  }
  const target = revoke ? visualProfileDecision(workflow, revoke) : null;
  if (revoke && !target) throw new SingularityFlowError(`This Story has no visual-profile decision ${revoke}.`, { code: 'VISUAL_PROFILE_DECISION_UNKNOWN' });
  const phaseId = revoke ? target.phase : requestedPhase;
  const phase = workflow.phases?.[phaseId];
  if (!phase || phase.status === 'skipped' || !isVisualVerificationPhase(phase)) {
    throw new SingularityFlowError(`Story ${id} has no visual verification step ${phaseId} on its route (a step whose artifact is visual-test-evidence).`, { code: 'VISUAL_PROFILE_DECISION_INVALID' });
  }
  const actor = actionActor(root);
  const loadedSession = await loadSession(root, { required: false });
  const agent = loadedSession?.workId === id ? loadedSession.agent ?? null : null;
  const { record, publication } = await recordVisualProfileDecisionFor(root, config, workflow, {
    phaseId, profileId, revoke, reason: optionString(options, 'reason') ?? ''
  }, { actor, agent });
  if (!optionBoolean(options, 'json')) {
    console.log(record.revokes
      ? `Revoked ${record.revokes}: ${record.profileId} needs a screenshot for ${record.phase} again.`
      : `Recorded ${record.id}: ${record.profileId} does not apply to this Story for ${record.phase}, decided through ${record.authorityGroup}. Coverage lists it as not applicable, never as passed.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.visual-profile', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.visual-profile.succeeded', { record: record.revokes ? `the revocation of ${record.revokes}` : record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
