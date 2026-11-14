/** Packed consumers execute an external runner and consume real selected failure/cohort proofs without source imports. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
import {namespaceCombinedRiskFixture} from './helpers/namespace-combined-risk-fixture.mjs';import {namespacePhaseCheckFixture} from './helpers/namespace-phase-check-fixture.mjs';
import {externalPythonFixture} from './helpers/external-python-runner.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),name='@singularity-flow/engine-sdk';
test('an offline installed SDK executes Python, consumes failed selected cohorts and preserves NodeNext contracts',{timeout:120000},async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-failure-runner-package-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
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
 const sources=[],sourceReaders=[],bindings=[];let checks={mode:'retained-only'};
 if(!value.replay){
  const {createFilesystemSourceUnit,createFilesystemSourceContentReader}=await import('${name}/sources/filesystem'),
   {createExternalCheckExecutionUnit,createExternalCommandExecutionUnit,createNodeCheckExecutionUnit,createEnvironmentQualifiedNodeCheckExecutionUnit,
     EXTERNAL_CHECK_EXECUTION_PROFILE,EXTERNAL_COMMAND_EXECUTION_PROFILE}=await import('${name}/testing/execution'),
   {createNodeExecutionOwner}=await import('${name}/execution/runtime');
  assert.equal(EXTERNAL_CHECK_EXECUTION_PROFILE,'sflow-external-check-execution/v1');assert.equal(EXTERNAL_COMMAND_EXECUTION_PROFILE,'sflow-external-command-execution/v1');
  assert.equal(typeof createExternalCommandExecutionUnit,'function');
  for(const [index,root]of value.roots.entries()){
   const repositoryId=index?'service-'+index:'app',source=await createFilesystemSourceUnit({root,id:value.external?'app-checkout':'clause-source-'+index,
    projectId:value.scope.projectId,repositoryId,...(value.external?{excludePaths:value.external.report.files}:{})});sources.push(source);
   sourceReaders.push(await createFilesystemSourceContentReader({root,id:'installed-source-'+index,source:source.descriptor}));
   for(const row of value.bindings.filter(row=>row.repositoryId===repositoryId)){
    const {unitId,argv,adapter,timeoutMs,...binding}=row,factory=value.external?createExternalCheckExecutionUnit:row.commandId==='node-tests'?createNodeCheckExecutionUnit:createEnvironmentQualifiedNodeCheckExecutionUnit,
     unit=await factory({id:unitId,root,projectId:value.scope.projectId,repositoryId,content,timeoutMs,
      ...(!value.external&&row.commandId!=='node-tests'?{hostId:'known-failure-host'}:{}),command:{executable:value.external?.runtime.executable??process.execPath,
       executableSha256:binding.executableSha256,arguments:argv.slice(1),environment:binding.environment},report:{adapter,files:value.external?.report.files??[]},authorizeCommand:m=>m.manifestSha256});
    bindings.push({...binding,unit:{...unit,start(...args){starts++;return unit.start(...args);}}});
   }
  }
  checks={owner:createNodeExecutionOwner({hostId:value.external?'phase-check-host':'known-failure-host'}),bindings};
  const binding={kind:'machine-local',deviceId:'test-device'};localDatabase=new DatabaseSync(path.join(value.privateDirectory,'content.db'));
  working={records:await createSqliteNamespaceStore({filename:path.join(value.privateDirectory,'records.db'),binding,create:false}),content:createSqliteContentStore({database:localDatabase,binding,create:false})};
 }
 const engine=createNamespaceEngine({records,content,sources,sourceReaders,working,checks,scope:value.scope,workId:value.workId,authority:value.authority,
  access:{current:()=>value.identity},clock:{now(){if(value.replay)throw Error('Replay has no new execution clock');return value.at;}}});
 const result=await engine.run(value.operation,value.input);assert.equal(starts,value.external&&!value.replay?1:0,'Only the explicitly requested external execution may start');process.stdout.write(JSON.stringify(result));
}finally{working?.records.close?.();localDatabase?.close();records.close?.();database.close();hook.deregister();}
`);
 async function invoke(f,operation,input,{external=null,replay=false}={}){
  const phaseId=external?'intake':'build',snapshot=f.state?(await f.state()).snapshot:await f.capture(),commands=snapshot.workflow.phases[phaseId].qualityCommands,
   bindings=f.checks.bindings.map(({unit,...row})=>{const command=commands.find(command=>command.id===row.commandId);return {...row,unitId:unit.descriptor().id,argv:command.argv,
    adapter:command.result.adapter,timeoutMs:command.timeoutMs??300000};});
  return JSON.parse(child(process.execPath,['consumer.mjs',JSON.stringify({directory:f.directory,privateDirectory:f.privateDirectory,roots:f.roots??[f.root],bindings,
   scope:f.scope,workId:f.inputs.workId,authority:f.authority,identity:await f.access.current({}),at:await f.clock.now(),operation,input,external,replay})],{cwd:consumer,env:{...env,PATH:''}}));
 }
 const external=await externalPythonFixture(),python=await namespacePhaseCheckFixture(t,{backend:'sqlite',external}),observed=await invoke(python,'phase.checks.run',python.input,{external});
 assert.equal(observed.verdict,'passed');assert.equal(observed.checks[0].tests.passed,2);assert.equal(python.control.starts,0);
 await rm(python.root,{recursive:true,force:true});assert.deepEqual((await invoke(python,'phase.checks.run',python.input,{external,replay:true})).record,observed.record);
 const f=await namespaceCombinedRiskFixture(t,{kind:'known',backend:'sqlite'});f.human();
 const view=(await invoke(f,'test-cohort.context',{phaseId:'build',baselineOperationId:'original-pre-feature-checks',observedOperationId:'combined-selected-execution',observedPhaseId:'build',candidateGeneration:1})).manifest;
 assert.equal(view.schemaVersion,2);assert.equal(view.execution.verdict,'failed');
 f.author();const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};assert.equal((await invoke(f,'phase.publish',publish)).status,'published');
 assert.equal((await invoke(f,'phase.submit',{phaseId:'build'})).status,'awaiting-approval');f.human();const review=(await invoke(f,'phase.review',{phaseId:'build'})).manifest.reviewBinding;
 assert.equal((await invoke(f,'phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:review.generation,reviewPacketSha256:review.packetSha256}})).approval.selfApproval,false);
 f.author();for(const root of f.roots)await rm(root,{recursive:true,force:true});assert.equal((await invoke(f,'phase.publish',publish,{replay:true})).status,'retained');
 const types=path.join(consumer,'types.mts');await writeFile(types,`
import {createEngine,type EngineInputs} from '${name}';import {createExternalCheckExecutionUnit,createExternalCommandExecutionUnit,EXTERNAL_CHECK_EXECUTION_PROFILE,EXTERNAL_COMMAND_EXECUTION_PROFILE,
 type NodeCheckExecutionOptions,type NodeCommandExecutionOptions} from '${name}/testing/execution';
declare const testOptions:NodeCheckExecutionOptions;declare const commandOptions:NodeCommandExecutionOptions;createExternalCheckExecutionUnit(testOptions);createExternalCommandExecutionUnit(commandOptions);
const testProfile:'sflow-external-check-execution/v1'=EXTERNAL_CHECK_EXECUTION_PROFILE,commandProfile:'sflow-external-command-execution/v1'=EXTERNAL_COMMAND_EXECUTION_PROFILE;void testProfile;void commandProfile;
const engine=createEngine({ports:{}});await engine.run('test-cohort.context',{phaseId:'build',baselineOperationId:'baseline',observedOperationId:'selected',observedPhaseId:'build',candidateGeneration:2});
const confirmed:EngineInputs['test-cohort.confirm']={operationId:'review-cohort',phaseId:'build',baselineOperationId:'baseline',observedOperationId:'selected',observedPhaseId:'build',candidateGeneration:2,expectedContext:'sha256:hash',reason:'Review exact original failed cohort',expires:'2026-11-20'};void confirmed;
// @ts-expect-error A serialized label is not a numeric generation.
await engine.run('test-cohort.context',{phaseId:'build',baselineOperationId:'baseline',observedOperationId:'selected',candidateGeneration:'2'});
// @ts-expect-error A compile check cannot provide a test-report selection.
createExternalCommandExecutionUnit({...commandOptions,report:{adapter:'junit-xml',files:[]}});
// @ts-expect-error An external full-command adapter cannot claim a qualified host observation.
createExternalCheckExecutionUnit({...testOptions,hostId:'unobserved-host'});
`);
 const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
 assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
