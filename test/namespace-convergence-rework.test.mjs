/** A real producer return changes the evidence basis, not the prospective convergence generation. */
import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceConvergenceFixture} from './helpers/namespace-convergence-fixture.mjs';
import {releasePublish} from './helpers/namespace-release-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
for(const backend of ['sqlite','application','filesystem'])test(backend+': convergence rework retains original human answers and requires a new judgment of the actual replacement Code',{timeout:600000},async t=>{
  const f=await namespaceConvergenceFixture(t,{backend}),before=await f.engine.run('convergence.context',{phaseId:'release'}),
    original=before.manifest.projection.projection.settledByPlan.find(row=>row.paths.includes('README.md'));
  await f.engine.run('phase.prepare',{phaseId:'release'});const oldDraft=await f.engine.run('phase.draft.read',{phaseId:'release'});
  const first={operationId:'require-reviewed-document-repair',phaseId:'release',itemId:original.id,disposition:'rework',expectedContext:before.manifest.contextBinding,
    reason:'Repair the actual converter documentation before this delivery advances.'};
  const answer=await f.reviewer.run('convergence.adjudicate',first);
  await f.engine.run('phase.prepare',{phaseId:'release'});
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'release'}),{code:'CONVERGENCE_REVIEW_REQUIRED'});
  const raised=await f.reviewer.run('upstream.raise',{operationId:'raise-convergence-producer-repair',phaseId:'build',about:'the reviewed converter documentation',
    problem:'The convergence reviewer requires this supporting documentation to be repaired and revalidated by its original Code producer.',authored:'human',proposed:'return'});
  const request={operationId:'return-convergence-code-owner',issueId:raised.records[0].id,outcome:'return',
    reason:'Repair the exact producer documentation and retain a fresh independently reviewed Code execution.'};
  const returned=await f.reviewer.run('upstream.decide',request);assert.equal(returned.currentPhase,'build');
  f.control.agentId='analyst';await f.write('build','# Repaired converter documentation\n\n## Agent brief\n\nKeep the original behavior and rerun its exact approved regression after the supporting documentation repair.\n');
  await writeFile(path.join(f.root,'README.md'),'# Converter\n\nThe converter returns FF for 255. Run the exact approved test with node --test test/converter.test.js.\n');
  await f.engine.run('phase.source.retain',{operationId:'convergence-repaired-source',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('convergence-repaired-execution');await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.approve('build');
  f.control.agentId='release-reviewer';const successor=(await f.engine.run('convergence.context',{phaseId:'release'})).manifest,
    projection=successor.projection.projection,item=projection.facts.find(row=>row.paths.includes('README.md'));
  assert.equal(successor.generation,1);assert.equal(successor.projection.iteration,2);assert.ok(item,'the approved plan cannot silently settle a path the human returned');
  assert.deepEqual(projection.findings,[]);assert.equal(successor.decisions.length,1);assert.notEqual(successor.sourceSha256,before.manifest.sourceSha256);
  assert.equal((await f.capture()).workflow.phases.release.generation,0);
  const judged={operationId:'accept-repaired-document',phaseId:'release',itemId:item.id,disposition:'dismissed',expectedContext:successor.contextBinding,
    reason:'The independent reviewer inspected the corrected retained documentation and the actual replacement Code execution.'};
  const accepted=await f.reviewer.run('convergence.adjudicate',judged);assert.equal(accepted.record.adjudication.replaced,undefined,'a new input basis is not a change to the original answer');
  const prepared=await f.engine.run('phase.prepare',{phaseId:'release'});assert.equal(prepared.manifest.convergence.iteration,2);
  const newDraft=await f.engine.run('phase.draft.read',{phaseId:'release'});assert.notEqual(newDraft.manifest.draft.bodySha256,oldDraft.manifest.draft.bodySha256);
  await f.engine.run('phase.publish',{phaseId:'release'});const review=await f.engine.run('convergence.advance',{});
  await f.engine.run('convergence.advance',{confirmation:review.confirmationDigest});await f.approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),2);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,access:f.reviewerAccess,clock:{now(){throw Error('Historical convergence replay cannot create another decision time.');}}});
  assert.deepEqual(await replay.run('convergence.adjudicate',first),answer);
  assert.deepEqual(await replay.run('convergence.adjudicate',judged),accepted);
  assert.deepEqual(await replay.run('upstream.decide',request),returned);
});
