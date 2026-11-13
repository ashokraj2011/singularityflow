/** Actual external package consumer, authenticated risk, final independent approval and source-free acknowledgement. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceObligationRiskFixture} from './helpers/namespace-obligation-risk-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),name='@singularity-flow/engine-sdk';
test('the installed offline SDK retains exact obligation risks and evaluates the actual closing human vote',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-installed-obligation-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceObligationRiskFixture(t,{backend:'filesystem'});
  await writeFile(path.join(consumer,'risk.mjs'),[
    'import assert from "node:assert/strict";import path from "node:path";import {DatabaseSync} from "node:sqlite";import {registerHooks} from "node:module";',
    'const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error("No native Git, CLI or installed authority");return next(specifier,context);}});',
    'const {createNamespaceEngine}=await import("'+name+'/hosts/namespace-engine"),{createFilesystemNamespaceStore}=await import("'+name+'/storage/filesystem"),',
    '{createSqliteContentStore}=await import("'+name+'/storage/sqlite-content"),value=JSON.parse(process.argv[2]),binding={kind:"shared"},',
    'database=new DatabaseSync(path.join(value.directory,"content.db")),records=await createFilesystemNamespaceStore({root:path.join(value.directory,"records"),binding,create:false}),',
    'content=createSqliteContentStore({database,binding,create:false});',
    'try{const engine=createNamespaceEngine({records,content,scope:value.scope,workId:value.workId,authority:value.authority,access:{current:()=>value.identity},',
    'clock:{now(){if(value.mode==="replay")throw Error("No new replay clock");return value.at;}}});let result,confirmation=value.confirmation;',
    'if(value.mode==="decide"){result=await engine.run("decision.risk",value.request);assert.equal(result.record.profile,"sflow-namespace-obligation-risk/v1");',
    'const view=await engine.run("story.evidence",{});assert.equal(view.manifest.report.rows.find(row=>row.id==="COMPOSED-STORY:AC-001").obligations.find(row=>row.responsibility==="verify").status,"excepted");}',
    'else if(value.mode==="approve"){const {manifest}=await engine.run("phase.review",{phaseId:"release"}),r=manifest.reviewBinding;',
    'confirmation={workId:value.workId,phase:"release",generation:r.generation,reviewPacketSha256:r.packetSha256};',
    'result=await engine.run("phase.approve",{phaseId:"release",confirmation});assert.equal(result.approval.selfApproval,false);',
    'const view=await engine.run("story.evidence",{});assert.equal(view.manifest.report.completion.kind,"complete-with-exceptions");}',
    'else{const risk=await engine.run("decision.risk",value.request);assert.equal(risk.status,"retained");assert.equal(risk.effects.committed,false);',
    'result=await engine.run("phase.approve",{phaseId:"release",confirmation});}',
    'process.stdout.write(JSON.stringify({result,confirmation}));}finally{records.close?.();database.close();hook.deregister();}'
  ].join('\n'));
  const invoke=async(mode,confirmation=null)=>JSON.parse(child(process.execPath,['risk.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.workId,
    authority:f.authority,identity:await f.access.current({}),at:await f.clock.now(),request:f.riskInput(),mode,confirmation})],{cwd:consumer,env:{...env,PATH:''}}));
  assert.equal((await invoke('decide')).result.status,'recorded');const approved=await invoke('approve'),snapshot=await f.capture();
  assert.equal(snapshot.workflow.status,'closed');assert.deepEqual((await invoke('replay',approved.confirmation)).result,approved.result);assert.deepEqual(await f.capture(),snapshot);
  const types=path.join(consumer,'types.mts');await writeFile(types,[
    'import type {EngineInputs} from "'+name+'";import type {EvidenceObservationOptions} from "'+name+'/evidence";',
    'const risk:EngineInputs["decision.risk"]={operationId:"actual-human-risk",obligationId:"OBL:example",category:"deferred-verification",reason:"The original reviewer accepts this exact gap.",expires:"2026-12-01"};',
    'const view:EvidenceObservationOptions={at:"2026-11-08T00:00:00.000Z",admission:{riskBindings:{"RISK-001":"overtaken"}}};',
    '// @ts-expect-error A caller cannot supply an authorized or completed risk flag.',
    'const wrong:EngineInputs["decision.risk"]={approved:true};',
    '// @ts-expect-error A binding observation does not grant approval.',
    'const falseBinding:EvidenceObservationOptions={at:"2026-11-08T00:00:00.000Z",admission:{riskBindings:{"RISK-001":"approved"}}};',
    'void risk;void view;void wrong;void falseBinding;'
  ].join('\n'));
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
