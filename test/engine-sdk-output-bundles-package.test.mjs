/** Real offline package consumption, with the unchanged 120/60-second qualification bounds. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('installed output bundles remain reviewable and approvable without a working store, checkout or Git',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-output-bundle-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});
  const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceEngineFixture(t,{configure(source){source.definition.artifactSets={packet:{primary:'plan.md',members:[
    {path:'plan.md',role:'requirements',required:true},{path:'diagram.bin',role:'supporting-evidence',required:true}]}};source.definition.phases.intake.artifactSet='packet';}});
  await f.bootstrap();f.control.permissions.push('phase.artifact.attach');await f.engine.run('phase.prepare',{phaseId:'intake'});
  let draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});const primary=(await f.local.content.put(f.scope,'local',Buffer.from('# Reviewed result\n\nThe actual author prepared this requested packet.\n'))).reference,
    body=Buffer.from([0,255,137,80,78,71,10]),member=(await f.local.content.put(f.scope,'local',body)).reference;
  await f.engine.run('phase.draft.write',{operationId:'installed-primary',workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,content:primary,reason:'Complete the actual primary document.'});
  draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.artifact.attach',{operationId:'installed-member',workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    memberPath:'diagram.bin',content:member,reason:'Retain the actual declared output bytes.'});
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'intake'});
  const script=`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('Unexpected installed Git or CLI owner');return next(specifier,context);}});
    const {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createFilesystemNamespaceStore}=await import('${packageName}/storage/filesystem'),
      {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding,create:false}),
      content=createSqliteContentStore({database,binding,create:false});
    try{const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,
        access:{current:()=>({projectId:selected.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
          identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.approve']})},clock:{now:()=>selected.at}}),
        review=await engine.run('phase.review',{phaseId:'intake'}),resources=await engine.run('phase.review.resources',{phaseId:'intake'});
      assert.equal(review.manifest.integrity,'matched');assert.equal(review.manifest.items.length,2);
      for(const item of review.manifest.items)await engine.run('document.read',{reference:item.reference});
      const output=resources.manifest.resources.find(row=>row.kind==='artifact-set-member');assert.ok(output);
      const reference={namespace:'evidence',...output.expected};assert.deepEqual(Buffer.from((await content.read(selected.scope,reference)).data),Buffer.from(selected.member,'base64'));
      await engine.run('document.read',{reference:output.reference});
      const bound=resources.manifest.reviewBinding,input={phaseId:'intake',confirmation:{workId:selected.workId,phase:'intake',generation:bound.generation,reviewPacketSha256:bound.packetSha256}},
        approval=await engine.run('phase.approve',input),again=await engine.run('phase.approve',input);
      assert.equal(approval.currentPhase,null);assert.equal(again.revision,approval.revision);
      const publication=await engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});assert.equal(publication.status,'retained');
      process.stdout.write(JSON.stringify({members:review.manifest.items.length,approved:approval.approval.thresholdReached,revision:approval.revision}));
    }finally{records.close?.();database.close();hook.deregister();}
  `;
  await writeFile(path.join(consumer,'bundle.mjs'),script);
  const result=JSON.parse(child(process.execPath,['bundle.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.workId,authority:f.authority,at:await f.clock.now(),member:body.toString('base64')})],
    {cwd:consumer,env:{...env,PATH:''}}));assert.equal(result.members,2);assert.equal(result.approved,true);assert.equal((await f.capture()).workflow.status,'closed');
  await writeFile(path.join(consumer,'api.mts'),`import type {Engine} from '${packageName}';import type {ContentReference} from '${packageName}/content';
    declare const engine:Engine;declare const content:ContentReference;
    engine.run('phase.artifact.attach',{operationId:'a',workId:'w',phaseId:'p',expectedRevision:'r',memberPath:'file.bin',content,reason:'Explicit output'});
    engine.run('phase.artifact.inspect',{maximumEntries:0});engine.run('witness.context',{clauseId:'W:AC-001',slotName:'screen',file:'evidence/output.png'});
    // @ts-expect-error Output bytes require an exact content reference.
    engine.run('phase.artifact.attach',{operationId:'a',workId:'w',phaseId:'p',expectedRevision:'r',memberPath:'file.bin',content:'wrong',reason:'Explicit output'});
  `);
  await writeFile(path.join(consumer,'tsconfig.json'),'{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","strict":true,"noEmit":true,"skipLibCheck":false},"files":["api.mts"]}');
  child(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p',path.join(consumer,'tsconfig.json')],{cwd:consumer});
  assert.match(await readFile(path.join(consumer,'node_modules/@singularity-flow/engine-sdk/dist/index.d.mts'),'utf8'),/phase\.artifact\.attach/u);
});
