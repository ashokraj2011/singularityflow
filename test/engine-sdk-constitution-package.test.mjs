/** The shipped namespace reader must replay the actual constitution without external dependencies. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
import {namespaceConstitutionFixture,authorConstitutionDraft} from './helpers/namespace-constitution-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),name='@singularity-flow/engine-sdk';
test('offline installed constitution replay and genuine independent human approval',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-constitution-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  const built=await buildEngineSdk({outdir:path.join(artifact,'dist')});
  assert.ok(built.sources.some(file=>file.startsWith('node_modules/yaml/browser/')));
  assert.equal(await readFile(path.join(artifact,'dist/third-party/yaml-LICENSE'),'utf8'),await readFile(path.join(root,'node_modules/yaml/LICENSE'),'utf8'));
  const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceConstitutionFixture(t);await f.bootstrap();await authorConstitutionDraft(f);
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'intake'});
  await writeFile(path.join(consumer,'constitution.mjs'),`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier)||specifier==='yaml')throw Error('Unexpected external or installed owner: '+specifier);return next(specifier,context);}}),
      {createNamespaceEngine}=await import('${name}/hosts/namespace-engine'),{createFilesystemNamespaceStore}=await import('${name}/storage/filesystem'),
      {createSqliteContentStore}=await import('${name}/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding,create:false}),content=createSqliteContentStore({database,binding,create:false});
    try{const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,
        access:{current:()=>({projectId:selected.scope.projectId,principalId:'independent-reviewer',agentId:null,actorKind:'human',identity:{name:'Independent reviewer',email:'independent@example.test',login:null},
          permissions:['phase.approve']})},clock:{now:()=>selected.at}}),view=await engine.run('phase.review.resources',{phaseId:'intake'});
      const resource=view.manifest.resources.find(row=>row.kind==='constitution-policy');assert.ok(resource);
      for(const row of view.manifest.resources)await engine.run('document.read',{reference:row.reference});
      const approval=await engine.run('phase.approve',{phaseId:'intake',confirmation:{workId:selected.workId,phase:'intake',generation:1,reviewPacketSha256:view.manifest.reviewBinding.packetSha256}});
      assert.equal(approval.approval.selfApproval,false);assert.equal(approval.currentPhase,null);
    }finally{database.close();hook.deregister();}
  `);
  child(process.execPath,['constitution.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.workId,authority:f.authority,at:'2026-11-11T12:00:00.000Z'})],{cwd:consumer,env:{...env,PATH:''}});
  assert.equal((await f.capture()).workflow.status,'closed');
});
