/** The actual offline package exposes the new registry vocabulary through its public types. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {copyFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';
import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('packed human decision and reviewer-return inputs resolve with NodeNext and reject identity overrides', {timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-human-types-')),
    artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp};
  const child=(executable,args,cwd,spawnOptions={})=>{const value=spawnSync(executable,args,{cwd,env,encoding:'utf8',timeout:60000,...spawnOptions});
    assert.equal(value.status,0,JSON.stringify({error:value.error?.message,stderr:value.stderr,stdout:value.stdout}));return value.stdout;};
  const npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,cwd,launch.spawnOptions);};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});
  const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"private":true,"type":"module"}');
  npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  await writeFile(path.join(consumer,'human.mts'),`
import {createNamespaceEngine} from '@singularity-flow/engine-sdk/hosts/namespace-engine';
declare const engine:ReturnType<typeof createNamespaceEngine>;
const context=await engine.run('conformance.context',{workId:'story',phaseId:'review'});
const request={workId:'story',phaseId:'review',expected:'digest',clauseId:'STORY:AC-001',ownerPhase:'code',outcome:'accept-risk',expires:'reviewed-date',reason:'Human-reviewed reason.'};
await engine.run('conformance.decide',request);
await engine.run('phase.reject',{workId:'story',phaseId:'review',target:'code',confirm:'packet',reason:'Human-reviewed repair.'});
const article=await engine.run('constitution.exception.context',{workId:'story',phaseId:'review',articleId:'ART-001'});
await engine.run('decision.constitution-exception',{operationId:'human-article',phaseId:'review',articleId:'ART-001',scope:'Exact reviewed scope.',reason:'The independently reviewed reason.',expectedContext:'sha256:digest',expires:null});
// @ts-expect-error an article context needs the exact article ID
await engine.run('constitution.exception.context',{phaseId:'review'});
// @ts-expect-error a human article decision requires its exact reviewed context
await engine.run('decision.constitution-exception',{operationId:'human-article',phaseId:'review',articleId:'ART-001',scope:'Exact reviewed scope.',reason:'The independently reviewed reason.'});
// @ts-expect-error human scope is text, not a successful readiness flag
await engine.run('decision.constitution-exception',{operationId:'human-article',phaseId:'review',articleId:'ART-001',scope:true,reason:'The independently reviewed reason.',expectedContext:'digest'});
// @ts-expect-error identity comes only from the trusted access port
await engine.run('conformance.decide',{...request,actor:'model'});
// @ts-expect-error a digest is not a boolean
await engine.run('conformance.decide',{...request,expected:true});
// @ts-expect-error review confirmation is a packet digest
await engine.run('phase.reject',{phaseId:'review',confirm:{approved:true}});
// @ts-expect-error unregistered vocabulary cannot become a new approval route
await engine.run('conformance.approve',{});
void context;
void article;
declare const output:import('@singularity-flow/engine-sdk/content').ContentReference;
await engine.run('phase.output.retain',{operationId:'capture-current-output',workId:'story',phaseId:'code',path:'singularity/work-items/story/evidence/result.png',content:output});
// @ts-expect-error an output needs an explicit immutable content reference, not a laptop filename
await engine.run('phase.output.retain',{operationId:'capture-current-output',workId:'story',phaseId:'code',path:'result.png',content:'/tmp/result.png'});
// @ts-expect-error output retention never accepts a successful human visual review flag
await engine.run('phase.output.retain',{operationId:'capture-current-output',workId:'story',phaseId:'code',path:'result.png',content:output,approved:true});
await engine.run('plan.correction.context',{operations:[{op:'reclassify-evidence',clauseId:'STORY:AC-001',path:'singularity/work-items/story/evidence/result.png',method:'visual',content:output}],reason:'Review the retained output contract.'});
// @ts-expect-error retained evidence needs a content reference, not a local laptop path
await engine.run('plan.correction.context',{operations:[{op:'reclassify-evidence',clauseId:'STORY:AC-001',path:'result.png',method:'visual',content:'/tmp/result.png'}],reason:'Review the retained output contract.'});
// @ts-expect-error evidence classification cannot waive tests
await engine.run('plan.correction.context',{operations:[{op:'reclassify-evidence',clauseId:'STORY:AC-001',path:'result.png',method:'test',content:output}],reason:'Review the retained output contract.'});
`);
  await writeFile(path.join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',
    strict:true,noEmit:true,types:[],lib:['ES2023','DOM']},include:['human.mts']}));
  child(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'--project','tsconfig.json'],consumer);
});
