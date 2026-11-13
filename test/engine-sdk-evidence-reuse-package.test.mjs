/** Actual installed consumer: new human reuse, submit, independent approval and shared-only replay. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceEvidenceReuseFixture,reuseReason} from './helpers/namespace-evidence-reuse-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('an offline installed consumer retains exact reuse and completes the receiving phase with empty PATH',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-evidence-reuse-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceEvidenceReuseFixture(t);f.human();
  await writeFile(path.join(consumer,'reuse.mjs'),[
    'import assert from "node:assert/strict";import path from "node:path";import {DatabaseSync} from "node:sqlite";import {registerHooks} from "node:module";',
    'const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error("No native Git, CLI or lifecycle authority");return next(specifier,context);}});',
    'const {createNamespaceEngine}=await import("'+packageName+'/hosts/namespace-engine"),{createFilesystemNamespaceStore}=await import("'+packageName+'/storage/filesystem"),',
    '{createSqliteContentStore}=await import("'+packageName+'/storage/sqlite-content"),value=JSON.parse(process.argv[2]),binding={kind:"shared"},',
    'database=new DatabaseSync(path.join(value.directory,"content.db")),records=await createFilesystemNamespaceStore({root:path.join(value.directory,"records"),binding,create:false}),',
    'content=createSqliteContentStore({database,binding,create:false});',
    'try{const sources=[];if(value.mode!=="replay"){const {createFilesystemSourceUnit}=await import("'+packageName+'/sources/filesystem");',
    'sources.push(await createFilesystemSourceUnit({root:value.root,id:"app-checkout",projectId:value.scope.projectId,repositoryId:"app"}));}',
    'const engine=createNamespaceEngine({records,content,sources,scope:value.scope,workId:value.workId,authority:value.authority,access:{current:()=>value.identity},',
    'clock:{now(){if(value.mode==="replay")throw Error("No restamping");return value.at;}}});let result;',
    'if(value.mode==="decide"){const context=await engine.run("evidence-reuse.context",{phaseId:"assess"});assert.equal(context.manifest.candidates.length,1);',
    'result=await engine.run("decision.evidence-reuse",{phaseId:"assess",attemptId:context.manifest.candidates[0].taskId,reason:value.reason});}',
    'else if(value.mode==="submit")result=await engine.run("phase.submit",{phaseId:"assess"});',
    'else if(value.mode==="approve"){const {manifest}=await engine.run("phase.review",{phaseId:"assess"}),r=manifest.reviewBinding;',
    'result=await engine.run("phase.approve",{phaseId:"assess",confirmation:{workId:value.workId,phase:"assess",generation:r.generation,reviewPacketSha256:r.packetSha256}});assert.equal(result.approval.selfApproval,false);}',
    'else result=await engine.run("phase.publish",{phaseId:"assess",authored:"governed-agent",channel:"copilot-host"});',
    'process.stdout.write(JSON.stringify(result));}finally{records.close?.();database.close();hook.deregister();}'
  ].join('\n'));
  const invoke=async mode=>JSON.parse(child(process.execPath,['reuse.mjs',JSON.stringify({directory:f.directory,root:f.root,scope:f.scope,workId:f.inputs.workId,
    authority:f.authority,identity:await f.access.current({}),at:await f.clock.now(),mode,reason:reuseReason})],{cwd:consumer,env:{...env,PATH:''}}));
  const recorded=await invoke('decide');assert.equal(recorded.record.producer.phase,'intake');assert.equal(recorded.record.producer.tests.passed,1);
  await f.prepareReceiver();await f.engine.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'});
  assert.equal((await invoke('submit')).status,'awaiting-approval');f.human();assert.equal((await invoke('approve')).approval.selfApproval,false);
  assert.equal((await f.observer.inspect()).snapshot.workflow.status,'closed');assert.equal(f.control.starts,1);await rm(f.root,{recursive:true,force:true});
  assert.equal((await invoke('replay')).status,'retained');
  const types=path.join(consumer,'types.mts');await writeFile(types,[
    'import type {EngineInputs} from "'+packageName+'";',
    'import {evidenceReuseExpiry,namespaceEvidenceReuseState,type NamespaceReusedExecution} from "'+packageName+'/testing/reuse";',
    'const read:EngineInputs["evidence-reuse.context"]={phaseId:"assess"};',
    'declare const record:NamespaceReusedExecution;namespaceEvidenceReuseState({phases:{}},record,{at:"2026-10-01T12:00:00Z"});',
    'evidenceReuseExpiry("2026-10-02","2026-10-01T12:00:00Z");',
    '// @ts-expect-error Reuse must bind a real returned task, never a successful flag.',
    'const wrong:EngineInputs["decision.evidence-reuse"]={phaseId:"assess",attemptId:true};',
    '// @ts-expect-error Source freshness and human approval do not come from a value helper.',
    'namespaceEvidenceReuseState({phases:{}},record,{at:"2026-10-01T12:00:00Z",approved:true});',
    '// @ts-expect-error Expiry requires explicit time.',
    'evidenceReuseExpiry("2026-10-02");void read;void wrong;'
  ].join('\n'));
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
