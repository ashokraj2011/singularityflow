/** Real offline installed SQL execution and shared-only replay, without a source checkout. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile,realpath,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
import {namespaceDataFixture} from './helpers/namespace-data-fixture.mjs';
const name='@singularity-flow/engine-sdk';
test('the installed SDK executes actual SQL and takes over a Git-free Story without private files or an executor',{timeout:120000},async t=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'sflow-data-package-')));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5}));
 const artifact=path.join(root,'package'),archives=path.join(root,'archives'),consumer=path.join(root,'consumer');for(const dir of [artifact,archives,consumer])await mkdir(dir);
 const env=isolatedTestEnvironment(path.join(root,'machine')),child=(exe,args,options={})=>{const result=spawnSync(exe,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
 npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
 for(const file of ['package.json','README.md'])await copyFile(new URL('../packages/engine-sdk/'+file,import.meta.url),path.join(artifact,file));
 await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
 await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
 await writeFile(path.join(consumer,'run.mjs'),`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {DatabaseSync} from 'node:sqlite';import path from 'node:path';import {readFile,realpath} from 'node:fs/promises';import {createHash} from 'node:crypto';
const hook=registerHooks({resolve(specifier,context,next){if(/\\/(?:git|cli|state)\\.mjs$/u.test(specifier)||new RegExp(['copilot','provider-runtime','sfield'].join('|'),'u').test(specifier))throw Error('Unexpected Git, native dispatcher or AI dependency: '+specifier);return next(specifier,context);}});
const {createNamespaceEngine}=await import('${name}/hosts/namespace-engine'),{createSqliteNamespaceStore}=await import('${name}/storage/sqlite'),
 {createSqliteContentStore}=await import('${name}/storage/sqlite-content'),{datasetSnapshot}=await import('${name}/work-products'),value=JSON.parse(process.argv[2]),binding={kind:'shared'},
 records=await createSqliteNamespaceStore({filename:path.join(value.directory,'records.db'),binding,create:false}),db=new DatabaseSync(path.join(value.directory,'content.db')),content=createSqliteContentStore({database:db,binding,create:false});
try{
 let data={mode:'retained-only'},starts=0;
 if(!value.replay){const {createSqliteDataExecutionUnit,SQLITE_DATA_DRIVER_SHA256}=await import('${name}/execution/data'),{createExecutionUnitManifest}=await import('${name}/execution/node'),{createNodeExecutionOwner}=await import('${name}/execution/runtime'),exe=await realpath(process.execPath),
   manifest=createExecutionUnitManifest({...Object.fromEntries(Object.entries(value.manifest).filter(([key])=>!['schemaVersion','kind','manifestSha256'].includes(key))),toolPolicy:{...value.manifest.toolPolicy,driverSha256:SQLITE_DATA_DRIVER_SHA256}}),
   unit=createSqliteDataExecutionUnit({manifest,executable:exe,executableSha256:createHash('sha256').update(await readFile(exe)).digest('hex'),scope:value.scope,content,authorize:()=>true});
   data={owner:createNodeExecutionOwner({hostId:'installed-sql-data'}),bindings:[{adapterId:'sql-data',unit:{...unit,start(...args){starts++;return unit.start(...args);}}}]};}
 const engine=createNamespaceEngine({records,content,scope:value.scope,workId:value.workId,authority:value.authority,data,
   access:{current:()=>value.identity},clock:{now(){if(value.replay)throw Error('Acknowledgement cannot restamp execution');return value.at;}}}),result=await engine.run('data.execute',value.input);
 assert.equal(starts,value.replay?0:1);assert.equal(result.record.checks[0].observed,50);if(value.replay)assert.equal(result.status,'retained');
 const output=await content.read(value.scope,result.record.asset.content);assert.deepEqual(datasetSnapshot(JSON.parse(Buffer.from(output.data))).rows,[{total:50}]);
 process.stdout.write(JSON.stringify(result));
}finally{records.close();db.close();hook.deregister();}
`);
 const f=await namespaceDataFixture(t);await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');
 const context=await f.engine.run('work-product.context',{phaseId:'analyze'}),input={operationId:'installed-query',workId:f.inputs.workId,phaseId:'analyze',expected:context.expected};
 const invoke=async replay=>JSON.parse(child(process.execPath,['run.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.inputs.workId,authority:f.authority,
   identity:await f.access.current({}),at:await f.clock.now(),manifest:f.manifest,input,replay})],{cwd:consumer,env:{...env,PATH:''}}));
 const executed=await invoke(false);await f.authorAndSubmit('analyze');await f.approve('analyze');await f.authorAndSubmit('accept');await f.approve('accept');
 await rm(f.privateDirectory,{recursive:true,force:true});f.control.permissions=[];const retained=await invoke(true);assert.deepEqual(retained.record,executed.record);assert.equal((await f.capture()).workflow.status,'closed');
 const types=path.join(consumer,'types.mts');await writeFile(types,`
import {createEngine,type EngineInputs} from '${name}';import {datasetSnapshot,workProductPolicy,type WorkProductPolicy,type DatasetSnapshot} from '${name}/work-products';
import {createSqliteDataExecutionUnit,sqliteDataRequest,SQLITE_DATA_DRIVER_SHA256} from '${name}/execution/data';import type {NamespaceEngineOptions} from '${name}/hosts/namespace-engine';
const driverDigest:string=SQLITE_DATA_DRIVER_SHA256;void driverDigest;
declare const policy:WorkProductPolicy;workProductPolicy(policy);declare const dataset:DatasetSnapshot;datasetSnapshot(dataset);sqliteDataRequest({query:'SELECT * FROM orders;',datasets:[{table:'orders',data:dataset}]});
const engine=createEngine({ports:{}});await engine.run('data.execute',{operationId:'query-1',workId:'analysis',phaseId:'analyze',expected:'digest'});
const retain:EngineInputs['work-product.retain']={operationId:'retain',workId:'analysis',phaseId:'intake',assetId:'query',content:{namespace:'evidence',sha256:'digest',bytes:1},reason:'Retain approved SQL'};void retain;
declare const options:NamespaceEngineOptions;void options.data;
// @ts-expect-error Execution must bind the inspected inputs.
await engine.run('data.execute',{operationId:'query-1',workId:'analysis',phaseId:'analyze'});
// @ts-expect-error Retention uses immutable content, not a laptop path.
await engine.run('work-product.retain',{...retain,content:'/private/query.sql'});
// @ts-expect-error An amendment needs its exact reviewed context.
await engine.run('work-product.amend',retain);
`);
 const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
 assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
