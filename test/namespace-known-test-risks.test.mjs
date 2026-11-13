import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceKnownTestRiskFixture,legacyTest} from './helpers/namespace-known-test-risk-fixture.mjs';
import {actualWitnessTest} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespaceSubmissionReader} from '../src/engine-storage/namespace-submission-reader.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': independently inventoried failures stay failed through Code, terminal evidence and independent approval',{timeout:120000},async t=>{
  const f=await namespaceKnownTestRiskFixture(t,{backend});assert.equal(f.view.manifest.identityAssurance,'independent-configured-case-inventory');
  f.human();const decision=await f.engine.run('test-risk.confirm-known',f.request);assert.equal(decision.record.id,'KTR-001');
  f.author();await f.rebase('continue-reviewed-known-failure');await f.retain('known-final-source');await f.run('known-fresh-publication-checks');
  const ready=await f.engine.run('phase.prepublish',{phaseId:'build'}).catch(error=>assert.fail(JSON.stringify({code:error.code,details:error.details})));
  assert.equal(ready.manifest.qualityDisposition,'ready',JSON.stringify(ready));
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const snapshot=(await f.observer.inspect()).snapshot,checks=createNamespacePhaseCheckReader(f.options),packets=createNamespaceSubmissionReader({observer:f.observer,...f.options,checks}),
    publication=await packets.publicationReader.accepted(snapshot.workflow.phases.build.publicationBindings[0],'build'),code=packets.publicationReader.policies.codeEvidence(publication);
  assert.equal(publication.checks,null);assert.equal(code.report.schemaVersion,33);assert.equal(code.report.executionException.failedAcceptanceWaived,false);
  assert.equal(code.report.acceptance[0].result.status,'met');assert.ok(publication.policyEvidence.some(row=>row.kind==='known-test-risk/v1'));
  await f.engine.run('phase.submit',{phaseId:'build'});f.human();const b=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
  await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}});
  assert.equal(f.starts(),6);
  const evidence=(await f.engine.run('story.evidence',{})).manifest;assert.equal(evidence.report.completion.kind,'complete-with-exceptions');
  assert.ok(evidence.excluded.some(row=>row.reason==='known-baseline-failures-remain-failed'));
  await rm(f.root,{recursive:true,force:true});const later=f.make({working:null,sources:[],checks:undefined,clock:{now(){throw Error('Original review replay cannot invent a new time.');}}});
  assert.equal((await later.run('test-risk.confirm-known',f.request)).status,'retained');
  assert.equal((await later.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}})).status,'recorded');
  assert.equal(f.starts(),6);
});
test('a human review cannot relabel a feature run as the baseline, bypass authority, change context or create a duplicate',{timeout:120000},async t=>{
  const f=await namespaceKnownTestRiskFixture(t);f.human();
  await assert.rejects(f.engine.run('test-risk.known-context',{phaseId:'build',baselineOperationId:'current-known-failure-checks',observedOperationId:'current-known-failure-checks'}),{code:'KNOWN_TEST_BASELINE_REQUIRED'});
  await assert.rejects(f.engine.run('test-risk.confirm-known',{...f.request,approved:true}),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(f.engine.run('test-risk.confirm-known',{...f.request,expectedContext:'sha256:'+'0'.repeat(64)}),{code:'KNOWN_TEST_RISK_CONTEXT_CHANGED'});
  f.control.creator.email='outside@example.test';await assert.rejects(f.engine.run('test-risk.confirm-known',f.request),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});f.human();
  const first=await f.engine.run('test-risk.confirm-known',f.request);assert.equal(first.record.id,'KTR-001');
  await assert.rejects(f.engine.run('test-risk.confirm-known',{...f.request,operationId:'duplicate-known-review'}),{code:'KNOWN_TEST_RISK_ALREADY_CONFIRMED'});
  f.control.permissions.push('decisions.list');const decisions=(await f.engine.run('decisions.list',{})).manifest;
  assert.ok(decisions.policy.items.concat(decisions.policy.offered).some(row=>row.title==='KTR-001:active'),JSON.stringify(decisions));
  const snapshot=(await f.observer.inspect()).snapshot,original=snapshot.workflow.namespaceDecisionReceipts.find(row=>row.operation==='test-risk.confirm-known').record;
  for(const code of ['EACCES','ETIMEDOUT','SDA_CONTENT_MISSING']){
    const failure=Object.assign(Error('The original known-failure receipt is unavailable.'),{code,path:'original-known-risk',timeoutMs:300000}),
      broken=f.make({content:{...f.content,read(scope,reference,options){if(reference.sha256===original.sha256)throw failure;return f.content.read(scope,reference,options);}}});
    await assert.rejects(broken.run('test-risk.confirm-known',f.request),error=>error===failure);
  }
  assert.equal(f.starts(),4);
});
test('expiry and revocation retain the exact published failure and expose original-owner renewal',{timeout:120000},async t=>{
  const f=await namespaceKnownTestRiskFixture(t,{configure:source=>{source.definition.testRecovery.maxEvidenceAgeSeconds=30*86400;}});f.human();await f.engine.run('test-risk.confirm-known',f.request);f.author();
  await f.rebase('known-risk-before-publication');await f.retain('known-risk-publication-source');await f.run('known-risk-publication-tests');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  f.control.now='2026-11-21T00:00:00.000Z';
  await assert.rejects(f.engine.run('phase.submit',{phaseId:'build'}),error=>error.code==='TEST_RUN_RISK_NOT_COVERED'&&error.details.actions.some(row=>row.operation==='test-risk.known-context'));
  f.human();await f.engine.run('test-risk.confirm-known',{...f.request,operationId:'renew-known-risk',expires:'2026-12-01'});f.author();
  await f.engine.run('phase.submit',{phaseId:'build'});f.human();
  await f.engine.run('test-risk.confirm-known',{operationId:'withdraw-known-risk',revoke:'KTR-002',reason:'The original reviewer withdraws this exact known-failure permission.'});
  const b=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
  await assert.rejects(f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}}),{code:'TEST_RUN_RISK_NOT_COVERED'});
  assert.equal((await f.capture()).workflow.namespaceKnownTestRisks.length,3);
});
test('changed test semantics, new failures and protected dependencies cannot be accepted as original known failures',{timeout:120000},async t=>{
  const f=await namespaceKnownTestRiskFixture(t);f.human();await f.engine.run('test-risk.confirm-known',f.request);f.author();await f.rebase('known-risk-repair-probe');
  await writeFile(path.join(f.root,'test/legacy.test.js'),"import test from 'node:test';import assert from 'node:assert/strict';test('the unchanged legacy failure',()=>assert.equal(2+2,6));test('the existing passing regression',()=>assert.equal(2+2,4));\n");
  await f.retain('changed-legacy-assertion');await f.run('changed-legacy-assertion-tests');
  await assert.rejects(f.engine.run('test-risk.known-context',{phaseId:'build',baselineOperationId:'original-pre-feature-checks',observedOperationId:'changed-legacy-assertion-tests'}),{code:'KNOWN_TEST_RISK_NOT_ELIGIBLE'});
  await assert.rejects(f.engine.run('phase.prepublish',{phaseId:'build'}),{code:'PHASE_CHECKS_NOT_PASSED'});
  await writeFile(path.join(f.root,'test/converter.test.js'),"import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';\n// @ac:STORY-1:AC-001\ntest('converts the approved value',()=>assert.equal(convert(255),'not-FF'));\n");
  await f.retain('failed-story-acceptance');await f.run('failed-story-acceptance-tests');
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'}),{code:'KNOWN_TEST_RISK_NOT_ELIGIBLE'});
  assert.equal((await f.capture()).workflow.phases.build.generation,0);
  await writeFile(path.join(f.root,'test/legacy.test.js'),legacyTest);await writeFile(path.join(f.root,'test/converter.test.js'),actualWitnessTest);
  await f.retain('restored-exact-known-scope');await f.run('restored-story-acceptance-tests');
  assert.equal((await f.engine.run('phase.prepublish',{phaseId:'build'})).manifest.qualityDisposition,'ready');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  assert.equal((await f.capture()).workflow.phases.build.generation,1);
});
test('a lost known-failure acknowledgement reconciles the original conditional human record',{timeout:120000},async t=>{
  const f=await namespaceKnownTestRiskFixture(t),failure=Object.assign(Error('The accepted review reply timed out.'),{code:'ETIMEDOUT',timeoutMs:300000});let lost=false;
  f.human();const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!lost&&args[1].events.some(row=>row.payload?.operation==='test-risk.confirm-known')){lost=true;throw failure;}return result;}},engine=f.make({records});
  await assert.rejects(engine.run('test-risk.confirm-known',f.request),error=>error===failure);assert.ok(lost);
  const result=await engine.run('test-risk.confirm-known',f.request);assert.equal(result.status,'retained');assert.equal(result.effects.committed,false);
  assert.equal((await f.capture()).workflow.namespaceKnownTestRisks.length,1);assert.equal(f.starts(),4);
});
