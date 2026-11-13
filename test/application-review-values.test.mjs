import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import * as native from '../src/application-review-contract.mjs';
import {applicationReviewPolicies,APPLICATION_REVIEW_VALUES_PROFILE} from '../src/kernel/application-review.mjs';
import {NODE_RECORD_BYTES,NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {applicationReviewValueCapture} from './helpers/application-review-values-fixture.mjs';
const captured=JSON.parse(await readFile(new URL('./fixtures/engine-application-review-values/native-v1.json',import.meta.url),'utf8')),
  rules=applicationReviewPolicies(NODE_RECORD_BYTES,NODE_TEXT_DIGESTS),nativeCases=applicationReviewValueCapture(native),portableCases=applicationReviewValueCapture(rules);
for(const expected of captured.cases)test('application-review original value compatibility: '+expected.id,()=>{
  assert.deepEqual(nativeCases.find(row=>row.id===expected.id),expected);
  assert.deepEqual(portableCases.find(row=>row.id===expected.id),expected);
});
test('application-review values expose rules and require frozen syntax primitives, without authenticating evidence or decisions',()=>{
  assert.equal(rules.profile,APPLICATION_REVIEW_VALUES_PROFILE);assert.equal(Object.isFrozen(rules),true);
  for(const name of ['publish','approve','execute','capture','accept'])assert.equal(Object.hasOwn(rules,name),false);
  let invoked=0;const forged=Object.freeze({...NODE_RECORD_BYTES,readRecord(){invoked++;return {approved:true};}});
  assert.throws(()=>applicationReviewPolicies(forged,NODE_TEXT_DIGESTS),{code:'ENGINE_RECORD_BYTES_PORT_INVALID'});
  assert.equal(invoked,0);assert.equal(captured.capturedFrom,'29a9e6f11');assert.equal(captured.cases.length,85);
});
