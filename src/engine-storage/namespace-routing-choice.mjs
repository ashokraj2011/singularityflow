/** Human routing through explicit ports. The original conditional receipt survives later rework. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseAccessIdentity,phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {routingChoiceSelection,planRoutingChoice,routingChoiceAuthority} from '../kernel/routed-approval.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceIdentifier,namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceLifecycleCommitter} from './namespace-lifecycle-commit.mjs';
import {commitNamespaceOperation,prepareNamespaceOperation} from './namespace-commit-coordination.mjs';
import {createNamespaceRoutingReceiptReader} from './namespace-routing-receipt-reader.mjs';
import {createNamespaceReadPorts} from './namespace-reader.mjs';
import {lifecycleRecord} from './namespace-lifecycle-contract.mjs';
import {namespaceRoutingChoiceValue,namespaceRoutingChoiceRecord,namespaceRoutingChoiceReceipt,namespaceRoutingChoiceReceipts,
  NAMESPACE_ROUTING_CHOICE_PROFILE} from './namespace-routing-choice-contract.mjs';
export {NAMESPACE_ROUTING_CHOICE_PROFILE};
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('The route choice was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');}

export function createNamespaceRoutingChoicePorts({records,content,scope,workId,authority,access,clock}={}) {
  scope=namespaceScope(scope);workId=namespaceIdentifier(workId,'Story ID');authority=Object.freeze(structuredClone(authority));
  const observer=createNamespaceStoryObserver({records,content,scope,workId,authority});
  const committer=createNamespaceLifecycleCommitter({records,content,scope,workId,authority});
  const receiptReader=createNamespaceRoutingReceiptReader({observer,scope,workId});
  const questions={read:receiptReader.question};
  if(typeof access?.current!=='function'||typeof clock?.now!=='function')throw error('A human choice needs explicit access and clock ports.','ENGINE_INPUT_INVALID');
  const current=access.current.bind(access),now=clock.now.bind(clock),put=content.put.bind(content),contexts=new WeakMap();
  function selected(context){const state=contexts.get(context);if(!state)throw error('Use the issued routing context.','ENGINE_INPUT_INVALID');return state;}
  function request(input) {
    const value={option:input.option??null,to:input.to??null,expected:input.expected??null,reason:(input.reason??'').trim()};
    if(value.expected===null)throw error('Confirm the exact pending question before choosing.','ENGINE_DECISION_CONFIRMATION_REQUIRED',{
      actions:[{operation:'decision.context',inputs:{workId}}]});
    if(!/^[a-f0-9]{16}$/u.test(value.expected)||value.reason.length>2048||/[\u0000\u007f]/u.test(value.reason))throw error('The human choice request is invalid.','ENGINE_INPUT_INVALID');
    if(input.fetch===true)throw error('Remote refresh requires an explicit transport owner.','ENGINE_PORT_UNAVAILABLE',{required:['routing-choice-fetch']});
    return value;
  }
  async function identity(signal) {
    cancelled(signal);const facts=namespaceJson(await current({projectId:scope.projectId,workId,operation:'decision.choose',signal}));cancelled(signal);
    const reviewer=phaseAccessIdentity(facts,scope.projectId);
    if(reviewer.actor.actorKind!=='human')throw error('A workflow route choice requires an authenticated human.','ENGINE_HUMAN_AUTHORITY_REQUIRED');
    return {facts,reviewer};
  }
  async function authorize(signal,expected) {
    const {facts}=await identity(signal);return phaseTransitionAccess(facts,scope.projectId,'decision.choose',{expected});
  }
  async function unchanged(snapshot,signal) {
    const fresh=await observer.capture({signal});
    if(fresh.snapshot.revision!==snapshot.revision)throw error('The Story changed during the human choice. Review the current question.','ENGINE_CONTEXT_CHANGED');
  }
  function humanAuthority(workflow,reviewer) {
    return routingChoiceAuthority(workflow,reviewer.actor);
  }
  function checkedPlan(plan,s) {
    if(plan&&(plan.operation!=='decision.choose'||plan.inputsSha256!==s.requestSha256))throw error('This choice ID has another retained intent.','ENGINE_OPERATION_ID_REUSED');
    return plan;
  }
  async function decode(reference,signal) {
    const data=await observer.bytes(reference,reference.bytes,signal);let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
    catch(cause){throw error('The retained choice is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}
    return namespaceRoutingChoiceValue(value,{projectId:scope.projectId,workId});
  }
  function proposed(workflow,value,reference) {
    return receiptReader.proposed(workflow,value,reference);
  }
  function evidence(value,reference,proof) {
    return receiptReader.evidence(value,reference,proof);
  }
  async function retained(plan,s,signal) {
    checkedPlan(plan,s);
    const body=await observer.state(await observer.bytes(plan.state,plan.state.bytes,signal),plan.basis.head,{signal});
    const links=namespaceRoutingChoiceReceipts(body.workflow,{projectId:scope.projectId,workId}).filter(item=>item.operationId===s.operationId);
    if(links.length!==1||s.receiptReference&&!same(links[0].record,s.receiptReference))throw error('The choice lost its original receipt link.','ENGINE_STORAGE_CORRUPT');
    const link=links[0],{value}=await receiptReader.verify(plan,link.record,{signal});
    if(value.operationId!==s.operationId||value.requestSha256!==s.requestSha256||!same(value.request,s.request)
      ||!same(value.actor,s.reviewer.actor)||value.agentId!==s.reviewer.agentId)throw error(
      'The retained choice differs from its original actor, question, intent or evidence.','ENGINE_STORAGE_CORRUPT');
    return {value,reference:link.record};
  }
  async function save(value,signal) {
    const data=Buffer.from(canonicalJson(value)),reference={namespace:'evidence',sha256:hash(data),bytes:data.byteLength};
    const saved=await put(scope,'evidence',data,{signal});
    if(!same(contentReference(saved?.reference),reference)||typeof saved.reused!=='boolean')throw error('The content port stored another route choice.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(reference,reference.bytes,signal);return reference;
  }
  const decisionRecord={
    async load(input,{signal,operation}={}) {
      if(operation?.id!=='decision.choose')throw error('This port owns only workflow route choices.','ENGINE_PORT_UNAVAILABLE',{operation:operation?.id??null});
      if(input.workId!=null&&input.workId!==workId)throw error('The choice is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');
      const supplied=request(input),requestSha256=hash(canonicalJson({workId,request:supplied}));
      const observed=await observer.inspect({signal}),workflow=observed.snapshot.workflow;
      const {facts,reviewer}=await identity(signal),links=namespaceRoutingChoiceReceipts(workflow,{projectId:scope.projectId,workId});
      const link=links.find(item=>item.pendingKey===supplied.expected&&item.principalId===reviewer.actor.principalId&&item.requestSha256===requestSha256);
      let bound=workflow,state={request:supplied,requestSha256,reviewer,initialFacts:facts,observed:observed.snapshot};
      if(link) {
        const value=await decode(link.record,signal);
        if(!same(value.actor,reviewer.actor)||!same(link,namespaceRoutingChoiceReceipt(value,link.record)))throw error('The receipt needs its original authenticated identity.','ENGINE_ACTOR_CHANGED');
        const plan=await committer.intent(link.operationId,{signal});if(!plan)throw error('The choice lost its original prepared operation.','ENGINE_STORAGE_CORRUPT');
        bound=(await observer.state(await observer.bytes(plan.basis.head.state,plan.basis.head.state.bytes,signal),plan.basis.head,{signal})).workflow;
        state={...state,reviewer:{actor:reviewer.actor,agentId:value.agentId},operationId:link.operationId,replay:true,receiptReference:link.record};
      }else {
        const choice=routingChoiceSelection(workflow,supplied);
        state.phaseId=choice.phase;
        state.operationId='choose-'+hash(canonicalJson({scope,authority,reviewer,requestSha256,
          basis:{revision:observed.snapshot.revision,authorityVersion:observed.basis.authorityVersion}}));
      }
      const context={subject:{kind:'story',id:workId},workflow:bound};
      state.phaseId=bound.pendingDecision?.after??null;contexts.set(context,state);return context;
    },
    async prepare(context,supplied,{signal}={}) {
      const s=selected(context);
      if(!same(request(supplied),s.request))throw error('Use the originally issued choice intent.','ENGINE_INPUT_INVALID');
      return prepareNamespaceOperation(committer,s.operationId,async()=>{
        const accepted=await committer.inspect(s.operationId,{signal}),plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
        if(accepted.status==='committed') {
          if(!plan)throw error('The accepted choice lost its retained candidate.','ENGINE_STORAGE_CORRUPT');
          await retained(plan,s,signal);s.accepted=accepted;return s.request;
        }
        if(s.replay)throw error('The retained choice has no original accepted receipt.','ENGINE_STORAGE_CORRUPT');
        phaseTransitionAccess(s.initialFacts,scope.projectId,'decision.choose');
        const snapshot=await committer.capture({signal}),workflow=snapshot.workflow,phase=workflow.phases[s.phaseId];
        const approved=await observer.approved(snapshot,{signal});
        if(snapshot.revision!==(plan?.basis.headVersion??s.observed.revision))throw error('The question changed before choice preparation.','ENGINE_CONTEXT_CHANGED');
        const source=await questions.read(snapshot,{signal});
        if(!source)throw error('The Story is not waiting for a decision.','DECISION_NOT_PENDING');
        const choice=routingChoiceSelection(workflow,s.request),authorityGroup=humanAuthority(workflow,s.reviewer);
        if(!same(approved.configuration,snapshot.configuration))throw error('The choice has another configuration pin.','ENGINE_STORAGE_CORRUPT');
        const qualified=await receiptReader.requirements(snapshot,source,choice,{signal}),required=qualified.required;
        if(required.length)throw error('This choice needs additional policy or execution owners.','ENGINE_PORT_UNAVAILABLE',{
          operation:'decision.choose',required});
        if(plan) {await retained(plan,s,signal);s.plan=plan;}
        else {
          const recordedAt=projectEnrollmentTimestamp(await now());
          const planned=planRoutingChoice(workflow,s.request,{at:recordedAt,actorId:s.reviewer.actor.principalId,
            agentId:s.reviewer.agentId,authorityGroup});
          const value=namespaceRoutingChoiceRecord({projectId:scope.projectId,workId,phase:s.phaseId,generation:phase.generation,
            operationId:s.operationId,requestSha256:s.requestSha256,baseRevision:snapshot.revision,configuration:snapshot.configuration,
            question:{key:choice.pendingKey,approval:source.approved.binding.record},request:s.request,actor:s.reviewer.actor,
            agentId:s.reviewer.agentId,authorityGroup,recordedAt,outcome:planned.outcome,currentPhase:planned.workflow.currentPhase});
          namespaceRoutingChoiceValue(value,{projectId:scope.projectId,workId});
          const reference=await save(value,signal),proposal=proposed(workflow,value,reference);
          const body=lifecycleRecord('state',{projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,
            configuration:snapshot.configuration.content,workflow:proposal});
          await authorize(signal,s.reviewer);await unchanged(snapshot,signal);
          try {await committer.prepare(snapshot,{operationId:s.operationId,operation:'decision.choose',inputsSha256:s.requestSha256,
            state:Buffer.from(canonicalJson(body)),evidence:[...new Map([...evidence(value,reference,source.proof),...qualified.references]
              .map(ref=>[canonicalJson(ref),ref])).values()]},{signal});}
          catch(cause){if(!['ENGINE_OPERATION_ID_REUSED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
            const competing=checkedPlan(await committer.intent(s.operationId,{signal}),s);if(!competing)throw cause;await retained(competing,s,signal);}
          s.plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
        }
        if(!s.plan)throw error('The choice preparation has no retained candidate.','ENGINE_STORAGE_CORRUPT');
        s.snapshot=snapshot;return s.request;
      },async accepted=>{
        const plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
        if(!plan)throw error('The accepted choice lost its retained candidate.','ENGINE_STORAGE_CORRUPT');
        await retained(plan,s,signal);s.accepted=accepted;return s.request;
      },{signal});
    },
    async commit(context,intent,{signal}={}) {
      const s=selected(context);if(!same(intent,s.request))throw error('Use the prepared routing choice.','ENGINE_INPUT_INVALID');
      if(s.accepted)return s.accepted;
      return commitNamespaceOperation(committer,s.operationId,async()=>{await authorize(signal,s.reviewer);await unchanged(s.snapshot,signal);},{signal});
    },
    async finish(context,_intent,accepted) {
      const s=selected(context),plan=checkedPlan(await committer.intent(s.operationId),s);
      if(!plan)throw error('The accepted choice lost its retained candidate.','ENGINE_STORAGE_CORRUPT');
      const {value}=await retained(plan,s),record=accepted.receipt.records.find(item=>item.namespace==='state'&&item.key===namespaceLifecycleStoryKey(workId));
      if(!record)throw error('The accepted choice has no Story revision.','ENGINE_PORT_RESULT_INVALID');
      return {workId,phase:s.phaseId,recordKind:'routing',record:value,revision:record.version,pushed:false,
        actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.currentPhase};
    }
  };
  return {decisionRecord};
}

export function createNamespaceRoutingChoiceEngine({records,content,scope,workId,authority,access,clock,localContent=null}={}) {
  scope=namespaceScope(scope);const options={records,content,scope,workId,authority,access,clock,localContent};
  const ports=createNamespaceRoutingChoicePorts(options);
  return createEngine({ports:{...createNamespaceReadPorts(options),...ports}});
}
