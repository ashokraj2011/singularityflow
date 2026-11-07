/** Narrow native read composition, using the same registered SDK operation as every other host. */
import path from 'node:path';
import {createEngine,ENGINE_OPERATIONS} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {withoutReadScope} from '../read-scope.mjs';
import {withoutConfigurationReadScope} from '../configuration-read-scope.mjs';

export function createGitQueryEngine({root,presentation=null}={}) {
  if(typeof root!=='string'||!path.isAbsolute(root))throw new SingularityFlowError(
    'Git query composition requires an explicit absolute checkout root.',{code:'ENGINE_INPUT_INVALID'});
  let owner,context=null;
  const preferences=presentation?Object.freeze({includeContinuation:presentation.includeContinuation===true,
    includeApprovalCheck:presentation.includeApprovalCheck!==false,includeSheet:presentation.includeSheet===true}):null;
  const phaseReview={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='phaseReview').stages) {
    phaseReview[stage]=async(...args)=>{
      owner??=import('./git-phase-review.mjs').then(({createGitPhaseReviewPort})=>
        createGitPhaseReviewPort({root,presentation:preferences,onContext:value=>{context=value;}}))
        .catch(error=>{owner=undefined;throw error;});
      return (await owner)[stage](...args);
    };
  }
  const engine=createEngine({ports:{phaseReview,invocation:{
    run:callback=>withoutConfigurationReadScope(()=>withoutReadScope(callback))
  }}});
  return Object.freeze({engine,presentation:()=>context});
}
