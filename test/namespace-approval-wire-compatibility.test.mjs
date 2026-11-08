import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonicalJson,NAMESPACE_APPROVAL_SCHEMAS} from '../src/foundation/record-schema.mjs';
import {namespaceApprovalValue,namespaceApprovalRecord} from '../src/engine-storage/namespace-approval-contract.mjs';
import {namespaceRoutingQuestionKey} from '../src/engine-storage/namespace-approval-reader.mjs';
const capture=JSON.parse(await readFile(new URL('./fixtures/namespace-approval-packets/native-v1.json',import.meta.url),'utf8'));
test('actual pre-routing v1 human votes retain their exact immutable bytes, identities and receipt outcomes',()=>{
  assert.equal(capture.baseline,'0edf0e0bb');assert.equal(capture.cases.length,3);
  for(const entry of capture.cases) {
    const value=JSON.parse(entry.wire),binding={projectId:entry.projectId,workId:entry.workId,phaseId:entry.phaseId};
    assert.equal(namespaceApprovalValue(value,binding),value);assert.equal(canonicalJson(value),entry.wire);
    const {schemaVersion,format,profile,...data}=value;
    assert.equal(canonicalJson(namespaceApprovalRecord(data)),entry.wire);
    assert.equal(createHash('sha256').update(canonicalJson(value)).digest('hex'),entry.sha256);
    assert.equal(value.schemaVersion,1);assert.equal(Object.hasOwn(value,'routing'),false);
    assert.equal(entry.result.approval.actorId,value.actor.principalId);assert.equal(entry.result.approval.thresholdReached,value.thresholdReached);
    assert.equal(entry.result.currentPhase,value.currentPhase);
    assert.throws(()=>namespaceApprovalValue({...value,routing:null},binding),{code:'ENGINE_STORAGE_CORRUPT'});
    assert.throws(()=>namespaceApprovalValue({...value,schemaVersion:2},binding),{code:'ENGINE_STORAGE_CORRUPT'});
    assert.throws(()=>namespaceApprovalValue({...value,schemaVersion:NAMESPACE_APPROVAL_SCHEMAS.vote.maximumReadableVersion+1},binding),
      error=>error.code==='ENGINE_STORAGE_UNSUPPORTED'&&error.cause.code==='SCHEMA_VERSION_FUTURE');
  }
});
test('actual original routed votes retain their bytes and native question identity after generation-bound questions are added',async()=>{
  const old=JSON.parse(await readFile(new URL('./fixtures/namespace-approval-packets/routed-v1.json',import.meta.url),'utf8'));
  assert.equal(old.baseline,'5edd773af');
  assert.equal(namespaceApprovalValue(old.value,{projectId:old.scope.projectId,workId:old.workId,phaseId:old.phase}),old.value);
  assert.equal(canonicalJson(old.value),old.canonicalBytes);
  assert.equal(createHash('sha256').update(old.canonicalBytes).digest('hex'),old.reference.sha256);
  const {key,...question}=old.pending;
  assert.equal(namespaceRoutingQuestionKey(question,1,1),key);assert.equal(namespaceRoutingQuestionKey(question,2,1),key);
  assert.notEqual(namespaceRoutingQuestionKey(question,1,2),namespaceRoutingQuestionKey(question,2,2));
});
