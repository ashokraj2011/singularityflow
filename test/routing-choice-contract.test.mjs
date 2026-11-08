/** Wire validation only; these detached records do not constitute a human choice or accepted receipt. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canonicalJson,NAMESPACE_ROUTING_CHOICE_SCHEMAS} from '../src/foundation/record-schema.mjs';
import {namespaceRoutingChoiceRecord,namespaceRoutingChoiceValue,namespaceRoutingChoiceReceipt,namespaceRoutingChoiceReceiptValue,
  namespaceRoutingChoiceReceipts} from '../src/engine-storage/namespace-routing-choice-contract.mjs';
const captured=JSON.parse(await readFile(new URL('./fixtures/namespace-approval-packets/routed-v1.json',import.meta.url),'utf8'));
function proposal() {
  const vote=captured.value,request={option:'continue',to:null,expected:captured.pending.key,reason:'The human selected the reviewed route.'};
  const value=namespaceRoutingChoiceRecord({projectId:vote.projectId,workId:vote.workId,phase:vote.phase,generation:vote.generation,
    operationId:'choice-fixture',requestSha256:'a'.repeat(64),baseRevision:vote.baseRevision,configuration:structuredClone(vote.configuration),
    question:{key:captured.pending.key,approval:structuredClone(captured.reference)},request,actor:structuredClone(vote.actor),agentId:null,
    authorityGroup:vote.authorityGroup,recordedAt:vote.recordedAt,outcome:{decision:'direction',label:'Choose delivery',after:vote.phase,
      kind:'next',route:'continue',routeLabel:'Continue',target:'review',skipped:[],values:null,maxRounds:3,by:'person'},currentPhase:'review'});
  return {value,scope:{projectId:vote.projectId,workId:vote.workId}};
}
test('a human choice has one explicit frozen wire profile and a scope-bound receipt link',()=>{
  const {value,scope}=proposal(),before=canonicalJson(value);
  assert.equal(namespaceRoutingChoiceValue(value,scope),value);assert.equal(canonicalJson(value),before);
  const receipt=namespaceRoutingChoiceReceipt(value,captured.reference);
  assert.equal(namespaceRoutingChoiceReceiptValue(receipt,scope),receipt);assert.equal(receipt.pendingKey,value.question.key);
  assert.equal(namespaceRoutingChoiceReceipts({namespaceRoutingChoiceReceipts:[receipt]},scope).length,1);
  assert.deepEqual(namespaceRoutingChoiceReceipts({},scope),[]);
});
test('malformed identity, question, intent, target and wire metadata are rejected',()=>{
  const {value,scope}=proposal();
  for(const change of [v=>v.actor.actorKind='agent',v=>v.question.approval.namespace='local',v=>v.request.expected='b'.repeat(16),
    v=>v.request.reason=' ',v=>v.request.to='review',v=>v.outcome.by='rule',v=>v.outcome.after='other',v=>v.currentPhase=42,
    v=>v.outcome.target=null,v=>v.generation=0,v=>v.ready=true,v=>v.profile='other',v=>v.request.confirmed=true]) {
    const other=structuredClone(value);change(other);assert.throws(()=>namespaceRoutingChoiceValue(other,scope),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  const {schemaVersion,format,profile,...data}=value;
  for(const field of ['schemaVersion','format','profile'])assert.throws(()=>namespaceRoutingChoiceRecord({...data,[field]:'caller'}),{code:'ENGINE_INPUT_INVALID'});
});
test('choice inventories reject null, duplicate questions, duplicate operations and changed scopes',()=>{
  const {value,scope}=proposal(),receipt=namespaceRoutingChoiceReceipt(value,captured.reference);
  for(const values of [null,{},[receipt,structuredClone(receipt)],[receipt,{...receipt,operationId:'another'}],
    [receipt,{...receipt,pendingKey:'b'.repeat(16)}]])assert.throws(
      ()=>namespaceRoutingChoiceReceipts({namespaceRoutingChoiceReceipts:values},scope),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.throws(()=>namespaceRoutingChoiceReceiptValue({...receipt,workId:'another'},scope),{code:'ENGINE_STORAGE_CORRUPT'});
});
test('future choice and receipt schemas retain their unsupported-version meaning',()=>{
  const {value,scope}=proposal(),receipt=namespaceRoutingChoiceReceipt(value,captured.reference);
  assert.throws(()=>namespaceRoutingChoiceValue({...value,schemaVersion:NAMESPACE_ROUTING_CHOICE_SCHEMAS.record.maximumReadableVersion+1},scope),{
    code:'ENGINE_STORAGE_UNSUPPORTED'});
  assert.throws(()=>namespaceRoutingChoiceReceipts({namespaceRoutingChoiceReceipts:[{...receipt,schemaVersion:2}]},scope),{code:'ENGINE_STORAGE_UNSUPPORTED'});
});
