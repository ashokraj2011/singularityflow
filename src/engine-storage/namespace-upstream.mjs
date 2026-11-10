/** Registered upstream coordination; original proof replay is a read-only dependency. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {upstreamOperationRequest} from '../kernel/decision-plan.mjs';
import {upstreamIssueStates} from '../kernel/upstream-issues.mjs';
import {phaseTransitionAccess,phaseAccessIdentity} from '../kernel/phase-preparation.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceUpstreamOwners} from './namespace-upstream-reader.mjs';
import {createNamespaceArtifactIssuePort} from './namespace-upstream-artifact.mjs';
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceUpstreamPort(options,runtime=null) {
  const {scope,workId,access,clock}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceUpstreamOwners({observer,scope,workId,runtime}),ports=new Map(),states=new WeakMap();
  function portFor(operation,owner){
    const request=(input,workflow)=>{
      const normalized=upstreamOperationRequest(operation,input),phaseId=operation==='upstream.raise'?normalized.phaseId
        :(workflow.upstreamIssues??[]).find(row=>row.id===normalized.issueId)?.phase;
      if(!phaseId)throw error('The upstream issue or producer is not in this Story.','UPSTREAM_ISSUE_NOT_FOUND');
      return {...normalized,phaseId};
    };
    return createNamespaceRecordedMutationPort(options,{operation,request,owner,contract:namespaceDecisionContract,
      explicitIdentity:true,requestUsesWorkflow:true,requiresHuman:operation!=='upstream.raise',finish:(value,revision)=>({revision,pushed:false,record:value.outcome.record})});
  }
  for(const [operation,owner]of owned.owners)ports.set(operation,portFor(operation,owner));
  const artifact=createNamespaceArtifactIssuePort(options,{observer,owned,portFor,runtime});
  return {
    async load(input,{signal,operation}={}) {
      if(input.workId!=null&&input.workId!==workId)throw error('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      if(operation.id==='upstream.raise'&&input.fromArtifact===true){const context=await artifact.load(input,{signal});
        states.set(context,{artifact:true});return context;}
      if(operation.id==='upstream.list') {
        phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:operation.id,signal}),scope.projectId,operation.id);
        const snapshot=(await observer.inspect({signal})).snapshot,context={subject:{kind:'story',id:workId},workflow:snapshot.workflow};
        states.set(context,{snapshot,operation:operation.id});return context;
      }
      const port=ports.get(operation.id);if(!port)throw error('The named amendment needs its namespace owner.','ENGINE_PORT_UNAVAILABLE',{required:[operation.id]});
      const context=await port.load(input,{signal});states.set(context,{port,input,operation:operation.id});return context;
    },
    async resolve(context,request,{signal}={}) {
      const state=states.get(context);if(!state)throw error('Use the issued upstream context.','ENGINE_INPUT_INVALID');
      if(state.artifact)return artifact.resolve(context,request,{signal});
      if(state.operation==='upstream.list') {
        await owned.admitted(state.snapshot,{signal});const now=await clock.now();
        const issues=upstreamIssueStates(context.workflow,now).filter(row=>!request.open||['open','expired'].includes(row.status))
          .map(({issue,...row})=>({...issue,...row}));
        if((await observer.inspect({signal})).snapshot.revision!==state.snapshot.revision)throw error('The issue list changed.','ENGINE_CONTEXT_CHANGED');
        return {issues};
      }
      state.prepared=await state.port.prepare(context,state.input,{signal});
      const accessFacts=await access.current({projectId:scope.projectId,workId,operation:state.operation,signal}),
        {actor}=phaseAccessIdentity(accessFacts,scope.projectId);
      // Identity is already authenticated by the conditional writer; only its display projection is used here.
      const actorId=actor.principalId;
      if(state.operation==='upstream.raise')return {requests:[{phase:request.phaseId,about:request.about,problem:request.problem,assumption:request.assumption,
        impact:request.impact,proposed:request.proposed??'unknown',source:null,supersedes:request.supersedes}],
        actorId,authored:request.authored??(actor?.actorKind==='human'?'human':'governed-agent'),agent:accessFacts.agentId??null,unowned:[]};
      return {requests:[request],actorId,authored:null,agent:accessFacts.agentId??null,unowned:[]};
    },
    async commit(context,_request,{signal,index}={}) {
      const state=states.get(context);if(state?.artifact)return artifact.commit(context,_request,{signal,index});
      if(!state?.prepared)throw error('Prepare this upstream mutation first.','ENGINE_INPUT_INVALID');
      const accepted=await state.port.commit(context,state.prepared,{signal});state.result=await state.port.finish(context,state.prepared,accepted);return state.result;
    },
    async finish(context,request,options) {if(states.get(context)?.artifact)return artifact.finish(context,request,options);
      return {workId,currentPhase:context.workflow.currentPhase,revalidate:[],refreshed:null};}
  };
}
