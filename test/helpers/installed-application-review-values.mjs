/** Pure installed values only: no image bytes, process or human-authority proof is synthesized. */
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {registerHooks} from 'node:module';
const captured=JSON.parse('__APPLICATION_REVIEW_ORACLE__'),unexpected=[],hook=registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('node:')){unexpected.push(specifier);throw Error('Unexpected application-review infrastructure: '+specifier);}return next(specifier,context);
}}),publicApi=await import('@sdk-name@/application-review'),
  bytes=Object.freeze({profile:'sflow-record-bytes/utf8-v1',isBytes:value=>Buffer.isBuffer(value)||value instanceof Uint8Array,decodeUtf8:value=>Buffer.from(value).toString('utf8')}),
  digests=Object.freeze({profile:'sflow-text-digests/sha256-utf8-v1',sha256Utf8:value=>createHash('sha256').update(value).digest('hex')}),
  values=publicApi.applicationReviewPolicies(bytes,digests),OriginalDate=Date;
__APPLICATION_REVIEW_CASES__

globalThis.Date=class extends OriginalDate{constructor(...arguments_){if(!arguments_.length)throw Error('Unexpected ambient clock.');super(...arguments_);}static now(){throw Error('Unexpected ambient clock.');}};
try{const observed=applicationReviewValueCapture(values);
  for(const expected of captured.cases)assert.deepEqual(observed.find(row=>row.id===expected.id),expected,expected.id);
  assert.equal(values.profile,publicApi.APPLICATION_REVIEW_VALUES_PROFILE);
  for(const name of ['publish','approve','execute','capture','accept'])assert.equal(Object.hasOwn(values,name),false);
  assert.deepEqual(unexpected,[]);
}finally{globalThis.Date=OriginalDate;hook.deregister();}
console.log(JSON.stringify({cases:captured.cases.length,infrastructure:unexpected.length}));
