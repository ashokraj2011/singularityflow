/** Real repeated-return history consumed by an offline package in another process. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
import {namespaceTargetedRepairFixture,targetedReport,unrelatedSource} from './helpers/namespace-targeted-repair-fixture.mjs';
import {releasePublish} from './helpers/namespace-release-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('an installed shared-only consumer approves the third Code generation and replays both genuine returns',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-repeated-returns-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceTargetedRepairFixture(t,{backend:'sqlite',budget:false}),first=await f.reviewer.run('phase.reject',f.request);
  await f.begin();await f.engine.run('phase.source.retain',{operationId:'installed-repeated-source-two',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('installed-repeated-tests-two');await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.engine.run('phase.submit',{phaseId:'build'});
  const review=await f.reviewer.run('phase.review',{phaseId:'build'}),request={phaseId:'build',target:'build',
    reason:'The independent reviewer requests a complete successor without reusing the older targeted restriction.',confirm:review.manifest.reviewBinding.packetSha256},
    second=await f.reviewer.run('phase.reject',request);
  f.control.agentId='analyst';await f.write('build','# Complete successor\n\n## Agent brief\n\nRetain the complete approved scope and execute fresh tests after both human returns.\n');
  await writeFile(path.join(f.root,'src/other.js'),unrelatedSource+'// Preserve the complete approved source accounting.\n');
  await f.engine.run('phase.source.retain',{operationId:'installed-repeated-source-three',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('installed-repeated-tests-three');await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.engine.run('phase.submit',{phaseId:'build'});
  const identity={...await f.reviewerAccess.current(),permissions:['phase.review','phase.review.resources','document.read','phase.approve','phase.publish','phase.reject']};
  await writeFile(path.join(consumer,'repeated.mjs'),`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('An installed Code reader cannot discover native Git, CLI or state');return next(specifier,context);}}),
      {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createSqliteNamespaceStore}=await import('${packageName}/storage/sqlite'),
      {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createSqliteNamespaceStore({filename:path.join(selected.directory,'records.db'),binding,create:false}),
      content=createSqliteContentStore({database,binding,create:false});
    try{const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,access:{current:()=>selected.identity},
        clock:{now(){if(selected.replay)throw Error('An original Code acknowledgement cannot restamp time.');return selected.at;}}});
      if(!selected.replay){const reviewed=await engine.run('phase.review.resources',{phaseId:'build'});
        for(const resource of reviewed.manifest.resources)await engine.run('document.read',{reference:resource.reference});
        const binding=reviewed.manifest.reviewBinding;assert.equal(binding.generation,3);
        const result=await engine.run('phase.approve',{phaseId:'build',confirmation:{workId:selected.workId,phase:'build',generation:3,reviewPacketSha256:binding.packetSha256}});
        assert.equal(result.approval.selfApproval,false);assert.equal(result.currentPhase,'release');
      }else assert.equal((await engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'})).status,'retained');
      const returns=[];for(const request of selected.requests)returns.push(await engine.run('phase.reject',request));process.stdout.write(JSON.stringify(returns));
    }finally{records.close?.();database.close();hook.deregister();}
  `);
  const invoke=replay=>JSON.parse(child(process.execPath,['repeated.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.inputs.workId,
    authority:f.authority,identity,at:awaitAt,requests:[f.request,request],replay})],{cwd:consumer,env:{...env,PATH:''}})),awaitAt=await f.clock.now();
  assert.deepEqual(invoke(false),[first,second]);
  f.control.agentId='release-reviewer';await f.write('release',targetedReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  const final=await f.capture();assert.equal(final.workflow.status,'closed');for(const sourceRoot of f.roots)await rm(sourceRoot,{recursive:true,force:true});
  assert.deepEqual(invoke(true),[first,second]);assert.deepEqual(await f.capture(),final);assert.equal(f.starts(),3);
});
