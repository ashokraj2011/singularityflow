import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestCohortPolicies,namespaceCodeEnvironmentRiskCoverage} from '../src/kernel/test-recovery.mjs';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {namespaceTestRiskRecordProfile} from '../src/foundation/record-schema.mjs';
const values=namespaceTestCohortPolicies(NODE_TEXT_DIGESTS),occurrence=(name,outcome='passed')=>({file:'test/converter.test.js',name,ancestorTitles:[],framework:'node-test',outcome});
test('risk schema capabilities are centralized while original profile metadata stays unchanged',()=>{
  for(const kind of ['record','context','policy','report']){
    const original=namespaceTestRiskRecordProfile(kind,{schemaVersion:1});assert.deepEqual(Object.keys(original),['version','profile']);assert.ok(Object.isFrozen(original));
    assert.equal(namespaceTestRiskRecordProfile(kind,{schemaVersion:2}).executionRisk,true);assert.equal(namespaceTestRiskRecordProfile(kind,{schemaVersion:2}).recoveryRisk,undefined);
    assert.equal(namespaceTestRiskRecordProfile(kind,{schemaVersion:3}).recoveryRisk,true);
    const selected=['policy','report'].includes(kind);
    if(selected)assert.equal(namespaceTestRiskRecordProfile(kind,{schemaVersion:4}).selectedExecution,true);
    assert.throws(()=>namespaceTestRiskRecordProfile(kind,{schemaVersion:selected?5:4}),{code:'SCHEMA_VERSION_FUTURE'});
  }
});
test('cohort identities require complete portable unambiguous observations, rather than passing counts',()=>{
  const rows=[occurrence('convert'),occurrence('boundary')];assert.equal(values.cases({discovered:2},rows).length,2);
  for(const occurrences of [null,[],[rows[0],rows[0]],[{...rows[0],file:'/another/checkout/test.js'},rows[1]],
    [{...rows[0],name:''},rows[1]],[{...rows[0],ancestorTitles:[{}]},rows[1]]])
    assert.throws(()=>values.cases({discovered:2},occurrences),{code:'TEST_COHORT_IDENTITY_REQUIRED'});
  const command=cases=>({repositoryId:'app',commandId:'tests',pinSha256:'sha256:original',cases}),baseline=command(values.cases({discovered:2},rows)),
    current=command(values.cases({discovered:1},[occurrence('convert','failed')])),selection=values.compare([baseline],[current])[0];
  assert.equal(selection.selectedIds.length,1,'execution success is a separate proof');assert.equal(selection.excludedIds.length,1);
  for(const change of [{pinSha256:'sha256:other'},{repositoryId:'another'},{commandId:'different'}])
    assert.throws(()=>values.compare([baseline],[{...current,...change}]),{code:'TEST_COHORT_PIN_CHANGED'});
  assert.equal(values.state([{id:'TCO-001',expiresAt:'2026-11-20T00:00:00Z'}],{id:'TCO-001',expiresAt:'2026-11-20T00:00:00Z'},'2026-11-21T00:00:00Z'),'expired');
  assert.equal(values.state([{revokes:'TCO-001'}],{id:'TCO-001'},'2026-11-21T00:00:00Z'),'revoked');
  assert.throws(()=>values.state([],{id:'TCO-001'}),{code:'ENGINE_INPUT_INVALID'});
});
test('Code-risk values refuse assertion, identity, assurance and repository gaps instead of manufacturing a pass',()=>{
  const match={witness:{identity:{name:'convert'},commandId:'tests',assertions:{adequacy:'adequate'},gaps:[]},result:{status:'failed',outcome:'failed'}},
    observation={repositoryId:'app',commandId:'tests',cause:{category:'environment'},decision:{record:{id:'TRR-001'}}},
    report={profile:'sflow-namespace-test-risk-policy/v2',observations:[observation]};
  assert.deepEqual(namespaceCodeEnvironmentRiskCoverage([match],'app',report),{profile:'sflow-namespace-code-execution-exception/v1',decisions:['TRR-001'],testsPassed:false});
  for(const changed of [{witness:{...match.witness,identity:null}},{witness:{...match.witness,gaps:['missing-test-source']}},
    {witness:{...match.witness,assertions:{adequacy:'insufficient'}}},{result:{status:'inconclusive',outcome:'inconclusive'}}])
    assert.equal(namespaceCodeEnvironmentRiskCoverage([{...match,...changed}],'app',report,{enforceAssertionAdequacy:true}),null);
  assert.equal(namespaceCodeEnvironmentRiskCoverage([match],'another',report),null);
  assert.equal(namespaceCodeEnvironmentRiskCoverage([match],'app',{...report,observations:[{...observation,cause:{category:'code'}}]}),null);
});
