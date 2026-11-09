/** Conditional source-control acceptance; independent of source-byte and lifecycle records. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_SOURCE_CONTROL_SCHEMAS,namespaceSourceControlRecordProfile,textDigestCapability} from '../foundation/record-schema.mjs';
import {namespaceScope,namespaceIdentifier,namespaceIdentityJson,namespaceRevision,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {namespaceJournalReceipt} from '../sda/namespace/journal-contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {sourceControlReaderDescriptor} from '../foundation/source-control.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-codec.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from './namespace-lifecycle-contract.mjs';
export const NAMESPACE_SOURCE_CONTROL_PROFILE='sflow-namespace-source-control/v1';
export const NAMESPACE_SOURCE_CONTROL_PROFILE_V2='sflow-namespace-source-control/v2';
const formats=Object.freeze(Object.fromEntries(Object.keys(NAMESPACE_SOURCE_CONTROL_SCHEMAS).map(kind=>[kind,'sflow-namespace-source-control-'+kind+'/v1'])));
const fields=Object.freeze({plan:['profile','binding','input','parametersSha256','actor','basis','generation','draft','source','observations'],
  result:['profile','plan','recordedAt','repositories','totals'],index:['projectId','workId','authorityId','epoch','manifestKey'],
  intent:['projectId','workId','authorityId','epoch','phase','operationId','parametersSha256','content'],
  manifest:['projectId','workId','authorityId','epoch','phase','operationId','parametersSha256','content','previousIndexVersion']});
const error=(message,code='ENGINE_STORAGE_CORRUPT',cause=undefined)=>new SingularityFlowError(message,{code,cause});
export function sourceControlRecord(kind,value,version=1){return {schemaVersion:version,format:formats[kind].replace('/v1','/v'+version),...value};}
export function sourceControlValue(kind,value){try{const profile=namespaceSourceControlRecordProfile(kind,value);
  exactObject(value,['schemaVersion','format',...fields[kind],...(kind==='plan'&&profile.origins?['origins']:[])]);if(value.format!==profile.format)throw Error('Another source-control format.');
  if(kind==='plan'&&profile.origins){
    if(!Array.isArray(value.origins)||!value.origins.length||value.origins.length>32||!Array.isArray(value.observations)||!value.observations.length||value.observations.length>32)throw Error('Another origin repository set.');
    const ids=new Set();for(const row of value.origins){
      exactObject(row,['id','origin','baseline']);namespaceIdentifier(row.id);if(ids.has(row.id))throw Error('Duplicate repository origins.');ids.add(row.id);
      for(const proof of [row.origin,row.baseline]){
        exactObject(proof,['sourceBindingId','operationId','result','index']);namespaceIdentifier(proof.sourceBindingId);namespaceIdentifier(proof.operationId);
        exactObject(proof.result,['key','version','content']);exactObject(proof.index,['key','version']);
        if(!/^source-baseline\/results\/[a-f0-9]{64}$/u.test(proof.result.key??'')||!/^source-baseline\/bindings\/[a-f0-9]{64}$/u.test(proof.index.key??'')
          ||namespaceRevision(proof.result.version)===null||namespaceRevision(proof.index.version)===null||contentReference(proof.result.content).namespace!=='evidence')throw Error('Another archive read binding.');
      }
    }
    for(const row of value.observations){exactObject(row,['id','reader','revision','content']);namespaceIdentifier(row.id);sourceControlReaderDescriptor(row.reader);
      if(!/^sha256:[a-f0-9]{64}$/u.test(row.revision??'')||contentReference(row.content).namespace!=='runtime')throw Error('Another origin observation binding.');}
  }
}catch(cause){throw error('The source-control record has another version or format.',
  ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause);}return value;}
export function createNamespaceSourceControlCodec({scope,workId,authority,limits,textDigests}={}){
  scope=namespaceScope(scope);namespaceIdentifier(workId);limits=namespaceLimits(limits);exactObject(authority,['id','epoch']);namespaceIdentifier(authority.id);
  if(!Number.isSafeInteger(authority.epoch)||authority.epoch<1)throw error('Source-control evidence requires an authority epoch.','ENGINE_INPUT_INVALID');
  const hash=textDigestCapability(textDigests).sha256Utf8,identity=value=>hash(namespaceIdentityJson(value));
  const binding=Object.freeze({projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch});
  const keys=input=>{const id=identity({binding,input});return {intent:'source-control/intents/'+id,manifest:'source-control/results/'+id,
    prepareOperation:'control-prepare-'+id,operation:'control-retain-'+id};};
  const indexKey=plan=>'source-control/drafts/'+identity({binding,phase:plan.input.phaseId,generation:plan.generation,
    baseRevision:plan.basis.headVersion,draft:plan.draft});
  function metadata(kind,plan,content,previousIndexVersion=null){return sourceControlRecord(kind,{...binding,phase:plan.input.phaseId,
    operationId:plan.input.operationId,parametersSha256:plan.parametersSha256,content:contentReference(content),...(kind==='manifest'?{previousIndexVersion}:{})},plan.schemaVersion);}
  function verifyMetadata(kind,value,input){sourceControlValue(kind,value);
    if(Object.entries(binding).some(([key,expected])=>value[key]!==expected)||value.phase!==input.phaseId||value.operationId!==input.operationId
      ||!/^[a-f0-9]{64}$/u.test(value.parametersSha256??'')||contentReference(value.content).namespace!==(kind==='intent'?'runtime':'evidence'))throw error('The source-control record has another operation or authority binding.');
    if(kind==='manifest')namespaceRevision(value.previousIndexVersion);return value;}
  function transaction(plan,content,{intent=false,previousIndexVersion=null}={}){
    const k=keys(plan.input),namespace=intent?'runtime':'evidence',key=intent?k.intent:k.manifest;
    const preconditions=[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:plan.basis.authorityVersion},
      {namespace:'state',key:namespaceLifecycleStoryKey(workId,textDigests),version:plan.basis.headVersion},
      {namespace:'config',key:plan.basis.configuration.key,version:plan.basis.configurationVersion},
      {namespace:'evidence',key:plan.source.result.key,version:plan.source.result.version},
      {namespace:'evidence',key:plan.source.index.key,version:plan.source.index.version},{namespace,key,version:null}];
    if(namespaceSourceControlRecordProfile('plan',plan).origins){
      const seen=new Map(preconditions.map(row=>[row.namespace+'\0'+row.key,row.version]));
      for(const row of plan.origins)for(const proof of [row.origin,row.baseline])for(const read of [proof.result,proof.index]){
        const key='evidence\0'+read.key;if(seen.has(key)){if(seen.get(key)!==read.version)throw error('Origin archives have inconsistent conditional read versions.');continue;}
        seen.set(key,read.version);preconditions.push({namespace:'evidence',key:read.key,version:read.version});
      }
    }
    const changes=[{op:'put',namespace,key,immutable:true,value:metadata(intent?'intent':'manifest',plan,content,previousIndexVersion)}];
    if(!intent){const selected=indexKey(plan);preconditions.push({namespace:'evidence',key:selected,version:previousIndexVersion});
      changes.push({op:'put',namespace:'evidence',key:selected,immutable:false,value:sourceControlRecord('index',{...binding,manifestKey:key},plan.schemaVersion)});}
    return namespaceTransaction({operationId:intent?k.prepareOperation:k.operation,preconditions,changes,events:[]},limits);
  }
  function receipt(value,tx){try{const receipt=namespaceJournalReceipt(value?.receipt,scope,tx.operationId);
    if(value.status!=='committed'||receipt.requestDigest!==hash(namespaceTransactionIdentity(scope,tx,limits))||receipt.eventIds.length
      ||receipt.records.length!==tx.changes.length||!tx.changes.every(change=>receipt.records.some(row=>row.namespace===change.namespace&&row.key===change.key&&namespaceRevision(row.version)!==null)))throw Error('Another receipt.');return receipt;
  }catch(cause){throw error('The source-control receipt does not prove its conditional acceptance.','ENGINE_PORT_RESULT_INVALID',cause);}}
  function index(value){sourceControlValue('index',value);if(Object.entries(binding).some(([key,expected])=>value[key]!==expected)
    ||!/^source-control\/results\/[a-f0-9]{64}$/u.test(value.manifestKey??''))throw error('The source-control index has another binding.');return value;}
  return Object.freeze({binding,keys,indexKey,metadata,verifyMetadata,transaction,receipt,index});
}
