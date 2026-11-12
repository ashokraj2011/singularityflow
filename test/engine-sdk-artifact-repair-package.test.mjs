/** Actual installed consumer and process restart, using the original 120/60-second bounds. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceArtifactRepairFixture} from './helpers/namespace-artifact-repair-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('installed member repair reconstructs actual output, then completes independent review in another shared-only process',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-artifact-repair-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});
  const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceArtifactRepairFixture(t,'filesystem');await f.start();
  const script=`
    import assert from 'node:assert/strict';import path from 'node:path';import {mkdir} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('Unexpected installed Git or CLI owner');return next(specifier,context);}});
    const {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createFilesystemNamespaceStore}=await import('${packageName}/storage/filesystem'),
      {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),mode=process.argv[3],binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding,create:false}),
      content=createSqliteContentStore({database,binding,create:false});let privateDatabase=null,reviewer=true,done=false;
    const access={current:()=>({projectId:selected.scope.projectId,principalId:reviewer?'independent-reviewer':'author',actorKind:'human',agentId:reviewer?null:'analyst',
      identity:reviewer?{name:'Independent reviewer',email:'independent@example.test',login:null}:{name:'Example reviewer',email:'reviewer@example.test',login:null},
      permissions:['phase.reject','phase.approve','phase.prepare','phase.draft.read','phase.draft.write','phase.artifact.inspect','phase.artifact.attach','phase.prepublish','phase.publish','phase.submit','phase.enter','phase.context.read']})},
      clock={now(){if(done)throw Error('A retained member operation cannot restamp its receipt.');return selected.at;}};
    try{const options={records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,access,clock};
      if(mode==='repair'){
        const device=path.resolve('device');await mkdir(device);const localBinding={kind:'machine-local',deviceId:'installed-repair-device'},
          localRecords=await createFilesystemNamespaceStore({root:path.join(device,'records'),binding:localBinding,create:true});
        privateDatabase=new DatabaseSync(path.join(device,'content.db'));const localContent=createSqliteContentStore({database:privateDatabase,binding:localBinding,create:true}),
          engine=createNamespaceEngine({...options,working:{records:localRecords,content:localContent}}),review=await engine.run('phase.review',{phaseId:'intake'}),
          request={phaseId:'intake',target:'intake',members:['notes.txt'],reason:'Correct the reviewed member and preserve the remaining delivered bundle.',confirm:review.manifest.reviewBinding.packetSha256};
        await engine.run('phase.reject',request);reviewer=false;
        const entry=await engine.run('phase.enter',{phaseId:'intake',compose:true});assert.equal(entry.manifest.schemaVersion,5);
        for(const resource of entry.manifest.resources.filter(row=>row.kind==='repair-scope'))await engine.run('phase.context.read',{
          workId:selected.workId,phaseId:'intake',contextSha256:entry.manifest.context.sha256,resourceId:resource.id});
        await engine.run('phase.prepare',{phaseId:'intake'});const draft=await engine.run('phase.draft.read',{phaseId:'intake'});assert.equal(draft.manifest.draft.generation,2);
        assert.equal((await engine.run('phase.artifact.inspect',{phaseId:'intake'})).manifest.members.length,4);
        await engine.run('phase.artifact.attach',{operationId:'installed-repair-notes',workId:selected.workId,phaseId:'intake',memberPath:'notes.txt',expectedRevision:draft.manifest.draft.revision,
          content:(await localContent.put(selected.scope,'local',Buffer.from('Corrected installed-consumer notes.\\n'))).reference,reason:'Correct the actual member selected by the human reviewer.'});
        assert.equal((await engine.run('phase.prepublish',{phaseId:'intake'})).manifest.qualityDisposition,'ready');
        await engine.run('phase.publish',{phaseId:'intake'});await engine.run('phase.submit',{phaseId:'intake'});process.stdout.write(JSON.stringify({request,generation:2}));
      }else{
        const engine=createNamespaceEngine(options),review=await engine.run('phase.review.resources',{phaseId:'intake'});
        for(const resource of review.manifest.resources)await engine.run('document.read',{reference:resource.reference});
        const bound=review.manifest.reviewBinding,approval=await engine.run('phase.approve',{phaseId:'intake',confirmation:{workId:selected.workId,phase:'intake',generation:bound.generation,reviewPacketSha256:bound.packetSha256}});
        assert.equal(approval.approval.selfApproval,false);assert.equal(approval.currentPhase,null);done=true;
        assert.equal((await engine.run('phase.publish',{phaseId:'intake'})).status,'retained');
        assert.equal((await engine.run('phase.reject',selected.request)).changeRequest.id,'CR-001');process.stdout.write(JSON.stringify({approved:true,generation:bound.generation}));
      }
    }finally{privateDatabase?.close();records.close?.();database.close();hook.deregister();}
  `;
  await writeFile(path.join(consumer,'repair.mjs'),script);const selected={directory:f.directory,scope:f.scope,workId:f.workId,authority:f.authority,at:await f.clock.now()},
    repaired=JSON.parse(child(process.execPath,['repair.mjs',JSON.stringify(selected),'repair'],{cwd:consumer,env:{...env,PATH:''}}));assert.equal(repaired.generation,2);
  await rm(path.join(consumer,'device'),{recursive:true,force:true});
  const approved=JSON.parse(child(process.execPath,['repair.mjs',JSON.stringify({...selected,request:repaired.request}),'approve'],{cwd:consumer,env:{...env,PATH:''}}));
  assert.equal(approved.approved,true);assert.equal(approved.generation,2);assert.equal((await f.capture()).workflow.status,'closed');
  await writeFile(path.join(consumer,'api.mts'),`import type {Engine} from '${packageName}';declare const engine:Engine;
    engine.run('phase.reject',{phaseId:'custom',target:'custom',members:['notes.txt'],reason:'Review the exact member.',confirm:'bound-review'});
    engine.run('phase.enter',{phaseId:'custom',compose:true});
    // @ts-expect-error members must be exact path strings
    engine.run('phase.reject',{phaseId:'custom',members:[123]});
  `);
  await writeFile(path.join(consumer,'tsconfig.json'),'{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","strict":true,"noEmit":true,"skipLibCheck":false},"files":["api.mts"]}');
  child(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p',path.join(consumer,'tsconfig.json')],{cwd:consumer});
});
