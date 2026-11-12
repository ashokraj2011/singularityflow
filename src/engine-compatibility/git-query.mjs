/** Narrow native read composition, using the same registered SDK operation as every other host. */
import path from 'node:path';
import {createEngine,ENGINE_OPERATIONS} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {withoutReadScope} from '../read-scope.mjs';
import {withoutConfigurationReadScope} from '../configuration-read-scope.mjs';

export function createGitQueryEngine({root,presentation=null,storyReference=null,storyNextContext=null,storyNextOptions={},decisionListOptions={}}={}) {
  if(typeof root!=='string'||!path.isAbsolute(root))throw new SingularityFlowError(
    'Git query composition requires an explicit absolute checkout root.',{code:'ENGINE_INPUT_INVALID'});
  let owner,documentOwner,entryOwner,assetOwner,statusOwner,nextOwner,scopeOwner,listOwner,context=null;
  const preferences=presentation?Object.freeze({includeContinuation:presentation.includeContinuation===true,
    includeApprovalCheck:presentation.includeApprovalCheck!==false,includeSheet:presentation.includeSheet===true}):null;
  const decisionCard=decisionListOptions.card!==false;
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
  const workflowAssets={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='workflowAssets').stages) {
    workflowAssets[stage]=async(...args)=>{
      assetOwner??=import('./git-workflow-assets.mjs').then(({createGitWorkflowAssetsPort})=>
        createGitWorkflowAssetsPort({root,approved:true})).catch(error=>{assetOwner=undefined;throw error;});
      return (await assetOwner).port[stage](...args);
    };
  }
  const storyStatus={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='storyStatus').stages) {
    storyStatus[stage]=async(...args)=>{
      statusOwner??=import('./git-story-status.mjs').then(({createGitStoryStatusPort})=>
        createGitStoryStatusPort({root,onContext:value=>{context=value;}})).catch(error=>{statusOwner=undefined;throw error;});
      return (await statusOwner)[stage](...args);
    };
  }
  const storyGuide=createGitStoryGuidePort({root,reference:storyReference,onContext:value=>{context=value;}});
  const storyNext={async load(...args){
    nextOwner??=import('./git-nextsteps.mjs').then(({createGitStoryNextPort})=>createGitStoryNextPort({root,
      accepted:storyNextContext,observationOptions:storyNextOptions,onContext:value=>{context=value;}}))
      .catch(error=>{nextOwner=undefined;throw error;});
    return (await nextOwner).load(...args);
  }};
  const scopeContext=Object.fromEntries(['load','read'].map(stage=>[stage,async(...args)=>{
    scopeOwner??=import('./git-scope-context.mjs').then(({createGitScopeContextPort})=>createGitScopeContextPort({root,
      onContext:value=>{context=value;}})).catch(error=>{scopeOwner=undefined;throw error;});
    return (await scopeOwner)[stage](...args);
  }]));
  const decisionList=Object.fromEntries(['load','read'].map(stage=>[stage,async(...args)=>{
    listOwner??=Promise.resolve(createGitDecisionListPort({root,card:decisionCard,onContext:value=>{context=value;}}));
    return (await listOwner)[stage](...args);
  }]));
  const engine=createEngine({ports:{phaseReview,documentRead,phaseEntry,workflowAssets,storyStatus,storyGuide,storyNext,scopeContext,decisionList,invocation:{
    run:callback=>withoutConfigurationReadScope(()=>withoutReadScope(callback))
  }}});
  return Object.freeze({engine,presentation:()=>context});
}

/** Native card bytes stay with their host; policy values never need the native mutation port. */
export function createGitDecisionListPort({root,onContext=()=>{},card=true}){
  const contexts=new WeakSet();return {
    async load(input){const [{loadAcceptedStoryExecution},{nowIso}]=await Promise.all([import('../accepted-story-execution.mjs'),import('../util.mjs')]),
      accepted=await loadAcceptedStoryExecution(root,input.workId??undefined),
      context={root,config:accepted.definition,workflow:accepted.workflow,subject:{kind:'story',id:accepted.workflow.workItem.id},at:nowIso(),phaseId:input.phaseId??null};
      contexts.add(context);return context;},
    async read(context){if(!contexts.has(context))throw new SingularityFlowError('Use the issued decision list.',{code:'ENGINE_INPUT_INVALID'});
      const [{readPendingList},{recordSha256},{decisionPolicyPacket}]=await Promise.all([import('../decision-list-reads.mjs'),import('../records.mjs'),import('../kernel/decision-plan.mjs')]);
      context.packet=await readPendingList(root,context.config,context.workflow,{phaseId:context.phaseId,at:context.at,card});
      const result={revision:'sha256:'+recordSha256(context.workflow),policy:decisionPolicyPacket(context.packet)};
      onContext(context);return result;}
  };
}

/** Native accepted record loading, without source-review execution, context composition or mutation. */
export function createGitStoryGuidePort({root,reference=null,onContext=()=>{}}) {
  return {
    async load(inputs) {
      const {loadAcceptedStoryExecution}=await import('../accepted-story-execution.mjs');
      const {workflow}=await loadAcceptedStoryExecution(root,reference??inputs.workId);
      const context={workflow,subject:{kind:'story',id:workflow.workItem.id}};
      onContext(context);
      return context;
    }
  };
}
