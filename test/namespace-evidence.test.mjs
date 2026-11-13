import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {namespaceSpecificationFixture,specificationText} from './helpers/namespace-specification-fixture.mjs';
import {namespaceForwardFixture} from './helpers/namespace-forward-fixture.mjs';
import {namespaceMultipleCodeCase} from './helpers/namespace-multiple-code-case.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
const grant=f=>(f.control.permissions??f.control.creator.permissions).push('story.evidence');
for(const backend of ['filesystem','sqlite','application'])test(backend+' retained evidence projection is read-only and survives shared-only takeover',async t=>{
  const f=await namespaceEngineFixture(t,{backend});await f.bootstrap();await f.author();await f.review();grant(f);
  const before=await f.capture(),view=await f.engine.run('story.evidence',{}),shared=await f.make({working:null}).run('story.evidence',{});
  assert.equal(view.manifest.profile,'sflow-namespace-evidence-context/v1');assert.equal(view.manifest.workId,f.workId);
  assert.equal(view.manifest.report.mode,'projection');assert.equal(view.manifest.terminalDecision,false);
  assert.equal(view.manifest.localSourceChecked,false);assert.ok(view.manifest.references.length>0);
  assert.deepEqual(shared,view);assert.deepEqual(await f.capture(),before);
  assert.deepEqual(view.effects,{committed:false,pushed:false,testsRun:false,modelInvocations:0,approvalRecorded:false,storyAdvanced:false});
});
test('Code projection joins actual exact tests and original independent approvals without rerunning or reading source files',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite'});grant(f);
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});await f.approve('build');
  const before=await f.capture(),starts=f.starts(),view=await f.engine.run('story.evidence',{}),criterion=view.manifest.report.rows.find(row=>row.id==='STORY-1:AC-001');
  assert.ok(criterion);assert.equal(criterion.obligations.find(row=>row.responsibility==='implement').status,'met');
  const verify=criterion.obligations.find(row=>row.responsibility==='verify');assert.equal(verify.facets.execution,'passed');assert.equal(verify.status,'met');
  assert.equal(f.starts(),starts);assert.deepEqual(await f.capture(),before);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const shared=createNamespaceEngine({...f.common,access:f.access??f.common.access});
  assert.deepEqual((await shared.run('story.evidence',{})).manifest.report,view.manifest.report);
  assert.equal(f.starts(),starts);
});
test('missing, denied and timed-out original evidence retains its actual error; no view is fabricated',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite'});await f.bootstrap();await f.author();await f.review();grant(f);
  const view=await f.engine.run('story.evidence',{}),target=view.manifest.references[0];
  for(const code of ['EACCES','ETIMEDOUT','ENGINE_STORAGE_CONTENT_MISSING']){
    const failure=Object.freeze(Object.assign(Error('The actual retained bytes are unavailable.'),{code,path:'original-evidence',details:{deadlineMs:317}})),
      guarded=f.make({working:null,content:{...f.content,read(scope,ref,options){if(ref.sha256===target.sha256)throw failure;return f.content.read(scope,ref,options);}}});
    await assert.rejects(guarded.run('story.evidence',{}),error=>error===failure);
  }
});
test('a private specification draft cannot become retained evidence in the shared view',async t=>{
  const f=await namespaceSpecificationFixture(t,{backend:'sqlite'});grant(f);
  await f.engine.run('phase.prepare',{phaseId:'intake'});const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'unpublished-specification',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(specificationText),reason:'Preserve an actual private authored definition without publication.'});
  const before=await f.capture(),engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:{...f.localContent,
    read(){throw Error('The retained evidence view must not inspect a private authoring file.');}}}}),view=await engine.run('story.evidence',{});
  assert.ok(view.manifest.excluded.some(row=>row.phase==='intake'&&row.reason==='generation-required'));
  assert.equal(view.manifest.report.rows.some(row=>row.type==='REQ'||row.type==='AC'),false);
  for(const ref of view.manifest.references)assert.equal((await f.content.read(f.scope,ref)).status,'present');
  assert.deepEqual(await f.capture(),before);
});
test('amendment evidence uses the actual replacement and original reader revalidation',async t=>{
  const f=await namespaceForwardFixture(t,{backend:'sqlite'});grant(f);
  const original=await f.engine.run('story.evidence',{});await f.propose();await f.decide();
  await f.engine.run('forward-amendment.revalidate',{operationId:'evidence-reader-revalidated',workId:f.workId,phaseId:'design',amendmentId:'FAM-001',outcome:'unchanged',
    reason:'The actual reviewed design remains valid for this exact independently approved replacement.'});
  const view=await f.engine.run('story.evidence',{}),snapshot=await f.capture(),binding=snapshot.workflow.phases.intake.publicationBindings.at(-1),publication=JSON.parse(Buffer.from((await f.content.read(f.scope,binding.record)).data));
  assert.notEqual(view.manifest.report.inputSha256,original.manifest.report.inputSha256);
  assert.ok(view.manifest.references.some(row=>row.sha256===publication.artifact.content.sha256));
  assert.deepEqual((await f.make({working:null}).run('story.evidence',{})).manifest.report,view.manifest.report);
});
test('a changed reader identity is refused at the final fresh check without recording an effect',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite'});await f.bootstrap();grant(f);const before=await f.capture();let calls=0;
  const engine=f.make({access:{async current(request){const facts=await f.access.current(request);
    return request.operation==='story.evidence'&&++calls===2?{...facts,principalId:'another-person'}:facts;}}});
  await assert.rejects(engine.run('story.evidence',{}),{code:'ENGINE_ACTOR_CHANGED'});assert.deepEqual(await f.capture(),before);
});
test('three Code phases across two repositories keep every exact witness separate after source removal',{timeout:120000},async t=>{
  const {f}=await namespaceMultipleCodeCase(t,'sqlite',{repositories:2});grant(f);
  const snapshot=await f.capture(),view=await f.engine.run('story.evidence',{}),criteria=view.manifest.report.rows.filter(row=>row.type==='AC');
  assert.equal(criteria.length,3);
  for(const row of criteria){assert.equal(row.obligations.find(value=>value.responsibility==='implement').status,'met');
    const verification=row.obligations.find(value=>value.responsibility==='verify');assert.equal(verification.status,'met',JSON.stringify({id:row.id,verification:row.verification,findings:row.findings}));assert.equal(verification.facets.execution,'passed');}
  assert.deepEqual(await f.capture(),snapshot);
});
