import assert from 'node:assert/strict';import {readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './namespace-release-fixture.mjs';
import {createNamespaceCodeHistoryReader} from '../../src/engine-storage/namespace-code-history.mjs';
import {createNamespaceStoryObserver} from '../../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePublicationReader} from '../../src/engine-storage/namespace-publication-reader.mjs';
import {createNamespacePhaseCheckReader} from '../../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';

export async function namespaceCodeReworkCase(t,backend){
  const f=await namespaceReleaseFixture(t,{backend,loop:true}),original=await f.published('build'),source=await readFile(path.join(f.root,'src/converter.js'));
  await f.write('release',releaseReport('partial'));await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});const oldRelease=await f.published('release');
  assert.equal(oldRelease.report.gaps.length,2);assert.ok(oldRelease.report.rows.every(row=>row.verdict==='partial'));
  await f.approve('release',undefined,{verdict:'Repair'});let state=await f.capture();
  assert.equal(state.workflow.currentPhase,'build');assert.equal(state.workflow.phases.build.generation,1);assert.equal(state.workflow.changeRequests[0].status,'open');
  const historyReader=createNamespaceCodeHistoryReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId});
  for(const mutate of [w=>{w.changeRequests[0].reason='Copied return';},w=>{w.phases.build.reworkRevalidation.invalidatedAt='2026-01-01T00:00:00.000Z';}]){
    const changed=structuredClone(state);mutate(changed.workflow);await assert.rejects(historyReader.opening(changed,'build'),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  f.control.agentId='analyst';await f.write('build','# Repaired implementation\n\n## Agent brief\n\nPreserve the original converter and add another executable boundary regression. This generation runs its own tests.\n');
  const testFile=path.join(f.root,'test/converter.test.js');await writeFile(testFile,(await readFile(testFile,'utf8'))+"\ntest('converts the next boundary',()=>assert.equal(convert(256),'100'));\n");
  await f.engine.run('phase.source.retain',{operationId:'rework-source',workId:f.inputs.workId,phaseId:'build'});const before=await f.head();
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',...releasePublish}),{code:'ENGINE_CHECK_EVIDENCE_REQUIRED'});assert.deepEqual(await f.head(),before);
  const tests=await f.engine.run('phase.checks.run',{operationId:'rework-tests',workId:f.inputs.workId,phaseId:'build'});assert.equal(tests.checks[0].tests.passed,2);
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});const successor=await f.published('build');
  assert.equal(successor.policy.kind,'code-delivery/v2');assert.equal(successor.manifest.schemaVersion,2);assert.equal(successor.report.schemaVersion,2);
  const history=successor.report.preflight.history;assert.deepEqual(history.predecessor.publication,original.binding);assert.equal(history.return.request.id,'CR-001');
  assert.deepEqual(history.repositories[0].changes.map(row=>row.path),['test/converter.test.js']);assert.deepEqual(await readFile(path.join(f.root,'src/converter.js')),source);
  await f.approve('build');state=await f.capture();assert.equal(state.workflow.changeRequests[0].status,'resolved');assert.equal(state.workflow.phases.build.publicationBindings.length,2);
  f.control.agentId='release-reviewer';await f.write('release',releaseReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});
  const final=await f.published('release');assert.equal(final.value.generation,2);assert.equal(final.report.inputs.inputs[0].generation,2);assert.equal(final.report.inputs.inputs[0].tests[0].tests.passed,2);
  await f.approve('release',undefined,{verdict:'Pass'});assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),2);
  const observer=createNamespaceStoryObserver(f.common),checks=createNamespacePhaseCheckReader({...f.common,observer}),
    reader=createNamespacePublicationReader({observer,checks,scope:f.scope,workId:f.inputs.workId});
  for(const [phase,originalPublication]of [['build',original],['release',oldRelease]]){
    assert.deepEqual(await reader.accepted(originalPublication.binding,phase),originalPublication.value);
    assert.deepEqual(await f.json(originalPublication.manifest.report),originalPublication.report);
  }
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('A successor replay cannot restamp the workflow.');}}});
  for(const phaseId of ['build','release'])assert.equal((await replay.run('phase.publish',{phaseId,...releasePublish})).status,'retained');
}
