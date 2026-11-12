import {createNamespaceSourceReviewOwners} from './namespace-source-review-reader.mjs';
/** Accepted Story diagnostics and advisory planning, using one explicit namespace observer. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {sourceReviewRequired,phaseAuthoringPlan,phaseNeedsGeneration,nextPhaseGeneration,isConvergencePhase} from '../kernel/phase-policy.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceStoryQueryPorts(options,runtime=null){
  const {scope,workId,access,modelEnabled=true}=options,observer=createNamespaceStoryObserver(options),contexts=new WeakMap();
  async function unchanged(context,signal){const {snapshot,principal,operation}=contexts.get(context);
    phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation,{expected:principal});
    const final=(await observer.inspect({signal})).snapshot;
    if(final.revision!==snapshot.revision)throw error('The Story changed during its diagnostic read. Read the current snapshot.','ENGINE_CONTEXT_CHANGED');}
  async function load(input,operation,{signal}={}){
    if(input.workId!=null&&input.workId!==workId)throw error('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH',{expectedWorkId:input.workId,actualWorkId:workId});
    const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation);
    const snapshot=(await observer.inspect({signal})).snapshot,context={subject:{kind:'story',id:workId},workflow:snapshot.workflow,
      source:{kind:'namespace-snapshot',revision:snapshot.revision}};
    contexts.set(context,{snapshot,principal,operation});return context;
  }
  let reviewOwners;async function reviewEvidence(snapshot,signal){const phase=snapshot.workflow.phases[snapshot.workflow.currentPhase];
    if(!phase||phase.status!=='in_progress'||phaseNeedsGeneration(snapshot.workflow,phase)||!sourceReviewRequired(snapshot.workflow,phase.id))return null;
    const value=await (reviewOwners??=createNamespaceSourceReviewOwners({observer,scope,workId})).inspect(snapshot,phase.id,{signal});
    return reviewOwners.continuation(value.status);}
  const storyStatus={load:(input,options)=>load(input,'story.status',options),async read(context,_selection,{signal}={}){
    if(!contexts.has(context))throw error('Use the issued Story diagnostic context.','ENGINE_INPUT_INVALID');
    await unchanged(context,signal);
    // An accepted namespace head is not a retained local Git publication marker. This ordinary
    // diagnostic deliberately makes no claim about a separate pending intent or external effect.
    return {workId,source:context.source,publication:{state:'not-retained',commit:null,error:null}};
  }};
  const storyGuide={async load(input,options){const context=await load(input,'story.guide',options);
    context.observations={modelEnabled,sourceReviewEvidence:await reviewEvidence(contexts.get(context).snapshot,options?.signal)};
    await unchanged(context,options?.signal);return context;}};
  const storyNext={async load(input,{signal}={}){
    const context=await load(input,'story.next',{signal}),snapshot=contexts.get(context).snapshot,workflow=snapshot.workflow,
      phase=workflow.phases[workflow.currentPhase];
    let authoringState=null,recoveryRequired=false;
    if(phase?.status==='in_progress'&&phaseNeedsGeneration(workflow,phase)&&isConvergencePhase(phase))authoringState={available:true,stage:'review-convergence',generation:nextPhaseGeneration(phase)};
    else if(runtime&&phase?.status==='in_progress'&&phaseNeedsGeneration(workflow,phase)){
      const token=await runtime.captureEntryDraft(phase.id,{signal}),facts=runtime.entryDraftFacts(token),draft=facts.draft;
      if(facts.revision!==snapshot.revision)throw error('Authoring observations belong to another Story snapshot.','ENGINE_CONTEXT_CHANGED');
      if(draft){const p=draft.payload;
        recoveryRequired=p.baseRevision!==snapshot.revision||p.generation!==nextPhaseGeneration(phase);
        if(!recoveryRequired){const open=p.generationIntent?{id:p.generationIntent.id,status:'open',generation:p.generation}:null,
          progress=phaseAuthoringPlan(workflow,{...phase,generationIntent:open},{draftEvidence:{draftExists:true,
            draftModified:p.artifact.initial.sha256!==p.artifact.current.sha256}});
          if(progress)authoringState={available:true,stage:progress.stage,generation:progress.generation};}
      }
      await runtime.revalidateEntryDraft(token,{signal});
    }
    context.observations={modelEnabled,sourceReviewEvidence:await reviewEvidence(snapshot,signal),authoringState,recoveryRequired,...(recoveryRequired?{recoveryPhase:phase.id}:{})};
    await unchanged(context,signal);return context;
  }};
  return Object.freeze({storyStatus,storyGuide,storyNext});
}
