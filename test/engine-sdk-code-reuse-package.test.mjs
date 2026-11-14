/** Installed offline consumer keeps real producer execution and human reuse separate. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {namespaceCodeReuseFixture,reuseReason} from './helpers/namespace-code-reuse-fixture.mjs';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),name='@singularity-flow/engine-sdk';
test('installed Code/recovery reuse completes publication, independent approval and shared-only replay with NodeNext',{timeout:120000},async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-code-reuse-package-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
 const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
 for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
 const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
  const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
  npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
 for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
 await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
 await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
 await writeFile(path.join(consumer,'consumer.mjs'),`
import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('No native Git, CLI or state imports');return next(specifier,context);}});
const {createNamespaceEngine}=await import('${name}/hosts/namespace-engine'),{createSqliteNamespaceStore}=await import('${name}/storage/sqlite'),
 {createSqliteContentStore}=await import('${name}/storage/sqlite-content'),value=JSON.parse(process.argv[2]),binding={kind:'shared'},
 database=new DatabaseSync(path.join(value.directory,'content.db')),records=await createSqliteNamespaceStore({filename:path.join(value.directory,'records.db'),binding,create:false}),
 content=createSqliteContentStore({database,binding,create:false});let working,localDatabase,starts=0;
try{
 const sources=[],sourceReaders=[];let checks;
 if(!value.replay){
  const {createFilesystemSourceUnit,createFilesystemSourceContentReader}=await import('${name}/sources/filesystem'),
   {createEnvironmentQualifiedNodeCheckExecutionUnit}=await import('${name}/testing/execution'),{createNodeExecutionOwner}=await import('${name}/execution/runtime'),bindings=[];
  for(const [index,root]of value.roots.entries()){
   const repositoryId=index?'service-'+index:'app',source=await createFilesystemSourceUnit({root,id:'clause-source-'+index,projectId:value.scope.projectId,repositoryId});sources.push(source);
   sourceReaders.push(await createFilesystemSourceContentReader({root,id:'installed-source-'+index,source:source.descriptor}));
   const old=value.bindings[index],unit=await createEnvironmentQualifiedNodeCheckExecutionUnit({id:'installed-qualified-code-'+index,hostId:'qualified-code-host',root,projectId:value.scope.projectId,repositoryId,content,
    command:{executable:process.execPath,executableSha256:old.executableSha256,arguments:['--test','test/converter.test.js'],environment:old.environment},report:{adapter:'node-tap',files:[]},authorizeCommand:m=>m.manifestSha256});
   bindings.push({...old,unit:{...unit,start(...args){starts++;return unit.start(...args);}}});
  }
  checks={owner:createNodeExecutionOwner({hostId:'qualified-code-host'}),bindings,codeRecoveryReuse:true};
  const binding={kind:'machine-local',deviceId:'test-device'};localDatabase=new DatabaseSync(path.join(value.privateDirectory,'content.db'));
  working={records:await createSqliteNamespaceStore({filename:path.join(value.privateDirectory,'records.db'),binding,create:false}),content:createSqliteContentStore({database:localDatabase,binding,create:false})};
 }else checks={mode:'retained-only'};
 const engine=createNamespaceEngine({records,content,sources,sourceReaders,working,checks,scope:value.scope,workId:value.workId,authority:value.authority,
  access:{current:()=>value.identity},clock:{now(){if(value.replay)throw Error('No new replay timestamp');return value.at;}}});
 const result=await engine.run(value.operation,value.input);assert.equal(starts,0,'An installed consumer must not invent another execution');process.stdout.write(JSON.stringify(result));
}finally{working?.records.close?.();localDatabase?.close();records.close?.();database.close();hook.deregister();}
`);
 const f=await namespaceCodeReuseFixture(t,{recovery:true}),invoke=async(operation,input,replay=false)=>JSON.parse(child(process.execPath,['consumer.mjs',JSON.stringify({directory:f.directory,privateDirectory:f.privateDirectory,
  roots:f.roots,bindings:f.checks.bindings.map(({unit,...row})=>row),scope:f.scope,workId:f.inputs.workId,authority:f.authority,identity:await f.access.current({}),at:await f.clock.now(),operation,input,replay})],{cwd:consumer,env:{...env,PATH:''}}));
 f.human();const view=await invoke('evidence-reuse.context',{phaseId:'build',...f.producer});assert.equal(view.manifest.profile,'sflow-namespace-evidence-reuse-context/v3');
 const request={phaseId:'build',...f.producer,attemptId:view.manifest.candidates[0].taskId,reason:reuseReason},accepted=await invoke('decision.evidence-reuse',request);
 assert.equal(accepted.record.profile,'sflow-namespace-evidence-reuse/v3');await f.rebase();const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
 await invoke('phase.publish',publish);await invoke('phase.submit',{phaseId:'build'});f.human();const review=(await invoke('phase.review',{phaseId:'build'})).manifest.reviewBinding;
 await invoke('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:review.generation,reviewPacketSha256:review.packetSha256}});assert.equal(f.starts(),1);
 for(const root of f.roots)await rm(root,{recursive:true,force:true});assert.deepEqual((await invoke('decision.evidence-reuse',request,true)).record,accepted.record);f.author();
 assert.equal((await invoke('phase.publish',publish,true)).status,'retained');
 await writeFile(path.join(consumer,'contracts.mts'),`
import {createEngine} from '${name}';import type {NamespaceCodeReusedExecution} from '${name}/testing/reuse';import type {NamespaceChecksBindings} from '${name}/hosts/namespace-checks';
declare const checks:NamespaceChecksBindings;const configured:NamespaceChecksBindings={...checks,codeRecoveryReuse:true};void configured;
const engine=createEngine({ports:{}});await engine.run('test-recovery.context',{reuse:'environment-qualified-exact'});
await engine.run('test-recovery.confirm',{operationId:'agreement',phaseId:'build',reuse:'environment-qualified-exact',expectedContext:'sha256:hash',reason:'Reviewed exact reuse policy'});
await engine.run('evidence-reuse.context',{phaseId:'build',producerPhaseId:'build',producerOperationId:'original'});
await engine.run('decision.evidence-reuse',{phaseId:'build',producerPhaseId:'build',producerOperationId:'original',attemptId:'actual-task',reason:'Reviewed original execution'});
declare const reused:NamespaceCodeReusedExecution;const version:3=reused.schemaVersion;void version;
// @ts-expect-error Caller success flags are not an execution or human approval.
await engine.run('decision.evidence-reuse',{phaseId:'build',passed:true});
`);
 const program=ts.createProgram([path.join(consumer,'contracts.mts')],{noEmit:true,strict:true,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,skipLibCheck:false,types:[],lib:['lib.es2022.d.ts','lib.dom.d.ts']});
 const diagnostics=ts.getPreEmitDiagnostics(program);assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:file=>file,getCurrentDirectory:()=>consumer,getNewLine:()=> '\n'}));
});
