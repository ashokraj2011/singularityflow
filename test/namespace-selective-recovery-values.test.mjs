import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceSelectiveTestRecoveryPolicies} from '../src/kernel/test-recovery.mjs';import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {admitRecordSchemaVersion,NAMESPACE_SELECTIVE_TEST_RECOVERY_CONTEXT_SCHEMA,SELECTIVE_CHECK_SUMMARY_SCHEMA,NODE_CHECK_ENVIRONMENT_OBSERVATION_SCHEMA,namespacePhaseCheckPlanProfile,namespaceCodePolicyProfile,namespaceCodeInputPolicyProfile,namespaceEvidenceReuseRecordProfile,namespaceTestRecoveryRecordProfile} from '../src/foundation/record-schema.mjs';
import {namespaceReuseEnvironment} from '../src/kernel/evidence-reuse.mjs';
const rules=namespaceSelectiveTestRecoveryPolicies(NODE_TEXT_DIGESTS),
  command={argv:['node','--test','--test-reporter=junit','test/one.js','test/two.js'],result:{adapter:'junit-xml',minimumDiscovered:2,minimumPassed:2}},
  declaration={adapter:'node-test-junit-v1',dependencyScope:'repository-and-node-builtins-only',tests:[{id:'one',path:'test/one.js',name:'one'},{id:'two',path:'test/two.js',name:'two'}]};
test('whole-file selection preserves the independent inventory and explicitly discloses unexecuted cases',()=>{
  const narrowed=rules.narrow(command,declaration,['test/one.js']);assert.deepEqual(narrowed.selectedIds,['one']);assert.deepEqual(narrowed.excludedIds,['two']);
  assert.deepEqual(narrowed.inventoryIds,['one','two']);assert.equal(narrowed.impactComplete,false);assert.equal(narrowed.failuresWaived,false);
  assert.deepEqual(narrowed.argv,['node','--test','--test-reporter=junit','test/one.js']);assert.equal(narrowed.effectiveMinimums.minimumDiscovered,1);
  assert.throws(()=>rules.narrow(command,declaration,['test/one.js'],{requiredFiles:['test/two.js']}),{code:'SELECTIVE_TEST_REQUIRED_FILE_EXCLUDED'});
});
test('no patterns, arbitrary argv, empty or ambiguous inventories may become an execution selection',()=>{
  for(const files of [[],new Array(1),['../escape'],['/absolute'],['test/*.js'],['test/one.js','test/one.js'],['-selector']])
    assert.throws(()=>rules.selection([{repositoryId:'app',commandId:'tests',files}]),{code:'SELECTIVE_TEST_RECOVERY_INVALID'});
  const original={repositoryId:'app',commandId:'tests',files:['test/one.js']};
  assert.throws(()=>rules.selection([original,original]),{code:'SELECTIVE_TEST_RECOVERY_INVALID'});
  assert.throws(()=>rules.selection(new Array(1)),{code:'SELECTIVE_TEST_RECOVERY_INVALID'});
  let reads=0;assert.throws(()=>rules.selection([{...original,get files(){reads++;return ['test/one.js'];}}]),{code:'SELECTIVE_TEST_RECOVERY_INVALID'});assert.equal(reads,0);
  for(const argv of [['npm','test'],['node','--test','--test-name-pattern=one','test/one.js'],['node','--test','--test-reporter=junit','--require=override','test/one.js']])
    assert.throws(()=>rules.narrow({...command,argv},declaration,['test/one.js']));
});
test('new record meanings have separate closed versions and leave the old agreement and check profiles intact',()=>{
  assert.deepEqual(namespacePhaseCheckPlanProfile({schemaVersion:3}),{version:3,format:'sflow-namespace-phase-check-plan/v3',commands:true,recovery:true});
  assert.equal(namespacePhaseCheckPlanProfile({schemaVersion:5,recovery:{}}).selective,true);assert.equal(namespacePhaseCheckPlanProfile({schemaVersion:5,recovery:{}}).mixed,undefined);
  assert.throws(()=>namespacePhaseCheckPlanProfile({schemaVersion:6}),{code:'SCHEMA_VERSION_FUTURE'});
  assert.equal(namespaceCodePolicyProfile('code',{schemaVersion:38}).selectiveRecovery,true);assert.throws(()=>namespaceCodePolicyProfile('code',{schemaVersion:39}),{code:'SCHEMA_VERSION_FUTURE'});
  assert.equal(namespaceCodeInputPolicyProfile('codeInputReport',{schemaVersion:3}).selectiveInputs,true);assert.throws(()=>namespaceCodeInputPolicyProfile('codeInputReport',{schemaVersion:4}),{code:'SCHEMA_VERSION_FUTURE'});
  for(const kind of ['record','context','policy','report']){assert.equal(namespaceEvidenceReuseRecordProfile(kind,{schemaVersion:1}).version,1);assert.equal(namespaceEvidenceReuseRecordProfile(kind,{schemaVersion:2}).version,2);
    assert.equal(namespaceEvidenceReuseRecordProfile(kind,{schemaVersion:1}).environmentQualified,undefined);assert.equal(namespaceEvidenceReuseRecordProfile(kind,{schemaVersion:2}).environmentQualified,true);
    assert.throws(()=>namespaceEvidenceReuseRecordProfile(kind,{schemaVersion:3}),{code:'SCHEMA_VERSION_FUTURE'});}
  for(const schema of [NAMESPACE_SELECTIVE_TEST_RECOVERY_CONTEXT_SCHEMA,SELECTIVE_CHECK_SUMMARY_SCHEMA,NODE_CHECK_ENVIRONMENT_OBSERVATION_SCHEMA]){
    assert.equal(admitRecordSchemaVersion(schema,{schemaVersion:1}).storedVersion,1);assert.throws(()=>admitRecordSchemaVersion(schema,{schemaVersion:2}),{code:'SCHEMA_VERSION_FUTURE'});}
  assert.equal(namespaceTestRecoveryRecordProfile('agreement',{schemaVersion:1}).version,1);assert.throws(()=>namespaceTestRecoveryRecordProfile('agreement',{schemaVersion:2}),{code:'SCHEMA_VERSION_FUTURE'});
});
test('environment equality is exact for the actual runtime and environment while ignoring device-local report paths',()=>{
  const command={executableSha256:'sha256:'+'1'.repeat(64),environmentSha256:'sha256:'+'2'.repeat(64),argumentsSha256:'sha256:'+'3'.repeat(64)},
    qualification={profile:'sflow-node-check-environment/v1',hostId:'actual-host',platform:'darwin',arch:'arm64',runtimeSha256:command.executableSha256,environmentSha256:command.environmentSha256,
      reportRoot:{grammar:'posix',absolute:'/old-checkout'}},before=namespaceReuseEnvironment(qualification,command);
  assert.deepEqual(namespaceReuseEnvironment({...qualification,reportRoot:{grammar:'posix',absolute:'/another-checkout'}},command),before);
  assert.notDeepEqual(namespaceReuseEnvironment({...qualification,hostId:'another-host'},command),before);
  assert.throws(()=>namespaceReuseEnvironment({...qualification,runtimeSha256:'sha256:'+'4'.repeat(64)},command),{code:'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_REQUIRED'});
});

