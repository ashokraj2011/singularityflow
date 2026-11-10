/** Shared conditional coordination for explicit human mutations. Domain rules are owner callbacks. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseAccessIdentity,phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceLifecycleCommitter} from './namespace-lifecycle-commit.mjs';
import {prepareNamespaceOperation,commitNamespaceOperation} from './namespace-commit-coordination.mjs';
import {lifecycleRecord} from './namespace-lifecycle-contract.mjs';
import {namespaceHumanDecisionRecord,namespaceHumanDecisionReceipt,namespaceHumanDecisionReceipts} from './namespace-human-decision-contract.mjs';
import {createNamespaceHumanDecisionReader} from './namespace-human-decision-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(value).digest('hex');
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceHumanDecisionPort(options,{operation,request,owner,finish}){
  const {records,content,scope,workId,authority,access,clock}=options,
    observer=createNamespaceStoryObserver(options),committer=createNamespaceLifecycleCommitter(options),
    reader=createNamespaceHumanDecisionReader({observer,scope,workId,operation,owner}),contexts=new WeakMap();
  function state(context){const s=contexts.get(context);if(!s)throw error('Use this operation\'s issued context.','ENGINE_INPUT_INVALID');return s;}
  async function identity(signal){const facts=namespaceJson(await access.current({projectId:scope.projectId,workId,operation,signal})),
    reviewer=phaseAccessIdentity(facts,scope.projectId);
    if(reviewer.actor.actorKind!=='human')throw error('This decision requires an authenticated human.','ENGINE_HUMAN_AUTHORITY_REQUIRED');
    return {facts,reviewer};}
  async function authorize(s,signal){const {facts}=await identity(signal);phaseTransitionAccess(facts,scope.projectId,operation,{expected:s.reviewer});}
  async function unchanged(snapshot,signal){if((await observer.capture({signal})).snapshot.revision!==snapshot.revision)throw error(
    'The Story changed during this human decision. Review its current binding.','ENGINE_CONTEXT_CHANGED');}
  function checked(plan,s){if(plan&&(plan.operation!==operation||plan.inputsSha256!==s.requestSha256))throw error(
    'This operation ID has another retained intent.','ENGINE_OPERATION_ID_REUSED');return plan;}
  async function retained(plan,s,signal){
    const body=await observer.state(await observer.bytes(plan.state,plan.state.bytes,signal),plan.basis.head,{signal}),
      links=namespaceHumanDecisionReceipts(body.workflow).filter(row=>row.operationId===s.operationId);
    if(links.length!==1)throw error('The human mutation lost its exact receipt.','ENGINE_STORAGE_CORRUPT');
    const value=await reader.verify(plan,links[0].record,{signal});
    if(!same(value.value.request,s.request)||!same(value.value.actor,s.reviewer.actor)
      ||!same(links[0],namespaceHumanDecisionReceipt(value.value,links[0].record)))throw error(
      'The original human mutation has another request or actor.','ENGINE_STORAGE_CORRUPT');
    return value;
  }
  async function save(value,signal){const bytes=Buffer.from(canonicalJson(value)),saved=await content.put(scope,'evidence',bytes,{signal}),
    reference={namespace:'evidence',sha256:hash(bytes),bytes:bytes.byteLength};
    if(!same(contentReference(saved?.reference),reference)||typeof saved.reused!=='boolean')throw error('The content store returned another human record.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(reference,reference.bytes,signal);return reference;}
  return {
    async load(input,{signal}={}){
      if(input.workId!=null&&input.workId!==workId)throw error('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      const supplied=request(input),requestSha256=hash(canonicalJson({workId,request:supplied})),observed=await observer.inspect({signal}),
        {facts,reviewer}=await identity(signal),link=namespaceHumanDecisionReceipts(observed.snapshot.workflow).find(row=>
          row.operation===operation&&row.requestSha256===requestSha256&&row.principalId===reviewer.actor.principalId);
      let workflow=observed.snapshot.workflow,s={request:supplied,requestSha256,reviewer,facts,observed:observed.snapshot,replay:false};
      if(link){const proof=await reader.accepted(link,{signal});if(!same(proof.value.actor,reviewer.actor))throw error('Replay needs its original identity.','ENGINE_ACTOR_CHANGED');
        workflow=proof.original.workflow;s={...s,reviewer:{actor:reviewer.actor,agentId:proof.value.agentId},operationId:link.operationId,replay:true};
      }else{s.operationId='human-'+hash(canonicalJson({scope,authority,operation,reviewer,requestSha256,basis:observed.snapshot.revision}));}
      const context={subject:{kind:'story',id:workId},workflow,phase:workflow.phases[supplied.phaseId]};contexts.set(context,s);return context;
    },
    async prepare(context,input,{signal}={}){
      const s=state(context);if(!same(request(input),s.request))throw error('Use the issued decision request.','ENGINE_INPUT_INVALID');
      const recover=async accepted=>{const plan=checked(await committer.intent(s.operationId,{signal}),s);
        if(!plan)throw error('The accepted human mutation lost its candidate.','ENGINE_STORAGE_CORRUPT');await retained(plan,s,signal);s.accepted=accepted;return s.request;};
      return prepareNamespaceOperation(committer,s.operationId,async()=>{
        if(s.replay)throw error('The original human mutation has no accepted receipt.','ENGINE_STORAGE_CORRUPT');
        phaseTransitionAccess(s.facts,scope.projectId,operation);const snapshot=await committer.capture({signal}),
          plan=checked(await committer.intent(s.operationId,{signal}),s);
        if(snapshot.revision!==(plan?.basis.headVersion??s.observed.revision))throw error('The human decision basis changed.','ENGINE_CONTEXT_CHANGED');
        await reader.admitAgent(snapshot,s.request.phaseId,s.reviewer.agentId,{signal});
        if(plan){await retained(plan,s,signal);s.plan=plan;}
        else{
          const authorityGroup=owner.authority(snapshot.workflow,s.request,s.reviewer.actor),at=projectEnrollmentTimestamp(await clock.now()),
            source=await owner.read(snapshot,s.request,{signal,at});
          await owner.assertNew?.(snapshot,s.request,source,{signal,at});
          const planned=owner.plan(snapshot.workflow,s.request,{at,actorId:s.reviewer.actor.principalId,agentId:s.reviewer.agentId,authorityGroup},source),
            value=namespaceHumanDecisionRecord({projectId:scope.projectId,workId,phase:s.request.phaseId,generation:source.generation,
              operation,operationId:s.operationId,requestSha256:s.requestSha256,baseRevision:snapshot.revision,configuration:snapshot.configuration,
              source:source.identity,request:s.request,actor:s.reviewer.actor,agentId:s.reviewer.agentId,authorityGroup,recordedAt:at,outcome:planned.outcome}),
            reference=await save(value,signal),proposal=reader.proposed(snapshot.workflow,value,reference,source),
            body=lifecycleRecord('state',{projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,
              configuration:snapshot.configuration.content,workflow:proposal});
          await authorize(s,signal);await unchanged(snapshot,signal);
          const evidence=[...new Map([reference,...source.references].map(ref=>[canonicalJson(ref),ref])).values()];
          try{await committer.prepare(snapshot,{operationId:s.operationId,operation,inputsSha256:s.requestSha256,state:Buffer.from(canonicalJson(body)),evidence},{signal});}
          catch(cause){if(!['ENGINE_OPERATION_ID_REUSED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
            const competing=checked(await committer.intent(s.operationId,{signal}),s);if(!competing)throw cause;await retained(competing,s,signal);}
          s.plan=checked(await committer.intent(s.operationId,{signal}),s);
        }
        s.snapshot=snapshot;return s.request;
      },recover,{signal});
    },
    async commit(context,intent,{signal}={}){const s=state(context);if(!same(intent,s.request))throw error('Use the prepared decision.','ENGINE_INPUT_INVALID');
      if(s.accepted)return s.accepted;
      return commitNamespaceOperation(committer,s.operationId,async()=>{await authorize(s,signal);await unchanged(s.snapshot,signal);},{signal});},
    async finish(context,_intent,accepted){const s=state(context),plan=checked(await committer.intent(s.operationId),s);
      if(!plan)throw error('The human mutation has no retained candidate.','ENGINE_STORAGE_CORRUPT');
      const proof=await retained(plan,s),revision=accepted.receipt.records.find(row=>row.namespace==='state'&&row.key===namespaceLifecycleStoryKey(workId))?.version;
      if(!revision)throw error('The accepted human decision has no Story revision.','ENGINE_STORAGE_CORRUPT');
      return finish(proof.value,revision);
    }
  };
}
