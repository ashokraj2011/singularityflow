/** Offline installed consumer, genuine persisted decisions and a second process with no checkout. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('installed confirmed batches replay in a checkout-free process with the original human decisions',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-decision-batch-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});
  const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceEngineFixture(t,{backend:'filesystem',storyText:JSON.stringify({acceptanceCriteria:['Retain independently reviewed tests.']})});await f.bootstrap();f.asReviewer();
  await writeFile(path.join(consumer,'batch.mjs'),`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('An installed decision consumer cannot discover native Git or CLI');return next(specifier,context);}}),
      {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createFilesystemNamespaceStore}=await import('${packageName}/storage/filesystem'),
      {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding,create:false}),
      content=createSqliteContentStore({database,binding,create:false});
    try{
      const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,
        access:{current:()=>({projectId:selected.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
          identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['decisions.list','decisions.record','decision.scope']})},
        clock:{now(){if(selected.input)throw Error('A retained batch cannot restamp its original human decision.');return selected.at;}}});
      let input=selected.input;
      if(!input){const listed=await engine.run('decisions.list'),item=listed.manifest.policy.items.find(row=>row.kind==='scope-disposition');
        input={confirmation:listed.manifest.policy.packetSha256,answers:{choose:{[item.id]:'scope-informative'},
          reason:{[item.id]:'The independent human reviewed this exact fixture statement as contextual information.'}}};}
      const result=await engine.run('decisions.record',input);assert.equal(result.effects.recordedEntries,1);process.stdout.write(JSON.stringify({input,result}));
    }finally{records.close?.();database.close();hook.deregister();}
  `);
  const selected={directory:f.directory,scope:f.scope,workId:f.workId,authority:f.authority,at:await f.clock.now()},
    invoke=input=>JSON.parse(child(process.execPath,['batch.mjs',JSON.stringify({...selected,input})],{cwd:consumer,env:{...env,PATH:''}})),first=invoke();
  f.asAuthor();await f.author();await f.review();f.asReviewer();const before=await f.capture();assert.equal(before.workflow.status,'closed');
  assert.deepEqual(invoke(first.input),first);assert.deepEqual(await f.capture(),before);
  await writeFile(path.join(consumer,'api.mts'),`import type {Engine} from '${packageName}';declare const engine:Engine;
    engine.run('decisions.list',{workId:'story',phaseId:'custom'});
    engine.run('decisions.record',{workId:'story',confirmation:'sha256:reviewed',answers:{choose:{d1:'scope-included'}}});
    // @ts-expect-error phases are exact identifiers
    engine.run('decisions.list',{phaseId:123});
    // @ts-expect-error callers cannot supply their own policy packet
    engine.run('decisions.list',{packet:{}});
  `);
  await writeFile(path.join(consumer,'tsconfig.json'),'{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","strict":true,"noEmit":true,"skipLibCheck":false},"files":["api.mts"]}');
  child(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p',path.join(consumer,'tsconfig.json')],{cwd:consumer});
});
