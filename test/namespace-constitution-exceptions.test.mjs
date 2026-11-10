import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceConstitutionFixture,authorConstitutionDraft} from './helpers/namespace-constitution-fixture.mjs';
import {createNamespaceConstitutionExceptionOwners} from '../src/engine-storage/namespace-constitution-exception-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {namespaceLifecycleStoryKey} from '../src/engine-storage/namespace-lifecycle-reader.mjs';
async function submitted(t,backend='filesystem'){
  const f=await namespaceConstitutionFixture(t,backend);f.control.permissions.push('constitution.exception.context','decision.constitution-exception');
  await f.bootstrap();await authorConstitutionDraft(f);await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  await f.engine.run('phase.submit',{phaseId:'intake'});f.asReviewer();return f;
}
const request=(f,manifest,id='grant-exact-article-exception')=>({operationId:id,workId:f.workId,phaseId:'intake',articleId:'ART-002',
  scope:'Only the documented reversal procedure for this exact reviewed document.',reason:'The authorized reviewer accepts a documented manual reversal procedure for this isolated result.',
  expires:'2026-12-01T00:00:00.000Z',expectedContext:manifest.expectedContext});
test('exception context provides the exact missing generation or submission recovery without modifying the Story',async t=>{
  const f=await namespaceConstitutionFixture(t);f.control.permissions.push('constitution.exception.context');await f.bootstrap();
  const before=await f.capture();
  await assert.rejects(f.engine.run('constitution.exception.context',{articleId:'ART-002'}),error=>error.code==='PHASE_GENERATION_REQUIRED'
    &&error.details.actions[0].operation==='phase.prepare'&&error.details.actions[0].inputs.phaseId==='intake');
  assert.deepEqual(await f.capture(),before);
  await authorConstitutionDraft(f);await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  const published=await f.capture();
  await assert.rejects(f.engine.run('constitution.exception.context',{articleId:'ART-002'}),error=>error.code==='PHASE_SUBMISSION_REQUIRED'
    &&error.details.actions[0].operation==='phase.submit'&&error.details.actions[0].inputs.workId===f.workId);
  assert.deepEqual(await f.capture(),published);
});
for(const backend of ['filesystem','sqlite','application'])test(backend+': a real article exception preserves the publication and completes independent shared-only approval',async t=>{
  const f=await submitted(t,backend),original=(await f.capture()).workflow.phases.intake.publicationBindings,
    {manifest}=await f.engine.run('constitution.exception.context',{articleId:'ART-002'}),input=request(f,manifest),
    result=await f.engine.run('decision.constitution-exception',input);
  assert.equal(result.record.format,'sflow-namespace-constitution-exception/v1');assert.equal(result.record.id,'CEX-001');
  assert.equal(result.record.articleSha256,manifest.article.articleSha256);assert.equal(result.currentPhase,'intake');
  assert.deepEqual((await f.capture()).workflow.phases.intake.publicationBindings,original);
  await assert.rejects(f.engine.run('decision.constitution-exception',{...input,operationId:'stale-article-context'}),{code:'ENGINE_CONSTITUTION_EXCEPTION_STALE'});
  const current=(await f.engine.run('constitution.exception.context',{articleId:'ART-002'})).manifest;
  await assert.rejects(f.engine.run('decision.constitution-exception',request(f,current,'duplicate-exact-article')),{code:'CONSTITUTION_EXCEPTION_ALREADY_RECORDED'});
  const shared=f.make({working:null}),review=await shared.run('phase.review.resources',{phaseId:'intake'});
  const approved=await shared.run('phase.approve',{phaseId:'intake',confirmation:{workId:f.workId,phase:'intake',generation:1,reviewPacketSha256:review.manifest.reviewBinding.packetSha256}});
  assert.equal(approved.approval.selfApproval,false);assert.equal((await f.capture()).workflow.status,'closed');
  assert.equal((await shared.run('constitution.exception.context',{phaseId:'intake',articleId:'ART-002'})).manifest.recording.status,'read-only');
  const before=await f.capture(),replay=f.make({working:null,clock:{now(){throw Error('Accepted exception replay cannot restamp a decision.');}}});
  assert.deepEqual(await replay.run('decision.constitution-exception',input),result);assert.deepEqual(await f.capture(),before);
});
test('an article exception cannot change machine policy, borrow authority or ignore a real read failure',async t=>{
  const f=await submitted(t),machine=(await f.engine.run('constitution.exception.context',{articleId:'ART-001'})).manifest;
  await assert.rejects(f.engine.run('decision.constitution-exception',{...request(f,machine),articleId:'ART-001'}),{code:'CONSTITUTION_EXCEPTION_NOT_JUDGED'});
  const {manifest}=await f.engine.run('constitution.exception.context',{articleId:'ART-002'}),input=request(f,manifest);
  f.control.identity={name:'Unrelated reviewer',email:'unrelated@example.test',login:null};
  await assert.rejects(f.engine.run('decision.constitution-exception',input),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});f.asReviewer();
  const denied=Object.freeze(Object.assign(Error('Actual pinned article bytes are unreadable.'),{code:'EACCES'})),
    blocked=f.make({content:{...f.content,read(scope,ref,options){if(ref.sha256===f.source.files[0].body.sha256)throw denied;return f.content.read(scope,ref,options);}}});
  await assert.rejects(blocked.run('constitution.exception.context',{articleId:'ART-002'}),error=>error===denied);
  await f.engine.run('decision.constitution-exception',input);const snapshot=await f.capture(),forged=structuredClone(snapshot);
  forged.workflow.namespaceConstitutionExceptions[0].scope='A copied claim has no human authority.';
  const owned=createNamespaceConstitutionExceptionOwners({observer:createNamespaceStoryObserver(f.options),scope:f.scope,workId:f.workId});
  await assert.rejects(owned.admitted(forged),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.throws(()=>owned.owner.assertNew({workflow:{resolution:{presence:{status:'required'}}}}),error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required[0]==='person-presence');
});
test('an expired exact-publication exception needs genuine human renewal before approval',async t=>{
  const f=await submitted(t),context=await f.engine.run('constitution.exception.context',{articleId:'ART-002'});
  await f.engine.run('decision.constitution-exception',request(f,context.manifest));
  const late=f.make({working:null,clock:{now:()=> '2026-12-02T00:00:00.000Z'}}),view=await late.run('phase.review.resources',{phaseId:'intake'}),
    approve={phaseId:'intake',confirmation:{workId:f.workId,phase:'intake',generation:1,reviewPacketSha256:view.manifest.reviewBinding.packetSha256}};
  await assert.rejects(late.run('phase.approve',approve),{code:'CONSTITUTION_EXCEPTION_EXPIRED'});
  const current=await late.run('constitution.exception.context',{articleId:'ART-002'});
  await late.run('decision.constitution-exception',{...request(f,current.manifest,'renew-exact-article'),expires:'2027-01-01T00:00:00.000Z'});
  assert.equal((await late.run('phase.approve',approve)).approval.selfApproval,false);
  assert.equal((await f.capture()).workflow.namespaceConstitutionExceptions.length,2);
});
test('a lost article decision acknowledgement preserves the exact receipt and never grants a second exception',async t=>{
  const f=await submitted(t),{manifest}=await f.engine.run('constitution.exception.context',{articleId:'ART-002'}),input=request(f,manifest),
    deadline=Object.freeze(Object.assign(Error('The original article decision acknowledgement was lost.'),{code:'ETIMEDOUT',details:{deadlineMs:7234}}));let failed=false;
  const interrupted=f.make({records:{...f.records,async transact(scope,transaction,options){const accepted=await f.records.transact(scope,transaction,options);
    if(!failed&&transaction.changes.some(row=>row.namespace==='state'&&row.key===namespaceLifecycleStoryKey(f.workId))){failed=true;throw deadline;}return accepted;}}});
  await assert.rejects(interrupted.run('decision.constitution-exception',input),error=>error===deadline);
  const before=await f.capture(),result=await f.engine.run('decision.constitution-exception',input);
  assert.equal(result.record.id,'CEX-001');assert.deepEqual(await f.capture(),before);assert.equal(before.workflow.namespaceConstitutionExceptions.length,1);
});
test('custom phases use their own submitted publication and authority while earlier approvals remain immutable',async t=>{
  const f=await namespaceConstitutionFixture(t),id='custom-review',phase=structuredClone(f.source.definition.phases.intake);
  phase.label='Custom review';phase.artifact.path='artifacts/custom-review/report.md';f.source.definition.phases[id]=phase;
  f.source.definition.workTypes.simple.phases.push(id);f.source.agents[0].phases.push(id);f.source.agents[0].defaultFor.push(id);
  f.control.permissions.push('constitution.exception.context','decision.constitution-exception');await f.bootstrap();await authorConstitutionDraft(f);
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'intake'});await f.review();
  const original=structuredClone((await f.capture()).workflow.phases.intake);await f.author(id);f.asReviewer();
  const {manifest}=await f.engine.run('constitution.exception.context',{phaseId:id,articleId:'ART-002'}),
    result=await f.engine.run('decision.constitution-exception',{...request(f,manifest,'custom-phase-exception'),phaseId:id});
  assert.equal(result.record.binding.phase,id);assert.equal(result.currentPhase,id);await f.review(id);
  assert.equal((await f.capture()).workflow.status,'closed');assert.deepEqual((await f.capture()).workflow.phases.intake,original);
});
