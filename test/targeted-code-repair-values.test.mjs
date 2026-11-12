import test from 'node:test';import assert from 'node:assert/strict';
import {targetedCodeRepairScope,assertTargetedCodeRepairDelta} from '../src/kernel/conformance-decisions.mjs';
const phaseId='repair-service',index={clauses:['SPEC:REQ-001','SPEC:REQ-002'].map(id=>({id}))},
  selected={expectedPaths:['src/selected.js'],tests:['test/shared.test.js'],steps:[phaseId]},other={expectedPaths:['src/other.js'],tests:['test/shared.test.js'],steps:[phaseId]},
  input={phaseId,clauseIds:['SPEC:REQ-001'],indexes:[index],repositories:[{id:'service-a',claims:{'SPEC:REQ-001':selected,'SPEC:REQ-002':other}},
    {id:'service-b',claims:{'SPEC:REQ-002':other}}]};
test('exact reviewed rows disclose shared tests and keep equal path names in another repository outside the repair',()=>{
  const scope=targetedCodeRepairScope(input);assert.deepEqual(scope.repositories,[{id:'service-a',paths:['src/selected.js','test/shared.test.js'],shared:[{path:'test/shared.test.js',clauseIds:['SPEC:REQ-002']}]},
    {id:'service-b',paths:[],shared:[]}]);
  assert.equal(assertTargetedCodeRepairDelta(scope,[{id:'service-a',changes:[{path:'src/selected.js'},{path:'test/shared.test.js'}]},{id:'service-b',changes:[]}],{}),2);
  for(const [id,path]of [['service-a','src/other.js'],['service-b','src/selected.js']])assert.throws(()=>assertTargetedCodeRepairDelta(scope,[{id,changes:[{path}]}],{workId:'story',phaseId}),
    error=>error.code==='ENGINE_TARGETED_REPAIR_SCOPE_EXCEEDED'&&error.details.outside[0].repositoryId===id&&error.details.actions[1].requiredInputs.includes('operations'));
});
test('unknown, duplicate, unallocated and nonliteral locations cannot silently create an unrestricted repair',()=>{
  assert.throws(()=>targetedCodeRepairScope({...input,clauseIds:['SPEC:REQ-999']}),{code:'ENGINE_REPAIR_CLAUSE_UNKNOWN'});
  assert.throws(()=>targetedCodeRepairScope({...input,clauseIds:['SPEC:REQ-001','SPEC:REQ-001']}),{code:'ENGINE_REPAIR_CLAUSE_INVALID'});
  assert.throws(()=>targetedCodeRepairScope({...input,phaseId:'different-service'}),{code:'ENGINE_REPAIR_LOCATION_REQUIRED'});
  assert.throws(()=>targetedCodeRepairScope({...input,repositories:[{id:'service-a',claims:{'SPEC:REQ-001':{...selected,expectedPaths:['src/**']}}}]}),{code:'ENGINE_REPAIR_LOCATION_REQUIRED'});
});
test('repository ordering is deterministic without a host locale and duplicate repositories are refused',()=>{
  const scope=targetedCodeRepairScope({...input,repositories:['service-a','service-Z'].map(id=>({id,claims:{'SPEC:REQ-001':selected}}))});
  assert.deepEqual(scope.repositories.map(row=>row.id),['service-Z','service-a']);
  assert.throws(()=>targetedCodeRepairScope({...input,repositories:[input.repositories[0],input.repositories[0]]}),{code:'ENGINE_REPAIR_SCOPE_INVALID'});
});
