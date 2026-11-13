/** A second device cannot use the first device's private draft, source path or executor. */
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,cp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {createFilesystemNamespaceStore} from '../src/sda/filesystem-namespace-adapter.mjs';import {openNativeSqliteDatabase} from '../src/sda/sqlite-native.mjs';
import {createSqliteContentStore} from '../src/sda/sqlite-content-adapter.mjs';import {createNamespaceDraftStore} from '../src/engine-storage/namespace-draft-store.mjs';
import {createFilesystemSourceUnit,createFilesystemSourceContentReader} from '../src/sgos/filesystem-source-unit.mjs';
import {createNodeCheckExecutionUnit} from '../src/sgos/node-check-execution-unit.mjs';import {createNodeExecutionOwner} from '../src/sgos/node-execution-owner.mjs';
test('a new device opens a reviewed successor from the published artifact and actual new checkout without the old draft or source',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite'}),publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
  f.control.permissions.push('phase.begin','phase.rollover');await f.engine.run('phase.publish',publish);
  const previous=createNamespaceDraftStore({records:f.localRecords,content:f.localContent,scope:f.scope,workId:f.inputs.workId,phaseId:'build'}),old=await previous.capture(),
    device=await mkdtemp(path.join(os.tmpdir(),'sflow-source-opening-device-')),root=path.join(device,'checkout'),binding={kind:'machine-local',deviceId:'takeover-device'};
  await cp(f.root,root,{recursive:true});await rm(f.root,{recursive:true,force:true});await mkdir(path.join(device,'private'));
  const records=await createFilesystemNamespaceStore({root:path.join(device,'private/records'),binding,create:true}),database=await openNativeSqliteDatabase(path.join(device,'private/content.db')),
    content=createSqliteContentStore({database,binding,create:true});t.after(async()=>{database.close();await rm(device,{recursive:true,force:true,maxRetries:5});});
  await writeFile(path.join(root,'src/converter.js'),converterSource+'// This successor was authored on the second device.\n');
  const source=await createFilesystemSourceUnit({root,id:'clause-source-0',projectId:f.scope.projectId,repositoryId:'app'}),
    reader=await createFilesystemSourceContentReader({root,id:'clause-content-0',source:source.descriptor}),template=f.checks.bindings[0],
    environment={...template.environment,SINGULARITY_FLOW_NODE_TEST_ROOT:root},unit=await createNodeCheckExecutionUnit({id:'second-device-tests',root,
      projectId:f.scope.projectId,repositoryId:'app',content:f.content,command:{executable:process.execPath,executableSha256:template.executableSha256,
        arguments:['--test','test/converter.test.js'],environment},report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256}),
    checks={owner:createNodeExecutionOwner({hostId:'second-device-worker'}),bindings:[{...template,environment,unit}]},
    engine=f.make({working:{records,content},sources:[source],sourceReaders:[reader],checks}),
    preview=await engine.run('phase.rollover',{phaseId:'build'});
  assert.equal(preview.plan.review.draft,null);assert.equal(preview.plan.review.artifact.content.namespace,'evidence');assert.equal(preview.plan.review.changedPathCount,1);
  assert.equal((await engine.run('phase.draft.read',{phaseId:'build'})).manifest.status,'missing');
  await engine.run('phase.rollover',{phaseId:'build',confirm:preview.plan.confirmation});
  const draft=(await engine.run('phase.draft.read',{phaseId:'build'})).manifest;assert.equal(draft.draft.generation,2);
  assert.match(draft.artifact.content.text,/converter and its exact pinned regression/u,'the original published summary is copied into the new device, never replaced with a template');
  assert.deepEqual(await previous.capture(),old,'the old device draft is neither read through a port nor updated');
  await engine.run('phase.source.retain',{operationId:'second-device-source',workId:f.inputs.workId,phaseId:'build'});
  const run=await engine.run('phase.checks.run',{operationId:'second-device-checks',workId:f.inputs.workId,phaseId:'build'});assert.equal(run.checks[0].tests.passed,1);
  await engine.run('phase.publish',publish);await f.approve('build');assert.equal((await f.capture()).workflow.phases.build.generation,2);
});
