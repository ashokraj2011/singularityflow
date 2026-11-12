import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceTargetedRepairFixture,unrelatedSource,targetedReport} from './helpers/namespace-targeted-repair-fixture.mjs';
import {releasePublish} from './helpers/namespace-release-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceCodeHistoryReader} from '../src/engine-storage/namespace-code-history.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
for(const backend of ['sqlite','application','filesystem'])test(backend+': a second Code rejection preserves earlier scope without applying it to the new return',{timeout:600000},async t=>{
  const f=await namespaceTargetedRepairFixture(t,{backend,budget:false}),first=await f.reviewer.run('phase.reject',f.request);
  await f.begin();await f.engine.run('phase.source.retain',{operationId:'repeated-first-source',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('repeated-first-checks');await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});
  const previous=await f.published('build');assert.equal(previous.report.preflight.history.profile,'sflow-namespace-code-history/v8');
  await f.engine.run('phase.submit',{phaseId:'build'});const review=await f.reviewer.run('phase.review',{phaseId:'build'}),
    request={phaseId:'build',target:'build',reason:'Review the next complete Code delivery without carrying the earlier clause-only repair restriction.',confirm:review.manifest.reviewBinding.packetSha256},
    returned=await f.reviewer.run('phase.reject',request);assert.equal(returned.changeRequest.id,'CR-002');
  const snapshot=await f.capture();assert.equal(snapshot.workflow.changeRequests.filter(row=>row.status==='open'&&row.targetPhase==='build').length,2);
  const reader=createNamespaceCodeHistoryReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId}),forged=structuredClone(snapshot);
  forged.workflow.changeRequests[0].comment='A copied earlier return cannot authorize another generation.';
  await assert.rejects(reader.opening(forged,'build'),{code:'ENGINE_STORAGE_CORRUPT'});
  f.control.agentId='analyst';const entry=await f.engine.run('phase.enter',{phaseId:'build'});assert.equal(entry.manifest.repairScope??null,null);
  await f.write('build','# Second Code repair\n\n## Agent brief\n\nPreserve both approved behaviors, account for the complete Code scope and execute its actual checks.\n');
  await writeFile(path.join(f.root,'src/other.js'),unrelatedSource+'// This separately planned path belongs to the complete current repair.\n');
  await f.engine.run('phase.source.retain',{operationId:'repeated-second-source',workId:f.inputs.workId,phaseId:'build'});
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',...releasePublish}),{code:'ENGINE_CHECK_EVIDENCE_REQUIRED'});
  await f.runChecks('repeated-second-checks');await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});
  const delivered=await f.published('build'),history=delivered.report.preflight.history;assert.equal(history.profile,'sflow-namespace-code-history/v10');
  assert.equal(history.return.request.id,returned.changeRequest.id);assert.equal(history.earlierReturns.length,1);
  assert.equal(history.earlierReturns[0].changeRequestId,first.changeRequest.id);assert.equal(history.earlierReturns[0].generation,1);
  assert.equal(history.targeted??null,null);assert.ok([24,25,26,27].includes(delivered.manifest.schemaVersion));
  assert.deepEqual(history.predecessor.publication,previous.binding);assert.ok(history.repositories[0].changes.some(row=>row.path==='src/other.js'));
  await f.approve('build');f.control.agentId='release-reviewer';await f.write('release',targetedReport());
  await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  const final=await f.capture();assert.equal(final.workflow.status,'closed');assert.equal(f.starts(),3);
  assert.deepEqual(await f.json(previous.manifest.report),previous.report);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,access:f.reviewerAccess,clock:{now(){throw Error('Accepted returns cannot consume another generation.');}}});
  assert.deepEqual(await replay.run('phase.reject',f.request),first);assert.deepEqual(await replay.run('phase.reject',request),returned);
  assert.deepEqual(await f.capture(),final);
});
