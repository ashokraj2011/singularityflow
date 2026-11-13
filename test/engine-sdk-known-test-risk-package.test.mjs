/** Offline installed consumers read the real pre-feature run, record human permission and close with real acceptance evidence. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {verificationWorkflow,codeInputArtifact} from './helpers/namespace-code-input-fixture.mjs';import {releaseReport} from './helpers/namespace-release-fixture.mjs';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceKnownTestRiskFixture,knownFailureReason} from './helpers/namespace-known-test-risk-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),name='@singularity-flow/engine-sdk';
test('an offline installed known-failure owner preserves actual failed tests, independent approval, Verification, Release, final evidence and shared-only replay',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-known-failure-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceKnownTestRiskFixture(t,{backend:'sqlite',configure:source=>{
    verificationWorkflow(source);source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',
      writeScope:'artifact-only',inputs:[{phase:'build'},{phase:'verify'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
      approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('release');source.agents.push({...source.agents[0],id:'release-author',label:'Release author',phases:['release'],defaultFor:['release']});
  }});
  await writeFile(path.join(consumer,'consumer.mjs'),[
    'import assert from "node:assert/strict";import path from "node:path";import {DatabaseSync} from "node:sqlite";import {registerHooks} from "node:module";',
    'const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error("No native Git, CLI or state owner");return next(specifier,context);}});',
    'const {createNamespaceEngine}=await import("'+name+'/hosts/namespace-engine"),{createSqliteNamespaceStore}=await import("'+name+'/storage/sqlite"),',
    '{createSqliteContentStore}=await import("'+name+'/storage/sqlite-content"),{createEnvironmentQualifiedNodeCheckExecutionUnit}=await import("'+name+'/testing/execution"),',
    'value=JSON.parse(process.argv[2]),phaseId=value.phaseId,binding={kind:"shared"},database=new DatabaseSync(path.join(value.directory,"content.db")),',
    'records=await createSqliteNamespaceStore({filename:path.join(value.directory,"records.db"),binding,create:false}),content=createSqliteContentStore({database,binding,create:false});',
    'assert.equal(typeof createEnvironmentQualifiedNodeCheckExecutionUnit,"function");let localDatabase,working;',
    'try{const sources=[];if(!value.mode.startsWith("replay")){const {createFilesystemSourceUnit}=await import("'+name+'/sources/filesystem");',
    'sources.push(await createFilesystemSourceUnit({root:value.root,id:value.sourceId,projectId:value.scope.projectId,repositoryId:"app"}));',
    'const binding={kind:"machine-local",deviceId:"test-device"};localDatabase=new DatabaseSync(path.join(value.privateDirectory,"content.db"));',
    'working={records:await createSqliteNamespaceStore({filename:path.join(value.privateDirectory,"records.db"),binding,create:false}),content:createSqliteContentStore({database:localDatabase,binding,create:false})};}',
    'const engine=createNamespaceEngine({records,content,sources,working,scope:value.scope,workId:value.workId,authority:value.authority,access:{current:()=>value.identity},',
    'clock:{now(){if(value.mode.startsWith("replay"))throw Error("No replay clock");return value.at;}}});let result;',
    'if(value.mode==="context")result=await engine.run("test-risk.known-context",value.context);',
    'else if(value.mode==="decide"||value.mode==="replay")result=await engine.run("test-risk.confirm-known",value.request);',
    'else if(value.mode==="submit")result=await engine.run("phase.submit",{phaseId});',
    'else if(value.mode==="approve"){const b=(await engine.run("phase.review",{phaseId})).manifest.reviewBinding;',
    'result=await engine.run("phase.approve",{phaseId,confirmation:{workId:value.workId,phase:phaseId,generation:b.generation,reviewPacketSha256:b.packetSha256}});',
    'assert.equal(result.approval.selfApproval,false);if(phaseId==="release")assert.equal((await engine.run("story.evidence",{})).manifest.report.completion.kind,"complete-with-exceptions");}',
    'else result=await engine.run("phase.publish",{phaseId,authored:"governed-agent",channel:"copilot-host"});',
    'process.stdout.write(JSON.stringify(result));}finally{working?.records.close?.();localDatabase?.close();records.close?.();database.close();hook.deregister();}'
  ].join('\n'));
  const context={phaseId:'build',baselineOperationId:'original-pre-feature-checks',observedOperationId:'current-known-failure-checks'};let request;
  const invoke=async (mode,phaseId='build')=>JSON.parse(child(process.execPath,['consumer.mjs',JSON.stringify({directory:f.directory,privateDirectory:f.privateDirectory,root:f.root,
    sourceId:f.sources[0].descriptor.id,scope:f.scope,workId:f.inputs.workId,authority:f.authority,identity:await f.access.current({}),at:await f.clock.now(),mode,phaseId,request,context})],{cwd:consumer,env:{...env,PATH:''}}));
  f.human();const view=await invoke('context');assert.equal(view.manifest.expectedContext,f.view.manifest.expectedContext);
  request={...f.request,operationId:'installed-known-failure-review',reason:knownFailureReason};assert.equal((await invoke('decide')).record.id,'KTR-001');
  f.author();await f.rebase('installed-known-continuation');await f.retain('installed-known-source');await f.run('installed-known-fresh-tests');
  assert.equal((await invoke('publish')).status,'published');assert.equal((await invoke('submit')).status,'awaiting-approval');
  f.human();assert.equal((await invoke('approve')).status,'recorded');
  f.control.permissions.push('phase.context.read','phase.enter');
  for(const [phaseId,agentId,text]of [['verify','verifier',codeInputArtifact],['release','release-author',releaseReport()]]){
    f.author();f.control.agentId=agentId;await f.engine.run('phase.prepare',{phaseId});const d=await f.engine.run('phase.draft.read',{phaseId});
    await f.engine.run('phase.draft.write',{operationId:'installed-known-'+phaseId,workId:f.inputs.workId,phaseId,expectedRevision:d.manifest.draft.revision,
      content:await f.upload(text),reason:'Carry original execution and explicit known failures without inventing a downstream run.'});
    assert.equal((await invoke('publish',phaseId)).status,'published');assert.equal((await invoke('submit',phaseId)).status,'awaiting-approval');
    f.human();assert.equal((await invoke('approve',phaseId)).status,'recorded');
  }
  await rm(f.root,{recursive:true,force:true});
  assert.equal((await invoke('replay')).status,'retained');assert.equal(f.starts(),6);
  for(const phaseId of ['verify','release'])assert.equal((await invoke('replay-publication',phaseId)).status,'retained');
  const types=path.join(consumer,'types.mts');await writeFile(types,[
    'import type {EngineInputs} from "'+name+'";import {namespaceKnownTestRecoveryPolicies,testRecoveryPolicies} from "'+name+'/testing/recovery";',
    'import {createEnvironmentQualifiedNodeCheckExecutionUnit,type NodeCheckExecutionOptions} from "'+name+'/testing/execution";',
    'const context:EngineInputs["test-risk.known-context"]={phaseId:"build",baselineOperationId:"baseline",observedOperationId:"observed"};',
    'const request:EngineInputs["test-risk.confirm-known"]={operationId:"human-known-review",phaseId:"build",baselineOperationId:"baseline",observedOperationId:"observed",expectedContext:"sha256:"+"a".repeat(64),reason:"The original reviewer confirms the legacy failure.",expires:"2026-11-20",followUpOwner:"team",remediationRef:"LEGACY-1"};',
    'const values=namespaceKnownTestRecoveryPolicies({profile:"sflow-text-digests/sha256-utf8-v1",sha256Utf8:value=>"a".repeat(64)});values.state([],{id:"KTR-001",expiresAt:"2026-11-20"},"2026-11-13");',
    'declare const options:NodeCheckExecutionOptions;createEnvironmentQualifiedNodeCheckExecutionUnit({...options,hostId:"actual-worker"});',
    '// @ts-expect-error Serialized approval flags cannot grant known-failure permission.',
    'const wrong:EngineInputs["test-risk.confirm-known"]={operationId:"wrong",reason:"No original review",approved:true};',
    '// @ts-expect-error An actual observed run is required.',
    'const missing:EngineInputs["test-risk.known-context"]={phaseId:"build",baselineOperationId:"baseline"};void context;void request;void wrong;void missing;void testRecoveryPolicies;'
  ].join('\n'));
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
