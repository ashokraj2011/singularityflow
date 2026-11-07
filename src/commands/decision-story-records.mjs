/** Existing command-module exports; native writes have one SDK compatibility owner. */
export {commitApplicabilityDecision,commitScopeDecision,commitCompletenessReview}
  from '../engine-compatibility/native-story-decisions.mjs';
import {commitRoutingChoice as recordRoutingChoice} from '../engine-compatibility/native-story-decisions.mjs';
import {presentPostPublicationNotice} from '../phase-post-transition-guidance.mjs';

/** Keep the original command helper's result and local warning presentation. */
export async function commitRoutingChoice(root,config,workflow,request,who) {
  const {result,publication,authority}=await recordRoutingChoice(root,config,workflow,request,
    {...who,notice:presentPostPublicationNotice});
  return {result,publication,authority};
}
