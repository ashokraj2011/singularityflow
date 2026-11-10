/** Conditional output records. These transactions never update the lifecycle head. No I/O. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_OUTPUT_RETENTION_SCHEMAS,admitRecordSchemaVersion,textDigestCapability} from '../foundation/record-schema.mjs';
import {PHASE_OUTPUT_LIMITS,phaseOutputPathKey} from '../kernel/phase-outputs.mjs';
import {namespaceScope,namespaceIdentifier,namespaceIdentityJson,namespaceRevision,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {namespaceJournalReceipt} from '../sda/namespace/journal-contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-codec.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from './namespace-lifecycle-contract.mjs';
export const NAMESPACE_OUTPUT_RETENTION_PROFILE='sflow-namespace-output-retention/v1';
const fields={plan:['profile','binding','input','parametersSha256','selection','draft','artifact','actor','basis','source'],
  result:['profile','plan','recordedAt','content'],index:['projectId','workId','authorityId','epoch','phase','generation','entries'],
  binding:['operationId','result','index'],intent:['projectId','workId','authorityId','epoch','phase','operationId','parametersSha256','content'],
  manifest:['projectId','workId','authorityId','epoch','phase','operationId','parametersSha256','content','previousIndex']};
const error=(message,code='ENGINE_STORAGE_CORRUPT',cause=undefined)=>new SingularityFlowError(message,{code,cause});
export function outputRetentionRecord(kind,value){return {schemaVersion:1,format:'sflow-namespace-output-retention-'+kind+'/v1',...value};}
export function outputRetentionValue(kind,value){try{admitRecordSchemaVersion(NAMESPACE_OUTPUT_RETENTION_SCHEMAS[kind],value);
    exactObject(value,['schemaVersion','format',...fields[kind]]);
    if(value.format!=='sflow-namespace-output-retention-'+kind+'/v1')throw Error('Another output format.');
  }catch(cause){throw error('The retained output has an invalid or unsupported record.',
    ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause);}return value;}
export function outputRetentionBinding(value){outputRetentionValue('binding',value);namespaceIdentifier(value.operationId);
  exactObject(value.result,['key','version','content']);exactObject(value.index,['key','version']);
  if(!/^output-retention\/results\/[a-f0-9]{64}$/u.test(value.result.key??'')||!/^output-retention\/generations\/[a-f0-9]{64}$/u.test(value.index.key??'')
    ||namespaceRevision(value.result.version)===null||namespaceRevision(value.index.version)===null
    ||contentReference(value.result.content).namespace!=='evidence')throw error('The retained output binding is invalid.');return value;}
export function createNamespaceOutputRetentionCodec({scope,workId,authority,limits,textDigests}={}){
  scope=namespaceScope(scope);namespaceIdentifier(workId);limits=namespaceLimits(limits);exactObject(authority,['id','epoch']);namespaceIdentifier(authority.id);
  if(!Number.isSafeInteger(authority.epoch)||authority.epoch<1)throw error('Output retention needs an actual authority epoch.','ENGINE_INPUT_INVALID');
  const hash=textDigestCapability(textDigests).sha256Utf8,identity=value=>hash(namespaceIdentityJson(value)),
    binding=Object.freeze({projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch}),
    token=input=>identity({...binding,phase:input.phaseId,operationId:input.operationId}),
    keys=input=>{const id=token(input);return {intent:'output-retention/intents/'+id,manifest:'output-retention/results/'+id,
      prepareOperation:'output-prepare-'+id,operation:'output-retain-'+id};},
    indexKey=selection=>'output-retention/generations/'+identity({...binding,phase:selection.phase,generation:selection.generation});
  function index(value){outputRetentionValue('index',value);namespaceIdentifier(value.phase);
    if(Object.entries(binding).some(([key,expected])=>value[key]!==expected)||!Number.isSafeInteger(value.generation)||value.generation<1
      ||!Array.isArray(value.entries)||!value.entries.length||value.entries.length>PHASE_OUTPUT_LIMITS.files)throw error('The output index has another scope or exceeds its bound.');
    const paths=new Set();for(const row of value.entries){exactObject(row,['path','manifestKey']);
      if(typeof row.path!=='string'||paths.has(phaseOutputPathKey(row.path))||!/^output-retention\/results\/[a-f0-9]{64}$/u.test(row.manifestKey??''))throw error('The output index repeats or substitutes a file.');paths.add(phaseOutputPathKey(row.path));}return value;}
  function metadata(kind,plan,content,previousIndex=null){return outputRetentionRecord(kind,{...binding,phase:plan.input.phaseId,
    operationId:plan.input.operationId,parametersSha256:plan.parametersSha256,content:contentReference(content),...(kind==='manifest'?{previousIndex}:{})});}
  function verifyMetadata(kind,value,input){outputRetentionValue(kind,value);
    if(Object.entries(binding).some(([key,expected])=>value[key]!==expected)||value.phase!==input.phaseId||value.operationId!==input.operationId
      ||!/^[a-f0-9]{64}$/u.test(value.parametersSha256??'')||contentReference(value.content).namespace!==(kind==='intent'?'runtime':'evidence'))throw error('The output metadata names another request or authority.');
    if(kind==='manifest'&&value.previousIndex!==null){exactObject(value.previousIndex,['version','value']);
      if(namespaceRevision(value.previousIndex.version)===null)throw error('The output index lost its prior revision.');index(value.previousIndex.value);}return value;}
  function transaction(plan,content,{intent=false,previousIndex=null}={}){
    const k=keys(plan.input),namespace=intent?'runtime':'evidence',key=intent?k.intent:k.manifest,
      preconditions=[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:plan.basis.authorityVersion},
        {namespace:'state',key:namespaceLifecycleStoryKey(workId,textDigests),version:plan.basis.headVersion},
        {namespace:'config',key:plan.basis.configuration.key,version:plan.basis.configurationVersion},{namespace,key,version:null}],
      changes=[{op:'put',namespace,key,immutable:true,value:metadata(intent?'intent':'manifest',plan,content,previousIndex)}];
    if(!intent){const selected=indexKey(plan.selection),prior=previousIndex?.value;
      if(prior&&(index(prior).phase!==plan.selection.phase||prior.generation!==plan.selection.generation))throw error('The previous output index belongs to another generation.');
      const entries=[...(prior?.entries??[]).filter(row=>row.path!==plan.input.path),{path:plan.input.path,manifestKey:key}].sort((a,b)=>a.path.localeCompare(b.path,'en')),
        value=outputRetentionRecord('index',{...binding,phase:plan.selection.phase,generation:plan.selection.generation,entries});index(value);
      preconditions.push({namespace:'evidence',key:selected,version:previousIndex?.version??null});changes.push({op:'put',namespace:'evidence',key:selected,immutable:false,value});}
    return namespaceTransaction({operationId:intent?k.prepareOperation:k.operation,preconditions,changes,events:[]},limits);
  }
  function receipt(value,tx){try{const receipt=namespaceJournalReceipt(value?.receipt,scope,tx.operationId);
      if(value.status!=='committed'||receipt.requestDigest!==hash(namespaceTransactionIdentity(scope,tx,limits))||receipt.eventIds.length
        ||receipt.records.length!==tx.changes.length||!tx.changes.every(change=>receipt.records.some(row=>row.namespace===change.namespace&&row.key===change.key&&namespaceRevision(row.version)!==null)))throw Error('Another receipt.');return receipt;
    }catch(cause){throw error('The output receipt does not prove its exact conditional acceptance.','ENGINE_PORT_RESULT_INVALID',cause);}}
  return Object.freeze({binding,keys,indexKey,index,metadata,verifyMetadata,transaction,receipt});
}
