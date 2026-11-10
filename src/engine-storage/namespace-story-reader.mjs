/** Read original creation proof and enforce its policy; never create or repair a Story. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {assertStoryPolicy} from '../kernel/story-policy.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {namespaceScope,namespaceIdentityJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceLifecycleObserver} from './namespace-lifecycle-reader.mjs';
import {createNamespaceConfigurationObserver} from './namespace-configuration-reader.mjs';
import {createNamespaceStoryCodec} from './namespace-story-codec.mjs';
import {createNamespaceLifecycleReceiptReader} from './namespace-lifecycle-receipt-reader.mjs';
import {namespaceStoryValue} from './namespace-story-contract.mjs';
import {LIFECYCLE_AUTHORITY_KEY,lifecycleAuthority} from './namespace-lifecycle-contract.mjs';
const same=(a,b)=>a===undefined||b===undefined?a===b:namespaceIdentityJson(a)===namespaceIdentityJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Story policy inspection was cancelled.','ENGINE_OPERATION_CANCELLED');}
const readDomains=new WeakMap();
/** Private capability identity: copies or overrides cannot claim another observer's read proof. */
export function namespaceStoryReadDomain(observer){return readDomains.get(observer)??observer;}

export function createNamespaceStoryObserver({records,content,scope,workId,authority}={}) {
  scope=namespaceScope(scope);authority=Object.freeze(structuredClone(authority));
  const base=createNamespaceLifecycleObserver({records,content,scope,workId,authority});
  const configured=createNamespaceConfigurationObserver({records,content,scope,authority});
  const codec=createNamespaceStoryCodec({scope,workId,authority,limits:namespaceLimits(records.descriptor.limits)});
  const receipts=createNamespaceLifecycleReceiptReader({records,content,scope,workId,authority});
  const inspectOperation=records.inspectOperation.bind(records),recordId=records.descriptor.id,contentId=content.descriptor.id,proofs=new WeakMap(),workflowProofs=new WeakMap(),readScopes=new WeakMap();
  function activeScope(token){if(token===undefined)return null;const found=readScopes.get(token);
    if(!found)throw error('Use the active Story proof-reading scope.','ENGINE_INPUT_INVALID');
    if(found.parent!==undefined)activeScope(found.parent);return found.facts;}
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
    let parameters=codec.parameters(inputs,{recordId,contentId});
    if(plan.parametersSha256!==parameters){
      // Frozen v1 creation digests bind the enrolling stores. A passive qualified client may
      // have another local adapter ID; verify the same digest using the recorded origin IDs.
      // This does not alter capture/write admission or waive an actual authority mismatch.
      const origin=lifecycleAuthority((await base.record('state',LIFECYCLE_AUTHORITY_KEY,false,signal)).value,scope);
      if(origin.authorityId===authority.id&&origin.epoch===authority.epoch){
        parameters=codec.parameters(inputs,{recordId:origin.recordsId,contentId:origin.contentId});
      }
    }
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
  async function approved(snapshot,{signal,readScope}={}) {
    cancelled(signal);const scoped=activeScope(readScope);let proof=proofs.get(snapshot)??workflowProofs.get(snapshot.workflow)??scoped?.proof;
    if(!proof){if(scoped){scoped.pending??=original(signal);try{proof=await scoped.pending;}finally{scoped.pending=null;}
        activeScope(readScope);scoped.proof=proof;}else proof=await original(signal);}
    if(!same(snapshot.configuration,proof.configuration))throw error(
      'The Story changed its original configuration without a verified amendment.','ENGINE_STORAGE_CORRUPT',{workId});
    assertStoryPolicy(snapshot.workflow,proof.workflow);proofs.set(snapshot,proof);workflowProofs.set(snapshot.workflow,proof);
    cancelled(signal);return proof.approval;
  }
  async function accepted(operationId,{signal,cache,snapshot,readScope}={}) {
    const scoped=activeScope(readScope);
    const proof=await receipts.accepted(operationId,{signal,cache:scoped?.receipts??cache});
    const selected=snapshot??{workflow:proof.state.workflow,configuration:proof.plan.basis.head.configuration};
    await approved(selected,{signal,readScope});const origin=proofs.get(selected);
    if(!same(origin.configuration,proof.plan.basis.head.configuration))throw error(
      'The accepted operation changed its original Story configuration.','ENGINE_STORAGE_CORRUPT',{workId,operationId});
    assertStoryPolicy(proof.state.workflow,origin.workflow);assertStoryPolicy(proof.basisState.workflow,origin.workflow);return proof;
  }
  async function observe(options,active,readScope) {
    activeScope(readScope);
    const captured=await (active?base.capture(options):base.inspect(options));
    await approved(captured.snapshot,{...options,readScope});
    // Proof traversal cannot extend an earlier head or authority observation indefinitely.
    const fresh=await base.record('state',codec.headKey,false,options?.signal),authorityRecord=await base.record('state',LIFECYCLE_AUTHORITY_KEY,false,options?.signal);
    cancelled(options?.signal);
    if(fresh.version!==captured.basis.headVersion||authorityRecord.version!==captured.basis.authorityVersion)throw error(
      'The Story or authority changed during its policy inspection.','ENGINE_CONTEXT_CHANGED',{workId});
    return captured;
  }
  async function state(data,head,{signal,readScope}={}) {
    activeScope(readScope);const value=base.state(data,head);await approved({workflow:value.workflow,configuration:head.configuration},{signal,readScope});return value;
  }
  // Nested readers share immutable facts for one awaited traversal. Mutable records, live source
  // captures and final head/authority checks stay fresh. Each callback owns its expiring capability.
  async function withReadScope(read,parent){
    if(typeof read!=='function')throw error('Provide a Story proof reader.','ENGINE_INPUT_INVALID');
    const facts=activeScope(parent)??{receipts:Object.freeze({}),cache:new Map(),bytes:0},token=Object.freeze({}),cache=facts.cache;
    readScopes.set(token,{parent,facts});
    async function memo(key,load,copy,size,signal){
      activeScope(token);cancelled(signal);const prior=cache.get(key);
      if(prior){const value=await prior;activeScope(token);cancelled(signal);return copy(value);}
      if(cache.size>=256&&!cache.has(key)){const value=await load();activeScope(token);cancelled(signal);return value;}
      const pending=load();cache.set(key,pending);
      try{const value=await pending;activeScope(token);cancelled(signal);
        const bytes=value===null?0:size(value);
        if(value===null||facts.bytes+bytes>8*1024*1024)cache.set(key,null);else facts.bytes+=bytes;
        return copy(value);
      }catch(cause){cache.set(key,null);throw cause;}
    }
    const scoped=Object.freeze({...observer,approved:(snapshot,options)=>approved(snapshot,{...options,readScope:token}),
      state:(data,head,options)=>state(data,head,{...options,readScope:token}),accepted:(id,options)=>accepted(id,{...options,readScope:token}),
      record:async(namespace,key,immutable,signal,missing=false)=>{
        activeScope(token);cancelled(signal);const load=()=>base.record(namespace,key,immutable,signal,missing);
        const value=await (immutable?memo('record:'+namespaceIdentityJson([namespace,key]),load,structuredClone,value=>new TextEncoder().encode(namespaceIdentityJson(value)).byteLength,signal):load());
        activeScope(token);cancelled(signal);return value;},
      bytes:async(reference,maximumBytes,signal)=>{
        activeScope(token);cancelled(signal);const selected=contentReference(reference),load=()=>base.bytes(reference,maximumBytes,signal);
        const value=await (maximumBytes===selected.bytes
          ?memo('bytes:'+namespaceIdentityJson(selected),load,value=>Buffer.from(value),value=>value.byteLength,signal):load());
        activeScope(token);cancelled(signal);return value;},
      capture:options=>observe(options,true,token),inspect:options=>observe(options,false,token),withReadScope:nested=>withReadScope(nested,token)});
    readDomains.set(scoped,namespaceStoryReadDomain(observer));
    try{return await read(scoped);}finally{if(parent===undefined){cache.clear();facts.bytes=0;facts.proof=null;facts.pending=null;facts.receipts=null;}readScopes.set(token,null);}
  }
  // Original evidence readers need only receipt inspection and this observer's read capabilities.
  const evidenceReads=Object.freeze({scope:Object.freeze({...scope}),workId,authority,
    records:Object.freeze({descriptor:records.descriptor,inspectOperation})});
  const observer=Object.freeze({...base,capture:options=>observe(options,true),inspect:options=>observe(options,false),approved,state,accepted,evidenceReads,withReadScope});
  readDomains.set(observer,Object.freeze({}));
  return observer;
}
