/** One confirmed list coordinates existing registry decisions, retaining their accepted prefix. */
import {createHash} from 'node:crypto';
import {canonicalJson,namespaceDecisionBatchProfile} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {parseDecisionAnswers,decisionRecordPlan,assertDecisionConfirmation,standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {phaseAccessIdentity,phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceDecisionListReader} from './namespace-decision-list-reader.mjs';
import {createNamespaceDecisionBatchJournal} from './namespace-decision-batch-journal.mjs';
import {namespaceDecisionReceipts} from './namespace-decision-contract.mjs';
import {namespaceHumanDecisionReceipts} from './namespace-human-decision-contract.mjs';
import {namespaceRoutingChoiceReceipts} from './namespace-routing-choice-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex'),
  fail=(message,code,details=null)=>{throw new SingularityFlowError(message,{code,details});},
  operations=new Set(['decision.scope','decision.completeness','decision.applicability','upstream.decide','test-command.decide','conformance.decide','decision.choose']);
export function createNamespaceDecisionBatchPort(options,runtime,executeOperation){
  const {scope,workId,authority,access,clock}=options,observer=createNamespaceStoryObserver(options),
    reader=createNamespaceDecisionListReader({observer,scope,workId,runtime}),journal=createNamespaceDecisionBatchJournal({...options,observer}),states=new WeakMap();
  if(typeof executeOperation!=='function')fail('Decision batches need the registered operation executor.','ENGINE_INPUT_INVALID');
  function selected(context){const s=states.get(context);if(!s)fail('Use the issued human decision batch.','ENGINE_INPUT_INVALID');return s;}
  async function identity(signal,authorize=false,expected=null){const facts=await access.current({projectId:scope.projectId,workId,operation:'decisions.record',signal}),
    principal=authorize?phaseTransitionAccess(facts,scope.projectId,'decisions.record',{expected}):phaseAccessIdentity(facts,scope.projectId);
    if(principal.actor.actorKind!=='human')fail('Only an authenticated human can record this decision list.','ENGINE_HUMAN_AUTHORITY_REQUIRED');
    if(expected&&!same(principal,expected))fail('Resume the batch under its original authenticated actor.','ENGINE_ACTOR_CHANGED');
    return {principal,permissions:[...facts.permissions]};}
  function normalized(input){return {workId,phaseId:input.phaseId??null,confirmation:input.confirmation??null,answers:input.answers??{}};}
  function recipe(s,effect,step){
    if(!operations.has(effect.operation))fail('The batch has no owner for that decision.','ENGINE_PORT_UNAVAILABLE',{required:[effect.operation]});
    const index=s.plan.steps.findIndex(row=>row.item===step.item),expected=s.plan.steps[index];
    if(index<0||!same(expected,step)||!expected.effects.some(row=>same(row,effect)))fail('Use the original ordered decision plan.','ENGINE_INPUT_INVALID');
    const inputs={workId,...effect.inputs,reason:step.values.reason??'',...(step.values.clause?{clauseIds:step.values.clause}:{}),
      ...(step.values.expires?{expires:step.values.expires}:{}),...(step.values.article?{checklist:step.values.article}:{})};
    if(['decision.scope','decision.completeness','decision.applicability','upstream.decide'].includes(effect.operation))inputs.operationId='batch-'+s.id.slice(0,48)+'-'+index;
    return inputs;
  }
  function acknowledged(workflow,s,operation,inputs){
    if(inputs.operationId)return namespaceDecisionReceipts(workflow).some(row=>row.operation===operation&&row.operationId===inputs.operationId);
    if(operation==='decision.choose'){
      const request={option:inputs.option??null,to:inputs.to??null,expected:inputs.expected??null,reason:inputs.reason.trim()},digest=hash({workId,request});
      return namespaceRoutingChoiceReceipts(workflow,{projectId:scope.projectId,workId}).some(row=>row.requestSha256===digest&&row.principalId===s.principal.actor.principalId);
    }
    const phaseId=operation==='test-command.decide'?(s.snapshot.workflow.testCommandDecisions??[]).find(row=>row.id===(inputs.accept??inputs.revoke))?.phase:inputs.phaseId,
      request=operation==='conformance.decide'?{phaseId,expected:inputs.expected,clauseId:inputs.clauseId,ownerPhase:inputs.ownerPhase,outcome:inputs.outcome,
        expires:inputs.expires??null,reason:inputs.reason.trim()}:{...standaloneDecisionRequest(operation,inputs),phaseId},digest=hash({workId,request});
    return (operation==='conformance.decide'?namespaceHumanDecisionReceipts(workflow):namespaceDecisionReceipts(workflow))
      .some(row=>row.operation===operation&&row.requestSha256===digest&&row.principalId===s.principal.actor.principalId);
  }
  return {
    async load(input,{signal}={}){
      if(input.workId!=null&&input.workId!==workId)fail('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      if(input.fetch===true)fail('Refresh requires the explicit transport owner.','ENGINE_PORT_UNAVAILABLE',{required:['decision-batch-fetch']});
      const current=await identity(signal),request=normalized(input),id=hash({scope,workId,authority,principalId:current.principal.actor.principalId,input:request}),
        retained=await journal.retained(id,{signal});let observed,snapshot,at,source,principal=current.principal,permissions=current.permissions,policy;
      if(retained){const value=retained.value;
        if(!same(value.input,request))fail('This batch has another reviewed request.','ENGINE_OPERATION_ID_REUSED');
        if(!same(value.principal.actor,principal.actor))fail('Resume the batch under its original authenticated actor.','ENGINE_ACTOR_CHANGED');
        principal={actor:current.principal.actor,agentId:value.principal.agentId};
        snapshot=retained.snapshot;at=value.at;permissions=value.permissions;source=await reader.read(snapshot,{principal,permissions,at,phaseId:value.policy.phase,bound:value.source,signal});
        policy=source.policy;if(!same(policy,value.policy))fail('The original decision list no longer replays its actual records.','ENGINE_STORAGE_CORRUPT');
        observed={snapshot,basis:value.basis};
      }else{
        await identity(signal,true,principal);observed=await observer.capture({signal});snapshot=observed.snapshot;
        if(snapshot.workflow.status!=='in_progress')fail('Decisions are recorded while the Story is in progress.','DECISIONS_STORY_CLOSED');
        if(request.phaseId!==null&&!snapshot.workflow.phases[request.phaseId])fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');
        at=projectEnrollmentTimestamp(await clock.now());source=await reader.read(snapshot,{principal,permissions,at,phaseId:request.phaseId??snapshot.workflow.currentPhase,signal});policy=source.policy;
      }
      const context={subject:{kind:'story',id:workId},workflow:snapshot.workflow,policy,at};
      states.set(context,{id,input:request,principal,permissions,snapshot,basis:observed.basis,at,source,policy,retained,expectedRevision:snapshot.revision,signal});return context;
    },
    async prepare(context,input){const s=selected(context);if(!same(normalized(input),s.input))fail('Use the exact reviewed list input.','ENGINE_INPUT_INVALID');
      const answers=parseDecisionAnswers(s.input.answers),known=new Set([...s.policy.items,...s.policy.offered].map(row=>row.id));
      for(const name of ['choose','reason','expires','cause','clause','article'])for(const id of answers[name].keys())if(!known.has(id))fail('That answer names an item outside this exact list.','DECISIONS_ANSWER_INVALID',{item:id});
      assertDecisionConfirmation(s.policy.packetSha256,s.input.confirmation);s.plan=decisionRecordPlan(s.policy,answers,{at:s.at});
      if(s.retained&&!same(s.plan,s.retained.value.plan))fail('The batch changed its original confirmed plan.','ENGINE_STORAGE_CORRUPT');
      return {answers,confirmation:s.input.confirmation};
    },
    async apply(context,effect,step){const s=selected(context),signal=s.signal;
      if(!s.retained){await s.source.fresh();await identity(signal,true,s.principal);
        const value={schemaVersion:1,format:namespaceDecisionBatchProfile('body',{schemaVersion:1}).format,
          binding:{projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch},identity:s.id,input:s.input,
          principal:s.principal,permissions:s.permissions,at:s.at,basis:s.basis,policy:s.policy,source:s.source.source,plan:s.plan};
        s.retained=await journal.retain(value,s.source,{signal});}
      const inputs=recipe(s,effect,step),current=(await observer.inspect({signal})).snapshot;
      if(!acknowledged(current.workflow,s,effect.operation,inputs)){
        await identity(signal,true,s.principal);
        if(current.revision!==s.expectedRevision)fail('Another operation changed this Story. Keep the accepted prefix and review what remains.','ENGINE_CONTEXT_CHANGED',{
          actions:[{operation:'decisions.list',inputs:{workId}}]});
        await reader.freshScope(current,s.source.source,{signal});
      }
      const result=await executeOperation(effect.operation,inputs,{signal});s.expectedRevision=result.revision;return result;
    },
    async finish(context,plan,outcome){const s=selected(context),recorded=outcome.recorded.map(row=>({item:row.item,kind:row.kind,
      record:row.record.record?.id??row.record.record?.accepts??row.record.record?.issue??row.record.record?.item??row.record.record?.responsibility??null,
      value:row.record.record??row.record}));
      let remaining=null,packetSha256=null;
      const completed=s.retained&&!outcome.failed?await journal.outcome(s.id,s.retained,{signal:s.signal}):null;
      if(completed){if(!same(completed.recorded,recorded)||!same(completed.refused,plan.refused)||completed.workId!==workId||completed.phase!==s.policy.phase)
          fail('The batch result differs from its actual accepted decision receipts.','ENGINE_STORAGE_CORRUPT');return completed;}
      if(!outcome.failed){try{const snapshot=(await observer.inspect({signal:s.signal})).snapshot,current=await identity(s.signal),
          actual=await reader.read(snapshot,{...current,at:projectEnrollmentTimestamp(await clock.now()),signal:s.signal});
        remaining=actual.policy.items.map(({id,kind,title})=>({id,kind,title}));packetSha256=actual.policy.packetSha256;
      }catch(cause){s.inspectionError=cause;try{await options.notice?.({code:'decisions.inspection-unavailable',workId,error:cause});}catch(observerError){s.noticeError=observerError;}throw cause;}}
      const result={workId,phase:s.policy.phase,recorded,refused:plan.refused,remaining,packetSha256};
      if(outcome.failed)return result;
      const accepted=await journal.complete(s.id,s.retained,result,{signal:s.signal});
      if(!same(accepted.recorded,recorded)||!same(accepted.refused,plan.refused)||accepted.workId!==workId||accepted.phase!==s.policy.phase)
        fail('The concurrent acknowledgement differs from the actual accepted decisions.','ENGINE_STORAGE_CORRUPT');
      return accepted;
    }
  };
}
