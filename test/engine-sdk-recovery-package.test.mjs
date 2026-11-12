/** Installed recovery confirmation and policy replay cannot reach the source checkout or host CLI. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('an offline SDK consumer confirms exact recovery and replays the original agreement after independent final approval',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceEngineFixture(t,{backend:'sqlite',configure(source){source.definition.testRecovery={enabled:true};}});await f.bootstrap();
  f.control.permissions.push('test-recovery.context','test-recovery.confirm');const identity=await f.access.current({}),
    request={operationId:'installed-agreement',phaseId:'intake',expectedContext:(await f.engine.run('test-recovery.context',{})).manifest.expectedContext,
      reason:'The human reviewed the actual full command set and its bounded automatic repair policy.'};
  await writeFile(path.join(consumer,'recovery.mjs'),[
    'import path from "node:path";import {DatabaseSync} from "node:sqlite";import {registerHooks} from "node:module";',
    'const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier))throw Error("No native host discovery");return next(specifier,context);}});',
    'const {createNamespaceEngine}=await import("'+packageName+'/hosts/namespace-engine"),{createSqliteNamespaceStore}=await import("'+packageName+'/storage/sqlite"),',
    '{createSqliteContentStore}=await import("'+packageName+'/storage/sqlite-content"),value=JSON.parse(process.argv[2]),binding={kind:"shared"},',
    'database=new DatabaseSync(path.join(value.directory,"content.db")),records=await createSqliteNamespaceStore({filename:path.join(value.directory,"records.db"),binding,create:false}),',
    'content=createSqliteContentStore({database,binding,create:false});',
    'try{const engine=createNamespaceEngine({records,content,scope:value.scope,workId:value.workId,authority:value.authority,access:{current:()=>value.identity},',
    'clock:{now(){if(value.replay)throw Error("Replay needs its actual retained clock");return value.at;}}});',
    'process.stdout.write(JSON.stringify(await engine.run("test-recovery.confirm",value.request)));}finally{records.close?.();database.close();hook.deregister();}'
  ].join('\n'));
  const invoke=replay=>JSON.parse(child(process.execPath,['recovery.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.workId,
    authority:f.authority,identity,at:awaitClock,request,replay})],{cwd:consumer,env:{...env,PATH:''}})),awaitClock=await f.clock.now();
  const recorded=invoke(false);assert.equal(recorded.record.revision,1);await f.author();await f.review();f.asAuthor();const before=await f.capture();
  assert.deepEqual(invoke(true),recorded);assert.deepEqual(await f.capture(),before);
  const types=path.join(consumer,'types.mts');await writeFile(types,[
    'import type {EngineInputs} from "'+packageName+'";',
    'import type {NamespaceTestRepairBindings} from "'+packageName+'/hosts/namespace-engine";',
    'const input:EngineInputs["phase.repair.run"]={operationId:"repair-one",workId:"story",phaseId:"code",failedOperationId:"failed-check"};',
    '// @ts-expect-error A check operation identity is not a success flag.',
    'const wrong:EngineInputs["phase.repair.run"]={operationId:"repair-one",workId:"story",phaseId:"code",failedOperationId:true};',
    'declare const repairs:NamespaceTestRepairBindings;void input;void wrong;void repairs;'
  ].join('\n'));
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:true,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
