/** Narrow native read composition, using the same registered SDK operation as every other host. */
import path from 'node:path';
import {createEngine,ENGINE_OPERATIONS} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {withoutReadScope} from '../read-scope.mjs';
import {withoutConfigurationReadScope} from '../configuration-read-scope.mjs';

export function createGitQueryEngine({root,presentation=null}={}) {
  if(typeof root!=='string'||!path.isAbsolute(root))throw new SingularityFlowError(
    'Git query composition requires an explicit absolute checkout root.',{code:'ENGINE_INPUT_INVALID'});
  let owner,documentOwner,entryOwner,context=null;
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
  const documentRead={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='documentRead').stages) {
    documentRead[stage]=async(...args)=>{
      documentOwner??=import('./git-document-read.mjs').then(({createGitDocumentReadPort})=>
        createGitDocumentReadPort({root,onContext:value=>{context=value;}}))
        .catch(error=>{documentOwner=undefined;throw error;});
      return (await documentOwner)[stage](...args);
    };
  }
  const phaseEntry={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='phaseEntry').stages) {
    phaseEntry[stage]=async(...args)=>{
      entryOwner??=import('./git-phase-entry.mjs').then(({createGitPhaseEntryPort})=>
        createGitPhaseEntryPort({root,onContext:value=>{context=value;}}))
        .catch(error=>{entryOwner=undefined;throw error;});
      return (await entryOwner)[stage](...args);
    };
  }
  const engine=createEngine({ports:{phaseReview,documentRead,phaseEntry,invocation:{
    run:callback=>withoutConfigurationReadScope(()=>withoutReadScope(callback))
  }}});
  return Object.freeze({engine,presentation:()=>context});
}
