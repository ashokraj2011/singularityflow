import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import * as native from '../src/plan-row-corrections.mjs';
import {EvidenceAmendmentSchema} from '../src/plan-evidence-amendments.mjs';
import {planCorrectionPolicies,planCorrectionRecordShapes} from '../src/kernel/plan-corrections.mjs';
import {parseRecordShape} from '../src/foundation/record-shapes.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {normalizeClaimMapReplay} from '../src/engine-compatibility/node-specification-policy.mjs';
import {NODE_TEXT_DIGESTS,recordSha256} from '../src/records.mjs';
import {presencePinKey,registerPersonCounts,forgetPersonCounts} from '../src/presence/counted.mjs';
import {planCorrectionValueCases,planCorrectionValueOutcome} from './helpers/plan-correction-values-fixture.mjs';
const oracle=JSON.parse(await readFile(new URL('./fixtures/plan-correction-values/native-v1.json',import.meta.url),'utf8')),
  policies=planCorrectionPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS),normalizeRow=(id,raw,clauseIds)=>{
    const replay=normalizeClaimMapReplay({claims:{[id]:raw}},{kind:'planned',clauseIds});let step=replay.next();
    while(!step.done)step=replay.next('2026-10-12T01:00:00.000Z');return step.value.claims[id];
  },shared={...policies,recordSha256,normalizeRow},compatibility={...native,recordSha256,normalizeRow};
test('the correction oracle is an independent native capture with fixed input cases',()=>{
  assert.equal(oracle.capturedAtCommit,'d56597560');assert.equal(oracle.cases.length,49);
  assert.deepEqual(oracle.cases.map(({outcome,...input})=>input),planCorrectionValueCases());
});
for(const entry of oracle.cases)test('plan/evidence value compatibility: '+entry.name,()=>{
  assert.deepEqual(planCorrectionValueOutcome(shared,entry),entry.outcome,'pure owner');
  assert.deepEqual(planCorrectionValueOutcome(compatibility,entry),entry.outcome,'native facade');
});
test('public native schema APIs share the same structural values as the pure readers',()=>{
  const shapes=planCorrectionRecordShapes();assert.ok(Object.isFrozen(shapes.row.operations));
  for(const entry of oracle.cases.filter(row=>row.outcome.status==='returned')){
    const base=entry.outcome.decision,shape=entry.evidence?shapes.evidence:shapes.row,schema=entry.evidence?EvidenceAmendmentSchema:native.PlanRowCorrectionSchema;
    for(const candidate of [base,{...base,unknown:true},{...base,ownerGeneration:0},{...base,ownerGeneration:1.5},{...base,ownerPhase:''},
      {...base,at:'not-a-date'},{...base,at:'2026-02-29T00:00:00Z'},{...base,at:'2026-10-12T24:00:00Z'},
      {...base,at:'2026-10-12T01:00Z'},{...base,at:'2026-10-12T01:00:00.000000Z'},
      {...base,authorizationId:'invalid'},{...base,reason:'short'},{...base,presence:{signature:'actual-value'}}]){
      const expected=schema.safeParse(candidate),actual=parseRecordShape(shape,candidate);
      assert.equal(actual.success,expected.success,entry.name+': '+JSON.stringify(candidate));
      if(actual.success)assert.deepEqual(actual.data,expected.data);
    }
  }
});
test('native adapters still count signed-person records before applying or listing corrections',()=>{
  const original=oracle.cases.find(row=>row.name==='replace-location').outcome,record=structuredClone(original.result);
  record.claims['PLAN-VALUES:AC-001'].expectedPaths=['src/old.mjs'];
  const workflow={workItem:{id:'PLAN-VALUES'},resolution:{presence:{status:'required'}},phases:{planning:{approvalPolicy:{authorities:['reviewers']},claimMaps:{planned:{sha256:recordSha256(record)}}}},
    planAmendments:[structuredClone(original.decision)]};
  try{
    assert.deepEqual(native.planRowCorrections(workflow),[]);assert.equal(native.applyPlanCorrections(record,workflow),record);
    registerPersonCounts(presencePinKey(workflow),()=>false);assert.deepEqual(native.planRowCorrections(workflow),[]);
    registerPersonCounts(presencePinKey(workflow),()=>true);assert.equal(native.planRowCorrections(workflow).length,1);
    assert.deepEqual(native.applyPlanCorrections(record,workflow),original.result);
    assert.equal(policies.applyPlanCorrections(record,workflow,{},[]),record,'pure readers use the explicitly admitted inventory');
  }finally{forgetPersonCounts();}
});
