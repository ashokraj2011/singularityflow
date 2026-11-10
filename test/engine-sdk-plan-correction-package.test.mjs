/** The actual installed archive records an exact human correction without a checkout or native terminal assurance. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
for(const profile of ['row','evidence'])test('installed human '+profile+' correction supports shared-only takeover and subsequent real Code delivery',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-plan-correction-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});
  const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceTestWitnessFixture(t,{plan:profile==='row'?planText.replaceAll('`src/converter.js`','`src/old.js`'):planText}),
    file='singularity/work-items/'+f.inputs.workId+'/evidence/output.png',
    content=profile==='evidence'?(await f.content.put(f.scope,'evidence',Buffer.from([137,80,78,71,13,10,26,10]))).reference:null,
    request={ownerPhase:'design',operations:profile==='row'?['REQ-001','AC-001'].map(id=>({op:'replace-location',clauseId:'STORY-1:'+id,from:'src/old.js',to:'src/converter.js'}))
      :[{op:'reclassify-evidence',clauseId:'STORY-1:AC-001',path:file,method:'visual',content}],
      reason:'Correct the exact approved delivery contract without changing the approved behavior or tests.'},before=await f.capture(),at=await f.clock.now();
  const script=`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('Unexpected installed Git or CLI owner');return next(specifier,context);}});
    const {createNamespaceEngine}=await import('${packageName}/hosts/namespace-engine'),{createFilesystemNamespaceStore}=await import('${packageName}/storage/filesystem'),
      {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
      database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding,create:false}),
      content=createSqliteContentStore({database,binding,create:false});
    try{const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,
        access:{current:()=>({projectId:selected.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
          identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['plan.correction.context','plan.correction.record','witness.context','decision.witness']})},
        clock:{now(){if(selected.replay)throw Error('Replay must retain the original human timestamp.');return selected.at;}}});
      if(selected.witness){const context=await engine.run('witness.context',selected.witness);
        const recorded=await engine.run('decision.witness',{...selected.witness,operationId:'installed-corrected-evidence-witness',expectedContext:context.manifest.contextBinding,
          expectedFile:'sha256:'+context.manifest.file.content.sha256,answers:selected.answers,reason:'The isolated fixture reviewer inspected this exact retained output for the approved criterion.'});
        assert.equal(recorded.record.outcome,'met');process.stdout.write(JSON.stringify(recorded));
      }else{let input=selected.input;
      if(!input){const context=await engine.run('plan.correction.context',selected.request);
        assert.equal(context.manifest.owner.phase,'design');assert.equal(context.manifest.recording.status,'requires-human-review');
        input={...selected.request,operationId:'installed-exact-human-plan-correction',expectedPreview:'sha256:'+context.manifest.preview.previewSha256};}
      const recorded=await engine.run('plan.correction.record',input),replayed=await engine.run('plan.correction.record',input);
      assert.deepEqual(replayed,recorded);assert.equal(recorded.record.reviewContext,input.expectedPreview);
      assert.equal(recorded.record.format,'sflow-namespace-plan-row-correction/v'+selected.version);assert.equal(Object.hasOwn(recorded.record,'authorizationId'),false);
      process.stdout.write(JSON.stringify({input,recorded}));}
    }finally{records.close?.();database.close();hook.deregister();}
  `;
  await writeFile(path.join(consumer,'correction.mjs'),script);
  const invoke=extra=>JSON.parse(child(process.execPath,['correction.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.inputs.workId,
    authority:f.authority,at,request,version:profile==='row'?1:2,...extra})],{cwd:consumer,env:{...env,PATH:''}})),recorded=invoke({});
  const corrected=await f.capture();assert.equal(corrected.workflow.planAmendments.length,1);
  assert.deepEqual(corrected.workflow.phases.design,before.workflow.phases.design);
  const draft=await f.engine.run('phase.draft.read',{phaseId:'build'});
  await f.engine.run('phase.draft.rebase',{operationId:'installed-correction-author-resume',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
    confirm:draft.manifest.draft.bodySha256,reason:'Continue this original Code draft using the exact human-corrected plan.'});
  await f.engine.run('phase.source.retain',{operationId:'installed-correction-current-source',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('installed-correction-fresh-test-run');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  if(profile==='evidence'){await assert.rejects(f.approve('build'),{code:'ENGINE_WITNESS_DECISION_REQUIRED'});
    invoke({witness:{clauseId:'STORY-1:AC-001',slotName:'retained-evidence',file},answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes']))});}
  assert.equal((await f.approve('build')).approval.selfApproval,false);
  assert.deepEqual(invoke({input:recorded.input,replay:true}),recorded);
  assert.equal((await f.capture()).workflow.planAmendments.length,1);
});
