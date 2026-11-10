/** Qualify the actual offline-installed SDK review operation in a different empty-PATH process. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
import {namespaceSourceReviewFixture,namespaceSourceReviewReport} from './helpers/namespace-source-review-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),name='@singularity-flow/engine-sdk';
test('installed source review retains exact sources and reaches independently approved shared-only completion',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-source-review-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});
  const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceSourceReviewFixture(t),view=await f.engine.run('source-review.context',{phaseId:'intake'}),
    input={operationId:'installed-source-review',workId:f.workId,phaseId:'intake',report:namespaceSourceReviewReport(view.manifest),expectedContext:view.manifest.contextBinding};
  const script=`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('Unexpected installed Git or CLI owner');return next(specifier,context);}}),
      {createNamespaceEngine}=await import('${name}/hosts/namespace-engine'),{createFilesystemNamespaceStore}=await import('${name}/storage/filesystem'),
      {createSqliteContentStore}=await import('${name}/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding,create:false}),content=createSqliteContentStore({database,binding,create:false});
    try{let agentId=selected.replay?'source-reviewer':'source-reviewer',principalId='source-review-agent';
      const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,
        access:{current:()=>({projectId:selected.scope.projectId,principalId,agentId,actorKind:'human',identity:{name:'Independent reviewer',email:'independent@example.test',login:null},
          permissions:['source-review.context','source-review.record','phase.submit','phase.approve']})},clock:{now(){if(selected.replay)throw Error('Replay retains the actual original review time.');return selected.at;}}}),
        captured=engine.capabilities,recorded=await engine.run('source-review.record',selected.input);
      assert.ok(captured.boundOperations.some(row=>row.id==='source-review.record'));assert.ok(captured.unboundOperations.some(row=>row.id==='decisions.record'));
      assert.equal(captured.readinessEstablished,false);assert.equal(captured.authorityGranted,false);
      assert.deepEqual(await engine.run('source-review.record',selected.input),recorded);
      if(!selected.replay){assert.equal((await engine.run('source-review.context',{phaseId:'intake'})).manifest.status.status,'ready');
        agentId='analyst';await engine.run('phase.submit',{phaseId:'intake'});agentId=null;principalId='independent-reviewer';
        const view=await engine.run('phase.review.resources',{phaseId:'intake'});for(const row of view.manifest.resources)await engine.run('document.read',{reference:row.reference});
        const result=await engine.run('phase.approve',{phaseId:'intake',confirmation:{workId:selected.workId,phase:'intake',generation:1,reviewPacketSha256:view.manifest.reviewBinding.packetSha256}});
        assert.equal(result.approval.selfApproval,false);assert.equal(result.currentPhase,null);}
      process.stdout.write(JSON.stringify(recorded));
    }finally{records.close?.();database.close();hook.deregister();}
  `;
  await writeFile(path.join(consumer,'review.mjs'),script);
  const invoke=replay=>JSON.parse(child(process.execPath,['review.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.workId,authority:f.authority,at:'2026-11-10T13:00:00.000Z',input,replay})],{cwd:consumer,env:{...env,PATH:''}})),first=invoke(false);
  assert.equal((await f.capture()).workflow.status,'closed');assert.deepEqual(invoke(true),first);
  await writeFile(path.join(consumer,'types.mts'),`import type {Engine} from '${name}';declare const engine:Engine;const profile:'sflow-engine-host-capabilities/v1'=engine.capabilities.profile;const granted:false=engine.capabilities.authorityGranted;
    engine.run('source-review.context',{phaseId:'intake'});
    engine.run('source-review.record',{operationId:'review',phaseId:'intake',report:{schemaVersion:1},expectedContext:'sha256:value'});
    // @ts-expect-error The actual independent report is required.
    engine.run('source-review.record',{operationId:'review',phaseId:'intake',expectedContext:'sha256:value'});
    // @ts-expect-error Review recording needs an explicit operation identity.
    engine.run('source-review.record',{phaseId:'intake',report:{schemaVersion:1},expectedContext:'sha256:value'});
  `);
  child(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','types.mts'],{cwd:consumer});
});
