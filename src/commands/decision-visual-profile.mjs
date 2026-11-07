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

import { repoRoot } from '../git.mjs';

import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { isVisualVerificationPhase } from '../kernel/phase-policy.mjs';
import { loadSession } from '../session.mjs';
import { loadConfig } from '../state-stores.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { visualProfileDecision } from '../visual-profile-decisions.mjs';
import { actionActor } from './kernel.mjs';

import {visualProfileDecisionPart,recordVisualProfileDecisionFor,visualProfileAuthorities} from '../engine-compatibility/native-visual-decisions.mjs';
export {visualProfileDecisionPart,recordVisualProfileDecisionFor,visualProfileAuthorities};

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
