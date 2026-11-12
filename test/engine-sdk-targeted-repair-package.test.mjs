/** Installed targeted return and exact context reading, followed by source-free immutable replay. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
import {namespaceTargetedRepairFixture,targetedReport} from './helpers/namespace-targeted-repair-fixture.mjs';
import {releasePublish} from './helpers/namespace-release-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('offline installed targeted returns expose exact repair resources and replay accepted Code without Git or a checkout',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-targeted-return-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceTargetedRepairFixture(t,{backend:'sqlite'}),at=await f.clock.now(),identity={...await f.reviewerAccess.current(),permissions:['phase.reject','phase.enter','phase.context.read','phase.publish']};
  await writeFile(path.join(consumer,'targeted.mjs'),`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('A targeted consumer cannot load Git, CLI or native state');return next(specifier,context);}}),
      {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createSqliteNamespaceStore}=await import('${packageName}/storage/sqlite'),
      {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createSqliteNamespaceStore({filename:path.join(selected.directory,'records.db'),binding,create:false}),
      content=createSqliteContentStore({database,binding,create:false});
    try{const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,access:{current:()=>selected.identity},
        clock:{now(){if(selected.replay)throw Error('An immutable targeted replay cannot consume another attempt or change its time.');return selected.at;}}}),
        result=await engine.run('phase.reject',selected.request);assert.deepEqual(result.repairBudget,{consumed:1,maximum:1});
      if(!selected.replay){const entry=await engine.run('phase.enter',{phaseId:'build'});assert.equal(entry.manifest.contract,'sflow-phase-entry-manifest/v4');
        assert.equal(entry.authoringAllowed,false);assert.deepEqual(entry.manifest.repairScope.current.repositories[0].paths,['src/converter.js','test/converter.test.js']);
        const resource=entry.manifest.resources.find(row=>row.kind==='repair-scope'&&row.reference.sha256===entry.manifest.repairScope.sourceRecord.sha256),
          read=await engine.run('phase.context.read',{workId:selected.workId,phaseId:'build',contextSha256:entry.manifest.context.sha256,resourceId:resource.id});
        assert.equal(JSON.parse(read.content.text).schemaVersion,3);
      }else assert.equal((await engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'})).status,'retained');
      process.stdout.write(JSON.stringify(result));
    }finally{records.close?.();database.close();hook.deregister();}
  `);
  const invoke=replay=>JSON.parse(child(process.execPath,['targeted.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.inputs.workId,
    authority:f.authority,at,identity,request:f.request,replay})],{cwd:consumer,env:{...env,PATH:''}})),first=invoke(false);
  await f.begin();await f.engine.run('phase.source.retain',{operationId:'installed-targeted-source',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('installed-targeted-execution');await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.approve('build');
  f.control.agentId='release-reviewer';await f.write('release',targetedReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  const before=await f.capture();assert.equal(before.workflow.status,'closed');assert.equal(before.workflow.namespaceRepairBudgetHistory.length,1);
  for(const sourceRoot of f.roots)await rm(sourceRoot,{recursive:true,force:true});
  assert.deepEqual(invoke(true),first);assert.deepEqual(await f.capture(),before);assert.equal(f.starts(),2);
});
