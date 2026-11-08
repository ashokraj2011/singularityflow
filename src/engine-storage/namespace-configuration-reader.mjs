/** Read only immutable configuration approval facts; never accept or repair a configuration. */
import { createHash } from 'node:crypto';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { namespaceConfigurationJsonValues } from '../kernel/namespace-configuration.mjs';
import { validateNamespaceStore,namespaceLimits } from '../sda/namespace/contract.mjs';
import { namespaceScope,namespaceIdentifier,namespaceRevision,namespaceJson,namespaceIdentityJson } from '../sda/namespace/values.mjs';
import { validateContentStore,contentReference } from '../sda/content/contract.mjs';
import { lifecycleConfiguration } from './namespace-lifecycle-contract.mjs';
import { namespaceConfigurationRecordValue,namespaceConfigurationCompiledValue } from './namespace-configuration-contract.mjs';
import { createNamespaceConfigurationCodec } from './namespace-configuration-codec.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>namespaceIdentityJson(a)===namespaceIdentityJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
export function createNamespaceConfigurationObserver({records,content,scope,authority}) {
  validateNamespaceStore(records);validateContentStore(content);scope=namespaceScope(scope);
  const limits=namespaceLimits(records.descriptor.limits),read=records.read.bind(records),get=content.read.bind(content);
  const inspect=records.inspectOperation.bind(records),configurationJson=namespaceConfigurationJsonValues();
  const {keys,projected,transaction,prepareTransaction,receipt,txDigest}=createNamespaceConfigurationCodec({scope,authority,limits});
  function stored(validate,...args) {
    try{return validate(...args);}catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;
      throw error('A retained configuration record is invalid.','ENGINE_STORAGE_CORRUPT',{projectId:scope.projectId},cause);}
  }
  async function record(namespace,key,immutable,signal) {
    const result=await read(scope,namespace,key,{signal});
    if(result?.status==='missing' && result.record===null)return null;
    try {
      if(result?.status!=='present' || result.record?.namespace!==namespace || result.record.key!==key
        || result.record.immutable!==immutable || namespaceRevision(result.record.version)===null)throw new Error('Wrong record binding.');
      return {version:result.record.version,value:namespaceJson(result.record.value,{maxBytes:limits.maxValueBytes})};
    }catch(cause){
      throw error('The namespace port returned another configuration record.','ENGINE_PORT_RESULT_INVALID',{namespace,key},cause);
    }
  }
  async function bytes(reference,signal) {
    reference=contentReference(reference); const result=await get(scope,reference,{maximumBytes:reference.bytes,signal});
    if(result?.status==='missing' && result.data===null)throw error('Required immutable configuration content is missing.','ENGINE_STORAGE_CONTENT_MISSING',{reference});
    try {
      if(result?.status!=='present' || !same(contentReference(result.reference),reference) || !(result.data instanceof Uint8Array)
        || result.data.byteLength!==reference.bytes || result.truncated!==false)throw new Error('Wrong content binding.');
    }catch(cause){throw error('The content port returned another configuration binding.','ENGINE_PORT_RESULT_INVALID',{reference},cause);}
    const data=Buffer.from(result.data);
    if(hash(data)!==reference.sha256)throw error('Immutable configuration content has another digest.','ENGINE_STORAGE_CORRUPT',{reference});
    return data;
  }
  function json(data) {
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
    catch(cause){throw error('The configuration package is not bounded UTF-8 JSON.','ENGINE_CONFIGURATION_INVALID',null,cause);}
  }
  async function approved(operationId,{signal}={}) {
    namespaceIdentifier(operationId,'Configuration approval ID');
    const k=keys(operationId),saved=await record('runtime',k.prepared,true,signal);
    if(!saved)throw error('The selected configuration has no retained approval intent.','ENGINE_CONFIGURATION_NOT_APPROVED',{operationId});
    const plan=stored(namespaceConfigurationRecordValue,'intent',saved.value,scope,operationId);
    if(plan.authorityId!==authority.id||plan.epoch!==authority.epoch)throw error('The selected configuration uses another authority.','ENGINE_AUTHORITY_FENCED');
    if(plan.requestDigest!==txDigest(transaction(plan)))throw error('The prepared configuration transaction changed.','ENGINE_STORAGE_CORRUPT');
    receipt(await inspect(scope,k.prepareOperation,{signal}),prepareTransaction(plan));
    const accepted=await inspect(scope,k.operation,{signal});
    if(accepted?.status==='missing'&&accepted.receipt===null)throw error('Review and approve the selected configuration before creating a Story.','ENGINE_CONFIGURATION_NOT_APPROVED',{operationId});
    const r=receipt(accepted,transaction(plan)),manifest=await record('evidence',k.manifest,true,signal);
    if(!manifest||!same(stored(namespaceConfigurationRecordValue,'manifest',manifest.value,scope,operationId),projected('manifest',plan))) {
      throw error('The selected configuration approval is missing or changed.','ENGINE_STORAGE_CORRUPT');
    }
    const configured=await record('config',plan.configuration.key,true,signal);
    if(!configured||!same(stored(lifecycleConfiguration,configured.value,scope).content,plan.configuration.content)) {
      throw error('The approved immutable configuration record is missing or changed.','ENGINE_STORAGE_CORRUPT');
    }
    const compiled=stored(namespaceConfigurationCompiledValue,configurationJson.namespaceJson(json(await bytes(plan.configuration.content,signal))),plan.source);
    return {operationId,configuration:structuredClone(plan.configuration),configurationVersion:configured.version,compiled,receipt:r};
  }
  return Object.freeze({stored,record,bytes,json,approved});
}
