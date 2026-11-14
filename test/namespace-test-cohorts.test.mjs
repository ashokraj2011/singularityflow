import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture,actualWitnessTest} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespaceSubmissionReader} from '../src/engine-storage/namespace-submission-reader.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {namespaceObservedCohortFixture as fixture,cohortReason as reason,cohortExtraTest as extraTest} from './helpers/namespace-observed-cohort-fixture.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': real suite baseline and human-selected cohort survive publication, independent approval and shared-only replay',{timeout:120000},async t=>{
  const f=await fixture(t,backend);assert.equal(f.view.manifest.selection[0].baselineIds.length,2);assert.equal(f.view.manifest.selection[0].excludedIds.length,1);
  assert.equal(f.view.manifest.newExecutionClaimed,false);f.human();const decision=await f.engine.run('test-cohort.confirm',f.request);
  assert.equal(decision.record.id,'TCO-001');f.author();await f.rebase('continue-with-selected-cohort');await f.retain('selected-current-source');await f.run('selected-fresh-suite');
  assert.equal((await f.engine.run('phase.prepublish',{phaseId:'build'})).manifest.qualityDisposition,'ready');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const snapshot=(await f.observer.inspect()).snapshot,checks=createNamespacePhaseCheckReader(f.options),packets=createNamespaceSubmissionReader({observer:f.observer,...f.options,checks}),
    publication=await packets.publicationReader.accepted(snapshot.workflow.phases.build.publicationBindings[0],'build');
  assert.ok(publication.policyEvidence.some(row=>row.kind==='test-cohort/v1'));assert.ok(publication.checks);
  assert.ok(packets.publicationReader.policies.resources(publication).some(row=>row.kind==='test-cohort'));
  await f.engine.run('phase.submit',{phaseId:'build'});f.human();const review=await f.engine.run('phase.review',{phaseId:'build'}),b=review.manifest.reviewBinding;
  await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}});
  f.control.permissions.push('story.evidence');const evidence=(await f.engine.run('story.evidence',{})).manifest;
  assert.equal(evidence.profile,'sflow-namespace-evidence-context/v4');assert.equal(evidence.report.completion.kind,'complete-with-exceptions');
  await rm(f.root,{recursive:true,force:true});const later=f.make({working:undefined,sources:[],checks:undefined,clock:{now(){throw Error('An accepted cohort does not allocate a new observation time.');}}});
  assert.equal((await later.run('test-cohort.confirm',f.request)).status,'retained');assert.equal(f.starts(),3);
});
test('cohort authority, exact contexts and original missing-file errors cannot be replaced with flags',{timeout:120000},async t=>{
  const f=await fixture(t);f.human();
  await assert.rejects(f.engine.run('test-cohort.confirm',{...f.request,approved:true}),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(f.engine.run('test-cohort.confirm',{...f.request,expectedContext:'sha256:'+'0'.repeat(64)}),{code:'TEST_COHORT_CONTEXT_CHANGED'});
  await assert.rejects(f.engine.run('test-cohort.confirm',{...f.request,expires:null}),{code:'TEST_COHORT_INVALID'});
  f.control.creator.email='outside@example.test';await assert.rejects(f.engine.run('test-cohort.confirm',f.request),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});f.human();
  const decision=await f.engine.run('test-cohort.confirm',f.request),snapshot=(await f.observer.inspect()).snapshot,
    original=snapshot.workflow.namespaceDecisionReceipts.find(row=>row.operation==='test-cohort.confirm').record;
  await assert.rejects(f.engine.run('test-cohort.confirm',{...f.request,operationId:'unnecessary-duplicate'}),{code:'TEST_COHORT_ALREADY_CONFIRMED'});
  for(const code of ['EACCES','ETIMEDOUT','SDA_CONTENT_MISSING']){
    const failure=Object.assign(Error('The original cohort decision could not be read.'),{code,path:'original-cohort-record',timeoutMs:300000}),
      denied=f.make({content:{...f.content,read(scope,ref,options){if(ref.sha256===original.sha256)throw failure;return f.content.read(scope,ref,options);}}});
    await assert.rejects(denied.run('test-cohort.confirm',f.request),error=>error===failure);
  }
  assert.equal(decision.record.id,'TCO-001');assert.equal(f.starts(),2);
});
test('expiry, revocation and newly omitted tests have current-phase recovery and preserve the original cohort',{timeout:120000},async t=>{
  const f=await fixture(t);f.human();await f.engine.run('test-cohort.confirm',f.request);f.author();
  await f.rebase('scope-before-publish');await f.retain('scope-before-publication');await f.run('scope-before-publication-check');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  f.control.now='2026-11-21T00:00:00.000Z';
  await assert.rejects(f.engine.run('phase.submit',{phaseId:'build'}),error=>error.code==='TEST_COHORT_NOT_COVERED'&&error.details.actions.some(row=>row.operation==='test-cohort.context'));
  f.human();await f.engine.run('test-cohort.confirm',{...f.request,operationId:'renew-exact-cohort',expires:'2026-12-01'});f.author();
  await f.engine.run('phase.submit',{phaseId:'build'});f.human();
  await f.engine.run('test-cohort.confirm',{operationId:'revoke-selected-cohort',revoke:'TCO-002',reason:'The reviewer withdraws this exact reduced-suite permission.'});
  const review=await f.engine.run('phase.review',{phaseId:'build'}),b=review.manifest.reviewBinding;
  await assert.rejects(f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}}),{code:'TEST_COHORT_NOT_COVERED'});
  assert.equal((await f.observer.inspect()).snapshot.workflow.namespaceTestCohorts.length,3);
});
test('a selected Code cohort and an independently accepted environment failure keep separate scope and execution proofs',{timeout:120000},async t=>{
  const f=await fixture(t);f.control.permissions.push('test-risk.context','decision.test-risk');f.human();await f.engine.run('test-cohort.confirm',f.request);
  const view=await f.engine.run('test-risk.context',{phaseId:'build'});await f.engine.run('decision.test-risk',{phaseId:'build',commandId:'node-tests',
    argvSha256:view.manifest.commands[0].argvSha256,causeClass:'service-unreachable',cause:'The integration service is unavailable on this machine.',reason,expires:'2026-11-20'});
  const text="import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import {once} from 'node:events';\nimport {convert} from '../src/converter.js';\n// @ac:STORY-1:AC-001\n"
    +"test('converts the approved value',async()=>{assert.equal(convert(255),'FF');const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));await once(net.connect({host:'127.0.0.1',port}),'connect');});\n";
  f.author();await f.rebase('continue-scope-and-environment');await writeFile(path.join(f.root,'test/converter.test.js'),text);await f.retain('combined-source');
  assert.equal((await f.run('combined-failed-test')).verdict,'failed');
  assert.equal((await f.engine.run('phase.prepublish',{phaseId:'build'})).manifest.qualityDisposition,'ready');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const snapshot=(await f.observer.inspect()).snapshot,checks=createNamespacePhaseCheckReader(f.options),packets=createNamespaceSubmissionReader({observer:f.observer,...f.options,checks}),
    publication=await packets.publicationReader.accepted(snapshot.workflow.phases.build.publicationBindings[0],'build');
  assert.ok(publication.policyEvidence.some(row=>row.kind==='test-cohort/v2'));assert.ok(publication.policyEvidence.some(row=>row.kind==='test-risk/v2'));
  assert.equal(publication.checks,null);await f.engine.run('phase.submit',{phaseId:'build'});f.human();
  const review=await f.engine.run('phase.review',{phaseId:'build'}),b=review.manifest.reviewBinding;
  await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}});
  assert.equal(f.starts(),3);
});
test('a lost cohort acknowledgement reconciles one original decision and exposes its history',{timeout:120000},async t=>{
  const f=await fixture(t),failure=Object.assign(Error('The accepted cohort reply timed out.'),{code:'ETIMEDOUT',timeoutMs:300000});let lost=false;
  f.human();const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!lost&&args[1].events.some(row=>row.payload?.operation==='test-cohort.confirm')){lost=true;throw failure;}return result;}},engine=f.make({records});
  await assert.rejects(engine.run('test-cohort.confirm',f.request),error=>error===failure);assert.ok(lost);
  const result=await engine.run('test-cohort.confirm',f.request);assert.equal(result.status,'retained');assert.equal(result.effects.committed,false);
  assert.equal((await f.capture()).workflow.namespaceTestCohorts.length,1);
  const context=await engine.run('test-cohort.context',{phaseId:'build',baselineOperationId:'baseline-suite',observedOperationId:'selected-suite'});
  assert.equal(context.manifest.previousDecisions.length,1);assert.equal(context.manifest.previousDecisions[0].record.id,result.record.id);
  assert.equal(context.manifest.previousDecisionTotal,1);assert.equal(context.manifest.previousDecisionsTruncated,false);
  assert.equal(Object.hasOwn(context.manifest.previousDecisions[0].record,'context'),false,'history references must not duplicate entire baseline inventories');
});
test('newly omitted selected tests are refused, while source changes and a restored full baseline remain explicit',{timeout:120000},async t=>{
  const f=await fixture(t);f.human();await f.engine.run('test-cohort.confirm',f.request);f.author();await f.rebase('continue-reviewed-cohort');
  await writeFile(path.join(f.root,'test/converter.test.js'),actualWitnessTest.replace("'converts the approved value'","'different observed regression'"));
  await f.retain('newly-omitted-source');await f.run('newly-omitted-checks');
  await assert.rejects(f.engine.run('phase.prepublish',{phaseId:'build'}),{code:'TEST_COHORT_NOT_COVERED'});
  f.control.now='2026-11-21T00:00:00.000Z';await writeFile(path.join(f.root,'test/converter.test.js'),actualWitnessTest+extraTest);
  await f.retain('restored-original-baseline');await f.run('restored-full-suite');
  assert.equal((await f.engine.run('phase.prepublish',{phaseId:'build'})).manifest.qualityDisposition,'ready');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  await f.engine.run('phase.submit',{phaseId:'build'});assert.equal((await f.capture()).workflow.namespaceTestCohorts.length,1);
});
test('cohort identities keep identical relative files and names separated by repository',{timeout:120000},async t=>{
  const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
    .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | `frontend` |\n| service-1 | `backend` |\n',f=await fixture(t,'sqlite',{repositories:2,plan});
  assert.equal(f.view.manifest.selection.length,2);assert.equal(f.view.manifest.selection.find(row=>row.repositoryId==='app').excludedIds.length,1);
  assert.equal(f.view.manifest.selection.find(row=>row.repositoryId==='service-1').excludedIds.length,0);
  f.human();await f.engine.run('test-cohort.confirm',f.request);f.author();await f.rebase('continue-two-repository-cohort');
  await f.retain('two-repository-selected-source');await f.run('two-repository-selected-checks');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'build'});assert.equal(f.starts(),6);
});
test('later phases retain the original cohort gap and can renew it without regenerating Code',{timeout:120000},async t=>{
  const f=await fixture(t,'sqlite',{configure(source){source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/report.md',kind:'phase-document'},defaultTemplate:'intake.md',
    inputs:[{phase:'build'}],clarification:{mode:'off',markers:{mode:'off'}},specificationQuality:{mode:'off'},approval:{authorities:['reviewers'],minimum:1,rejectTo:['build'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('release');source.agents[0].phases.push('release');source.agents[0].defaultFor.push('release');}});
  f.control.permissions.push('story.evidence','decisions.list');f.human();await f.engine.run('test-cohort.confirm',f.request);f.author();await f.rebase('continue-late-cohort');
  await f.retain('late-cohort-source');await f.run('late-cohort-check');await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  await f.engine.run('phase.submit',{phaseId:'build'});f.human();
  async function approve(phaseId){const b=(await f.engine.run('phase.review',{phaseId})).manifest.reviewBinding;
    return f.engine.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:b.generation,reviewPacketSha256:b.packetSha256}});}
  await approve('build');f.control.now='2026-11-21T00:00:00.000Z';
  const gap=(await f.engine.run('story.evidence',{})).manifest.report.rows.find(row=>row.type==='EXECUTION-POLICY');
  assert.equal(gap.result,'pending');assert.ok(gap.actions.some(row=>row.operation==='test-cohort.context'&&row.inputs.phaseId==='build'));
  const listed=(await f.engine.run('decisions.list',{})).manifest.policy;assert.ok([...listed.offered,...listed.items].some(row=>row.kind==='test-cohort'));
  f.author();await f.engine.run('phase.prepare',{phaseId:'release'});const draft=(await f.engine.run('phase.draft.read',{phaseId:'release'})).manifest.draft;
  await f.engine.run('phase.draft.write',{operationId:'late-cohort-release',workId:f.inputs.workId,phaseId:'release',expectedRevision:draft.revision,
    content:await f.upload('# Release\n\n## Agent brief\n\nThe omitted baseline case and its original human scope decision remain disclosed.\n'),reason});
  await f.engine.run('phase.publish',{phaseId:'release',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'release'});f.human();
  await assert.rejects(approve('release'),{code:'ENGINE_TERMINAL_EVIDENCE_REQUIRED'});
  await f.engine.run('test-cohort.confirm',{...f.request,operationId:'renew-original-code-cohort',expires:'2026-12-01'});await approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),3);
});
