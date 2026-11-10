/** The offline installed SDK accepts actual local output and replays without the device or Git. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceSourceRetentionFixture} from './helpers/namespace-source-retention-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('offline output retention preserves lifecycle and original receipts across installed processes with empty PATH',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-output-retention-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceSourceRetentionFixture(t);f.control.permissions.push('phase.output.retain');await f.engine.run('phase.source.retain',f.input);
  const bytes=Buffer.from([137,80,78,71,13,10,26,10]),content=(await f.localContent.put(f.scope,'local',bytes)).reference,
    input={operationId:'installed-current-output',workId:f.inputs.workId,phaseId:'intake',path:'singularity/work-items/'+f.inputs.workId+'/evidence/proof.png',content},
    before=await f.head(),identity=await f.access.current({projectId:f.scope.projectId,workId:f.inputs.workId,operation:'phase.output.retain'}),at=await f.clock.now();
  await writeFile(path.join(consumer,'output.mjs'),`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('An output consumer cannot load Git, CLI or native state');return next(specifier,context);}}),
      {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createFilesystemNamespaceStore}=await import('${packageName}/storage/filesystem'),
      {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),{createFilesystemSourceUnit}=await import('${packageName}/sources/filesystem'),
      selected=JSON.parse(process.argv[2]),binding={kind:'shared'},database=new DatabaseSync(path.join(selected.directory,'content.db')),
      records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding,create:false}),content=createSqliteContentStore({database,binding,create:false});
    let privateDatabase,privateRecords;
    try{let working=null,sources=[];
      if(!selected.replay){privateDatabase=new DatabaseSync(path.join(selected.privateDirectory,'content.db'));
        privateRecords=await createFilesystemNamespaceStore({root:path.join(selected.privateDirectory,'records'),binding:selected.localBinding,create:false});
        working={records:privateRecords,content:createSqliteContentStore({database:privateDatabase,binding:selected.localBinding,create:false})};
        sources=[await createFilesystemSourceUnit({root:selected.sourceRoot,id:'app-checkout',projectId:selected.scope.projectId,repositoryId:'app'})];}
      const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,working,sources,
        access:{current:()=>selected.identity},clock:{now(){if(selected.replay)throw Error('Replay cannot restamp the output.');return selected.at;}}}),
        result=await engine.run('phase.output.retain',selected.input);assert.equal(result.status,'retained');assert.equal(result.replayed,selected.replay);
      assert.equal(result.effects.lifecycleChanged,false);assert.equal(result.effects.approvalRecorded,false);process.stdout.write(JSON.stringify(result));
    }finally{privateRecords?.close?.();privateDatabase?.close();records.close?.();database.close();hook.deregister();}
  `);
  const invoke=replay=>JSON.parse(child(process.execPath,['output.mjs',JSON.stringify({directory:f.directory,privateDirectory:f.privateDirectory,sourceRoot:f.sourceRoot,
    localBinding:f.localRecords.descriptor.binding,scope:f.scope,workId:f.inputs.workId,authority:f.authority,identity,at,input,replay})],{cwd:consumer,env:{...env,PATH:''}})),
    result=invoke(false);assert.deepEqual(await f.head(),before);await rm(f.sourceRoot,{recursive:true,force:true});
  const replay=invoke(true);assert.deepEqual(replay.record,result.record);assert.equal(replay.recordedAt,result.recordedAt);assert.deepEqual(await f.head(),before);
});
