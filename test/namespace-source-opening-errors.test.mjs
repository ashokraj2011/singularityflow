/** Exercise real local/source/shared boundaries; confirmation never grants lifecycle authority. */
import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,mkdir,readFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceSourceClauseFixture,converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespaceDraftStore} from '../src/engine-storage/namespace-draft-store.mjs';
import {namespaceReviewedSourceOpening} from '../src/engine-storage/namespace-generation-reader.mjs';
import {namespaceSourceOpeningPolicies} from '../src/kernel/source-opening.mjs';import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'},file=f=>path.join(f.root,'src/converter.js'),
  local=f=>createNamespaceDraftStore({records:f.localRecords,content:f.localContent,scope:f.scope,workId:f.inputs.workId,phaseId:'build'}),
  rules=namespaceSourceOpeningPolicies(NODE_TEXT_DIGESTS);
test('engine-owned report drift does not become a dirty application start or require source adoption',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite',beforePrepare:async(f,engine,roots)=>{
    f.control.permissions.push('phase.begin');await mkdir(path.join(roots[0],'.sflow/results'),{recursive:true});
    await writeFile(path.join(roots[0],'.sflow/results/history.json'),'{"retained":true}\n');
    const before=await f.head();assert.equal((await engine.run('phase.begin',{phaseId:'build'})).status,'begun');assert.deepEqual(await f.head(),before);
    const store=local(f),draft=await store.capture(),generation=JSON.parse(Buffer.from(await store.bytes(draft.payload.generationIntent.record))),
      opening=namespaceReviewedSourceOpening(generation),view=rules.summary(opening.context);
    assert.equal(generation.schemaVersion,4);assert.equal(opening.confirmation,null);assert.equal(view.dirtyStartPolicy,'block');
    assert.equal(view.changedPathCount,0);assert.equal(view.repositories[0].totals.changes,0);assert.equal(view.repositories[0].snapshotTotals.changes,1);
  }});
  await f.engine.run('phase.publish',publish);await f.approve('build');assert.equal(await readFile(path.join(f.root,'.sflow/results/history.json'),'utf8'),'{"retained":true}\n');
});
for(const mode of ['pinned-policy','protected-path','source-boundary'])test(mode+': initial adoption cannot override the real pinned source policy',{timeout:120000},async t=>{
  await namespaceSourceClauseFixture(t,{backend:'sqlite',configure:source=>{
    source.definition.codeDelivery.generationBoundary={dirtyStart:mode==='pinned-policy'?'block':'allow-explicit-adoption'};
    if(mode==='protected-path')source.definition.governance={...source.definition.governance,protectedPaths:['src/converter.js']};
    if(mode==='source-boundary')source.definition.phases.build.sourceBoundary='test-automation';
  },beforePrepare:async(f,engine,roots)=>{
    f.control.permissions.push('phase.begin','phase.rollover');const before=await f.head();await writeFile(path.join(roots[0],'src/converter.js'),converterSource);
    await assert.rejects(engine.run('phase.rollover',{phaseId:'build'}),{code:'GENERATION_ROLLOVER_UNAVAILABLE'});
    let preview;await assert.rejects(engine.run('phase.begin',{phaseId:'build'}),error=>{preview=error.details;return error.code==='GENERATION_DIRTY_START';});
    assert.equal(preview.review.violationCount,mode==='pinned-policy'?0:1);
    await assert.rejects(engine.run('phase.begin',{phaseId:'build',adoptExisting:true,confirm:preview.confirmation}),{code:'GENERATION_DIRTY_START'});
    assert.deepEqual(await f.head(),before);assert.equal((await engine.run('phase.draft.read',{phaseId:'build'})).manifest.status,'missing');
    await writeFile(path.join(roots[0],'src/converter.js'),'export const convert=value=>String(value);\n');
  }});
});
test('a clean successor keeps its original intent and does not become an unconfirmable rollover loop',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite'});f.control.permissions.push('phase.begin','phase.rollover');await f.engine.run('phase.publish',publish);
  await assert.rejects(f.engine.run('phase.rollover',{phaseId:'build'}),error=>error.code==='GENERATION_ROLLOVER_UNAVAILABLE'&&error.details.actions[0].operation==='phase.begin');
  const begun=await f.engine.run('phase.begin',{phaseId:'build'});assert.equal(begun.generation,2);
  assert.equal((await f.engine.run('phase.begin',{phaseId:'build'})).status,'retained');
  await assert.rejects(f.engine.run('phase.rollover',{phaseId:'build'}),error=>error.code==='GENERATION_ROLLOVER_UNAVAILABLE'&&error.details.actions[0].operation==='phase.begin');
  await f.engine.run('phase.source.retain',{operationId:'clean-successor-source',workId:f.inputs.workId,phaseId:'build'});await f.runChecks('clean-successor-checks');
  await f.engine.run('phase.publish',publish);await f.approve('build');assert.equal(f.starts(),2);
});
test('a submitted Code packet refuses both local opening paths and keeps its exact review and private draft',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite'});f.control.permissions.push('phase.begin','phase.rollover');
  await f.engine.run('phase.publish',publish);await f.engine.run('phase.submit',{phaseId:'build'});const head=await f.head(),draft=await local(f).capture();
  for(const operation of ['phase.begin','phase.rollover'])await assert.rejects(f.engine.run(operation,{phaseId:'build'}),error=>
    error.code==='GENERATION_ROLLOVER_REVIEW_REQUIRED'&&error.details.actions[0].operation==='phase.review');
  assert.deepEqual(await f.head(),head);assert.deepEqual(await local(f).capture(),draft);
});
test('source opening checks its own permission before reading private or shared archives',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite',run:false}),forbidden=()=>{throw Error('An unauthorized source opening cannot read archives.');};
  f.control.permissions=f.control.permissions.filter(row=>!['phase.begin','phase.rollover'].includes(row));
  const engine=f.make({records:{...f.records,read:forbidden},content:{...f.content,read:forbidden},working:{records:{...f.localRecords,read:forbidden},content:{...f.localContent,read:forbidden}}});
  for(const operation of ['phase.begin','phase.rollover'])await assert.rejects(engine.run(operation,{phaseId:'build'}),error=>error.code==='ENGINE_AUTHORITY_REQUIRED'&&error.details.permission===operation);
});
test('a changed opening actor cannot save a successor, and a lost local acknowledgement retains the original accepted intent',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite'});f.control.permissions.push('phase.rollover');await f.engine.run('phase.publish',publish);
  await writeFile(file(f),converterSource+'// Review the exact local successor.\n');const input={phaseId:'build',confirm:(await f.engine.run('phase.rollover',{phaseId:'build'})).plan.confirmation},
    before=await local(f).capture(),principal=f.control.principalId;
  await assert.rejects(f.make({clock:{async now(){f.control.principalId='another-author';return f.clock.now();}}}).run('phase.rollover',input),{code:'ENGINE_ACTOR_CHANGED'});
  f.control.principalId=principal;assert.deepEqual(await local(f).capture(),before);
  const timeout=Object.freeze(Object.assign(Error('The actual private opening acknowledgement was lost.'),{code:'ETIMEDOUT',details:{deadlineMs:300000}}));let lost=false;
  const records={...f.localRecords,async transact(...args){const result=await f.localRecords.transact(...args);if(!lost){lost=true;throw timeout;}return result;}};
  await assert.rejects(f.make({working:{records,content:f.localContent}}).run('phase.rollover',input),error=>error===timeout);assert.equal(lost,true);
  const accepted=await local(f).capture();assert.equal(accepted.payload.generation,2);
  const repeat=await f.make({sources:f.sources.map(source=>({...source,capture(){throw Error('Do not recapture an already accepted opening.');}})),
    clock:{now(){throw Error('Do not restamp an already accepted opening.');}}}).run('phase.rollover',input);
  assert.equal(repeat.status,'retained');assert.equal(repeat.effects.generationOpened,false);assert.deepEqual(await local(f).capture(),accepted);
  const generation=JSON.parse(Buffer.from(await local(f).bytes(accepted.payload.generationIntent.record))),opening=namespaceReviewedSourceOpening(generation);
  for(const code of ['EACCES','ETIMEDOUT']){const original=Object.freeze(Object.assign(Error('The original opening basis could not be read.'),{code,details:{deadlineMs:6723}})),
    content={...f.content,read(scope,reference,options){if(reference.sha256===opening.context.basis.head.state.sha256)throw original;return f.content.read(scope,reference,options);}};
    await assert.rejects(f.make({content}).run('phase.rollover',input),error=>error===original);assert.deepEqual(await local(f).capture(),accepted);}
  assert.equal(rules.assert(opening),opening);
  for(const change of [c=>{c.generation=0;},c=>{c.repositories[0].baseline.content.sha256='invalid';},c=>{c.previousDraft.revision=null;},c=>{c.kind='initial';},
    c=>{c.commands=['shell'];},c=>{c.basis.head=null;},c=>{c.basis.head={};},c=>{c.basis.revision=null;}]){
    const bad=structuredClone(opening);change(bad.context);await assert.rejects(async()=>rules.assert(bad),{code:'ENGINE_STORAGE_CORRUPT'});}
  const future=structuredClone(opening);future.context.schemaVersion=2;assert.throws(()=>rules.assert(future),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  const row=opening.context.repositories[0],baseline=await f.json(row.baseline.content),tampered=structuredClone(row.changes);tampered.entries[0].before.sha256='a'.repeat(64);
  assert.throws(()=>rules.restored(baseline,tampered,row.repository.descriptor),{code:'ENGINE_STORAGE_CORRUPT'});
});
test('a shared decision cannot relabel an open successor; exact rebase preserves its original confirmed opening',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite'});f.control.permissions.push('phase.begin','phase.rollover','decision.plan');await f.engine.run('phase.publish',publish);
  await writeFile(file(f),converterSource+'// Keep the reviewed successor through plan accounting.\n');const view=await f.engine.run('phase.rollover',{phaseId:'build'});
  await f.engine.run('phase.rollover',{phaseId:'build',confirm:view.plan.confirmation});
  const author={principalId:f.control.principalId,agentId:f.control.agentId,creator:f.control.creator};
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  await f.engine.run('decision.plan',{operationId:'account-after-reviewed-opening',changes:[{kind:'add-location',clauseId:'STORY-1:REQ-001',path:'src/test/setup.js'}],
    reason:'Account for a possible in-scope test support file without changing product acceptance.'});Object.assign(f.control,author);
  const before=await local(f).capture();let route;
  for(const operation of ['phase.begin','phase.rollover'])await assert.rejects(f.engine.run(operation,{phaseId:'build'}),error=>{
    route=error.details;return error.code==='ENGINE_DRAFT_BASIS_CHANGED'&&route.operation==='phase.draft.rebase';});
  assert.deepEqual(await local(f).capture(),before);await f.engine.run('phase.draft.rebase',{operationId:'continue-reviewed-opening',workId:f.inputs.workId,phaseId:'build',
    expectedRevision:route.revision,confirm:route.confirm,reason:'Keep this same generation and original source confirmation after the reviewed plan decision.'});
  const next=await local(f).capture(),generation=JSON.parse(Buffer.from(await local(f).bytes(next.payload.generationIntent.record)));
  assert.equal(generation.schemaVersion,2);assert.equal(namespaceReviewedSourceOpening(generation).confirmation,view.plan.confirmation);assert.equal(next.payload.generation,2);
  await f.engine.run('phase.source.retain',{operationId:'continued-reviewed-source',workId:f.inputs.workId,phaseId:'build'});await f.runChecks('continued-reviewed-checks');
  assert.equal((await f.engine.run('phase.publish',publish)).status,'published');await f.approve('build');
});
