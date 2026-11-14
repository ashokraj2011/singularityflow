/** Offline installed consumer: real SGOS runs, current environments and accepted shared-only replay. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './helpers/namespace-selective-test-recovery-fixture.mjs';
import {namespaceEvidenceReuseFixture,reuseReason} from './helpers/namespace-evidence-reuse-fixture.mjs';
import {createEnvironmentQualifiedNodeCheckExecutionUnit} from '../src/sgos/node-check-execution-unit.mjs';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),name='@singularity-flow/engine-sdk',executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
test('offline package executes independent selection, qualified reuse and exact replay with NodeNext contracts',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-selective-reuse-package-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  await writeFile(path.join(consumer,'consumer.mjs'),`
import assert from 'node:assert/strict';import path from 'node:path';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error('No native Git, CLI or state modules');return next(specifier,context);}});
const {createNamespaceEngine}=await import('${name}/hosts/namespace-engine'),{createSqliteNamespaceStore}=await import('${name}/storage/sqlite'),
 {createSqliteContentStore}=await import('${name}/storage/sqlite-content'),value=JSON.parse(process.argv[2]),binding={kind:'shared'},
 database=new DatabaseSync(path.join(value.directory,'content.db')),records=await createSqliteNamespaceStore({filename:path.join(value.directory,'records.db'),binding,create:false}),
 content=createSqliteContentStore({database,binding,create:false});let working,localDatabase;
try{
 const sources=[],sourceReaders=[];let checks;
 if(!value.mode.startsWith('replay')){
  const {createFilesystemSourceUnit,createFilesystemSourceContentReader}=await import('${name}/sources/filesystem'),
   {createNodeCheckExecutionUnit,createEnvironmentQualifiedNodeCheckExecutionUnit}=await import('${name}/testing/execution'),
   {createNodeExecutionOwner}=await import('${name}/execution/runtime'),bindings=[],executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
  for(const [index,root]of value.roots.entries()){
   const repositoryId=index?'service-'+index:'app',source=await createFilesystemSourceUnit({root,id:value.reuse?'app-checkout':'clause-source-'+index,projectId:value.scope.projectId,repositoryId});sources.push(source);
   sourceReaders.push(await createFilesystemSourceContentReader({root,id:'installed-source-'+index,source:source.descriptor}));
   if(value.reuse){const unit=await createEnvironmentQualifiedNodeCheckExecutionUnit({id:'installed-qualified-reuse',hostId:'qualified-host',root,projectId:value.scope.projectId,repositoryId,content,
     command:{executable:process.execPath,executableSha256,arguments:['--test','--test-reporter=tap','case.test.mjs'],environment:{}},report:{adapter:'node-tap',files:[]},authorizeCommand:m=>m.manifestSha256});
    const observation=await unit.observeEnvironment();assert.equal(observation.profile,'sflow-node-check-environment-observation/v1');
    bindings.push({phaseId:'assess',commandId:'node-tests',repositoryId,executable:'node',executableSha256,environment:{},unit});
   }else{
    const environment={NODE_OPTIONS:'--test-reporter='+import.meta.resolve('${name}/testing/node-test-reporter'),SINGULARITY_FLOW_NODE_TEST_ROOT:root,SINGULARITY_FLOW_NODE_TEST_TAP:'1'},
     primary=await createNodeCheckExecutionUnit({id:'installed-primary',root,projectId:value.scope.projectId,repositoryId,content,command:{executable:process.execPath,executableSha256,arguments:['--test','test/converter.test.js'],environment},report:{adapter:'node-tap',files:[]},authorizeCommand:m=>m.manifestSha256}),
     legacy=await createEnvironmentQualifiedNodeCheckExecutionUnit({id:'installed-legacy',hostId:'selective-host',root,projectId:value.scope.projectId,repositoryId,content,
       command:{executable:process.execPath,executableSha256,arguments:['--test','--test-reporter=junit','test/first.test.js','test/second.test.js'],environment:{}},report:{adapter:'junit-xml',files:[]},authorizeCommand:m=>m.manifestSha256});
    for(const [commandId,unit,env]of [['node-tests',primary,environment],['legacy-tests',legacy,{}]])bindings.push({phaseId:'build',commandId,repositoryId,executable:'node',executableSha256,environment:env,unit});
   }
  }
  checks={owner:createNodeExecutionOwner({hostId:value.reuse?'qualified-host':'selective-host'}),bindings,...(value.reuse?{environmentSensitiveReuse:true}:{})};
  const binding={kind:'machine-local',deviceId:'test-device'};localDatabase=new DatabaseSync(path.join(value.privateDirectory,'content.db'));
  working={records:await createSqliteNamespaceStore({filename:path.join(value.privateDirectory,'records.db'),binding,create:false}),content:createSqliteContentStore({database:localDatabase,binding,create:false})};
 }else checks={mode:'retained-only'};
 const engine=createNamespaceEngine({records,content,sources,sourceReaders,working,checks,scope:value.scope,workId:value.workId,authority:value.authority,
   access:{current:()=>value.identity},clock:{now(){if(value.mode.startsWith('replay'))throw Error('No new replay timestamp');return value.at;}}});let result;
 if(value.mode==='select-context')result=await engine.run('test-recovery.select-context',value.input);
 else if(value.mode==='select-confirm'||value.mode==='replay-selection')result=await engine.run('test-recovery.select-confirm',value.input);
 else if(value.mode==='checks'||value.mode==='replay-checks')result=await engine.run('phase.checks.run',value.input);
 else if(value.mode==='reuse-context')result=await engine.run('evidence-reuse.context',{phaseId:'assess'});
 else result=await engine.run('decision.evidence-reuse',value.input);
 process.stdout.write(JSON.stringify(result));
}finally{working?.records.close?.();localDatabase?.close();records.close?.();database.close();hook.deregister();}
`);
  const invoke=async(f,mode,input,reuse=false)=>JSON.parse(child(process.execPath,['consumer.mjs',JSON.stringify({directory:f.directory,privateDirectory:f.privateDirectory,
    roots:reuse?[f.root]:f.roots,scope:f.scope,workId:f.inputs.workId,authority:f.authority,identity:await f.access.current({}),at:await f.clock.now(),mode,input,reuse})],{cwd:consumer,env:{...env,PATH:''}}));
  const f=await namespaceSelectiveTestRecoveryFixture(t),view=await invoke(f,'select-context',f.contextInput);assert.equal(view.manifest.rows[0].excludedIds[0],'legacy:second');f.human();
  const request={...f.contextInput,operationId:'installed-selective-confirm',expectedContext:view.manifest.expectedContext,reason:selectionReason,expires:'2026-11-20',followUpOwner:'suite-owner',remediationRef:'FIX-1'};
  const confirmed=await invoke(f,'select-confirm',request);assert.equal(confirmed.record.profile,'sflow-namespace-selective-test-recovery/v1');await f.rebase();
  const checkInput={operationId:'installed-selective-execution',workId:f.inputs.workId,phaseId:'build'},tested=await invoke(f,'checks',checkInput);
  assert.equal(tested.verdict,'passed');assert.equal(tested.execution.completeSuiteClaimed,false);assert.equal(tested.checks.find(row=>row.id==='legacy-tests').tests.passed,1);
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  await rm(f.root,{recursive:true,force:true});f.human();assert.equal((await invoke(f,'replay-selection',request)).status,'retained');f.author();assert.equal((await invoke(f,'replay-checks',checkInput)).replayed,true);
  const r=await namespaceEvidenceReuseFixture(t,{backend:'sqlite',beforePrepare:async input=>{
    const unit=await createEnvironmentQualifiedNodeCheckExecutionUnit({id:'qualified-producer',hostId:'qualified-host',root:path.join(input.directory,'checkout'),projectId:input.scope.projectId,repositoryId:'app',content:input.content,
      command:{executable:process.execPath,executableSha256,arguments:['--test','--test-reporter=tap','case.test.mjs'],environment:{}},report:{adapter:'node-tap',files:[]},authorizeCommand:m=>m.manifestSha256});
    input.checks.environmentSensitiveReuse=true;input.checks.bindings[0].unit=unit;input.checks.bindings.push({...input.checks.bindings[0],phaseId:'assess'});
  }});r.human();const reusable=await invoke(r,'reuse-context',null,true);assert.equal(reusable.manifest.candidates[0].environmentMatches,true);
  const reuseRequest={phaseId:'assess',attemptId:reusable.manifest.candidates[0].taskId,reason:reuseReason},reused=await invoke(r,'reuse',reuseRequest,true);
  assert.equal(reused.record.profile,'sflow-namespace-evidence-reuse/v2');await r.prepareReceiver();await r.engine.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'});
  await rm(r.root,{recursive:true,force:true});r.human();assert.deepEqual((await invoke(r,'replay-reuse',reuseRequest,true)).record,reused.record);
  await writeFile(path.join(consumer,'contracts.mts'),`
import {createEngine} from '${name}';import {namespaceSelectiveTestRecoveryPolicies} from '${name}/testing/recovery';
import {createEnvironmentQualifiedNodeCheckExecutionUnit,type NodeCheckExecutionOptions} from '${name}/testing/execution';
import type {NamespaceChecksBindings} from '${name}/hosts/namespace-checks';import type {NamespaceQualifiedReusedExecution} from '${name}/testing/reuse';
declare const options:NodeCheckExecutionOptions;declare const checks:NamespaceChecksBindings;declare const digests:Parameters<typeof namespaceSelectiveTestRecoveryPolicies>[0];
const engine=createEngine({ports:{}});await engine.run('test-recovery.select-context',{phaseId:'build',baselineOperationId:'original',selection:[{repositoryId:'app',commandId:'tests',files:['test/a.js']}]});
await engine.run('test-recovery.select-confirm',{operationId:'review-files',phaseId:'build',baselineOperationId:'original',expectedContext:'sha256:digest',selection:[{repositoryId:'app',commandId:'tests',files:['test/a.js']}],reason:'Reviewed complete file scope',expires:'2026-11-20',followUpOwner:'team',remediationRef:'FIX-1'});
const unit=await createEnvironmentQualifiedNodeCheckExecutionUnit({...options,hostId:'host'}),observed=await unit.observeEnvironment();
await unit.selectTestFiles({files:['test/a.js'],selectionSha256:'sha256:digest',originalArgumentsSha256:'sha256:digest'});
const qualified:NamespaceChecksBindings={...checks,environmentSensitiveReuse:true};void qualified;void observed;namespaceSelectiveTestRecoveryPolicies(digests).selection([{repositoryId:'app',commandId:'tests',files:['test/a.js']}]);
declare const reused:NamespaceQualifiedReusedExecution;const version:2=reused.schemaVersion;void version;
// @ts-expect-error No success flags in a human file selection.
await engine.run('test-recovery.select-confirm',{operationId:'invented',reason:'fake',approved:true});
// @ts-expect-error No arbitrary argv is accepted as a selected file list.
await unit.selectTestFiles({arguments:['--require=override']});
`);
  const program=ts.createProgram([path.join(consumer,'contracts.mts')],{noEmit:true,strict:true,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,skipLibCheck:false,types:[],lib:['lib.es2022.d.ts','lib.dom.d.ts']});
  const diagnostics=ts.getPreEmitDiagnostics(program);assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:file=>file,getCurrentDirectory:()=>consumer,getNewLine:()=> '\n'}));
});
