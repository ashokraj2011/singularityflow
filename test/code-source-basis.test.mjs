import test from 'node:test';import assert from 'node:assert/strict';
import {codeSourceBasis,CODE_SOURCE_BASIS_PROFILE} from '../src/kernel/code-delivery-evidence.mjs';
import {namespaceCodeDeliveryPreflightReplay,codeDeliveryPreflightReplay} from '../src/engine-compatibility/node-source-policy.mjs';
import {acceptanceTagBindings} from '../src/kernel/specification-policy.mjs';
import {requiredAcceptanceFromPlan,mergedVerificationContracts} from '../src/engine-compatibility/node-specification-policy.mjs';
const workflow={workItem:{id:'example'},phases:{},resolution:{}},phase={id:'custom-code',generation:0,generationPolicy:{task:'code'},writeScope:'source-and-artifact'},
  basis={profile:CODE_SOURCE_BASIS_PROFILE,workId:'example',phase:'custom-code',generation:1,repositoryId:'app',sourceBindingId:'selected-source',generationIntentId:'generation-one',
    baselineRevision:'sha256:'+'a'.repeat(64),currentRevision:'sha256:'+'b'.repeat(64)};
test('namespace source identity needs an exact generation, explicit immutable revisions and data properties',()=>{
  assert.ok(Object.isFrozen(codeSourceBasis(basis,workflow,phase)));
  for(const change of [{ready:true},{generation:2},{workId:'other'},{baselineRevision:'main'},{currentRevision:null},{profile:'future/v9'}])
    assert.throws(()=>codeSourceBasis({...basis,...change},workflow,phase),{code:'ENGINE_SOURCE_BASIS_INVALID'});
  let called=false;const invalid={...basis};Object.defineProperty(invalid,'profile',{enumerable:true,get(){called=true;return basis.profile;}});
  assert.throws(()=>codeSourceBasis(invalid,workflow,phase),{code:'ENGINE_SOURCE_BASIS_INVALID'});assert.equal(called,false);
});
test('portable preflight asks for original source proof and never asks for a Git work interval',()=>{
  const replay=namespaceCodeDeliveryPreflightReplay({},workflow,phase,{sourceBasis:basis});
  assert.equal(replay.next().value.kind,'verify-source-generation');const request=replay.next().value;
  assert.equal(request.kind,'working-change-set');assert.equal(request.baseCommit,null);assert.deepEqual(request.sourceBasis,basis);
  assert.equal(request.subject.generationIntentId,'generation-one');
  const native=codeDeliveryPreflightReplay({},workflow,phase);assert.equal(native.next().value.kind,'prepare-local-exclusions');assert.equal(native.next().value.kind,'verify-work-interval');
  const failure=Object.assign(Error('Actual source receipt is unavailable.'),{code:'EACCES'}),blocked=namespaceCodeDeliveryPreflightReplay({},workflow,phase,{sourceBasis:basis});blocked.next();
  assert.throws(()=>blocked.throw(failure),error=>error===failure);
});
test('acceptance allocation shares required-tag semantics and stable occurrence ordering',()=>{
  const claims={'SPEC:AC-001':{tests:['test/a.js'],steps:['other']},'SPEC:AC-002':{testDisposition:'not-applicable'},'SPEC:AC-003':{tests:['test/b.js']}},
    contracts=mergedVerificationContracts([{verificationContracts:[{clauseId:'SPEC:AC-004',slots:[{method:'visual',role:'primary'}]}]}]);
  assert.deepEqual(requiredAcceptanceFromPlan(Object.keys(claims).concat('SPEC:AC-004'),claims,contracts,'custom-code'),['SPEC:AC-003']);
  const tags=acceptanceTagBindings([{clauseId:'SPEC:AC-003',testSource:'test/z.js',line:5},{clauseId:'SPEC:AC-003',testSource:'test/a.js',line:3},
    {clauseId:'SPEC:AC-003',testSource:'test/a.js',line:2}]);
  assert.equal(tags.bindings.length,2);assert.deepEqual(tags.locations.map(row=>row.line),[2,3,5]);assert.deepEqual(tags.ids,['SPEC:AC-003']);
});
