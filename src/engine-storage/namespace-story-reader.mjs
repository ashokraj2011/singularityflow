/** Read original creation proof and enforce its policy; never create or repair a Story. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {assertStoryPolicy} from '../kernel/story-policy.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {namespaceScope,namespaceIdentityJson} from '../sda/namespace/values.mjs';
import {createNamespaceLifecycleObserver} from './namespace-lifecycle-reader.mjs';
import {createNamespaceConfigurationObserver} from './namespace-configuration-reader.mjs';
import {createNamespaceStoryCodec} from './namespace-story-codec.mjs';
import {namespaceStoryValue} from './namespace-story-contract.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from './namespace-lifecycle-contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>a===undefined||b===undefined?a===b:namespaceIdentityJson(a)===namespaceIdentityJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Story policy inspection was cancelled.','ENGINE_OPERATION_CANCELLED');}

export function createNamespaceStoryObserver({records,content,scope,workId,authority}={}) {
  scope=namespaceScope(scope);authority=Object.freeze(structuredClone(authority));
  const base=createNamespaceLifecycleObserver({records,content,scope,workId,authority});
  const configured=createNamespaceConfigurationObserver({records,content,scope,authority});
  const codec=createNamespaceStoryCodec({scope,workId,authority,limits:namespaceLimits(records.descriptor.limits)});
  const inspectOperation=records.inspectOperation.bind(records),recordId=records.descriptor.id,contentId=content.descriptor.id,proofs=new WeakMap();
  const binding={projectId:scope.projectId,workId,authority};
  function stored(kind,value,operationId=null) {
    try {return namespaceStoryValue(kind,value,scope,workId,operationId);}
    catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;
      throw error('The retained Story creation proof is invalid.','ENGINE_STORAGE_CORRUPT',{workId,kind},cause);}
  }
  function receiptVersion(receipt,namespace,key,record) {
    if(receipt.records.find(item=>item.namespace===namespace&&item.key===key)?.version!==record.version)throw error(
      'The immutable creation record has another receipt revision.','ENGINE_STORAGE_CORRUPT',{workId,namespace,key});
  }
  async function original(signal) {
    cancelled(signal);
    const genesisRecord=await base.record('state',codec.genesisKey,true,signal);
    const genesis=stored('genesis',genesisRecord.value);
    if(genesis.authorityId!==authority.id||genesis.epoch!==authority.epoch)throw error(
      'The original Story creation needs its matching authority proof.','ENGINE_AUTHORITY_FENCED',{workId,authority});
    const keys=codec.keys(genesis.operationId),intentRecord=await base.record('runtime',keys.prepared,true,signal);
    const plan=stored('intent',intentRecord.value,genesis.operationId);
    if(!same(genesis,codec.projected('genesis',plan))||plan.requestDigest!==codec.txDigest(codec.transaction(plan)))throw error(
      'The original Story genesis differs from its prepared transaction.','ENGINE_STORAGE_CORRUPT',{workId});
    const inputs=Object.fromEntries(['operationId','workId','title','workTypeId','configurationId','source'].map(key=>[key,plan[key]]));
    const parameters=hash(namespaceIdentityJson({operation:'story.create',inputs,binding,recordId,contentId}));
    if(plan.parametersSha256!==parameters)throw error('The original creation inputs have another binding.','ENGINE_STORAGE_CORRUPT',{workId});
    const prepared=codec.receipt(await inspectOperation(scope,keys.prepareOperation,{signal}),codec.transaction(plan,true));
    receiptVersion(prepared,'runtime',keys.prepared,intentRecord);
    const committed=codec.receipt(await inspectOperation(scope,keys.operation,{signal}),codec.transaction(plan));
    receiptVersion(committed,'state',codec.genesisKey,genesisRecord);
    const manifest=await base.record('evidence',keys.manifest,true,signal);
    stored('manifest',manifest.value,plan.operationId);receiptVersion(committed,'evidence',keys.manifest,manifest);
    if(!same(manifest.value,codec.projected('manifest',plan)))throw error(
      'The original creation manifest differs from its accepted transaction.','ENGINE_STORAGE_CORRUPT',{workId});
    const approval=await configured.approved(plan.configurationId,{signal});
    if(approval.configurationVersion!==plan.configurationVersion||!same(approval.configuration,plan.configuration))throw error(
      'The original creation has another approved configuration pin.','ENGINE_STORAGE_CORRUPT',{workId});
    const state=base.state(await base.bytes(plan.state,plan.state.bytes,signal),codec.firstHead(plan)),workflow=state.workflow,item=workflow.workItem;
    if(item.title!==plan.title||item.workType!==plan.workTypeId||item.createdAt!==plan.recordedAt||!same(item.createdBy,plan.actor)
      ||!same(item.source?.content,plan.source)||item.source?.contentSha256!==plan.source.sha256
      ||workflow.currentPhase!==plan.initialPhase||workflow.phaseOrder?.[0]!==plan.initialPhase
      ||workflow.resolution?.configurationApprovalId!==plan.configurationId
      ||!same(workflow.resolution?.configurationSource,approval.compiled.source)||workflow.resolution?.sourceSha256!==plan.source.sha256)throw error(
      'The original lifecycle state has another creation binding.','ENGINE_STORAGE_CORRUPT',{workId});
    assertStoryPolicy(workflow,workflow);
    await base.bytes(plan.source,plan.source.bytes,signal);cancelled(signal);
    return {workflow,configuration:plan.configuration,approval};
  }
  async function approved(snapshot,{signal}={}) {
    cancelled(signal);let proof=proofs.get(snapshot);
    if(!proof){proof=await original(signal);proofs.set(snapshot,proof);}
    if(!same(snapshot.configuration,proof.configuration))throw error(
      'The Story changed its original configuration without a verified amendment.','ENGINE_STORAGE_CORRUPT',{workId});
    assertStoryPolicy(snapshot.workflow,proof.workflow);cancelled(signal);return proof.approval;
  }
  async function observe(options,active) {
    const captured=await (active?base.capture(options):base.inspect(options));
    await approved(captured.snapshot,options);
    // Proof traversal cannot extend an earlier head or authority observation indefinitely.
    const fresh=await base.record('state',codec.headKey,false,options?.signal),authorityRecord=await base.record('state',LIFECYCLE_AUTHORITY_KEY,false,options?.signal);
    cancelled(options?.signal);
    if(fresh.version!==captured.basis.headVersion||authorityRecord.version!==captured.basis.authorityVersion)throw error(
      'The Story or authority changed during its policy inspection.','ENGINE_CONTEXT_CHANGED',{workId});
    return captured;
  }
  async function state(data,head,{signal}={}) {
    const value=base.state(data,head);await approved({workflow:value.workflow,configuration:head.configuration},{signal});return value;
  }
  return Object.freeze({...base,capture:options=>observe(options,true),inspect:options=>observe(options,false),approved,state});
}
