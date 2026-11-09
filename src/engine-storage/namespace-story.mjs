/** Explicit namespace Story genesis. No repository discovery, checkout or assumed execution. */
import { createHash } from 'node:crypto';
import { createEngine } from '../engine-sdk/index.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { initialNamespaceStory,storyCreationAccess,storyCreationBinding } from '../kernel/story-creation.mjs';
import { projectEnrollmentTimestamp } from '../kernel/project-enrollment.mjs';
import { namespaceLimits } from '../sda/namespace/contract.mjs';
import { exactObject,namespaceIdentifier,namespaceScope,namespaceJson,namespaceIdentityJson } from '../sda/namespace/values.mjs';
import { contentReference } from '../sda/content/contract.mjs';
import { createNamespaceConfigurationObserver } from './namespace-configuration-reader.mjs';
import { createNamespaceLifecycleObserver } from './namespace-lifecycle-reader.mjs';
import { LIFECYCLE_AUTHORITY_KEY,LIFECYCLE_STATE_MAXIMUM_BYTES,lifecycleRecord } from './namespace-lifecycle-contract.mjs';
import { namespaceStoryRecord,namespaceStoryValue } from './namespace-story-contract.mjs';
import {createNamespaceStoryCodec} from './namespace-story-codec.mjs';
import { createNamespaceReadPorts } from './namespace-reader.mjs';
export {namespaceStoryGenesisKey} from './namespace-story-codec.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>namespaceIdentityJson(a)===namespaceIdentityJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Story creation was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');}

