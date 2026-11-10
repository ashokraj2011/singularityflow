/** An installed, offline namespace consumer records exact Story-command changes across processes. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespacePhaseCheckFixture} from './helpers/namespace-phase-check-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('offline installed command decisions preserve original authorities and shared-only replay with empty PATH',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-story-commands-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespacePhaseCheckFixture(t,{configure(source){source.definition.phases.intake.approval.allowSelfApproval=false;source.definition.approvalAuthorities.reviewers.members.push({email:'independent@example.test'});}});
  f.accessControl.permissions.push('test-command.context','test-command.request','test-command.decide');
  const identity=await f.access.current({projectId:f.scope.projectId,workId:f.inputs.workId,operation:'test-command.request'}),at=await f.clock.now();
  await writeFile(path.join(consumer,'command.mjs'),`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('A command consumer cannot load Git, CLI or native state');return next(specifier,context);}}),
      {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createFilesystemNamespaceStore}=await import('${packageName}/storage/filesystem'),
      {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding,create:false}),
      content=createSqliteContentStore({database,binding,create:false});
    try{
      const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,access:{current:()=>selected.identity},
        clock:{now(){if(selected.mode==='replay')throw Error('Replay must preserve the original command time.');return selected.at;}}});
      let result,request=selected.request;
      if(selected.mode==='accept')result=await engine.run('test-command.decide',{accept:'TCD-001',reason:'The independent fixture reviewer accepts this exact structured command.'});
      else{if(!request){const view=await engine.run('test-command.context',{phaseId:'intake'}),entry=view.manifest.commands[0];
          request={phaseId:'intake',command:{profile:'sflow-namespace-story-command/v1',command:{...entry.command,argv:[entry.command.argv[0],'--test-concurrency=1',...entry.command.argv.slice(1)]},
            replaces:{id:entry.command.id,sha256:entry.sha256}},reason:'Use the exact reviewed Story command without changing the original configuration.'};}
        result=await engine.run('test-command.request',request);}
      const view=await engine.run('test-command.context',{phaseId:'intake'});assert.equal(view.manifest.requests.length,1);
      assert.equal(view.manifest.requests[0].state,selected.mode==='request'?'requested':'accepted');
      process.stdout.write(JSON.stringify({result,request}));
    }finally{records.close?.();database.close();hook.deregister();}
  `);
  const invoke=(mode,request)=>JSON.parse(child(process.execPath,['command.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.inputs.workId,
    authority:f.authority,at,mode,request,identity:mode==='accept'?{...identity,principalId:'independent-command-reviewer',agentId:null,
      identity:{name:'Independent reviewer',email:'independent@example.test',login:null}}:identity})],{cwd:consumer,env:{...env,PATH:''}}));
  const requested=invoke('request');await rm(f.root,{recursive:true,force:true});const accepted=invoke('accept');assert.equal(accepted.result.record.accepts,'TCD-001');
  const replay=invoke('replay',requested.request);assert.equal(replay.result.status,'retained');assert.deepEqual(replay.result.record,requested.result.record);
});