test('closing votes and later views share the same requirement for an actual final evaluation',async()=>{
  const {namespaceTerminalEvaluationRequired}=await import('../src/kernel/approval-policy.mjs');
  assert.equal(namespaceTerminalEvaluationRequired({phases:{}}),false);
  for(const key of ['namespaceObligationRisks','namespaceKnownTestRisks','namespaceTestCohorts','namespaceSelectiveTestRecoveries'])
    assert.equal(namespaceTerminalEvaluationRequired({phases:{},[key]:[{id:'original-record'}]}),true);
  assert.equal(namespaceTerminalEvaluationRequired({phases:{}},{newWitnessReview:true}),true);
  assert.equal(namespaceTerminalEvaluationRequired({phases:{build:{approvals:[{witnessMappings:[{id:'reviewed'}]}]}}}),true);
});

test('qualified reporter roots use their retained Windows or POSIX grammar without reading this host',async()=>{
  const {qualifiedCheckReportLocation,qualifiedCheckReportRoot}=await import('../src/sgos/node-execution-values.mjs');
  assert.equal(qualifiedCheckReportLocation('C:\\work\\repo\\test\\one.js',{grammar:'win32',absolute:'C:\\work\\repo'}),'test/one.js');
  assert.equal(qualifiedCheckReportLocation('/work/repo/test/one.js',{grammar:'posix',absolute:'/work/repo'}),'test/one.js');
  assert.equal(qualifiedCheckReportLocation('C:\\other\\one.js',{grammar:'win32',absolute:'C:\\work\\repo'}),null);
  assert.equal(qualifiedCheckReportLocation('/work/outside/one.js',{grammar:'posix',absolute:'/work/repo'}),null);
  assert.equal(qualifiedCheckReportRoot({grammar:'unknown',absolute:'/work/repo'}),false);
});
