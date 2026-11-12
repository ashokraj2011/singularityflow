/** Real installed namespace convergence, process restart and source-free independent approval. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
import {namespaceConvergenceFixture} from './helpers/namespace-convergence-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('the offline installed SDK confirms actual convergence, independently approves without a checkout and replays immutable answers',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-convergence-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceConvergenceFixture(t),entry=(await f.engine.run('convergence.context',{phaseId:'release'})).manifest,item=entry.projection.projection.settledByPlan[0],
    request={operationId:'installed-convergence-answer',phaseId:'release',itemId:item.id,disposition:'dismissed',expectedContext:entry.contextBinding,
      reason:'The independent reviewer inspected this exact retained supporting documentation.'},answer=await f.reviewer.run('convergence.adjudicate',request);
  await f.engine.run('phase.prepare',{phaseId:'release'});await f.engine.run('phase.publish',{phaseId:'release'});
  const preview=await f.engine.run('convergence.advance',{}),at=await f.clock.now(),author={...await f.access.current({}),permissions:['convergence.advance','phase.submit']},
    reviewer={...await f.reviewerAccess.current(),permissions:['phase.review','phase.approve','phase.publish','convergence.adjudicate']};
  await writeFile(path.join(consumer,'convergence.mjs'),`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('An installed convergence consumer cannot load native Git, CLI or state');return next(specifier,context);}}),
      {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createSqliteNamespaceStore}=await import('${packageName}/storage/sqlite'),
      {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),{createFilesystemSourceUnit}=await import('${packageName}/sources/filesystem'),
      {convergenceValuePolicies}=await import('${packageName}/convergence'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createSqliteNamespaceStore({filename:path.join(selected.directory,'records.db'),binding,create:false}),
      content=createSqliteContentStore({database,binding,create:false});
    assert.equal(typeof convergenceValuePolicies,'function');
    try{const sources=selected.mode==='submit'?await Promise.all(selected.sources.map(async row=>createFilesystemSourceUnit({root:row.root,
        id:row.descriptor.id,projectId:row.descriptor.projectId,repositoryId:row.descriptor.repositoryId,limits:row.descriptor.limits}))):[],
        engine=createNamespaceEngine({records,content,sources,scope:selected.scope,workId:selected.workId,authority:selected.authority,
          access:{current:()=>selected.identity},clock:{now(){if(selected.mode==='replay')throw Error('Replay cannot change a human answer time.');return selected.at;}}});
      let result;
      if(selected.mode==='submit'){const preview=await engine.run('convergence.advance',{});assert.equal(preview.confirmationDigest,selected.digest);
        result=await engine.run('convergence.advance',{confirmation:preview.confirmationDigest});assert.equal(result.status,'awaiting-approval');}
      else if(selected.mode==='approve'){const {manifest}=await engine.run('phase.review',{phaseId:'release'}),review=manifest.reviewBinding;
        result=await engine.run('phase.approve',{phaseId:'release',confirmation:{workId:selected.workId,phase:'release',generation:review.generation,reviewPacketSha256:review.packetSha256}});
        assert.equal(result.approval.selfApproval,false);assert.equal(result.currentPhase,null);}
      else{assert.equal((await engine.run('phase.publish',{phaseId:'release'})).status,'retained');result=await engine.run('convergence.adjudicate',selected.request);}
      process.stdout.write(JSON.stringify(result));
    }finally{records.close?.();database.close();hook.deregister();}
  `);
  const invoke=(mode,identity)=>JSON.parse(child(process.execPath,['convergence.mjs',JSON.stringify({mode,identity,directory:f.directory,scope:f.scope,workId:f.inputs.workId,
    authority:f.authority,at,digest:preview.confirmationDigest,request,sources:f.sources.map((unit,index)=>({root:f.roots[index],descriptor:unit.descriptor}))})],{cwd:consumer,env:{...env,PATH:''}}));
  invoke('submit',author);for(const sourceRoot of f.roots)await rm(sourceRoot,{recursive:true,force:true});
  invoke('approve',reviewer);const snapshot=await f.capture();assert.equal(snapshot.workflow.status,'closed');assert.equal(f.starts(),1);
  assert.deepEqual(invoke('replay',reviewer),answer);assert.deepEqual(await f.capture(),snapshot);
});
