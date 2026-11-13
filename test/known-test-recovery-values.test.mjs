import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceKnownTestRecoveryPolicies} from '../src/kernel/known-test-recovery.mjs';
import {testRecoveryPolicies} from '../src/kernel/test-recovery.mjs';import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {namespaceTestRiskRecordProfile,namespaceCodeExecutionRiskProfile} from '../src/foundation/record-schema.mjs';
import {createTrpFixture} from './test-recovery-policy.fixture.mjs';
const rules=namespaceKnownTestRecoveryPolicies(NODE_TEXT_DIGESTS),trp=testRecoveryPolicies(NODE_TEXT_DIGESTS),
  projection=()=>{const f=createTrpFixture();return {policy:f.policy,agreement:f.agreement,baseline:f.baseline,observation:f.observation,selection:f.selection};};
test('known-failure values preserve independent identities, exact causes, semantics and qualified environments',()=>{
  assert.equal(rules.eligible(projection()),true);
  for(const mutate of [
    p=>p.observation.cases[0].semanticsSha256=trp.trpDigest('changed assertion'),
    p=>p.observation.cases[0].causeSha256=trp.trpDigest('new failure'),
    p=>p.observation.cases[1].outcome='skipped',
    p=>p.observation.cases[1].outcome='failed',
    p=>p.observation.expectedTestIds.push('omitted-before'),
    p=>p.observation.environment.runtimeSha256=trp.trpDigest('different native Node'),
    p=>p.observation.environment.platform='win32',
    p=>p.observation.environment.dependencySha256=trp.trpDigest('changed protected dependency'),
    p=>p.baseline.preFeatureBase='another-source',
    p=>p.observation.subject.repositoryId='another-repository'
  ]){const p=structuredClone(projection());mutate(p);assert.equal(rules.eligible(p),false);}
  assert.equal(rules.authorize,undefined);assert.equal(rules.execute,undefined);
});
test('scope equality does not grant an authority receipt and expiry/revocation retain exact boundaries',()=>{
  const p=projection(),record={reason:'The exact legacy failure remains under an independent follow-up.',expiresAt:'2026-10-20T10:00:00Z',
    followUpOwner:'legacy-team',remediationRef:'LEGACY-1',contextSha256:trp.trpDigest('human-review'),recordedAt:'2026-10-02T11:00:00Z'},
    decision=rules.risk(p,record,{principal:'reviewer',authorizationRef:'original-human-receipt'});
  assert.equal(decision.issuer.channel,'namespace-known-failure-review');assert.equal(decision.receipt,undefined);
  const gate=trp.evaluateTestRecoveryGate({policy:p.policy,agreement:p.agreement,subject:p.observation.subject,operation:'publish',at:record.recordedAt,
    observations:[p.observation],baselines:[p.baseline],decisions:[decision],selection:p.selection,candidateDependencies:p.observation.dependencies,candidateEnvironment:p.observation.environment});
  assert.equal(gate.gateDecision,'block');
  const row={id:'KTR-001',expiresAt:record.expiresAt};assert.equal(rules.state([row],row,'2026-10-20T09:59:59Z'),'active');
  assert.equal(rules.state([row],row,record.expiresAt),'expired');assert.equal(rules.state([row,{revokes:row.id}],row,record.recordedAt),'revoked');
});
test('known-failure schema capabilities and Code evidence have separate versioned meanings',()=>{
  const record={schemaVersion:1,profile:'sflow-namespace-known-test-run-risk/v1'},report={schemaVersion:1,profile:'sflow-namespace-known-test-risk-policy/v1'};
  assert.equal(namespaceTestRiskRecordProfile('record',record).knownFailure,true);
  assert.equal(namespaceCodeExecutionRiskProfile(report).version,33);assert.equal(namespaceCodeExecutionRiskProfile(report).humanAcceptance,undefined);
  assert.equal(namespaceCodeExecutionRiskProfile({schemaVersion:2,profile:'sflow-namespace-test-risk-policy/v2'}).version,32);
  assert.deepEqual(Object.keys(namespaceTestRiskRecordProfile('record',{schemaVersion:1})),['version','profile']);
  assert.throws(()=>namespaceTestRiskRecordProfile('record',{...record,schemaVersion:2}),{code:'SCHEMA_VERSION_FUTURE'});
});
test('planned test-input identity is independent of completion order and still detects changed or extra cases',()=>{
  const a={file:'test/feature.test.js',name:'converts the approved value',ancestorTitles:['feature'],line:7},
    b={file:'test/feature.test.js',name:'handles an input boundary',ancestorTitles:['feature'],line:12},original=[a,b];
  assert.deepEqual(rules.testInputCases(original),rules.testInputCases([b,a]));assert.deepEqual(original,[a,b]);
  for(const rows of [[a,{...b,name:'another behavior'}],[a,{...b,line:13}],[a,b,b],[a]])
    assert.notEqual(rules.testInputCases(rows).sha256,rules.testInputCases(original).sha256);
});
test('malformed independent inventories return an actionable policy error and case ordering is portable',()=>{
  const command={id:'legacy',argv:['node','--test','--test-reporter=junit','test/legacy.test.js'],result:{adapter:'junit-xml'}},
    facts={workId:'story',phaseId:'build',generation:0,repositoryId:'app',command,commands:[command],
      declaration:{adapter:'node-test-junit-v1',dependencyScope:'repository-and-node-builtins-only',baselineMutableRoots:['src'],
        tests:[{id:'z-case',path:'test/legacy.test.js',name:'one'},{id:'a-case',path:'test/legacy.test.js',name:'two'}]},
      snapshot:{entries:[{path:'test/legacy.test.js',sha256:'a'.repeat(64),bytes:100,executable:false}]},
      qualification:{profile:'sflow-node-check-environment/v1',hostId:'worker',platform:'darwin',arch:'arm64',runtimeSha256:'sha256:'+'b'.repeat(64),environmentSha256:'sha256:'+'c'.repeat(64)},
      parsed:{tests:{discovered:2,passed:1,failed:1,skipped:0},cases:[{file:'test/legacy.test.js',name:'one',outcome:'failed',causeSha256:'sha256:'+'d'.repeat(64)},
        {file:'test/legacy.test.js',name:'two',outcome:'passed',causeSha256:null}]},reportSha256s:['sha256:'+'e'.repeat(64)],at:'2026-11-08T00:00:00.000Z',
      configuration:{schemaVersion:1},sourceRevision:'sha256:'+'f'.repeat(64)};
  assert.deepEqual(rules.observed(facts).expectedTestIds,['a-case','z-case']);
  for(const change of [value=>value.declaration.tests=[null],value=>value.declaration.tests=[{id:{},path:'test/legacy.test.js',name:'one'}],
    value=>value.declaration.tests=[{id:'case',path:'../outside.js',name:'one'}],value=>value.declaration.tests=[{id:'case',path:'test/legacy.test.js',name:''}],
    value=>value.declaration.baselineMutableRoots='src',value=>value.declaration.baselineMutableRoots=['../outside']]){
    const value=structuredClone(facts);change(value);assert.throws(()=>rules.observed(value),{code:'KNOWN_TEST_RISK_NOT_ELIGIBLE'});
  }
});
