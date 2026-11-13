/** Actual installed consumer: human risk, real failed execution, publication and independent approval. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceTestRiskFixture} from './helpers/namespace-test-risk-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('an offline installed consumer retains an environment risk without fabricating passing execution',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-test-risk-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceTestRiskFixture(t,{backend:'filesystem'});f.human();
  await writeFile(path.join(consumer,'risk.mjs'),[
    'import assert from "node:assert/strict";import path from "node:path";import {DatabaseSync} from "node:sqlite";import {registerHooks} from "node:module";',
    'const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error("No native Git, CLI or lifecycle authority");return next(specifier,context);}});',
    'const {createNamespaceEngine}=await import("'+packageName+'/hosts/namespace-engine"),{createFilesystemNamespaceStore}=await import("'+packageName+'/storage/filesystem"),',
    '{createSqliteContentStore}=await import("'+packageName+'/storage/sqlite-content"),value=JSON.parse(process.argv[2]),binding={kind:"shared"},',
    'database=new DatabaseSync(path.join(value.directory,"content.db")),records=await createFilesystemNamespaceStore({root:path.join(value.directory,"records"),binding,create:false}),',
    'content=createSqliteContentStore({database,binding,create:false});let localDatabase,working;',
    'try{const sources=[];if(value.mode!=="replay"){const {createFilesystemSourceUnit}=await import("'+packageName+'/sources/filesystem");',
    'sources.push(await createFilesystemSourceUnit({root:value.root,id:"app-checkout",projectId:value.scope.projectId,repositoryId:"app"}));',
    'const binding={kind:"machine-local",deviceId:"test-device"};localDatabase=new DatabaseSync(path.join(value.privateDirectory,"content.db"));',
    'working={records:await createFilesystemNamespaceStore({root:path.join(value.privateDirectory,"records"),binding,create:false}),content:createSqliteContentStore({database:localDatabase,binding,create:false})};}',
    'const engine=createNamespaceEngine({records,content,sources,working,scope:value.scope,workId:value.workId,authority:value.authority,access:{current:()=>value.identity},',
    'clock:{now(){if(value.mode==="replay")throw Error("No replay clock");return value.at;}}});let result;',
    'if(value.mode==="decide"){const context=await engine.run("test-risk.context",{phaseId:"intake"});assert.equal(context.manifest.commands[0].argvSha256,value.request.argvSha256);',
    'result=await engine.run("decision.test-risk",value.request);assert.equal(result.record.boundBy,"command-digest");assert.equal(result.record.observation,undefined);}',
    'else if(value.mode==="submit")result=await engine.run("phase.submit",{phaseId:"intake"});',
    'else if(value.mode==="approve"){const {manifest}=await engine.run("phase.review",{phaseId:"intake"}),r=manifest.reviewBinding;',
    'result=await engine.run("phase.approve",{phaseId:"intake",confirmation:{workId:value.workId,phase:"intake",generation:r.generation,reviewPacketSha256:r.packetSha256}});assert.equal(result.approval.selfApproval,false);}',
    'else result=await engine.run("phase.publish",{phaseId:"intake",authored:"governed-agent",channel:"copilot-host"});',
    'process.stdout.write(JSON.stringify(result));}finally{working?.records.close?.();localDatabase?.close();records.close?.();database.close();hook.deregister();}'
  ].join('\n'));
  const invoke=async mode=>JSON.parse(child(process.execPath,['risk.mjs',JSON.stringify({directory:f.directory,privateDirectory:f.privateDirectory,root:f.root,scope:f.scope,workId:f.inputs.workId,
    authority:f.authority,identity:await f.access.current({}),at:await f.clock.now(),mode,request:f.request})],{cwd:consumer,env:{...env,PATH:''}}));
  const recorded=await invoke('decide');assert.equal(recorded.record.profile,'sflow-namespace-test-run-risk/v1');assert.equal(f.control.starts,0);
  f.author();await f.rebase('installed-risk-continued-draft');assert.equal((await f.engine.run('phase.checks.run',f.input)).verdict,'failed');
  assert.equal((await invoke('publish')).status,'published');assert.equal((await invoke('submit')).status,'awaiting-approval');
  f.human();assert.equal((await invoke('approve')).approval.selfApproval,false);assert.equal((await f.observer.inspect()).snapshot.workflow.status,'closed');assert.equal(f.control.starts,1);
  await rm(f.root,{recursive:true,force:true});f.author();assert.equal((await invoke('replay')).status,'retained');
  const types=path.join(consumer,'types.mts');await writeFile(types,[
    'import type {EngineInputs} from "'+packageName+'";',
    'import {testRunCausePolicies} from "'+packageName+'/testing/causes";',
    'import {testRunRiskRecordPolicies} from "'+packageName+'/testing/risks";',
    'const read:EngineInputs["test-risk.context"]={phaseId:"intake"};',
    'const record:EngineInputs["decision.test-risk"]={phaseId:"intake",commandId:"unit",argvSha256:"a".repeat(64),causeClass:"service-unreachable",cause:"The service is unavailable.",reason:"Independent integration validation runs before deployment.",expires:"2026-11-20"};',
    'const rules=testRunRiskRecordPolicies(testRunCausePolicies({toBytes:value=>typeof value==="string"?new TextEncoder().encode(value):value}));',
    '// @ts-expect-error A cause decision never comes from a successful flag.',
    'const wrong:EngineInputs["decision.test-risk"]={phaseId:"intake",approved:true};',
    '// @ts-expect-error Value rules cannot authenticate a reviewer or retain an acceptance.',
    'rules.approve(record);void read;void wrong;'
  ].join('\n'));
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