export function createNamespaceStoryPorts({records,content,scope,workId,authority,access,clock}={}) {
  scope=namespaceScope(scope);exactObject(authority,['id','epoch']);
  authority=Object.freeze({id:namespaceIdentifier(authority.id),epoch:authority.epoch});
  storyCreationBinding({projectId:scope.projectId,workId,authority},{workId});
  if(typeof access?.current!=='function'||typeof clock?.now!=='function')throw error('Story creation needs explicit identity and clock ports.','ENGINE_INPUT_INVALID');
  const observer=createNamespaceLifecycleObserver({records,content,scope,workId,authority});
  const configured=createNamespaceConfigurationObserver({records,content,scope,authority});
  const {record,bytes,assertAuthority,state}=observer;
  const limits=namespaceLimits(records.descriptor.limits),transact=records.transact.bind(records),inspect=records.inspectOperation.bind(records),put=content.put.bind(content);
  const current=access.current.bind(access),now=clock.now.bind(clock),recordId=records.descriptor.id,contentId=content.descriptor.id;
  const binding=Object.freeze({projectId:scope.projectId,workId,authority}),contexts=new WeakMap(),preparations=new WeakMap(),outcomes=new WeakMap();
  const {headKey,genesisKey,readKey,keys,parameters,txDigest,projected,firstHead,transaction,receipt}=createNamespaceStoryCodec({scope,workId,authority,limits});
  function select(context){const selected=contexts.get(context);if(!selected)throw error('Story creation needs its issued context.','ENGINE_INPUT_INVALID');return selected;}
  function retainedValue(kind,value,operationId) {
    try {return namespaceStoryValue(kind,value,scope,workId,operationId);}
    catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;throw error('The retained Story creation intent is invalid.','ENGINE_STORAGE_CORRUPT',null,cause);}
  }
  function checked(plan,selected) {
    retainedValue('intent',plan,selected.inputs.operationId);
    if(plan.authorityId!==authority.id||plan.epoch!==authority.epoch||plan.parametersSha256!==selected.parameters) {
      throw error('This operation ID belongs to another Story creation.','ENGINE_OPERATION_ID_REUSED');
    }
    if(plan.requestDigest!==txDigest(transaction(plan)))throw error('The prepared Story creation transaction changed.','ENGINE_STORAGE_CORRUPT');
    return plan;
  }
  async function checkpoint(selected,signal) {
    const k=keys(selected.inputs.operationId);let saved=await record('runtime',k.prepared,true,signal,true);
    const observed=await inspect(scope,k.prepareOperation,{signal});
    if(saved===null&&observed?.status==='missing'&&observed.receipt===null)return null;
    if(saved===null&&observed?.status==='committed')saved=await record('runtime',k.prepared,true,signal,true);
    if(!saved)throw error('Story creation lost its immutable prepared intent.','ENGINE_STORAGE_CORRUPT');
    const plan=checked(saved.value,selected);receipt(observed,transaction(plan,true));return plan;
  }
  async function authorize(expected,signal) {
    cancelled(signal);const response=await current({projectId:scope.projectId,workId,operation:'story.create',signal});let facts;
    try {facts=namespaceJson(response);}
    catch(cause){throw error('The creator port did not return bounded identity facts.','ENGINE_PORT_RESULT_INVALID',null,cause);}
    cancelled(signal);return storyCreationAccess(facts,scope.projectId,expected);
  }
  async function basis(signal) {
    const active=await record('state',LIFECYCLE_AUTHORITY_KEY,false,signal,true);
    if(!active)throw error('Enroll this project before creating a Story.','ENGINE_PROJECT_NOT_ENROLLED');
    assertAuthority(active.value);
    for(const key of [headKey,genesisKey,readKey])if(await record('state',key,key===genesisKey,signal,true)) {
      throw error('This Story ID is already retained. Reopen it or choose a different ID.','ENGINE_STORY_EXISTS',{workId});
    }
    return active.version;
  }
  async function source(reference,signal) {
    const data=await bytes(reference,reference.bytes,signal);
    try {const text=new TextDecoder('utf-8',{fatal:true}).decode(data);if(!text.trim()||text.includes('\0'))throw new Error('Empty or NUL-containing source.');}
    catch(cause){throw error('The Story source must be nonempty UTF-8 text.','ENGINE_SOURCE_INVALID',{reference},cause);}
    return data;
  }
  async function body(inputs,approval,actor,at,signal) {
    await source(inputs.source,signal);
    const workflow=initialNamespaceStory(inputs,approval.compiled,actor,at);
    const value=lifecycleRecord('state',{projectId:scope.projectId,authorityId:authority.id,epoch:authority.epoch,workId,
      configuration:approval.configuration.content,workflow});
    const data=Buffer.from(JSON.stringify(value)+'\n');
    if(data.byteLength>LIFECYCLE_STATE_MAXIMUM_BYTES)throw error('The initial Story state exceeds its content bound.','ENGINE_STORAGE_LIMIT');
    return {data,reference:{namespace:'state',sha256:hash(data),bytes:data.byteLength},phase:workflow.currentPhase};
  }
  function outcome(context,plan,r,replayed){const token=Object.freeze({});outcomes.set(token,{context,plan,r,replayed});return token;}
  async function retained(context,_inputs,{signal}={}) {
    cancelled(signal);const selected=select(context),k=keys(selected.inputs.operationId);
    const observed=await inspect(scope,k.operation,{signal});
    if(observed?.status==='missing'&&observed.receipt===null)return null;
    const plan=await checkpoint(selected,signal);
    if(!plan)throw error('An accepted Story creation lost its prepared intent.','ENGINE_STORAGE_CORRUPT');
    const r=receipt(observed,transaction(plan));
    for(const [namespace,key,kind] of [['state',genesisKey,'genesis'],['evidence',k.manifest,'manifest']]) {
      const saved=await record(namespace,key,true,signal);
      retainedValue(kind,saved.value,plan.operationId);
      if(!same(saved.value,projected(kind,plan)))throw error('The retained Story genesis or creation receipt changed.','ENGINE_STORAGE_CORRUPT');
    }
    await configured.approved(plan.configurationId,{signal});
    state(await bytes(plan.state,plan.state.bytes,signal),firstHead(plan));await source(plan.source,signal);
    return outcome(context,plan,r,true);
  }
  const storyCreation={
    async load(inputs,{signal}={}) {cancelled(signal);storyCreationBinding(binding,inputs);const context=Object.freeze({binding});
      contexts.set(context,{inputs,parameters:parameters(inputs,{recordId,contentId})});return context;},
    retained,
    async prepare(context,_inputs,{signal}={}) {
      const selected=select(context);let plan=await checkpoint(selected,signal);
      const actor=await authorize(plan?.actor??null,signal),authorityVersion=await basis(signal);
      const approval=await configured.approved(selected.inputs.configurationId,{signal});
      const at=plan?.recordedAt??projectEnrollmentTimestamp(await now()),initial=await body(selected.inputs,approval,actor,at,signal);
      if(plan) {
        if(plan.authorityVersion!==authorityVersion||plan.configurationVersion!==approval.configurationVersion
          ||!same(plan.configuration,approval.configuration)||!same(plan.state,initial.reference))throw error('The prepared Story basis changed.','ENGINE_CONTEXT_CHANGED');
        await bytes(plan.state,plan.state.bytes,signal);
      }else {
        cancelled(signal);const saved=await put(scope,'state',initial.data,{signal});
        if(!same(contentReference(saved?.reference),initial.reference)||typeof saved.reused!=='boolean')throw error('The content port did not acknowledge the initial Story state.','ENGINE_PORT_RESULT_INVALID');
        plan=namespaceStoryRecord('intent',{projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,
          operationId:selected.inputs.operationId,parametersSha256:selected.parameters,configurationId:selected.inputs.configurationId,
          configuration:approval.configuration,configurationVersion:approval.configurationVersion,authorityVersion,source:selected.inputs.source,
          title:selected.inputs.title,workTypeId:selected.inputs.workTypeId,actor,recordedAt:at,state:initial.reference,initialPhase:initial.phase,requestDigest:'0'.repeat(64)});
        plan.requestDigest=txDigest(transaction(plan));checked(plan,selected);state(initial.data,firstHead(plan));
        cancelled(signal);const tx=transaction(plan,true);
        try {receipt(await transact(scope,tx,{signal}),tx);}
        catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          const concurrent=await checkpoint(selected,signal);if(!concurrent)throw cause;
          if(!same(actor,concurrent.actor))throw error('Concurrent Story creation belongs to another creator.','ENGINE_ACTOR_CHANGED');plan=concurrent;}
      }
      const token=Object.freeze({});preparations.set(token,{context,plan});return token;
    },
    async commit(context,token,{signal}={}) {
      const prepared=preparations.get(token);if(!prepared||prepared.context!==context)throw error('Story creation requires its own prepared intent.','ENGINE_INPUT_INVALID');
      const accepted=await retained(context,select(context).inputs,{signal});if(accepted!==null)return accepted;
      const plan=await checkpoint(select(context),signal);
      if(!plan||!same(plan,prepared.plan))throw error('The prepared Story changed.','ENGINE_CONTEXT_CHANGED');
      const approval=await configured.approved(plan.configurationId,{signal});
      const initial=await body(select(context).inputs,approval,plan.actor,plan.recordedAt,signal);
      if(approval.configurationVersion!==plan.configurationVersion||!same(approval.configuration,plan.configuration)
        ||!same(initial.reference,plan.state))throw error('The approved Story contract changed after preparation.','ENGINE_CONTEXT_CHANGED');
      state(await bytes(plan.state,plan.state.bytes,signal),firstHead(plan));
      await authorize(plan.actor,signal);
      if(await basis(signal)!==plan.authorityVersion)throw error('The Story authority changed after preparation.','ENGINE_CONTEXT_CHANGED');
      cancelled(signal);const tx=transaction(plan),result=await transact(scope,tx,{signal});
      return outcome(context,plan,receipt(result,tx),result.replayed===true);
    },
    async finish(context,token) {
      const accepted=outcomes.get(token);if(!accepted||accepted.context!==context)throw error('Story creation requires its accepted receipt.','ENGINE_PORT_RESULT_INVALID');
      const {plan,r,replayed}=accepted;
      return {projectId:scope.projectId,workId,operationId:plan.operationId,authorityId:authority.id,epoch:authority.epoch,
        principalId:plan.actor.principalId,configurationId:plan.configurationId,currentPhase:plan.initialPhase,recordedAt:plan.recordedAt,
        revision:r.records.find(item=>item.namespace==='state'&&item.key===headKey).version,transactionRevision:r.revision,requestDigest:r.requestDigest,replayed};
    }
  };
  return {storyCreation};
}

export function createNamespaceStoryEngine({records,content,localContent=null,scope,workId,authority,access,clock}={}) {
  scope=namespaceScope(scope);const options={records,content,localContent,scope,workId,authority,access,clock};
  const ports=createNamespaceStoryPorts(options);
  return createEngine({ports:{...createNamespaceReadPorts(options),...ports}});
}
