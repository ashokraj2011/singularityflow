/** Conditional writer for namespace Story commands; immutable proof reads have their own owner. */
import {createHash} from 'node:crypto';
import {canonicalJson,NAMESPACE_STORY_COMMAND_SCHEMAS,namespaceStoryCommandRecordProfile} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {storyTestCommandPolicies} from '../kernel/test-recovery.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
const operations=['test-command.request','test-command.decide'],rules=storyTestCommandPolicies(NODE_TEXT_DIGESTS),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function createNamespaceTestCommandPorts(options){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceTestCommandOwners({observer,scope,workId}),ports=new Map(),states=new WeakMap();
  for(const [operation,owner]of owned.owners){const request=(input,workflow)=>{const raw=standaloneDecisionRequest(operation,input),
      phaseId=operation==='test-command.request'?raw.phaseId:rules.storyTestCommandState(workflow,raw.accept??raw.revoke)?.request.phase;
      if(!phaseId)fail('The Story has no such command request.','TEST_COMMAND_DECISION_UNKNOWN');return {...raw,phaseId};};
    ports.set(operation,createNamespaceRecordedMutationPort(options,{operation,request,owner,contract:namespaceDecisionContract,
      requiresHuman:operation!=='test-command.request',requestUsesWorkflow:true,finish:(value,revision,replay)=>({workId,phase:value.phase,
        recordKind:operation==='test-command.request'?'test-command-request':'test-command-decision',record:value.outcome.record,revision:operation==='test-command.request'&&replay.replayed?null:revision,pushed:false,
        ...(operation==='test-command.request'?{retained:replay.replayed}:{}),
        actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})}));}
  const decision={operations,
    async load(input,{operation,signal}={}){const port=ports.get(operation.id);if(!port)fail('This test decision needs its actual namespace owner.','ENGINE_PORT_UNAVAILABLE',{required:[operation.id]});
      const context=await port.load(input,{signal});states.set(context,{port,input,operation:operation.id});return context;},
    async prepare(context,_request,{signal}={}){const s=states.get(context);s.prepared=await s.port.prepare(context,s.input,{signal});
      const raw=standaloneDecisionRequest(s.operation,s.input);return raw;},
    async resolve(context,request){return {phaseId:context.phase.id,...(states.get(context).operation==='test-command.request'?{command:request.command,repin:null}: {accept:request.accept,revoke:request.revoke}),reason:request.reason};},
    commit(context,_intent,options){const s=states.get(context);return s.port.commit(context,s.prepared,options);},
    finish(context,_intent,accepted){const s=states.get(context);return s.port.finish(context,s.prepared,accepted);}
  };
  const contexts=new WeakMap(),contextOperation='test-command.context',context={
    async load(input,{signal}={}){
      if(input.workId!=null&&input.workId!==workId)fail('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:contextOperation,signal}),scope.projectId,contextOperation),
        snapshot=(await observer.inspect({signal})).snapshot,phaseId=input.phaseId??snapshot.workflow.currentPhase,phase=snapshot.workflow.phases[phaseId];
      if(!phase)fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');
      const value={subject:{kind:'story',id:workId},workflow:snapshot.workflow,phase};contexts.set(value,{snapshot,principal});return value;
    },
    async read(context,{signal}={}){const state=contexts.get(context);if(!state)fail('Use the issued command context.','ENGINE_INPUT_INVALID');
      const selected=await owned.commands(state.snapshot,context.phase.id,{signal}),workflow=state.snapshot.workflow,
        requests=(workflow.testCommandDecisions??[]).filter(row=>row.id&&row.phase===context.phase.id).map(row=>rules.storyTestCommandState(workflow,row.id));
      phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:contextOperation,signal}),scope.projectId,contextOperation,{expected:state.principal});
      if((await observer.inspect({signal})).snapshot.revision!==state.snapshot.revision)fail('The command context changed during review.','ENGINE_CONTEXT_CHANGED');
      const profile=namespaceStoryCommandRecordProfile('context',{schemaVersion:NAMESPACE_STORY_COMMAND_SCHEMAS.context.currentVersion});
      return {schemaVersion:profile.version,format:profile.format,workId,phase:context.phase.id,revision:state.snapshot.revision,
        commands:selected.commands.map(command=>({command,sha256:'sha256:'+createHash('sha256').update(canonicalJson(command)).digest('hex')})),
        requests:requests.map(({request,accepted,revoked,state})=>({id:request.id,state,request,accepted,revoked})),authorities:testRunRiskAuthorities(workflow,context.phase.id)};
    }};
  return Object.freeze({testDecisionRecord:decision,testCommandContext:context});
}
export function createNamespaceTestCommandPort(options){return createNamespaceTestCommandPorts(options).testDecisionRecord;}

