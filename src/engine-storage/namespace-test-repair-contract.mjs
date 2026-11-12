/** Conditional reservation and result envelopes. No execution or storage implementation. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,textDigestCapability,NAMESPACE_TEST_RECOVERY_SCHEMAS,admitRecordSchemaVersion} from '../foundation/record-schema.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {namespaceJournalReceipt} from '../sda/namespace/journal-contract.mjs';
import {namespaceScope,namespaceIdentifier,namespaceRevision,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-codec.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from './namespace-lifecycle-contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
const fail=(message,cause=null)=>{throw new SingularityFlowError(message,{code:'ENGINE_STORAGE_CORRUPT',cause});};
export function testRepairInput(value){
  exactObject(value,['operationId','workId','phaseId','failedOperationId']);
  for(const field of Object.keys(value))namespaceIdentifier(value[field],field);return value;
}
export function testRepairRecord(kind,value){
  admitRecordSchemaVersion(NAMESPACE_TEST_RECOVERY_SCHEMAS[kind],value);
  if(value.profile!=='sflow-namespace-test-repair-'+kind+'/v1')fail('The test-repair record has another profile.');return value;
}
export function createNamespaceTestRepairCodec({scope,workId,authority,limits,textDigests}){
  scope=namespaceScope(scope);namespaceIdentifier(workId);const hash=textDigestCapability(textDigests).sha256Utf8,
    binding={projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch},digest=value=>hash(canonicalJson(value)),
    token=input=>digest({...binding,operationId:input.operationId}),keys=input=>{const id=token(input);return {intent:'test-repair/attempts/'+id,
      result:'test-repair/results/'+id,reservation:'repair-reserve-'+id,completion:'repair-complete-'+id};};
  const indexKey=plan=>'test-repair/budgets/'+digest({...binding,phaseId:plan.input.phaseId,generation:plan.generation,agreement:plan.repair.agreement});
  const conditions=plan=>[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:plan.basis.authorityVersion},
    {namespace:'state',key:namespaceLifecycleStoryKey(workId,textDigests),version:plan.basis.headVersion},
    {namespace:'config',key:plan.basis.configuration.key,version:plan.basis.configurationVersion}];
  function transaction(plan,reference,{result=false}={}){
    const k=keys(plan.input),budget=indexKey(plan),key=result?k.result:k.intent;
    const changes=[{op:'put',namespace:result?'evidence':'runtime',key,immutable:true,value:{schemaVersion:1,
      profile:result?'sflow-namespace-test-repair-result-reference/v1':'sflow-namespace-test-repair-attempt-reference/v1',
      ...binding,operationId:plan.input.operationId,phaseId:plan.input.phaseId,parametersSha256:plan.parametersSha256,content:contentReference(reference)}}];
    const preconditions=[...conditions(plan),{namespace:result?'evidence':'runtime',key,version:null}];
    if(!result){preconditions.push({namespace:'runtime',key:budget,version:plan.previous.version});
      changes.push({op:'put',namespace:'runtime',key:budget,immutable:false,value:{schemaVersion:1,profile:'sflow-namespace-test-repair-budget/v1',...binding,
        attempts:[...plan.previous.attempts,{operationId:plan.input.operationId,record:contentReference(reference)}]}});}
    return namespaceTransaction({operationId:result?k.completion:k.reservation,preconditions,changes,events:[]},limits);
  }
  function receipt(value,tx){
    try{const found=namespaceJournalReceipt(value?.receipt,scope,tx.operationId);
      if(value.status!=='committed'||found.requestDigest!==hash(namespaceTransactionIdentity(scope,tx,limits))||found.eventIds.length
        ||found.records.length!==tx.changes.length||!tx.changes.every(change=>found.records.some(row=>row.namespace===change.namespace&&row.key===change.key&&namespaceRevision(row.version)!==null)))
        throw Error('Another transaction receipt.');return found;
    }catch(cause){fail('The repair has no exact conditional acknowledgement.',cause);}
  }
  function metadata(value,plan,reference,result=false){const expected=transaction(plan,reference,{result}).changes[0].value;
    if(canonicalJson(value)!==canonicalJson(expected))fail('The repair record differs from its original reservation.');return value;}
  function budget(value){admitRecordSchemaVersion(NAMESPACE_TEST_RECOVERY_SCHEMAS.budget,value);exactObject(value,['schemaVersion','profile',...Object.keys(binding),'attempts']);
    if(value.profile!=='sflow-namespace-test-repair-budget/v1'||!Object.entries(binding).every(([key,v])=>value[key]===v)
      ||!Array.isArray(value.attempts)||value.attempts.length>3)fail('The repair budget has another Story binding.');
    const seen=new Set();for(const row of value.attempts){exactObject(row,['operationId','record']);namespaceIdentifier(row.operationId);
      if(seen.has(row.operationId)||contentReference(row.record).namespace!=='runtime')fail('Invalid or duplicate repair attempt.');seen.add(row.operationId);}return value.attempts;}
  return Object.freeze({binding,keys,indexKey,conditions,transaction,receipt,metadata,budget,digest});
}
