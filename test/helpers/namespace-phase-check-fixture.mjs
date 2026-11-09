/** Actual bound test execution over a configured namespace Story, never seeded test evidence. */
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {namespacePreparationFixture} from './namespace-preparation-fixture.mjs';
import {createNamespacePhaseChecksEngine} from '../../src/engine-storage/namespace-phase-checks.mjs';
import {createNamespaceSourceEngine} from '../../src/engine-storage/namespace-source.mjs';
import {createFilesystemSourceUnit} from '../../src/sgos/filesystem-source-unit.mjs';
import {createNodeCheckExecutionUnit} from '../../src/sgos/node-check-execution-unit.mjs';
import {createNodeExecutionOwner} from '../../src/sgos/node-execution-owner.mjs';
import {createNamespaceLifecycleObserver} from '../../src/engine-storage/namespace-lifecycle-reader.mjs';
const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
const command={id:'node-tests',argv:['node','--test','--test-reporter=tap','case.test.mjs'],kind:'test',modelPolicy:'never',
  result:{adapter:'node-tap',path:'results/tests.tap'}};
const input={operationId:'check-one',workId:'portable-story',phaseId:'intake'};
export async function namespacePhaseCheckFixture(t,{backend='filesystem',failing=false,modify=()=>{},configure=()=>{}}={}) {
  const f=await namespacePreparationFixture(t,{backend,configure:source=>{source.definition.phases.intake.qualityCommands=[command];configure(source);}});
  const root=path.join(f.directory,'checkout');await mkdir(root);
  await writeFile(path.join(root,'case.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('actual pinned check',()=>assert.equal(2+2,"+(failing?'5':'4')+"));");
  const source=await createFilesystemSourceUnit({root,id:'app-checkout',projectId:f.scope.projectId,repositoryId:'app'});
  const options={records:f.records,content:f.content,localRecords:f.localRecords,localContent:f.localContent,scope:f.scope,
    workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock,sources:[source]};
  await createNamespaceSourceEngine(options).run('source.bind',{operationId:'source-for-checks',workId:f.inputs.workId,
    expectedRevision:f.story.revision,repositories:['app'],reason:'Select the real repository for phase checks.'});
  const control={starts:0};
  const raw=await createNodeCheckExecutionUnit({id:'node-phase-check',root,projectId:f.scope.projectId,repositoryId:'app',content:f.content,
    command:{executable:process.execPath,executableSha256,arguments:command.argv.slice(1),environment:{}},
    report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256});
  const unit={...raw,start(task){control.starts++;return raw.start(task);}};
  const owner=createNodeExecutionOwner({hostId:'phase-check-host'}),checks={owner,bindings:[{phaseId:'intake',commandId:command.id,repositoryId:'app',
    executable:'node',executableSha256,environment:{},unit}]};
  modify({checks,options,control});f.control.permissions.push('phase.checks.run');
  const make=extra=>createNamespacePhaseChecksEngine({...options,checks,...extra}),engine=make();
  await engine.run('phase.prepare');const draft=await engine.run('phase.draft.read',{phaseId:'intake'});
  const reference=await f.upload('# Checked artifact\n\nThe authored phase artifact has meaningful observed content.');
  await engine.run('phase.draft.write',{operationId:'author-for-checks',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:reference,reason:'Complete the actual phase artifact before executing its pinned checks.'});
  const boundInput={...input,workId:f.inputs.workId};
  const state=()=>createNamespaceLifecycleObserver(options).capture();
  return {...f,accessControl:f.control,root,source,control,options,checks,make,engine,input:boundInput,state};
}
