/** Native compatibility clock binding. Review rules are pure and shared with the SDK. */
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX} from './records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from './engine-compatibility/node-configuration-path.mjs';
import {sourceGroundedReviewPolicies} from './kernel/source-grounded-review.mjs';
import {SPECIFICATION_CLAIM_TIMESTAMP_REQUEST} from './kernel/specification-values.mjs';
import {nowIso,SingularityFlowError} from './util.mjs';
const policies=/* @__PURE__ */ sourceGroundedReviewPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS);
export const sourceReviewBinding=policies.sourceReviewBinding;
export const sourceReviewScenarioIds=policies.sourceReviewScenarioIds;
export function evaluateSourceGroundedReview(report,context){
  const replay=policies.evaluateSourceGroundedReviewReplay(report,context);let step=replay.next();
  while(!step.done){if(step.value!==SPECIFICATION_CLAIM_TIMESTAMP_REQUEST)throw new SingularityFlowError('Unsupported source-review value request.',{code:'ENGINE_PORT_RESULT_INVALID'});
    let at;try{at=nowIso();}catch(error){step=replay.throw(error);continue;}step=replay.next(at);}
  return step.value;
}
