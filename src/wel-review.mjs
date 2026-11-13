/** Native compatibility: optional clock and Node memory stay outside the shared adequacy rules. */
import {witnessMappingReviewPolicies} from './kernel/human-witnesses.mjs';
import {NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS} from './records.mjs';
export {ADEQUACY_FACETS} from './kernel/human-witnesses.mjs';
const values=witnessMappingReviewPolicies(NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS);
export function evaluateWitnessMappingReview({mappings=[],decisions=[],prior=[],now=Date.now()}={}){
  return values.evaluateWitnessMappingReview({mappings,decisions,prior,now});
}
