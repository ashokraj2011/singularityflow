/** Conditional evidence acceptance, distinct from canonical lifecycle publication. No I/O. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {SOURCE_CONTENT_MAXIMUM_CHUNKS} from '../foundation/source-snapshot.mjs';
import {NAMESPACE_SOURCE_RETENTION_SCHEMAS,admitRecordSchemaVersion,textDigestCapability} from '../foundation/record-schema.mjs';
import {namespaceScope,namespaceIdentifier,namespaceIdentityJson,namespaceRevision,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {namespaceJournalReceipt} from '../sda/namespace/journal-contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-codec.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from './namespace-lifecycle-contract.mjs';
export const NAMESPACE_SOURCE_RETENTION_PROFILE='sflow-namespace-source-retention/v1';
export const SOURCE_RETENTION_MAXIMUM_CHUNKS=SOURCE_CONTENT_MAXIMUM_CHUNKS;
const error=(message,code='ENGINE_STORAGE_CORRUPT',cause=undefined)=>new SingularityFlowError(message,{code,cause});
const formats=Object.freeze(Object.fromEntries(Object.keys(NAMESPACE_SOURCE_RETENTION_SCHEMAS).map(kind=>[kind,'sflow-namespace-source-retention-'+kind+'/v1'])));
const fields=Object.freeze({
  plan:['profile','binding','input','parametersSha256','generation','draft','artifact','actor','basis','generationIntent','sourceBinding','sources'],
  result:['profile','plan','recordedAt','repositories','totals'],
  repository:['profile','plan','id','baselineRevision','observedRevision','selection','policy','totals','roles','protectedChanges','boundaryViolations','entries'],
  index:['projectId','workId','authorityId','epoch','manifestKey'],
  binding:['operationId','result','index'],
  intent:['projectId','workId','authorityId','epoch','phase','operationId','parametersSha256','content'],
  manifest:['projectId','workId','authorityId','epoch','phase','operationId','parametersSha256','content','previousIndexVersion']
});
export function sourceRetentionRecord(kind,value){return {schemaVersion:1,format:formats[kind],...value};}
export function sourceRetentionValue(kind,value) {
  try{admitRecordSchemaVersion(NAMESPACE_SOURCE_RETENTION_SCHEMAS[kind],value);
    if(value.format!==formats[kind])throw Error('Another source-retention format.');
    exactObject(value,['schemaVersion','format',...fields[kind]]);
  }catch(cause){throw error('The retained source record has another version or format.',
    ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause);}
  return value;
}
export function sourceRetentionBinding(value){
  sourceRetentionValue('binding',value);namespaceIdentifier(value.operationId,'Source-retention operation');
  exactObject(value.result,['key','version','content']);exactObject(value.index,['key','version']);
  if(!/^source-retention\/results\/[a-f0-9]{64}$/u.test(value.result.key??'')
    ||!/^source-retention\/drafts\/[a-f0-9]{64}$/u.test(value.index.key??'')
    ||namespaceRevision(value.result.version)===null||namespaceRevision(value.index.version)===null
    ||contentReference(value.result.content).namespace!=='evidence')throw error('The retained source binding is invalid.');
  return value;
}
export function createNamespaceSourceRetentionCodec({scope,workId,authority,limits,textDigests}={}) {
  scope=namespaceScope(scope);namespaceIdentifier(workId,'Story ID');limits=namespaceLimits(limits);
  exactObject(authority,['id','epoch']);namespaceIdentifier(authority.id,'Authority ID');
  if(!Number.isSafeInteger(authority.epoch)||authority.epoch<1)throw error('Source retention needs an authority epoch.','ENGINE_INPUT_INVALID');
  const hash=textDigestCapability(textDigests).sha256Utf8,identity=value=>hash(namespaceIdentityJson(value));
  const binding=Object.freeze({projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch});
  const token=input=>identity({...binding,phase:input.phaseId,operationId:input.operationId});
  const keys=input=>{const key=token(input);return {intent:'source-retention/intents/'+key,manifest:'source-retention/results/'+key,
    prepareOperation:'source-prepare-'+key,operation:'source-retain-'+key};};
  const indexKey=plan=>'source-retention/drafts/'+identity({...binding,phase:plan.input.phaseId,generation:plan.generation,
    baseRevision:plan.basis.headVersion,draft:plan.draft});
  function metadata(kind,plan,content,previousIndexVersion=null) {
    return sourceRetentionRecord(kind,{...binding,phase:plan.input.phaseId,operationId:plan.input.operationId,
      parametersSha256:plan.parametersSha256,content:contentReference(content),...(kind==='manifest'?{previousIndexVersion}:{})});
  }
  function verifyMetadata(kind,value,input) {
    sourceRetentionValue(kind,value);
    if(Object.entries(binding).some(([key,expected])=>value[key]!==expected)||value.phase!==input.phaseId||value.operationId!==input.operationId
      ||!/^[a-f0-9]{64}$/u.test(value.parametersSha256??'')||contentReference(value.content).namespace!==(kind==='intent'?'runtime':'evidence')) {
      throw error('The source record has another operation or authority binding.');
    }
    if(kind==='manifest')namespaceRevision(value.previousIndexVersion);return value;
  }
  function transaction(plan,content,{intent=false,previousIndexVersion=null}={}) {
    const k=keys(plan.input),key=intent?k.intent:k.manifest,namespace=intent?'runtime':'evidence';
    const preconditions=[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:plan.basis.authorityVersion},
      {namespace:'state',key:namespaceLifecycleStoryKey(workId,textDigests),version:plan.basis.headVersion},
      {namespace:'config',key:plan.basis.configuration.key,version:plan.basis.configurationVersion},{namespace,key,version:null}];
    const changes=[{op:'put',namespace,key,immutable:true,value:metadata(intent?'intent':'manifest',plan,content,previousIndexVersion)}];
    if(!intent){const selected=indexKey(plan);preconditions.push({namespace:'evidence',key:selected,version:previousIndexVersion});
      changes.push({op:'put',namespace:'evidence',key:selected,immutable:false,value:sourceRetentionRecord('index',{...binding,manifestKey:key})});}
    return namespaceTransaction({operationId:intent?k.prepareOperation:k.operation,preconditions,changes,events:[]},limits);
  }
  function receipt(value,tx) {
    let receipt;
    try{receipt=namespaceJournalReceipt(value?.receipt,scope,tx.operationId);
      if(value.status!=='committed'||receipt.requestDigest!==hash(namespaceTransactionIdentity(scope,tx,limits))||receipt.eventIds.length
        ||receipt.records.length!==tx.changes.length||!tx.changes.every(change=>receipt.records.some(row=>row.namespace===change.namespace&&row.key===change.key&&namespaceRevision(row.version)!==null)))throw Error('Another receipt.');
    }catch(cause){throw error('The source receipt does not prove this exact conditional acceptance.','ENGINE_PORT_RESULT_INVALID',cause);}
    return receipt;
  }
  function index(value){sourceRetentionValue('index',value);
    if(Object.entries(binding).some(([key,expected])=>value[key]!==expected)||!/^source-retention\/results\/[a-f0-9]{64}$/u.test(value.manifestKey??''))throw error('The source index has another binding.');
    return value;
  }
  return Object.freeze({binding,keys,indexKey,index,metadata,verifyMetadata,transaction,receipt});
}
