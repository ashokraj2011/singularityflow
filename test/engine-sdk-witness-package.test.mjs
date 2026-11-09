/** The real tarball reads prior records and executes a new exact pinned run on another checkout. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('installed witnesses keep original intent and exact execution across checkout takeover',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-exact-witness-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});
  const child=(executable,args,options)=>{const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceTestWitnessFixture(t),before=await f.head(),checkout=path.join(directory,'new-checkout');
  await cp(f.root,checkout,{recursive:true});await rm(f.root,{recursive:true,force:true});
  const source=`
    import assert from 'node:assert/strict';import path from 'node:path';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
    import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('Unexpected installed Git or CLI owner');return next(specifier,context);}});
    const {createFilesystemNamespaceStore}=await import('${packageName}/storage/filesystem'),{createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),
      {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createFilesystemSourceUnit}=await import('${packageName}/sources/filesystem'),
      {createNodeCheckExecutionUnit}=await import('${packageName}/testing/execution'),{createNodeExecutionOwner}=await import('${packageName}/execution/runtime');
    const selected=JSON.parse(process.argv[2]),binding={kind:'machine-local',deviceId:'test-device'},sharedDb=new DatabaseSync(path.join(selected.directory,'content.db')),
      localDb=new DatabaseSync(path.join(selected.privateDirectory,'content.db'));
    const records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding:{kind:'shared'},create:false}),
      localRecords=await createFilesystemNamespaceStore({root:path.join(selected.privateDirectory,'records'),binding,create:false}),
      content=createSqliteContentStore({database:sharedDb,binding:{kind:'shared'},create:false}),localContent=createSqliteContentStore({database:localDb,binding,create:false});
    try{
      const unit=await createFilesystemSourceUnit({root:selected.checkout,id:selected.descriptor.id,projectId:selected.scope.projectId,repositoryId:'app'}),
        environment={NODE_OPTIONS:'--test-reporter='+import.meta.resolve('${packageName}/testing/node-test-reporter'),SINGULARITY_FLOW_NODE_TEST_ROOT:selected.checkout,SINGULARITY_FLOW_NODE_TEST_TAP:'1'},
        executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
        executor=await createNodeCheckExecutionUnit({id:'installed-exact-check',root:selected.checkout,projectId:selected.scope.projectId,repositoryId:'app',content,
          command:{executable:process.execPath,executableSha256,arguments:['--test','test/converter.test.js'],environment},report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256}),
        checks={owner:createNodeExecutionOwner({hostId:'installed-exact-witness-host'}),bindings:[{phaseId:'build',commandId:'node-tests',repositoryId:'app',executable:'node',executableSha256,environment,unit:executor}]},
        engine=createNamespaceEngine({records,content,working:{records:localRecords,content:localContent},scope:selected.scope,workId:selected.workId,authority:selected.authority,
          sources:[unit],checks,access:{current:()=>selected.access},clock:{now:()=>selected.at}});
      const prior=(await engine.run('phase.test-witnesses.inspect',{phaseId:'build'})).manifest;assert.equal(prior.paths[0].status,'met');
      await engine.run('phase.checks.run',{operationId:'installed-exact-execution',workId:selected.workId,phaseId:'build'});
      const current=(await engine.run('phase.test-witnesses.inspect',{phaseId:'build'})).manifest;
      assert.equal(current.paths[0].status,'met');assert.equal(current.paths[0].witnesses[0].execution,'exact-local-observed');
      assert.notDeepEqual(current.checks,prior.checks);assert.deepEqual(current.plan,prior.plan);assert.equal(current.applicationAcceptanceEstablished,false);
      assert.equal(JSON.stringify(current).includes(selected.checkout),false);process.stdout.write(JSON.stringify({before:prior.checks,after:current.checks,clause:current.paths[0].clauseId}));
    }finally{records.close?.();localRecords.close?.();sharedDb.close();localDb.close();hook.deregister();}
  `;
  await writeFile(path.join(consumer,'witness.mjs'),source);
  const access=await f.access.current({projectId:f.scope.projectId,workId:f.inputs.workId,operation:'phase.source.inspect'}),result=JSON.parse(child(process.execPath,['witness.mjs',JSON.stringify({directory:f.directory,privateDirectory:f.privateDirectory,
    checkout,descriptor:f.sources[0].descriptor,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access,at:await f.clock.now()})],{cwd:consumer,env:{...env,PATH:''}}));
  assert.equal(result.clause,'STORY-1:AC-001');assert.notDeepEqual(result.before,result.after);assert.deepEqual(await f.head(),before);
});
