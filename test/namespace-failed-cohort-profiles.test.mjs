import test from 'node:test';import assert from 'node:assert/strict';
import {admitRecordSchemaVersion,NAMESPACE_TEST_COHORT_SCHEMAS,NAMESPACE_KNOWN_TEST_RISK_SCHEMAS,namespaceCodePolicyProfile,
 namespaceCodeInputPolicyProfile,namespaceConformancePolicyProfile,namespaceTestRiskRecordProfile,namespaceTestRecoveryRecordProfile,
 namespaceCodeExecutionRiskEvidenceAllowed,namespaceTestCohortRecordProfile} from '../src/foundation/record-schema.mjs';
import {namespaceTestCohortPolicies,namespaceTestCohortReviewInput} from '../src/kernel/test-recovery.mjs';import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
test('selected failure profiles are explicit while original full-run risk records retain their exact versions',()=>{
 for(const kind of ['code','codeReport'])for(const version of [43,44]){
  const p=namespaceCodePolicyProfile(kind,{schemaVersion:version});assert.equal(p.combinedRisk,true);assert.equal(p.executionRisk,true);assert.equal(p.selectiveRecovery,true);
  assert.equal(p.knownFailureRisk===true,version===44);assert.equal(namespaceCodeExecutionRiskEvidenceAllowed(p,1),true);
  assert.equal(namespaceCodeExecutionRiskEvidenceAllowed(p,34),true);assert.equal(namespaceCodeExecutionRiskEvidenceAllowed(p,44),false);
 }
 for(const kind of ['record','context','policy','report']){
  const full=namespaceTestRiskRecordProfile(kind,{schemaVersion:1,profile:'sflow-namespace-known-test-run-risk/v1'});assert.equal(full.version,1);assert.equal(full.selectedExecution,undefined);
  const selected=['policy','report'].includes(kind);assert.equal(NAMESPACE_KNOWN_TEST_RISK_SCHEMAS[kind].maximumReadableVersion,selected?2:1);
  if(selected)assert.equal(namespaceTestRiskRecordProfile(kind,{schemaVersion:2,profile:'sflow-namespace-known-test-risk-policy/v2'}).selectedExecution,true);
  assert.throws(()=>namespaceTestRiskRecordProfile(kind,{schemaVersion:selected?3:2,profile:'sflow-namespace-known-test-run-risk/v1'}),{code:'SCHEMA_VERSION_FUTURE'});
 }
 for(const kind of ['policy','report'])assert.equal(namespaceTestRecoveryRecordProfile(kind,{schemaVersion:6}).version,6);
 for(const kind of ['decision','context','policy','report']){
  const family=NAMESPACE_TEST_COHORT_SCHEMAS[kind],original={schemaVersion:1,data:'immutable'};
  assert.equal(admitRecordSchemaVersion(family,original).record,original);assert.equal(family.maximumReadableVersion,['policy','report'].includes(kind)?3:2);
  assert.equal(namespaceTestCohortRecordProfile(kind,original).executionBinding,undefined);
  const next=namespaceTestCohortRecordProfile(kind,{schemaVersion:['policy','report'].includes(kind)?3:2});
  assert.equal(next.executionBinding===true,['decision','context'].includes(kind));assert.equal(next.combinedExecution===true,['policy','report'].includes(kind));
  assert.throws(()=>admitRecordSchemaVersion(family,{schemaVersion:family.maximumReadableVersion+1}),{code:'SCHEMA_VERSION_FUTURE'});
 }
 const unversioned={data:'original pure context'};assert.equal(namespaceTestCohortRecordProfile('contextValue',unversioned).version,1);
 assert.deepEqual(unversioned,{data:'original pure context'});assert.throws(()=>namespaceTestCohortRecordProfile('context',unversioned),{code:'SCHEMA_VERSION_MISSING'});
});
test('downstream environment and selected known failures cannot be confused with earlier passing or reused profiles',()=>{
 for(const kind of ['codeInputs','codeInputReport']){
  const env=namespaceCodeInputPolicyProfile(kind,{schemaVersion:6}),known=namespaceCodeInputPolicyProfile(kind,{schemaVersion:7});
  assert.equal(env.environmentFailureInputs,true);assert.equal(env.optionalSelectiveInputs,true);assert.equal(env.knownFailureInputs,undefined);assert.equal(env.reusedInputs,undefined);
  assert.equal(known.knownFailureInputs,true);assert.equal(known.selectiveInputs,true);assert.equal(known.environmentFailureInputs,undefined);assert.equal(known.reusedInputs,undefined);
 }
 for(const kind of ['conformance','conformanceReport'])for(const version of [5,6]){
  const p=namespaceConformancePolicyProfile(kind,{schemaVersion:version});assert.equal(p.environmentFailureInputs,true);assert.equal(p.issueLinks,version===6);assert.equal(p.knownFailureInputs,undefined);
 }
});
test('a failed baseline sentinel must still execute when the observed cohort is reviewed',()=>{
 const values=namespaceTestCohortPolicies(NODE_TEXT_DIGESTS),cases=rows=>values.cases({discovered:rows.length},rows.map(([name,outcome])=>({file:'test/legacy.test.js',name,outcome,ancestorTitles:[],framework:'node-test'}))),
  command=rows=>({repositoryId:'app',commandId:'tests',pinSha256:'sha256:original',cases:cases(rows)}),
  baseline=command([['known failure','failed'],['stable one','passed'],['stable two','passed']]),selected=command([['known failure','failed'],['stable one','passed']]);
 assert.equal(values.compare([baseline],[selected])[0].baselineIds.length,2,'older comparison keeps its original passing-baseline meaning');
 const review=values.compare([baseline],[selected],{retainFailures:true})[0];assert.equal(review.baselineIds.length,3);assert.equal(review.selectedIds.length,2);assert.equal(review.excludedIds.length,1);
 assert.throws(()=>values.compare([baseline],[command([['stable one','passed']])],{retainFailures:true}),{code:'TEST_COHORT_REQUIRED_FAILURE_SENTINEL'});
 const record={phase:'build',context:{schemaVersion:2,generation:2,baseline:{phase:'build',checks:{operationId:'baseline'}},observed:{operationId:'original-selected'},execution:{phase:'build'}}};
 assert.deepEqual(namespaceTestCohortReviewInput(record),{phaseId:'build',baselinePhaseId:'build',baselineOperationId:'baseline',observedOperationId:'original-selected',observedPhaseId:'build',candidateGeneration:2});
});
