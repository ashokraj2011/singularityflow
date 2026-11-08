/** Shared durable configuration transaction identity. Reads and writes use one frozen codec. */
import { createHash } from 'node:crypto';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { exactObject,namespaceJson,namespaceRevision,namespaceIdentityJson } from '../sda/namespace/values.mjs';
import { namespaceTransaction,namespaceTransactionIdentity } from '../sda/namespace/transaction.mjs';
import { LIFECYCLE_AUTHORITY_KEY,lifecycleRecord } from './namespace-lifecycle-contract.mjs';
import { NAMESPACE_CONFIGURATION_HEAD_KEY,namespaceConfigurationRecord } from './namespace-configuration-contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=value=>hash(namespaceIdentityJson(value));
const same=(a,b)=>namespaceIdentityJson(a)===namespaceIdentityJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
export function createNamespaceConfigurationCodec({scope,authority,limits}) {
  const txDigest=tx=>hash(namespaceTransactionIdentity(scope,tx,limits));
  const keys=operationId=> { const id=identity({projectId:scope.projectId,authority,operationId});
    return {prepared:`configuration/prepared/${id}`,manifest:`configuration/approvals/${id}`,
      prepareOperation:`config-prepare-${id}`,operation:`config-approve-${id}`,event:`config-approve-${id}`}; };
  const projected=(kind,plan)=>namespaceConfigurationRecord(kind,Object.fromEntries(Object.entries(plan)
    .filter(([key])=>!['schemaVersion','format','requestDigest'].includes(key))));
  function transaction(plan) {
    const k=keys(plan.operationId),configuration=lifecycleRecord('configuration',{projectId:scope.projectId,content:plan.configuration.content});
    return namespaceTransaction({operationId:k.operation,preconditions:[
      {namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:plan.authorityVersion},
      {namespace:'config',key:NAMESPACE_CONFIGURATION_HEAD_KEY,version:plan.baseRevision},
      {namespace:'config',key:plan.configuration.key,version:plan.configurationVersion},
      {namespace:'evidence',key:k.manifest,version:null}
    ],changes:[
      ...(plan.configurationVersion===null?[{op:'put',namespace:'config',key:plan.configuration.key,immutable:true,value:configuration}]:[]),
      {op:'put',namespace:'config',key:NAMESPACE_CONFIGURATION_HEAD_KEY,immutable:false,value:projected('head',plan)},
      {op:'put',namespace:'evidence',key:k.manifest,immutable:true,value:projected('manifest',plan)}
    ],events:[{eventId:k.event,eventType:'engine.configuration-approved',namespace:'config',
      payload:{projectId:scope.projectId,operationId:plan.operationId,source:plan.source,configuration:plan.configuration.content,
        principalId:plan.principalId,authorityId:authority.id,epoch:authority.epoch}}]},limits);
  }
  function prepareTransaction(plan) {
    const k=keys(plan.operationId);
    return namespaceTransaction({operationId:k.prepareOperation,preconditions:[
      {namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:plan.authorityVersion},
      {namespace:'config',key:NAMESPACE_CONFIGURATION_HEAD_KEY,version:plan.baseRevision},
      {namespace:'runtime',key:k.prepared,version:null},{namespace:'evidence',key:k.manifest,version:null}
    ],changes:[{op:'put',namespace:'runtime',key:k.prepared,immutable:true,value:plan}],events:[]},limits);
  }
  function receipt(result,tx) {
    let r;
    try {
      r=namespaceJson(result?.receipt,{maxBytes:limits.maxValueBytes});
      exactObject(r,['operationId','scope','revision','requestDigest','records','eventIds']); exactObject(r.scope,['projectId']);
      if(namespaceRevision(r.revision)===null || !Array.isArray(r.records) || !Array.isArray(r.eventIds))throw new Error('Invalid receipt fields.');
      for(const item of r.records){exactObject(item,['namespace','key','version']);if(namespaceRevision(item.version)===null)throw new Error('Missing record revision.');}
    }catch(cause){throw error('Inspect the original configuration operation: its receipt is invalid.','ENGINE_PORT_RESULT_INVALID',null,cause);}
    const addresses=tx.changes.map(change=>[change.namespace,change.key]);
    if(result.status!=='committed' || r.operationId!==tx.operationId || r.scope.projectId!==scope.projectId || r.requestDigest!==txDigest(tx)
      || result.replayed!==undefined && typeof result.replayed!=='boolean' || r.records.length!==addresses.length
      || new Set(r.records.map(item=>JSON.stringify([item.namespace,item.key]))).size!==addresses.length
      || !r.records.every(item=>addresses.some(([namespace,key])=>item.namespace===namespace&&item.key===key))
      || !same(r.eventIds,tx.events.map(event=>event.eventId)))throw error('The configuration receipt has another binding.','ENGINE_PORT_RESULT_INVALID');
    return r;
  }
  return Object.freeze({keys,projected,transaction,prepareTransaction,receipt,txDigest});
}
