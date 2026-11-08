import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createNamespaceLifecycleCodec} from '../src/engine-storage/namespace-lifecycle-codec.mjs';
import {namespaceLifecycleStoryKey} from '../src/engine-storage/namespace-lifecycle-reader.mjs';
import {TEXT_DIGEST_PROFILE} from '../src/foundation/record-schema.mjs';
const original=JSON.parse(await readFile(new URL('./fixtures/namespace-lifecycle-packets/native-v1.json',import.meta.url),'utf8'));
test('pre-extraction publish, submit and approve transactions retain their exact v1 manifests and receipt digests',()=>{
  assert.equal(original.baseline,'8c0047454');assert.deepEqual(original.operations.map(item=>item.intent.value.operation),['phase.publish','phase.submit','phase.approve']);
  const codec=createNamespaceLifecycleCodec({...original,textDigests:NODE_TEXT_DIGESTS});
  for(const operation of original.operations){const plan=operation.intent.value;
    assert.equal(codec.requestDigest(codec.transaction(plan)),plan.requestDigest);
    assert.equal(codec.requestDigest(codec.prepareTransaction(plan)),operation.prepared.receipt.requestDigest);
    assert.deepEqual(codec.manifest(plan),operation.manifest.value);
    assert.deepEqual(codec.receipt(operation.prepared,plan,codec.prepareTransaction(plan)),operation.prepared.receipt);
    assert.deepEqual(codec.receipt(operation.committed,plan),operation.committed.receipt);
  }
});
for(const field of ['operationId','scope','revision','requestDigest','records','eventIds'])test('lifecycle receipt validation preserves rejection of altered '+field,()=>{
  const codec=createNamespaceLifecycleCodec({...original,textDigests:NODE_TEXT_DIGESTS}),{intent,committed}=original.operations[0],changed=structuredClone(committed);
  changed.receipt[field]=field==='scope'?{projectId:'another-project'}:field==='records'||field==='eventIds'?[]:null;
  assert.throws(()=>codec.receipt(changed,intent.value),error=>error.code==='ENGINE_PORT_RESULT_INVALID');
});
test('the portable codec requires an explicit digest capability while legacy Story key imports retain their native signature',()=>{
  assert.throws(()=>createNamespaceLifecycleCodec(original),{code:'ENGINE_TEXT_DIGEST_PORT_INVALID'});
  assert.throws(()=>createNamespaceLifecycleCodec({...original,textDigests:Object.freeze({profile:TEXT_DIGEST_PROFILE,sha256Utf8(){return 'invalid';}})}),
    {code:'ENGINE_TEXT_DIGEST_RESULT_INVALID'});
  for(const workId of [original.workId,'team/story-Δ'])assert.equal(createNamespaceLifecycleCodec({...original,workId,textDigests:NODE_TEXT_DIGESTS}).headKey,
    namespaceLifecycleStoryKey(workId));
});
