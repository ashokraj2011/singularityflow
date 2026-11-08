import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonicalJson,NAMESPACE_APPROVAL_SCHEMAS} from '../src/foundation/record-schema.mjs';
import {namespaceApprovalValue} from '../src/engine-storage/namespace-approval-contract.mjs';
const capture=JSON.parse(await readFile(new URL('./fixtures/namespace-approval-packets/native-v1.json',import.meta.url),'utf8'));
test('actual pre-routing v1 human votes retain their exact immutable bytes, identities and receipt outcomes',()=>{
  assert.equal(capture.baseline,'0edf0e0bb');assert.equal(capture.cases.length,3);
  for(const entry of capture.cases) {
    const value=JSON.parse(entry.wire),binding={projectId:entry.projectId,workId:entry.workId,phaseId:entry.phaseId};
    assert.equal(namespaceApprovalValue(value,binding),value);assert.equal(canonicalJson(value),entry.wire);
    assert.equal(createHash('sha256').update(canonicalJson(value)).digest('hex'),entry.sha256);
    assert.equal(value.schemaVersion,1);assert.equal(Object.hasOwn(value,'routing'),false);
    assert.equal(entry.result.approval.actorId,value.actor.principalId);assert.equal(entry.result.approval.thresholdReached,value.thresholdReached);
    assert.equal(entry.result.currentPhase,value.currentPhase);
    assert.throws(()=>namespaceApprovalValue({...value,routing:null},binding),{code:'ENGINE_STORAGE_CORRUPT'});
    assert.throws(()=>namespaceApprovalValue({...value,schemaVersion:NAMESPACE_APPROVAL_SCHEMAS.vote.maximumReadableVersion+1},binding),
      error=>error.code==='ENGINE_STORAGE_UNSUPPORTED'&&error.cause.code==='SCHEMA_VERSION_FUTURE');
  }
});
