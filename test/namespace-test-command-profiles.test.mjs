import test from 'node:test';import assert from 'node:assert/strict';
import {namespacePhaseCheckPlanProfile,namespaceStoryCommandRecordProfile,namespaceTestRecoveryRecordProfile} from '../src/foundation/record-schema.mjs';
import {phaseCheckRecord,phaseCheckRecordValue} from '../src/engine-storage/namespace-phase-check-contract.mjs';
test('configured-only and human-command check plans retain distinct exact wire contracts',()=>{
  const fields={profile:'sflow-namespace-phase-checks/v1',binding:{},input:{},parametersSha256:'a'.repeat(64),generation:1,draft:{},artifact:{},actor:{},basis:{},sources:[],steps:[]},
    original=phaseCheckRecord('plan',fields),amended=phaseCheckRecord('plan',{...fields,testCommands:{profile:'sflow-namespace-story-command/v1'}});
  assert.equal(namespacePhaseCheckPlanProfile(original).commands,false);assert.equal(namespacePhaseCheckPlanProfile(amended).commands,true);
  assert.equal(phaseCheckRecordValue('plan',original),original);assert.equal(phaseCheckRecordValue('plan',amended),amended);
  assert.throws(()=>phaseCheckRecordValue('plan',{...original,testCommands:amended.testCommands}),{code:'ENGINE_STORAGE_CORRUPT'});
  const {testCommands,...missing}=amended;assert.throws(()=>phaseCheckRecordValue('plan',missing),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.throws(()=>phaseCheckRecordValue('plan',{...amended,format:original.format}),{code:'ENGINE_STORAGE_CORRUPT'});
});
test('Story command context and replacement versions reject unknown future meanings',()=>{
  for(const kind of ['context','replacement']){const profile=namespaceStoryCommandRecordProfile(kind,{schemaVersion:1});assert.ok(Object.isFrozen(profile));
    assert.equal(profile.version,1);assert.match(profile.format,/\/v1$/u);
    assert.throws(()=>namespaceStoryCommandRecordProfile(kind,{schemaVersion:2}),{code:'SCHEMA_VERSION_FUTURE'});}
  assert.throws(()=>namespacePhaseCheckPlanProfile({schemaVersion:7}),{code:'SCHEMA_VERSION_FUTURE'});
});

test('recovery records and conditional budgets have central, closed schema meanings',()=>{
  for(const kind of ['agreement','context','policy','report','attempt','result','budget']){
    const profile=namespaceTestRecoveryRecordProfile(kind,{schemaVersion:1});assert.equal(profile.version,1);assert.ok(Object.isFrozen(profile));
    assert.throws(()=>namespaceTestRecoveryRecordProfile(kind,{schemaVersion:['policy','report'].includes(kind)?7:['agreement','context','contextValue'].includes(kind)?4:2}),{code:'SCHEMA_VERSION_FUTURE'});
    assert.throws(()=>namespaceTestRecoveryRecordProfile(kind,{schemaVersion:0}),{code:'SCHEMA_VERSION_MISSING'});
  }
  assert.throws(()=>namespaceTestRecoveryRecordProfile('invented',{schemaVersion:1}),{code:'SCHEMA_FAMILY_UNKNOWN'});
});
test('mixed commands have their own check plan and cannot alter the old configured/command/recovery meanings',()=>{
  const base={profile:'sflow-namespace-phase-checks/v1',binding:{},input:{},parametersSha256:'a'.repeat(64),generation:1,draft:{},artifact:{},actor:{},basis:{},sources:[],steps:[],testCommands:{receipts:[]}},
    mixed=phaseCheckRecord('plan',{...base,executionProfile:'sflow-namespace-mixed-checks/v1'});
  assert.equal(mixed.schemaVersion,4);assert.equal(namespacePhaseCheckPlanProfile(mixed).mixed,true);assert.equal(namespacePhaseCheckPlanProfile(mixed).recovery,undefined);
  assert.equal(phaseCheckRecordValue('plan',mixed),mixed);
  assert.throws(()=>phaseCheckRecordValue('plan',{...mixed,schemaVersion:2,format:'sflow-namespace-phase-check-plan/v2'}),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.throws(()=>phaseCheckRecordValue('plan',{...mixed,executionProfile:'another-contract'}),{code:'ENGINE_STORAGE_CORRUPT'});
  const recovery=phaseCheckRecord('plan',{...mixed,recovery:{agreementSha256:'actual-agreement'}});
  assert.equal(namespacePhaseCheckPlanProfile(recovery).recovery,true);assert.equal(phaseCheckRecordValue('plan',recovery),recovery);
});
