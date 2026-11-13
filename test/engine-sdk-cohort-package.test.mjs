/** Real offline consumer of the registered cohort and Code-risk owners; no native Git or global installation. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceTestWitnessFixture,actualWitnessTest} from './helpers/namespace-test-witness-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),name='@singularity-flow/engine-sdk',
  reason='The independent integration suite retains the omitted regression and validates the exact unavailable service before deployment.',
  extra="test('existing independent regression',()=>assert.equal(2+2,4));\n",
  failed=actualWitnessTest.replace("import {convert}","import net from 'node:net';import {once} from 'node:events';\nimport {convert}")
    .replace("()=>assert.equal(convert(255),'FF')","async()=>{assert.equal(convert(255),'FF');const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));await once(net.connect({host:'127.0.0.1',port}),'connect');}");
test('installed cohort scope and genuine Code environment failure retain separate human records, final evidence and offline replay',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-cohort-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceTestWitnessFixture(t,{backend:'filesystem',testSource:actualWitnessTest+extra,run:false});
  f.control.permissions.push('test-cohort.context','test-cohort.confirm','test-risk.context','decision.test-risk','story.evidence');
  const human=()=>Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}}),
    author=()=>Object.assign(f.control,{principalId:'author',agentId:'analyst',creator:{name:'Phase author',email:'reviewer@example.test',login:null}});
  await f.runChecks('installed-baseline');await writeFile(path.join(f.root,'test/converter.test.js'),actualWitnessTest);
  await f.engine.run('phase.source.retain',{operationId:'installed-selected-source',workId:f.inputs.workId,phaseId:'build'});await f.runChecks('installed-selected-run');
  await writeFile(path.join(consumer,'consumer.mjs'),[
    'import assert from "node:assert/strict";import path from "node:path";import {DatabaseSync} from "node:sqlite";import {registerHooks} from "node:module";',
    'const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error("No native Git, CLI or state owner");return next(specifier,context);}});',
    'const {createNamespaceEngine}=await import("'+name+'/hosts/namespace-engine"),{createFilesystemNamespaceStore}=await import("'+name+'/storage/filesystem"),',
    '{createSqliteContentStore}=await import("'+name+'/storage/sqlite-content"),value=JSON.parse(process.argv[2]),binding={kind:"shared"},',
    'database=new DatabaseSync(path.join(value.directory,"content.db")),records=await createFilesystemNamespaceStore({root:path.join(value.directory,"records"),binding,create:false}),',
    'content=createSqliteContentStore({database,binding,create:false});let localDatabase,working;',
    'try{const sources=[];if(value.mode!=="replay"){const {createFilesystemSourceUnit}=await import("'+name+'/sources/filesystem");',
    'sources.push(await createFilesystemSourceUnit({root:value.root,id:value.sourceId,projectId:value.scope.projectId,repositoryId:"app"}));',
    'const binding={kind:"machine-local",deviceId:"test-device"};localDatabase=new DatabaseSync(path.join(value.privateDirectory,"content.db"));',
    'working={records:await createFilesystemNamespaceStore({root:path.join(value.privateDirectory,"records"),binding,create:false}),content:createSqliteContentStore({database:localDatabase,binding,create:false})};}',
    'const engine=createNamespaceEngine({records,content,sources,working,scope:value.scope,workId:value.workId,authority:value.authority,access:{current:()=>value.identity},',
    'clock:{now(){if(value.mode==="replay")throw Error("No replay clock");return value.at;}}});let result;',
    'if(value.mode==="context")result=await engine.run("test-cohort.context",value.context);',
    'else if(value.mode==="decide"){result=await engine.run("test-cohort.confirm",value.request);const view=await engine.run("test-risk.context",{phaseId:"build"});',
    'await engine.run("decision.test-risk",{phaseId:"build",commandId:"node-tests",argvSha256:view.manifest.commands[0].argvSha256,causeClass:"service-unreachable",cause:"The required service is unavailable on this isolated device.",reason:value.reason,expires:"2026-11-20"});}',
    'else if(value.mode==="submit")result=await engine.run("phase.submit",{phaseId:"build"});',
    'else if(value.mode==="approve"){const r=(await engine.run("phase.review",{phaseId:"build"})).manifest.reviewBinding;',
    'result=await engine.run("phase.approve",{phaseId:"build",confirmation:{workId:value.workId,phase:"build",generation:r.generation,reviewPacketSha256:r.packetSha256}});',
    'assert.equal(result.approval.selfApproval,false);const view=await engine.run("story.evidence",{});assert.equal(view.manifest.report.completion.kind,"complete-with-exceptions");}',
    'else if(value.mode==="replay")result=await engine.run("test-cohort.confirm",value.request);',
    'else result=await engine.run("phase.publish",{phaseId:"build",authored:"governed-agent",channel:"copilot-host"});',
    'process.stdout.write(JSON.stringify(result));}finally{working?.records.close?.();localDatabase?.close();records.close?.();database.close();hook.deregister();}'
  ].join('\n'));
  const context={phaseId:'build',baselineOperationId:'installed-baseline',observedOperationId:'installed-selected-run'};let request;
  const invoke=async mode=>JSON.parse(child(process.execPath,['consumer.mjs',JSON.stringify({directory:f.directory,privateDirectory:f.privateDirectory,root:f.root,
    sourceId:f.sources[0].descriptor.id,scope:f.scope,workId:f.inputs.workId,authority:f.authority,identity:await f.access.current({}),at:await f.clock.now(),mode,request,context,reason})],{cwd:consumer,env:{...env,PATH:''}}));
  human();const view=await invoke('context');request={...context,operationId:'installed-confirmed-cohort',expectedContext:view.manifest.expectedContext,reason,expires:'2026-11-20'};
  const recorded=await invoke('decide');assert.equal(recorded.record.id,'TCO-001');author();
  const draft=(await f.engine.run('phase.draft.read',{phaseId:'build'})).manifest.draft;
  await f.engine.run('phase.draft.rebase',{operationId:'installed-cohort-continuation',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.revision,confirm:draft.bodySha256,reason});
  await writeFile(path.join(f.root,'test/converter.test.js'),failed);await f.engine.run('phase.source.retain',{operationId:'installed-failed-source',workId:f.inputs.workId,phaseId:'build'});
  assert.equal((await f.runChecks('installed-failed-execution')).verdict,'failed');assert.equal((await invoke('publish')).status,'published');
  assert.equal((await invoke('submit')).status,'awaiting-approval');human();assert.equal((await invoke('approve')).status,'recorded');
  await rm(f.root,{recursive:true,force:true});assert.equal((await invoke('replay')).status,'retained');assert.equal(f.starts(),3);
  const types=path.join(consumer,'types.mts');await writeFile(types,[
    'import type {EngineInputs} from "'+name+'";import {namespaceTestCohortPolicies,namespaceCodeEnvironmentRiskCoverage} from "'+name+'/testing/recovery";',
    'const read:EngineInputs["test-cohort.context"]={phaseId:"build",baselineOperationId:"baseline",observedOperationId:"selected"};',
    'const write:EngineInputs["test-cohort.confirm"]={operationId:"human-confirmation",phaseId:"build",reason:"The original approver confirms the observed cohort."};',
    'const recovery:EngineInputs["test-risk.confirm-recovery"]={operationId:"exact-recovery",phaseId:"build",commandId:"tests",argvSha256:"a".repeat(64),causeClass:"service-unreachable",cause:"The service is unavailable.",reason:"The independent integration suite retains validation.",expires:"2026-11-20",expectedRecovery:"sha256:"+"a".repeat(64)};',
    'const values=namespaceTestCohortPolicies({profile:"sflow-text-digests/sha256-utf8-v1",sha256Utf8:value=>"a".repeat(64)});const cases=values.cases({discovered:1},[{file:"test/a.js",name:"original",ancestorTitles:[],outcome:"passed"}]);',
    'values.compare([{repositoryId:"app",commandId:"tests",pinSha256:"pin",cases}],[{repositoryId:"app",commandId:"tests",pinSha256:"pin",cases}]);namespaceCodeEnvironmentRiskCoverage([],"app",null);',
    '// @ts-expect-error Native-style flags cannot authorize a namespace cohort.',
    'const wrong:EngineInputs["test-cohort.confirm"]={operationId:"wrong",reason:"No confirmation",approved:true};',
    '// @ts-expect-error Test scope requires a retained observed run.',
    'const missing:EngineInputs["test-cohort.context"]={phaseId:"build",baselineOperationId:"baseline"};void read;void write;void recovery;void wrong;void missing;'
  ].join('\n'));
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
