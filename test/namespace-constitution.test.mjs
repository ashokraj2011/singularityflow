/** Actual approved file and citation evidence through shared-only independent approval. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceConstitutionFixture,authorConstitutionDraft} from './helpers/namespace-constitution-fixture.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': pinned constitution reaches exact publication, review and cross-host approval',{timeout:120000},async t=>{
  const f=await namespaceConstitutionFixture(t,backend);await f.bootstrap();await authorConstitutionDraft(f);
  assert.equal((await f.engine.run('phase.prepublish',{phaseId:'intake'})).status,'ready');
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  const state=await f.capture(),ref=state.workflow.phases.intake.publicationBindings[0].record,
    publication=JSON.parse(Buffer.from((await f.content.read(f.scope,ref)).data)),binding=publication.policyEvidence.find(row=>row.kind==='constitution-policy/v1');
  assert.ok(binding);const manifest=JSON.parse(Buffer.from((await f.content.read(f.scope,binding.record)).data)),
    report=JSON.parse(Buffer.from((await f.content.read(f.scope,manifest.report)).data));
  assert.equal(report.pin.source.content.sha256,f.source.files[0].body.sha256);assert.equal(report.pin.configuration.content.sha256,state.configuration.content.sha256);
  assert.deepEqual(report.requiredArticles,['ART-002']);assert.deepEqual(report.judgment,{performed:false,owner:'phase-approval'});
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.citations.cited,['ART-002']);assert.equal(Object.hasOwn(report.pin,'configurationCommit'),false);
  await f.engine.run('phase.submit',{phaseId:'intake'});f.asReviewer();
  const shared=f.make({working:null}),view=await shared.run('phase.review.resources',{phaseId:'intake'}),resource=view.manifest.resources.find(row=>row.kind==='constitution-policy');
  assert.ok(resource);assert.equal(resource.expected.sha256,manifest.report.sha256);
  const denied=Object.freeze(Object.assign(Error('Actual approved constitution cannot be read.'),{code:'EACCES'}));
  const bad=f.make({working:null,content:{...f.content,read(scope,reference,options){if(reference.sha256===f.source.files[0].body.sha256)throw denied;return f.content.read(scope,reference,options);}}});
  await assert.rejects(bad.run('phase.review.resources',{phaseId:'intake'}),error=>error===denied);
  for(const row of view.manifest.resources)await shared.run('document.read',{reference:row.reference});
  const result=await shared.run('phase.approve',{phaseId:'intake',confirmation:{workId:f.workId,phase:'intake',generation:1,reviewPacketSha256:view.manifest.reviewBinding.packetSha256}});
  assert.equal(result.approval.selfApproval,false);assert.equal((await f.capture()).workflow.status,'closed');
  const before=await f.capture();f.asAuthor();const replay=f.make({working:null,clock:{now(){throw Error('No new clock on accepted replay.');}}});
  await replay.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});assert.deepEqual(await f.capture(),before);
});
test('invalid citations are repaired in the same draft; missing files and real integrity errors are preserved',async t=>{
  const f=await namespaceConstitutionFixture(t);await f.bootstrap();await authorConstitutionDraft(f,{citation:'ART-999'});
  const inspect=await f.engine.run('phase.prepublish',{phaseId:'intake'});assert.equal(inspect.status,'correction-required');
  assert.ok(inspect.manifest.findings.some(row=>row.code==='CONSTITUTION_POLICY_REQUIRED'));
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),{code:'CONSTITUTION_POLICY_REQUIRED'});
  await authorConstitutionDraft(f,{operationId:'repair-exact-citation'});
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  assert.equal((await f.capture()).workflow.phases.intake.generation,1);
  const missing=await namespaceConstitutionFixture(t,'filesystem',{markdown:null});await assert.rejects(missing.bootstrap(),{code:'ENGINE_CONFIGURATION_INVALID'});
  const altered=await namespaceConstitutionFixture(t,'filesystem',{markdown:Buffer.from((await f.content.read(f.scope,f.source.files[0].body)).data).toString().replace('Effective value: 1','Effective value: 9')});
  await assert.rejects(altered.bootstrap(),error=>error.code==='CONSTITUTION_POLICY_REQUIRED'&&error.details.findings.some(row=>row.kind==='hand-edited'));
});
test('warn mode discloses unavailable rules and citations without inventing judgment or authority',async t=>{
  const f=await namespaceConstitutionFixture(t,'filesystem',{mode:'warn',markdown:null});await f.bootstrap();await authorConstitutionDraft(f,{citation:'ART-999'});
  const ready=await f.engine.run('phase.prepublish',{phaseId:'intake'});assert.equal(ready.status,'ready');assert.ok(ready.manifest.advisories.length>=2);
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'intake'});
  assert.equal((await f.review()).result.approval.selfApproval,false);
});
test('a lost publication response resumes the original constitution proof without creating a second generation',async t=>{
  const f=await namespaceConstitutionFixture(t);await f.bootstrap();await authorConstitutionDraft(f);
  const timeout=Object.freeze(Object.assign(Error('Actual publication acknowledgement was lost.'),{code:'ETIMEDOUT',details:{deadlineMs:4023}}));let failed=false;
  const records={...f.records,async transact(scope,transaction,options){const accepted=await f.records.transact(scope,transaction,options);
    if(!failed&&transaction.changes.some(row=>row.namespace==='runtime'&&row.value?.operation==='phase.publish')){failed=true;throw timeout;}return accepted;}};
  const input={phaseId:'intake',authored:'governed-agent',channel:'copilot-host'};
  await assert.rejects(f.make({records}).run('phase.publish',input),error=>error===timeout);
  await f.engine.run('phase.publish',input);await f.engine.run('phase.submit',{phaseId:'intake'});await f.review();
  assert.equal((await f.capture()).workflow.phases.intake.publicationBindings.length,1);
});
