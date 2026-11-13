/** Phase-check metadata identities and conditional acceptance. Explicit text hashing; no I/O. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_PHASE_CHECK_SCHEMAS,namespacePhaseCheckPlanProfile,admitRecordSchemaVersion,textDigestCapability} from '../foundation/record-schema.mjs';
import {namespaceScope,namespaceIdentifier,namespaceIdentityJson,namespaceRevision,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {namespaceJournalReceipt} from '../sda/namespace/journal-contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-codec.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from './namespace-lifecycle-contract.mjs';
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
export const NAMESPACE_MIXED_CHECK_PROFILE='sflow-namespace-mixed-checks/v1';
export const NAMESPACE_PHASE_CHECK_PROFILE='sflow-namespace-phase-checks/v1';
const formats=Object.freeze(Object.fromEntries(Object.keys(NAMESPACE_PHASE_CHECK_SCHEMAS).map(kind=>[kind,'sflow-namespace-phase-check-'+kind+'/v1'])));
const fields=Object.freeze({
  plan:['profile','binding','input','parametersSha256','generation','draft','artifact','actor','basis','sources','steps'],
  result:['profile','plan','recordedAt','results','checks','verdict'],
  index:['projectId','workId','authorityId','epoch','manifestKey'],
  binding:['operationId','result','index'],
  intent:['projectId','workId','authorityId','epoch','phase','operationId','parametersSha256','content'],
  manifest:['projectId','workId','authorityId','epoch','phase','operationId','parametersSha256','content','previousIndexVersion']
});
export function phaseCheckRecord(kind,fields){const version=kind==='plan'&&fields.executionProfile?4:kind==='plan'&&fields.recovery?3:kind==='plan'&&fields.testCommands?2:1;return {schemaVersion:version,format:version===1?formats[kind]:'sflow-namespace-phase-check-plan/v'+version,...fields};}
export function phaseCheckRecordValue(kind,value) {
  try{admitRecordSchemaVersion(NAMESPACE_PHASE_CHECK_SCHEMAS[kind],value);
    const selected=kind==='plan'?namespacePhaseCheckPlanProfile(value):null,amended=selected?.commands;
    if(value.format!==(amended?selected.format:formats[kind]))throw Error('Another format.');exactObject(value,['schemaVersion','format',...fields[kind],...(amended?['testCommands']:[]),...(selected?.recovery?['recovery']:[]),...(selected?.mixed?['executionProfile']:[])]);
    if(selected?.mixed&&value.executionProfile!==NAMESPACE_MIXED_CHECK_PROFILE)throw Error('Another mixed-check execution contract.');
  }catch(cause){throw error('The phase-check record has another version or format.',
    ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
  return value;
}
export function phaseCheckEvidenceBinding(value) {
  phaseCheckRecordValue('binding',value);namespaceIdentifier(value.operationId,'Check operation ID');
  exactObject(value.result,['key','version','content']);exactObject(value.index,['key','version']);
  if(!/^phase-checks\/results\/[a-f0-9]{64}$/u.test(value.result.key??'')
    ||!/^phase-checks\/drafts\/[a-f0-9]{64}$/u.test(value.index.key??'')
    ||namespaceRevision(value.result.version)===null||namespaceRevision(value.index.version)===null
    ||contentReference(value.result.content,33_554_432).namespace!=='evidence')throw error('Invalid accepted check evidence binding.');
  return value;
}
export function createNamespacePhaseCheckCodec({scope,workId,authority,limits,textDigests}={}) {
  scope=namespaceScope(scope);namespaceIdentifier(workId,'Story ID');limits=namespaceLimits(limits);
  exactObject(authority,['id','epoch']);namespaceIdentifier(authority.id,'Authority ID');
  if(!Number.isSafeInteger(authority.epoch)||authority.epoch<1)throw error('Phase checks require an authority epoch.','ENGINE_INPUT_INVALID');
  const hash=textDigestCapability(textDigests).sha256Utf8,identity=value=>hash(namespaceIdentityJson(value));
  const binding=Object.freeze({projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch});
  const token=input=>identity({...binding,phase:input.phaseId,operationId:input.operationId});
  const keys=input=>{const key=token(input);return {intent:'phase-checks/intents/'+key,manifest:'phase-checks/results/'+key,
    prepareOperation:'check-prepare-'+key,operation:'check-record-'+key};};
  const indexKey=plan=>'phase-checks/drafts/'+identity({...binding,phase:plan.input.phaseId,generation:plan.generation,
    baseRevision:plan.basis.headVersion,draft:plan.draft});
  function metadata(kind,plan,reference,previousIndexVersion=null) {
    const input=plan.input;return phaseCheckRecord(kind,{...binding,phase:input.phaseId,operationId:input.operationId,
      parametersSha256:plan.parametersSha256,content:contentReference(reference),...(kind==='manifest'?{previousIndexVersion}: {})});
  }
  function verifyMetadata(kind,value,input) {
    phaseCheckRecordValue(kind,value);exactObject(value,['schemaVersion','format',...Object.keys(binding),'phase','operationId','parametersSha256','content',
      ...(kind==='manifest'?['previousIndexVersion']:[])]);
    if(Object.entries(binding).some(([key,wanted])=>value[key]!==wanted)||value.phase!==input.phaseId||value.operationId!==input.operationId
      ||!/^([a-f0-9]{64})$/u.test(value.parametersSha256??'')||contentReference(value.content).namespace!==(kind==='intent'?'runtime':'evidence'))
      throw error('The check record belongs to another operation.');
    if(kind==='manifest')namespaceRevision(value.previousIndexVersion);return value;
  }
  function conditions(plan) {return [
    {namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:plan.basis.authorityVersion},
    {namespace:'state',key:namespaceLifecycleStoryKey(workId,textDigests),version:plan.basis.headVersion},
    {namespace:'config',key:plan.basis.configuration.key,version:plan.basis.configurationVersion}];}
  function transaction(plan,reference,{intent=false,previousIndexVersion=null}={}) {
    const k=keys(plan.input),key=intent?k.intent:k.manifest,namespace=intent?'runtime':'evidence';
    const preconditions=[...conditions(plan),{namespace,key,version:null}],changes=[
      {op:'put',namespace,key,immutable:true,value:metadata(intent?'intent':'manifest',plan,reference,previousIndexVersion)}];
    if(!intent){const selected=indexKey(plan);preconditions.push({namespace:'evidence',key:selected,version:previousIndexVersion});
      changes.push({op:'put',namespace:'evidence',key:selected,immutable:false,value:phaseCheckRecord('index',{...binding,manifestKey:key})});}
    return namespaceTransaction({operationId:intent?k.prepareOperation:k.operation,preconditions,changes,events:[]},limits);
  }
  function receipt(value,tx) {
    let r;try{r=namespaceJournalReceipt(value?.receipt,scope,tx.operationId);
      if(value.status!=='committed'||r.requestDigest!==hash(namespaceTransactionIdentity(scope,tx,limits))||r.eventIds.length
        ||r.records.length!==tx.changes.length||!tx.changes.every(change=>r.records.some(row=>row.namespace===change.namespace&&row.key===change.key&&namespaceRevision(row.version)!==null)))throw Error('Another receipt.');
    }catch(cause){throw error('The check receipt does not prove this exact conditional acceptance.','ENGINE_PORT_RESULT_INVALID',{operationId:tx.operationId},cause);}
    return r;
  }
  function index(value){phaseCheckRecordValue('index',value);
    if(Object.entries(binding).some(([key,wanted])=>value[key]!==wanted)||!/^phase-checks\/results\/[a-f0-9]{64}$/u.test(value.manifestKey??''))
      throw error('The check index belongs to another binding.');return value;}
  return Object.freeze({binding,keys,indexKey,index,metadata,verifyMetadata,transaction,receipt});
}
