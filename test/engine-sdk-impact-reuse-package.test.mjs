/** Installed combined profiles retain selected execution, separate permissions and new public impact ports. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {reuseReason} from './helpers/namespace-code-reuse-fixture.mjs';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './helpers/namespace-selective-test-recovery-fixture.mjs';
import {fixtureImpactUnit} from './helpers/source-impact-fixture.mjs';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),name='@singularity-flow/engine-sdk';
test('installed selected/reuse profiles complete independent approval and shared-only replay with NodeNext',{timeout:120000},async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-impact-reuse-package-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
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
   for(const old of value.bindings.filter(row=>row.repositoryId===repositoryId)){
    const {argv,adapter,timeoutMs,...binding}=old,unit=await createEnvironmentQualifiedNodeCheckExecutionUnit({id:'installed-selected-code-'+binding.commandId,hostId:'selective-host',root,projectId:value.scope.projectId,repositoryId,content,timeoutMs,
     command:{executable:process.execPath,executableSha256:old.executableSha256,arguments:argv.slice(1),environment:old.environment},report:{adapter,files:[]},authorizeCommand:m=>m.manifestSha256});
    bindings.push({...binding,unit:{...unit,start(...args){starts++;return unit.start(...args);}}});
   }
  }
  checks={owner:createNodeExecutionOwner({hostId:'selective-host'}),bindings,combinedEvidenceReuse:true};
  const binding={kind:'machine-local',deviceId:'test-device'};localDatabase=new DatabaseSync(path.join(value.privateDirectory,'content.db'));
  working={records:await createSqliteNamespaceStore({filename:path.join(value.privateDirectory,'records.db'),binding,create:false}),content:createSqliteContentStore({database:localDatabase,binding,create:false})};
 }else checks={mode:'retained-only'};
 const engine=createNamespaceEngine({records,content,sources,sourceReaders,working,checks,scope:value.scope,workId:value.workId,authority:value.authority,
  access:{current:()=>value.identity},clock:{now(){if(value.replay)throw Error('No new replay timestamp');return value.at;}}});
 let result;try{result=await engine.run(value.operation,value.input);assert.equal(value.expectedError,null,'Expected the actual source mutation to be refused');}
 catch(error){if(!value.expectedError?.includes(error.code))throw error;result={code:error.code};}
 assert.equal(starts,0,'An installed consumer must not invent another execution');process.stdout.write(JSON.stringify(result));
}finally{working?.records.close?.();localDatabase?.close();records.close?.();database.close();hook.deregister();}
`);
 const f=await namespaceSelectiveTestRecoveryFixture(t,{reuse:'environment-qualified-selected',
  baselineFiles:{'test/first.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';test('first stable regression',()=>assert.equal(convert(0),'0'));\n"},
  configure:source=>{source.definition.testRecovery.reuseProfile='environment-qualified-selected/v1';}}),
  authoring=f.make({checks:{...f.checks,impact:fixtureImpactUnit(f)}}),selectionInput={phaseId:'build',baselineOperationId:'pre-feature-full-execution',mode:'changed-and-affected'};
 f.control.permissions.push('evidence-reuse.context','decision.evidence-reuse');f.human();const scope=(await authoring.run('test-recovery.select-context',selectionInput)).manifest;
 assert.deepEqual(scope.rows[0].excludedIds,['legacy:second']);
 await authoring.run('test-recovery.select-confirm',{...selectionInput,operationId:'installed-impact-review',expectedContext:scope.expectedContext,reason:selectionReason,
  expires:'2026-11-20',followUpOwner:'suite-maintainers',remediationRef:'INSTALLED-IMPACT-1'});
 await f.rebase();await authoring.run('phase.checks.run',{operationId:'installed-original-selection',workId:f.inputs.workId,phaseId:'build'});
 const producer={producerPhaseId:'build',producerOperationId:'installed-original-selection'},commands=(await f.capture()).workflow.phases.build.qualityCommands,
  invoke=async(operation,input,replay=false,expectedError=null)=>JSON.parse(child(process.execPath,['consumer.mjs',JSON.stringify({directory:f.directory,privateDirectory:f.privateDirectory,
  roots:f.roots,bindings:f.checks.bindings.map(({unit,...row})=>{const command=commands.find(command=>command.id===row.commandId);return {...row,argv:command.argv,adapter:command.result.adapter,timeoutMs:command.timeoutMs??300000};}),scope:f.scope,workId:f.inputs.workId,authority:f.authority,identity:await f.access.current({}),at:await f.clock.now(),operation,input,replay,expectedError})],{cwd:consumer,env:{...env,PATH:''}}));
 f.human();const view=await invoke('evidence-reuse.context',{phaseId:'build',...producer});assert.equal(view.manifest.profile,'sflow-namespace-evidence-reuse-context/v4');const decisions=[];
 for(const row of view.manifest.candidates){const request={phaseId:'build',...producer,attemptId:row.taskId,reason:reuseReason},accepted=await invoke('decision.evidence-reuse',request);assert.equal(accepted.record.profile,'sflow-namespace-evidence-reuse/v4');decisions.push({request,accepted});}
 await f.rebase('rebase-installed-selected-reuse');const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'},before=f.starts();
 await invoke('phase.publish',publish);const sourcePath=path.join(f.root,'src/converter.js'),sourceBytes=await readFile(sourcePath);
 await writeFile(sourcePath,Buffer.concat([sourceBytes,Buffer.from('\n// Source changed after the approved impact observation.\n')]));
 assert.ok(['ENGINE_SOURCE_CHANGED','ENGINE_EVIDENCE_REUSE_INCOMPLETE'].includes((await invoke('phase.submit',{phaseId:'build'},false,['ENGINE_SOURCE_CHANGED','ENGINE_EVIDENCE_REUSE_INCOMPLETE'])).code));
 await writeFile(sourcePath,sourceBytes);await invoke('phase.submit',{phaseId:'build'});f.human();const review=(await invoke('phase.review',{phaseId:'build'})).manifest.reviewBinding;
 await invoke('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:review.generation,reviewPacketSha256:review.packetSha256}});assert.equal(f.starts(),before);
 for(const root of f.roots)await rm(root,{recursive:true,force:true});for(const {request,accepted}of decisions)assert.deepEqual((await invoke('decision.evidence-reuse',request,true)).record,accepted.record);f.author();
 assert.equal((await invoke('phase.publish',publish,true)).status,'retained');
 await writeFile(path.join(consumer,'contracts.mts'),`
import {createEngine} from '${name}';import {createSourceTestImpactUnit} from '${name}/testing/execution';import {namespaceTestImpactPolicies} from '${name}/testing/recovery';void createSourceTestImpactUnit;void namespaceTestImpactPolicies;import type {NamespaceCombinedReusedExecution} from '${name}/testing/reuse';import type {NamespaceChecksBindings} from '${name}/hosts/namespace-checks';
declare const checks:NamespaceChecksBindings;const configured:NamespaceChecksBindings={...checks,combinedEvidenceReuse:true};void configured;
const engine=createEngine({ports:{}});await engine.run('test-recovery.context',{reuse:'environment-qualified-selected'});
await engine.run('test-recovery.select-context',{phaseId:'build',baselineOperationId:'full',mode:'changed-and-affected'});
await engine.run('test-recovery.select-context',{phaseId:'build',baselineOperationId:'full',mode:'changed-and-affected',candidateGeneration:2});
// @ts-expect-error A generation is a number, not a caller label.
await engine.run('test-recovery.select-context',{phaseId:'build',baselineOperationId:'full',mode:'changed-and-affected',candidateGeneration:'2'});
await engine.run('test-recovery.confirm',{operationId:'agreement',phaseId:'build',reuse:'environment-qualified-selected',expectedContext:'sha256:hash',reason:'Reviewed exact reuse policy'});
await engine.run('evidence-reuse.context',{phaseId:'build',producerPhaseId:'build',producerOperationId:'original'});
await engine.run('decision.evidence-reuse',{phaseId:'build',producerPhaseId:'build',producerOperationId:'original',attemptId:'actual-task',reason:'Reviewed original execution'});
declare const reused:NamespaceCombinedReusedExecution;const version:4=reused.schemaVersion;void version;
// @ts-expect-error Caller success flags are not an execution or human approval.
await engine.run('decision.evidence-reuse',{phaseId:'build',passed:true});
`);
 const program=ts.createProgram([path.join(consumer,'contracts.mts')],{noEmit:true,strict:true,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,skipLibCheck:false,types:[],lib:['lib.es2022.d.ts','lib.dom.d.ts']});
 const diagnostics=ts.getPreEmitDiagnostics(program);assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:file=>file,getCurrentDirectory:()=>consumer,getNewLine:()=> '\n'}));
});
