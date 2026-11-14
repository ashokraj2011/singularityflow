import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceCodePolicyProfile,namespaceCodeReportEvidenceProfile,namespaceCodeInputPolicyProfile,namespaceEvidenceReuseRecordProfile,
 namespaceTestRecoveryRecordProfile,namespaceExecutionPermissionProfile,namespaceEvidenceContextProfile} from '../src/foundation/record-schema.mjs';
import {namespaceTestRecoveryPolicies} from '../src/kernel/test-recovery.mjs';import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {normalizeTestRecoveryPolicy} from '../src/engine-compatibility/node-configuration-path.mjs';
test('Code reuse, inherited execution and recovery permission retain their own closed schema versions',()=>{
 for(const kind of ['record','context','policy','report']){
  assert.equal(namespaceEvidenceReuseRecordProfile(kind,{schemaVersion:2}).codeRecoveryReuse,undefined);
  assert.equal(namespaceEvidenceReuseRecordProfile(kind,{schemaVersion:3}).codeRecoveryReuse,true);
  assert.throws(()=>namespaceEvidenceReuseRecordProfile(kind,{schemaVersion:5}),{code:'SCHEMA_VERSION_FUTURE'});
 }
 for(const kind of ['agreement','context','contextValue']){
  assert.equal(namespaceTestRecoveryRecordProfile(kind,{schemaVersion:1}).qualifiedReuse,undefined);
  assert.equal(namespaceTestRecoveryRecordProfile(kind,{schemaVersion:2}).qualifiedReuse,true);
  assert.throws(()=>namespaceTestRecoveryRecordProfile(kind,{schemaVersion:4}),{code:'SCHEMA_VERSION_FUTURE'});
 }
 for(const kind of ['policy','report'])assert.equal(namespaceTestRecoveryRecordProfile(kind,{schemaVersion:3}).version,3);
 for(const kind of ['code','codeReport'])assert.equal(namespaceCodePolicyProfile(kind,{schemaVersion:39}).reusedExecution,true);
 for(const evidenceVersion of [1,7,12,18,24,30,34,35])assert.deepEqual(namespaceCodeReportEvidenceProfile({schemaVersion:39,evidenceVersion}),namespaceCodePolicyProfile('codeReport',{schemaVersion:evidenceVersion}));
 assert.equal(namespaceCodeInputPolicyProfile('codeInputReport',{schemaVersion:4}).reusedInputs,true);
 assert.equal(namespaceExecutionPermissionProfile({profile:'sflow-namespace-execution-permission/v2',kind:'evidence-reuse'}).fullExecution,true);
 assert.throws(()=>namespaceExecutionPermissionProfile({profile:'sflow-namespace-execution-permission/v1',kind:'evidence-reuse'}),{code:'ENGINE_INPUT_INVALID'});
 assert.equal(namespaceEvidenceContextProfile({schemaVersion:5}).version,5);assert.throws(()=>namespaceEvidenceContextProfile({schemaVersion:6}),{code:'SCHEMA_VERSION_FUTURE'});
});
test('the explicit qualified agreement changes its hash without changing the old full-command meaning',()=>{
 const rules=namespaceTestRecoveryPolicies(NODE_TEXT_DIGESTS),workflow={workItem:{id:'story'},phaseOrder:['build'],resolution:{testRecovery:{enabled:true,allowEvidenceReuse:true,
  reuseProfile:'environment-qualified-exact/v1',maxDistinctAutomaticAttempts:3}}},configuration={content:{sha256:'a'.repeat(64)}},commands=[{phaseId:'build',commands:[]}],
  old=rules.context(workflow,configuration,commands),qualified=rules.context(workflow,configuration,commands,null,{reuse:'environment-qualified-exact'});
 assert.equal(old.value.schemaVersion,1);assert.equal(old.value.reuse,'never');assert.equal(qualified.value.schemaVersion,2);assert.notEqual(old.sha256,qualified.sha256);
 for(const policy of [{...workflow.resolution.testRecovery,allowEvidenceReuse:false},{...workflow.resolution.testRecovery,reuseProfile:undefined}])
  assert.throws(()=>rules.context({...workflow,resolution:{testRecovery:policy}},configuration,commands,null,{reuse:'environment-qualified-exact'}),{code:'TEST_RECOVERY_REUSE_DISABLED'});
});
test('qualified reuse configuration is an explicit additive contract and preserves legacy refusals',()=>{
 const input={enabled:true,allowEvidenceReuse:true,reuseProfile:'environment-qualified-exact/v1'},before=structuredClone(input),policy=normalizeTestRecoveryPolicy(input);
 assert.deepEqual(input,before);assert.equal(policy.reuseProfile,input.reuseProfile);assert.equal(policy.allowEvidenceReuse,true);assert.equal(policy.maxEvidenceAgeSeconds,86400);
 assert.throws(()=>normalizeTestRecoveryPolicy({enabled:true,allowEvidenceReuse:true}),{code:'TRP_EVIDENCE_REUSE_UNAVAILABLE'});
 assert.equal(Object.hasOwn(normalizeTestRecoveryPolicy({enabled:true}),'reuseProfile'),false);
 for(const patch of [{enabled:false},{allowEvidenceReuse:false},{reuseProfile:'future/v2'},{maxEvidenceAgeSeconds:0}])
  assert.throws(()=>normalizeTestRecoveryPolicy({...input,...patch}),{code:'TRP_POLICY_INVALID'});
});
