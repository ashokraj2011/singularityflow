/** Read accepted conditional effects without importing a writer, dispatching or repairing storage. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceIdentityJson,namespaceScope} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {createNamespaceLifecycleObserver} from './namespace-lifecycle-reader.mjs';
import {createNamespaceLifecycleCodec} from './namespace-lifecycle-codec.mjs';
import {lifecyclePrepared,lifecycleManifest,lifecycleConfiguration} from './namespace-lifecycle-contract.mjs';
import {memoNamespaceLifecycleReceiptProof} from './namespace-read-session.mjs';
import {readNamespaceBatch} from '../sda/namespace/read-batch.mjs';
const same=(a,b)=>namespaceIdentityJson(a)===namespaceIdentityJson(b);
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
function cancelled(signal){if(signal?.aborted)throw error('Lifecycle receipt inspection was cancelled.','ENGINE_OPERATION_CANCELLED');}
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function createNamespaceLifecycleReceiptReader({records,content,scope,workId,authority}={}) {
  scope=namespaceScope(scope);authority=Object.freeze(structuredClone(authority));
  const observer=createNamespaceLifecycleObserver({records,content,scope,workId,authority});
  const codec=createNamespaceLifecycleCodec({scope,workId,authority,limits:namespaceLimits(records.descriptor.limits),textDigests:NODE_TEXT_DIGESTS});
  const inspectOperation=records.inspectOperation.bind(records);
  // A caller-owned token scopes reuse to one proof traversal, never a backend-global freshness cache.
  const traversals=new WeakMap();
  function revision(receipt,namespace,key,record){if(receipt.records.find(item=>item.namespace===namespace&&item.key===key)?.version!==record.version)throw error(
    'The retained lifecycle record differs from its accepted receipt revision.','ENGINE_STORAGE_CORRUPT',{workId,namespace,key});}
  async function inspect(operationId,{signal}={}) {
    cancelled(signal);const keys=codec.keys(operationId),batch=await readNamespaceBatch(records,scope,[
      {kind:'operation',operationId:keys.operation},{kind:'record',namespace:'runtime',key:keys.prepared},
      {kind:'operation',operationId:keys.prepareOperation},{kind:'record',namespace:'evidence',key:keys.manifest}],{signal}),
      observed=batch?batch.facts[0].result:await inspectOperation(scope,keys.operation,{signal});
    const missing=observed?.status==='missing'&&observed.receipt===null;
    if(!missing&&observed?.status!=='committed')throw error('The namespace port returned an invalid operation inspection.','ENGINE_PORT_RESULT_INVALID',{workId,operationId});
    const intent=batch?observer.recordResult('runtime',keys.prepared,true,batch.facts[1].result,true):await observer.record('runtime',keys.prepared,true,signal,true);
    if(!intent){if(!missing)throw error('A committed lifecycle operation has lost its prepared intent.','ENGINE_STORAGE_CORRUPT',{workId,operationId});
      return freeze({status:'missing',operationId});}
    const plan=observer.stored(lifecyclePrepared,intent.value,workId,operationId);
    if(plan.authorityId!==authority.id||plan.epoch!==authority.epoch||plan.requestDigest!==codec.requestDigest(codec.transaction(plan)))throw error(
      'The retained lifecycle intent differs from its original authority or transaction.','ENGINE_STORAGE_CORRUPT',{workId,operationId});
    const prepared=codec.receipt(batch?batch.facts[2].result:await inspectOperation(scope,keys.prepareOperation,{signal}),plan,codec.prepareTransaction(plan));
    revision(prepared,'runtime',keys.prepared,intent);
    if(missing)return freeze({status:'prepared',operationId,operation:plan.operation,requestDigest:plan.requestDigest});
    const receipt=codec.receipt(observed,plan),manifest=batch?observer.recordResult('evidence',keys.manifest,true,batch.facts[3].result):await observer.record('evidence',keys.manifest,true,signal);
    observer.stored(lifecycleManifest,manifest.value,workId,operationId);revision(receipt,'evidence',keys.manifest,manifest);
    if(!same(manifest.value,codec.manifest(plan)))throw error('The retained lifecycle manifest differs from its accepted transaction.','ENGINE_STORAGE_CORRUPT',{workId,operationId});
    const configuration=await observer.record('config',plan.basis.head.configuration.key,true,signal);
    observer.stored(lifecycleConfiguration,configuration.value);
    if(configuration.version!==plan.basis.configurationVersion||!same(configuration.value.content,plan.basis.head.configuration.content))throw error(
      'The accepted operation has another immutable configuration revision.','ENGINE_STORAGE_CORRUPT',{workId,operationId});
    const state=observer.state(await observer.bytes(plan.state,plan.state.bytes,signal),codec.head(plan));
    const basisState=observer.state(await observer.bytes(plan.basis.head.state,plan.basis.head.state.bytes,signal),plan.basis.head);
    cancelled(signal);return freeze({status:'committed',operationId,operation:plan.operation,plan,receipt,manifest:manifest.value,state,basisState});
  }
  async function acceptedObservation(operationId,{signal,cache}={}) {
    cancelled(signal);let pending;
    if(cache){let values=traversals.get(cache);if(!values){values=new Map();traversals.set(cache,values);}
      pending=values.get(operationId);if(!pending){pending=inspect(operationId,{signal});values.set(operationId,pending);
        const remove=()=>{if(values.get(operationId)===pending)values.delete(operationId);};
        pending.then(proof=>{if(proof.status!=='committed')remove();},remove);}}
    const proof=await (pending??inspect(operationId,{signal}));cancelled(signal);
    if(proof.status!=='committed')throw error('This evidence has no accepted lifecycle operation. Resume its original operation before using it downstream.',
      'ENGINE_OPERATION_NOT_COMMITTED',{workId,operationId,status:proof.status});
    return proof;
  }
  async function accepted(operationId,options={}){
    const proof=await memoNamespaceLifecycleReceiptProof(records,content,{scope,workId,authority,operationId},
      ()=>acceptedObservation(operationId,options),options);
    return freeze(proof);
  }
  return Object.freeze({inspect,accepted});
}

/** Typed evidence owners still validate their own payload and resulting phase bindings. */
export async function namespaceAcceptedEvidence(observer,binding,value,operation,options={}) {
  if(typeof observer.accepted!=='function')throw error('This evidence needs its accepted lifecycle receipt reader.',
    'ENGINE_PORT_UNAVAILABLE',{required:['retained-lifecycle-receipt']});
  const proof=await observer.accepted(value.operationId,options),plan=proof.plan;
  if(plan.operation!==operation||plan.inputsSha256!==value.requestSha256||plan.basis.headVersion!==value.baseRevision
    ||!same(plan.basis.head.configuration,value.configuration)||!plan.evidence.some(ref=>same(ref,binding.record)))throw error(
    'The retained evidence differs from its accepted lifecycle intent.','ENGINE_STORAGE_CORRUPT',{workId:value.workId,operationId:value.operationId});
  return proof;
}
