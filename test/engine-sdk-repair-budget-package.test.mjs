/** An installed consumer returns a real reviewed candidate and replays without its source checkout. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceReleaseFixture,releasePublish,releaseReport} from './helpers/namespace-release-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('offline installed reviewer return consumes its original budget once and replays across processes without Git or a checkout',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-bounded-return-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceReleaseFixture(t,{configure(source){source.definition.phases.build.repairBudget={maxAttempts:1,resetOnPhase:'intake'};
    source.definition.workTypes.simple.reworkLoops=[{from:'release',to:'build',maxAttempts:1,resetOnPhase:'intake'}];}});
  await f.write('release',releaseReport('partial'));await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.engine.run('phase.submit',{phaseId:'release'});
  const identity={projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.review','phase.reject']},
    reviewer=f.make({access:{current:()=>identity}}),{manifest}=await reviewer.run('phase.review',{phaseId:'release'}),
    request={phaseId:'release',target:'build',reason:'Repair the exact reviewed candidate using the approved reset anchor and existing one-attempt limit.',confirm:manifest.reviewBinding.packetSha256},at=await f.clock.now();
  for(const sourceRoot of f.roots)await rm(sourceRoot,{recursive:true,force:true});
  await writeFile(path.join(consumer,'return.mjs'),`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('A bounded-return consumer cannot load Git, CLI or native state');return next(specifier,context);}}),
      {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createFilesystemNamespaceStore}=await import('${packageName}/storage/filesystem'),
      {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding,create:false}),
      content=createSqliteContentStore({database,binding,create:false});
    try{
      const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,access:{current:()=>selected.identity},
        clock:{now(){if(selected.replay)throw Error('An original return cannot consume another attempt or change its time.');return selected.at;}}});
      const result=await engine.run('phase.reject',selected.request);assert.deepEqual(result.repairBudget,{consumed:1,maximum:1});assert.equal(result.currentPhase,'build');
      process.stdout.write(JSON.stringify(result));
    }finally{records.close?.();database.close();hook.deregister();}
  `);
  const invoke=replay=>JSON.parse(child(process.execPath,['return.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.inputs.workId,
    authority:f.authority,at,identity,request,replay})],{cwd:consumer,env:{...env,PATH:''}})),first=invoke(false),before=await f.capture();
  assert.equal(before.workflow.namespaceRepairBudgetHistory.length,1);assert.equal(before.workflow.changeRequests.length,1);
  const link=before.workflow.namespaceHumanDecisionReceipts.at(-1),wire=await f.json(link.record);assert.equal(wire.schemaVersion,2);assert.equal(wire.source.repairBudget.reset.generation,1);
  assert.deepEqual(invoke(true),first);assert.deepEqual(await f.capture(),before);assert.equal(f.starts(),1);
});
