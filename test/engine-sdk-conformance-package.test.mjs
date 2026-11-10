/** Installed release/rework profiles, with the same 120-second parent and 60-second child bounds. */
import {describe,test,before,after} from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
for(const profile of ['conformance','rework','human-return','partial-decisions','upstream-return','multiple-code'])describe('installed '+profile+' survives phase-by-phase process restarts',{concurrency:false},()=>{
  let directory,consumer,env,source,child,previous,completed='';
  before(async()=>{
    directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-'+profile+'-package-'));
    const artifact=path.join(directory,'package'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');consumer=path.join(directory,'consumer');
    for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
    env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp};
    for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
    await buildEngineSdk({outdir:path.join(artifact,'dist')});
    child=(executable,args,options)=>{const result=spawnSync(executable,args,{encoding:'utf8',timeout:60000,env,...options});
      assert.equal(result.status,0,JSON.stringify({error:result.error?.message,stderr:result.stderr,stdout:result.stdout}));return result.stdout;};
    const npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
    const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
    await writeFile(path.join(consumer,'package.json'),'{"private":true,"type":"module"}');
    npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
    source=(await readFile(new URL('./helpers/installed-namespace-conformance.mjs',import.meta.url),'utf8')).replaceAll('@sdk-name@',packageName);
    await writeFile(path.join(consumer,'journey.mjs'),source);
  },{timeout:120000});
  after(async()=>{if(directory)await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const repair=['rework','human-return','upstream-return'].includes(profile),partial=profile==='partial-decisions',
    stages=['setup',...(profile==='rework'?['review','repair-write','repair-publish']:profile==='human-return'?['draft-partial','return','repair-write','repair-publish','repair-approve']:profile==='upstream-return'?['upstream-return','repair-write','repair-publish']:partial?['draft-partial','decide-requirement','decide-acceptance']:[]),
      ...(profile==='multiple-code'?['write-extend','publish-extend','approve-extend','write-finish','publish-finish','approve-finish']:[]),
      ...(!partial?['publish-final']:[]),'submit-final','approve-final','finish',
      ...(['human-return','upstream-return'].includes(profile)?['replay-return']:partial?['replay-decisions']:[]),'replay-build',
      ...(profile==='multiple-code'?['replay-extend','replay-finish']:[]),'replay-validate','replay'];
  for(const [index,stage]of stages.entries())test(stage,{timeout:120000},()=>{
    assert.equal(completed,index?stages[index-1]:'','The preceding durable phase must have succeeded.');
    const output=JSON.parse(child(process.execPath,['journey.mjs',stage,profile],{cwd:consumer,env:{...env,PATH:''}}));
    if(stage==='finish'){assert.equal(output.report.gaps.length,profile==='partial-decisions'?2:0);assert.equal(output.report.inputs.inputs[0].generation,repair?2:1);previous=output;}
    if(stage==='replay')assert.deepEqual(output,previous);completed=stage;
  });
});
