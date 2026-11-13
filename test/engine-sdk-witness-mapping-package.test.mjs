/** An installed offline consumer owns real mapping approval and original-phase renewal from shared records. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceWitnessMappingFixture} from './helpers/namespace-witness-mapping-fixture.mjs';
const name='@singularity-flow/engine-sdk';
test('installed mapping approval and renewal use shared receipts with no original checkout, Git, CLI or executable PATH',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-installed-mappings-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives');for(const folder of [artifact,consumer,archives])await mkdir(folder);
  const env=isolatedTestEnvironment(path.join(directory,'machine')),child=(executable,args,options)=>{const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(new URL('../packages/engine-sdk/'+file,import.meta.url),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceWitnessMappingFixture(t);await rm(f.root,{recursive:true,force:true});
  await writeFile(path.join(consumer,'journey.mjs'),`
    import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
    const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier)||specifier==='node:child_process')throw Error('No installed legacy or process owner');return next(specifier,context);}});
    const {createNamespaceEngine}=await import('${name}/hosts/namespace-engine'),{createFilesystemNamespaceStore}=await import('${name}/storage/filesystem'),{createSqliteContentStore}=await import('${name}/storage/sqlite-content');
    const s=JSON.parse(process.argv[2]),binding={kind:'shared'},database=new DatabaseSync(path.join(s.directory,'content.db')),
      records=await createFilesystemNamespaceStore({root:path.join(s.directory,'records'),binding,create:false}),content=createSqliteContentStore({database,binding,create:false});
    try{let at=s.at;const options={records,content,scope:s.scope,workId:s.workId,authority:s.authority,access:{current:()=>({projectId:s.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
      identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.approve','test-witness.context','decision.witness-exception','story.evidence']})},checks:{mode:'retained-only'},repairs:{mode:'retained-only'},clock:{now:()=>new Date(at).toISOString()}},engine=createNamespaceEngine(options),
      ctx=(await engine.run('test-witness.context',{phaseId:'build'})).manifest,mappingSha256=ctx.mappings[0].mappingSha256;
      const approved=await engine.run('phase.approve',{phaseId:'build',confirmation:s.confirmation,witnessReviewContext:ctx.contextSha256,witnessMappings:[{mappingSha256,decision:'exception',reason:'The human reviewer acknowledges the exact bounded boundary inadequacy.',inadequate:['boundaries'],expiresAt:new Date(at+3600000).toISOString()}]});
      assert.equal(approved.currentPhase,'release');at+=3600001;
      const expired=(await engine.run('story.evidence')).manifest.report;assert.ok(expired.findings.some(row=>row.code==='EVIDENCE_WITNESS_EXCEPTION_EXPIRED'));
      const input={phaseId:'build',mappingSha256,expires:new Date(at+3600000).toISOString(),reason:'The original phase reviewer renews the same actual test exception.'},renewed=await engine.run('decision.witness-exception',input);
      const current=(await engine.run('story.evidence')).manifest;assert.equal(current.report.profile,'sflow-evidence-evaluation/v3');assert.ok(!current.report.findings.some(row=>row.code==='EVIDENCE_WITNESS_EXCEPTION_EXPIRED'));
      const replay=await createNamespaceEngine({...options,clock:{now(){throw Error('Do not allocate replay time');}}}).run('decision.witness-exception',input);
      assert.equal(replay.status,'retained');assert.equal(replay.effects.committed,false);assert.deepEqual(replay.record,renewed.record);assert.equal(replay.currentPhase,'release');
    }finally{records.close?.();database.close();hook.deregister();}
  `);
  child(process.execPath,['journey.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.inputs.workId,authority:f.authority,at:f.at(),confirmation:f.confirmation})],{cwd:consumer,env:{...env,PATH:''}});
  const types=path.join(consumer,'types.mts');await writeFile(types,`
    import {createEngine} from '${name}';import type {ReviewedWitnessMapping,EvidenceObservationOptions} from '${name}/evidence';
    const engine=createEngine({ports:{}});engine.run('test-witness.context',{phaseId:'custom-code'});
    engine.run('phase.approve',{phaseId:'custom-code',witnessReviewContext:'sha256:exact'});
    declare const mapping:ReviewedWitnessMapping;const observed:EvidenceObservationOptions={at:'2026-11-08T00:00:00Z',admission:{witnessMappings:[mapping]}};
    // @ts-expect-error A boolean cannot stand in for an exact test review context.
    engine.run('phase.approve',{witnessReviewContext:true});
    // @ts-expect-error Observation data never establishes approval.
    const invented:EvidenceObservationOptions={at:'now',admission:{witnessMappings:[mapping],approved:true}};void observed;void invented;
  `);
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
