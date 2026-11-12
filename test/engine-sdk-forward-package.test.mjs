/** Installed operations consume actual human records without a local checkout. */
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {namespaceForwardFixture} from './helpers/namespace-forward-fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('offline consumers approve and revalidate the amendment, then replay without private files',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-forward-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp},child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const f=await namespaceForwardFixture(t,{backend:'sqlite'});await f.propose();f.asReviewer();
  const identity=await f.access.current({}),at=await f.clock.now(),decision={workId:f.workId,operationId:'installed-forward-decision',amendmentId:'FAM-001',decision:'approve',confirmation:'FAM-001',
    reason:'The independent human reviewed the exact retained amendment and its original approved dependencies.'},
    revalidate={workId:f.workId,operationId:'installed-forward-reader',phaseId:'design',amendmentId:'FAM-001',outcome:'unchanged',
      reason:'The approved design remains correct for this exact independently reviewed amendment.'};
  await writeFile(path.join(consumer,'forward.mjs'),(await readFile(new URL('./helpers/installed-namespace-forward.mjs',import.meta.url),'utf8')).replaceAll('@sdk-name@',packageName));
  const invoke=replay=>JSON.parse(child(process.execPath,['forward.mjs',JSON.stringify({directory:f.directory,scope:f.scope,workId:f.workId,authority:f.authority,identity,at,decision,revalidate,replay})],{cwd:consumer,env:{...env,PATH:''}})),
    accepted=invoke(false);f.asAuthor();await f.author('delivery');await f.review('delivery');const after=await f.capture();assert.equal(after.workflow.status,'closed');
  assert.deepEqual(invoke(true),accepted);assert.deepEqual(await f.capture(),after);
  const typeFile=path.join(consumer,'types.mts');await writeFile(typeFile,[
    'import type {EngineInputs} from "'+packageName+'";',
    'const input:EngineInputs["forward-amendment.propose"]={workId:"story",operationId:"amend-one",phaseId:"review",reason:"Exact replacement",content:{namespace:"local",sha256:"a".repeat(64),bytes:7}};',
    '// @ts-expect-error An attachment size cannot be a string.',
    'const wrong:EngineInputs["forward-amendment.propose"]={content:{namespace:"local",sha256:"a".repeat(64),bytes:"seven"}};',
    'void input;void wrong;'
  ].join('\n'));
  const program=ts.createProgram([typeFile],{noEmit:true,strict:true,skipLibCheck:true,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
