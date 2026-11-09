/** Versioned baseline evidence acceptance. Existing source bindings and lifecycle bytes are unchanged. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_SOURCE_BASELINE_SCHEMAS,admitRecordSchemaVersion,textDigestCapability} from '../foundation/record-schema.mjs';
import {namespaceScope,namespaceIdentifier,namespaceIdentityJson,namespaceRevision,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {namespaceJournalReceipt} from '../sda/namespace/journal-contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-codec.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from './namespace-lifecycle-contract.mjs';
export const NAMESPACE_SOURCE_BASELINE_PROFILE='sflow-namespace-source-baseline/v1';
const error=(message,code='ENGINE_STORAGE_CORRUPT',cause=undefined)=>new SingularityFlowError(message,{code,cause});
const fields={plan:['profile','binding','input','parametersSha256','recordedAt','actor','basis','sources'],
  result:['profile','plan','recordedAt','repositories','totals'],
  repository:['profile','plan','id','baselineRevision','selection','roles','entries'],
  intent:['projectId','workId','authorityId','epoch','operationId','sourceBindingId','parametersSha256','content'],
  manifest:['projectId','workId','authorityId','epoch','operationId','sourceBindingId','parametersSha256','content','previousIndexVersion'],
  index:['projectId','workId','authorityId','epoch','sourceBindingId','manifestKey']};
const formats=Object.fromEntries(Object.keys(fields).map(kind=>[kind,'sflow-namespace-source-baseline-'+kind+'/v1']));
export function sourceBaselineRecord(kind,value){return {schemaVersion:1,format:formats[kind],...value};}
export function sourceBaselineValue(kind,value){
  try{admitRecordSchemaVersion(NAMESPACE_SOURCE_BASELINE_SCHEMAS[kind],value);
    if(value.format!==formats[kind])throw Error('Another baseline format.');exactObject(value,['schemaVersion','format',...fields[kind]]);
  }catch(cause){throw error('The retained baseline has another version or format.',
    ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause);}
  return value;
}
export function createNamespaceSourceBaselineCodec({scope,workId,authority,limits,textDigests}={}) {
  scope=namespaceScope(scope);namespaceIdentifier(workId);limits=namespaceLimits(limits);exactObject(authority,['id','epoch']);namespaceIdentifier(authority.id);
  if(!Number.isSafeInteger(authority.epoch)||authority.epoch<1)throw error('Baseline retention needs an explicit authority epoch.','ENGINE_INPUT_INVALID');
  const hash=textDigestCapability(textDigests).sha256Utf8,identity=value=>hash(namespaceIdentityJson(value));
  const binding=Object.freeze({projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch});
  const keys=input=>{const key=identity({binding,operationId:input.operationId});return {intent:'source-baseline/intents/'+key,manifest:'source-baseline/results/'+key,
    prepareOperation:'baseline-prepare-'+key,operation:'baseline-retain-'+key};};
  const indexKey=input=>'source-baseline/bindings/'+identity({binding,sourceBindingId:input.sourceBindingId});
  function metadata(kind,plan,content,previousIndexVersion=null){return sourceBaselineRecord(kind,{...binding,operationId:plan.input.operationId,
    sourceBindingId:plan.input.sourceBindingId,parametersSha256:plan.parametersSha256,content:contentReference(content),...(kind==='manifest'?{previousIndexVersion}:{})});}
  function verifyMetadata(kind,value,input){
    sourceBaselineValue(kind,value);
    if(Object.entries(binding).some(([key,expected])=>value[key]!==expected)||value.operationId!==input.operationId||value.sourceBindingId!==input.sourceBindingId
      ||!/^[a-f0-9]{64}$/u.test(value.parametersSha256??'')||contentReference(value.content).namespace!==(kind==='intent'?'runtime':'evidence'))throw error('The baseline has another request or authority binding.');
    if(kind==='manifest')namespaceRevision(value.previousIndexVersion);return value;
  }
  function transaction(plan,content,{intent=false,previousIndexVersion=null}={}){
    const k=keys(plan.input),namespace=intent?'runtime':'evidence',key=intent?k.intent:k.manifest;
    const preconditions=[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:plan.basis.authorityVersion},
      {namespace:'state',key:namespaceLifecycleStoryKey(workId,textDigests),version:plan.basis.headVersion},
      {namespace:'config',key:plan.basis.configuration.key,version:plan.basis.configurationVersion},{namespace,key,version:null}];
    const changes=[{op:'put',namespace,key,immutable:true,value:metadata(intent?'intent':'manifest',plan,content,previousIndexVersion)}];
    if(!intent){const key=indexKey(plan.input);preconditions.push({namespace:'evidence',key,version:previousIndexVersion});
      changes.push({op:'put',namespace:'evidence',key,immutable:false,value:sourceBaselineRecord('index',{...binding,sourceBindingId:plan.input.sourceBindingId,manifestKey:k.manifest})});}
    return namespaceTransaction({operationId:intent?k.prepareOperation:k.operation,preconditions,changes,events:[]},limits);
  }
  function receipt(value,tx){let receipt;
    try{receipt=namespaceJournalReceipt(value?.receipt,scope,tx.operationId);
      if(value.status!=='committed'||receipt.requestDigest!==hash(namespaceTransactionIdentity(scope,tx,limits))||receipt.eventIds.length
        ||receipt.records.length!==tx.changes.length||!tx.changes.every(change=>receipt.records.some(row=>row.namespace===change.namespace&&row.key===change.key&&namespaceRevision(row.version)!==null)))throw Error('Another receipt.');
    }catch(cause){throw error('The baseline receipt does not prove its exact conditional acceptance.','ENGINE_PORT_RESULT_INVALID',cause);}return receipt;
  }
  function index(value,input){sourceBaselineValue('index',value);
    if(Object.entries(binding).some(([key,expected])=>value[key]!==expected)||value.sourceBindingId!==input.sourceBindingId
      ||!/^source-baseline\/results\/[a-f0-9]{64}$/u.test(value.manifestKey??''))throw error('The baseline index has another binding.');return value;}
  return Object.freeze({binding,keys,indexKey,metadata,verifyMetadata,transaction,receipt,index});
}
