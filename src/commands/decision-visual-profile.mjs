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


import {executeTestDecision} from './shared/test-decision-operation.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString } from '../util.mjs';

import {visualProfileDecisionPart,recordVisualProfileDecisionFor,visualProfileAuthorities} from '../engine-compatibility/native-visual-decisions.mjs';
export {visualProfileDecisionPart,recordVisualProfileDecisionFor,visualProfileAuthorities};

export async function decisionVisualProfileCommand(positionals, options) {
  const {receipt,context,publication}=await executeTestDecision('decision.visual-profile',
    positionals[2]??optionString(options,'work-id')??null,options,()=>({phaseId:optionString(options,'phase')??null,profileId:optionString(options,'profile')??null,notApplicable:optionBoolean(options,'not-applicable'),revoke:optionString(options,'revoke')??null,reason:optionString(options,'reason')??''}));
  const {workflow}=context,id=receipt.subject.id,record=receipt.record;
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
