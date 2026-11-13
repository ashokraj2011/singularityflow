import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceDraftStore} from '../src/engine-storage/namespace-draft-store.mjs';
const publish={authored:'governed-agent',channel:'copilot-host'};
test('initial source adoption requires the exact policy-permitted current boundary before any generation is opened',{timeout:120000},async t=>{
  let opening;
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite',configure:source=>{source.definition.codeDelivery.generationBoundary={dirtyStart:'allow-explicit-adoption'};},
    beforePrepare:async(f,engine,roots)=>{
      f.control.permissions.push('phase.begin','phase.rollover');await writeFile(path.join(roots[0],'src/converter.js'),converterSource);
      const before=await f.head();let preview;
      await assert.rejects(engine.run('phase.begin',{phaseId:'build'}),error=>{preview=error.details;return error.code==='GENERATION_DIRTY_START'&&preview.review.changedPathCount===1;});
      await assert.rejects(engine.run('phase.begin',{phaseId:'build',adoptExisting:true,confirm:'sha256:'+'0'.repeat(64)}),{code:'GENERATION_DIRTY_START'});
      assert.equal((await engine.run('phase.draft.read',{phaseId:'build'})).manifest.status,'missing');assert.deepEqual(await f.head(),before);
      opening=await engine.run('phase.begin',{phaseId:'build',adoptExisting:true,confirm:preview.confirmation});assert.equal(opening.status,'begun');
      assert.equal((await engine.run('phase.begin',{phaseId:'build',adoptExisting:true,confirm:preview.confirmation})).status,'retained');
    }});
  assert.equal(opening.generation,1);await f.engine.run('phase.publish',{phaseId:'build',...publish});await f.approve('build');
  assert.equal((await f.capture()).workflow.phases.build.generation,1);
});
async function rolloverJourney(t,backend){
  const f=await namespaceTestWitnessFixture(t,{backend});f.control.permissions.push('phase.begin','phase.rollover');
  await f.engine.run('phase.publish',{phaseId:'build',...publish});const original=await f.capture(),old=original.workflow.phases.build.publicationBindings[0];
  await writeFile(path.join(f.root,'src/converter.js'),converterSource+'// An additional reviewed converter note.\n');
  const preview=await f.engine.run('phase.rollover',{phaseId:'build'});assert.equal(preview.status,'preview');assert.equal(preview.plan.schemaVersion,2);
  assert.equal(preview.plan.fromGeneration,1);assert.equal(preview.plan.toGeneration,2);assert.equal(preview.plan.review.changedPathCount,1);
  const before=await f.head();await assert.rejects(f.engine.run('phase.rollover',{phaseId:'build',confirm:'sha256:'+'0'.repeat(64)}),{code:'GENERATION_ROLLOVER_STALE'});
  assert.deepEqual(await f.head(),before);
  const begun=await f.engine.run('phase.rollover',{phaseId:'build',confirm:preview.plan.confirmation});assert.equal(begun.status,'begun');assert.equal(begun.generation,2);
  const repeat=await f.engine.run('phase.rollover',{phaseId:'build',confirm:preview.plan.confirmation});assert.equal(repeat.status,'retained');assert.equal(repeat.effects.generationOpened,false);
  assert.deepEqual((await f.capture()).workflow.phases.build.publicationBindings,[old]);
  const d=await f.engine.run('phase.draft.read',{phaseId:'build'});
  await f.engine.run('phase.draft.write',{operationId:'author-reviewed-successor',workId:f.inputs.workId,phaseId:'build',expectedRevision:d.manifest.draft.revision,
    content:await f.upload('# Implementation\n\n## Agent brief\n\nThe exact converter and acceptance test remain current; its reviewed documentation was clarified.\n'),reason:'Complete the actual successor artifact.'});
  await f.engine.run('phase.source.retain',{operationId:'retain-reviewed-successor',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('checks-reviewed-successor');await f.engine.run('phase.publish',{phaseId:'build',...publish});
  const current=await f.capture();assert.equal(current.workflow.phases.build.generation,2);assert.deepEqual(current.workflow.phases.build.publicationBindings[0],old);
  const publication=await f.json(current.workflow.phases.build.publicationBindings.at(-1).record);assert.ok(publication.policyEvidence.some(row=>row.kind==='code-delivery/v34'));
  await f.approve('build');assert.equal((await f.capture()).workflow.phases.build.status,'approved');
  await rm(f.root,{recursive:true,force:true});const shared=f.make({working:null,sources:[],sourceReaders:[],clock:{now(){throw Error('A retained publication cannot be restamped.');}}});
  assert.equal((await shared.run('phase.publish',{phaseId:'build',...publish})).status,'retained');
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': confirmed rollover preserves original evidence, fresh execution and independent approval',{timeout:180000},t=>rolloverJourney(t,backend));
test('a source race after preview refuses its confirmed opening and preserves the private draft',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite'});f.control.permissions.push('phase.rollover');await f.engine.run('phase.publish',{phaseId:'build',...publish});
  await writeFile(path.join(f.root,'src/converter.js'),converterSource+'// First reviewed note.\n');const view=await f.engine.run('phase.rollover',{phaseId:'build'}),
    store=createNamespaceDraftStore({records:f.localRecords,content:f.localContent,scope:f.scope,workId:f.inputs.workId,phaseId:'build'}),before=await store.capture();
  await writeFile(path.join(f.root,'src/converter.js'),converterSource+'// The source changed after that review.\n');
  await assert.rejects(f.engine.run('phase.rollover',{phaseId:'build',confirm:view.plan.confirmation}),{code:'GENERATION_ROLLOVER_STALE'});
  assert.deepEqual(await store.capture(),before);
});
