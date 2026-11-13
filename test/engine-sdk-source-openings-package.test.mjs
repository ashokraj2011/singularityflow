/** Offline package ownership, real source changes and checks; no native Git or CLI. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';import {verificationWorkflow,codeInputArtifact} from './helpers/namespace-code-input-fixture.mjs';
import {releaseReport} from './helpers/namespace-release-fixture.mjs';import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';
import {resolvePlatformProcess} from '../src/platform-process.mjs';import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),name='@singularity-flow/engine-sdk';
test('an offline installed package adopts and rolls over two repositories, retains fresh tests, independently approves and closes through Release',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-source-openings-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  await writeFile(path.join(consumer,'consumer.mjs'),[
    'import assert from "node:assert/strict";import path from "node:path";import {DatabaseSync} from "node:sqlite";import {registerHooks} from "node:module";',
    'const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error("No native Git, CLI or state");return next(specifier,context);}});',
    'const {createNamespaceEngine}=await import("'+name+'/hosts/namespace-engine"),{createSqliteNamespaceStore}=await import("'+name+'/storage/sqlite"),',
    '{createSqliteContentStore}=await import("'+name+'/storage/sqlite-content"),selected=JSON.parse(process.argv[2]),binding={kind:"shared"},',
    'database=new DatabaseSync(path.join(selected.directory,"content.db")),records=await createSqliteNamespaceStore({filename:path.join(selected.directory,"records.db"),binding,create:false}),',
    'content=createSqliteContentStore({database,binding,create:false});let working,localDatabase;',
    'try{const sources=[];if(!selected.mode.startsWith("replay")){const {createFilesystemSourceUnit}=await import("'+name+'/sources/filesystem");',
    'for(const [index,root]of selected.roots.entries())sources.push(await createFilesystemSourceUnit({root,id:"clause-source-"+index,projectId:selected.scope.projectId,repositoryId:index?"service-"+index:"app"}));',
    'const binding={kind:"machine-local",deviceId:"test-device"};localDatabase=new DatabaseSync(path.join(selected.privateDirectory,"content.db"));',
    'working={records:await createSqliteNamespaceStore({filename:path.join(selected.privateDirectory,"records.db"),binding,create:false}),content:createSqliteContentStore({database:localDatabase,binding,create:false})};}',
    'const engine=createNamespaceEngine({records,content,sources,working,scope:selected.scope,workId:selected.workId,authority:selected.authority,access:{current:()=>selected.identity},',
    'clock:{now(){if(selected.mode.startsWith("replay"))throw Error("No replay clock");return selected.at;}}});let result;const phaseId=selected.phaseId;',
    'if(selected.mode==="adopt-preview"){await assert.rejects(engine.run("phase.begin",{phaseId}),error=>{result={code:error.code,...error.details};return error.code==="GENERATION_DIRTY_START";});}',
    'else if(selected.mode==="adopt")result=await engine.run("phase.begin",{phaseId,adoptExisting:true,confirm:selected.confirm});',
    'else if(selected.mode==="rollover")result=await engine.run("phase.rollover",{phaseId,...(selected.confirm?{confirm:selected.confirm}:{})});',
    'else if(selected.mode==="submit")result=await engine.run("phase.submit",{phaseId});',
    'else if(selected.mode==="approve"){const view=await engine.run("phase.review.resources",{phaseId});for(const resource of view.manifest.resources)await engine.run("document.read",{reference:resource.reference});',
    'const b=view.manifest.reviewBinding;result=await engine.run("phase.approve",{phaseId,confirmation:{workId:selected.workId,phase:phaseId,generation:b.generation,reviewPacketSha256:b.packetSha256}});assert.equal(result.approval.selfApproval,false);}',
    'else result=await engine.run("phase.publish",{phaseId,authored:"governed-agent",channel:"copilot-host"});',
    'process.stdout.write(JSON.stringify(result));}finally{working?.records.close?.();localDatabase?.close();records.close?.();database.close();hook.deregister();}'
  ].join('\n'));
  const invoke=async(f,mode,phaseId='build',confirm=null,roots=f.roots)=>JSON.parse(child(process.execPath,['consumer.mjs',JSON.stringify({directory:f.directory,
    privateDirectory:f.privateDirectory,roots,scope:f.scope,workId:f.inputs.workId,authority:f.authority,identity:await f.access.current({}),at:await f.clock.now(),mode,phaseId,confirm})],{cwd:consumer,env:{...env,PATH:''}}));
  const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`').replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n',
    f=await namespaceTestWitnessFixture(t,{backend:'sqlite',repositories:2,plan,configure:source=>{
      verificationWorkflow(source);source.definition.codeDelivery.generationBoundary={dirtyStart:'allow-explicit-adoption'};
      source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',writeScope:'artifact-only',
        inputs:[{phase:'build'},{phase:'verify'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
        approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
      source.definition.workTypes.simple.phases.push('release');source.agents.push({...source.agents[0],id:'release-author',label:'Release author',phases:['release'],defaultFor:['release']});
    },beforePrepare:async(f,_engine,roots)=>{
      f.control.permissions.push('phase.begin','phase.rollover');for(const root of roots)await writeFile(path.join(root,'src/converter.js'),converterSource);
      const head=await f.head(),preview=await invoke(f,'adopt-preview','build',null,roots);assert.equal(preview.review.changedPathCount,2);assert.deepEqual(await f.head(),head);
      assert.equal((await invoke(f,'adopt','build',preview.confirmation,roots)).status,'begun');assert.equal((await invoke(f,'adopt','build',preview.confirmation,roots)).status,'retained');
    }});
  assert.equal((await invoke(f,'publish')).status,'published');const before=await f.capture(),old=before.workflow.phases.build.publicationBindings[0];
  await writeFile(path.join(f.root,'src/converter.js'),converterSource+'// Only the frontend repository changed for this successor.\n');
  const preview=await invoke(f,'rollover');assert.equal(preview.plan.review.repositories.length,2);assert.equal(preview.plan.review.changedPathCount,1);
  assert.equal(preview.plan.review.changedPaths[0].repositoryId,'app');assert.equal((await invoke(f,'rollover','build',preview.plan.confirmation)).status,'begun');
  assert.equal((await invoke(f,'rollover','build',preview.plan.confirmation)).status,'retained');
  const draft=await f.engine.run('phase.draft.read',{phaseId:'build'});await f.engine.run('phase.draft.write',{operationId:'installed-source-successor-summary',workId:f.inputs.workId,phaseId:'build',
    expectedRevision:draft.manifest.draft.revision,content:await f.upload('# Implementation\n\n## Agent brief\n\nBoth repository contracts remain current; only the frontend source note changed and both suites were executed freshly.\n'),reason:'Complete the actual installed successor.'});
  await f.engine.run('phase.source.retain',{operationId:'installed-source-successor',workId:f.inputs.workId,phaseId:'build'});await f.runChecks('installed-successor-checks');
  assert.equal((await invoke(f,'publish')).status,'published');assert.equal((await invoke(f,'submit')).status,'awaiting-approval');
  const author={principalId:f.control.principalId,agentId:f.control.agentId,creator:f.control.creator},human=()=>Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,
    creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  human();await invoke(f,'approve');const code=await f.capture();assert.deepEqual(code.workflow.phases.build.publicationBindings[0],old);
  const publication=await f.json(code.workflow.phases.build.publicationBindings[1].record);assert.ok(publication.policyEvidence.some(row=>row.kind==='code-delivery/v34'));
  for(const [phaseId,agentId,text]of [['verify','verifier',codeInputArtifact],['release','release-author',releaseReport()]]){
    Object.assign(f.control,{...author,agentId});await f.engine.run('phase.prepare',{phaseId});const d=await f.engine.run('phase.draft.read',{phaseId});
    await f.engine.run('phase.draft.write',{operationId:'installed-successor-'+phaseId,workId:f.inputs.workId,phaseId,expectedRevision:d.manifest.draft.revision,
      content:await f.upload(text),reason:'Carry only the approved exact successor execution and repository evidence.'});
    assert.equal((await invoke(f,'publish',phaseId)).status,'published');await invoke(f,'submit',phaseId);human();await invoke(f,'approve',phaseId);
  }
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),4,'both selected repositories execute once per Code generation');
  for(const root of f.roots)await rm(root,{recursive:true,force:true});for(const phaseId of ['build','verify','release'])assert.equal((await invoke(f,'replay',phaseId)).status,'retained');
  const types=path.join(consumer,'types.mts');await writeFile(types,[
    'import type {EngineInputs} from "'+name+'";import {namespaceSourceOpeningPolicies} from "'+name+'/changes";import type {SourceSnapshot,SourceDescriptor} from "'+name+'/source";',
    'const begin:EngineInputs["phase.begin"]={phaseId:"build",adoptExisting:true,confirm:"sha256:"+"a".repeat(64)};',
    'const rollover:EngineInputs["phase.rollover"]={phaseId:"build",confirm:"sha256:"+"a".repeat(64)};',
    'const values=namespaceSourceOpeningPolicies({profile:"sflow-text-digests/sha256-utf8-v1",sha256Utf8:text=>"a".repeat(64)});values.hash({source:"actual"});',
    'declare const snapshot:SourceSnapshot;declare const descriptor:SourceDescriptor;const restored:SourceSnapshot=values.restored(snapshot,{},descriptor);void restored;',
    '// @ts-expect-error No caller-supplied authority or source root.',
    'const wrong:EngineInputs["phase.rollover"]={phaseId:"build",approved:true,root:"/other"};void begin;void rollover;void wrong;'
  ].join('\n'));
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
