import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('an offline consumer evaluates the native evidence capture with infrastructure denied and NodeNext types',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-evidence-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives');
  for(const folder of [artifact,consumer,archives])await mkdir(folder);
  const env=isolatedTestEnvironment(path.join(directory,'machine')),child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const fixture=JSON.parse(await readFile(new URL('./fixtures/native-evidence-evaluation-v1.json',import.meta.url),'utf8')),
    source=(await readFile(new URL('./helpers/installed-evidence-values.mjs',import.meta.url),'utf8'))
      .replace("'__EVIDENCE_ORACLE__'",JSON.stringify(JSON.stringify(fixture))).replaceAll('@sdk-name@',packageName);
  await writeFile(path.join(consumer,'values.mjs'),source);child(process.execPath,['values.mjs'],{cwd:consumer,env:{...env,PATH:''}});
  await writeFile(path.join(consumer,'compile.mjs'),(await readFile(new URL('./helpers/installed-command-observation.mjs',import.meta.url),'utf8')).replaceAll('@sdk-name@',packageName));
  child(process.execPath,['compile.mjs'],{cwd:consumer,env:{...env,PATH:''}});
  const types=path.join(consumer,'types.mts');await writeFile(types,[
    'import {evidenceEvaluationPolicies, type EvidenceEvaluationValues} from "'+packageName+'/evidence";',
    'declare const values:EvidenceEvaluationValues;declare const graph:Readonly<Record<string,unknown>>;',
    'const report=values.evaluateEvidence(graph,{at:"2026-10-02T12:00:00.000Z"});const gate:"allow"|"allow-with-risk"|"block"=report.decision.gate;',
    '// @ts-expect-error Time is a required observation, never an implicit host clock.',
    'values.evaluateEvidence(graph,{});',
    '// @ts-expect-error There is no approval or success flag in this value API.',
    'values.evaluateEvidence(graph,{at:"2026-10-02T12:00:00.000Z",approved:true});',
    'import {createNamespaceEngine,type NamespaceEngineOptions} from "'+packageName+'/hosts/namespace-engine";',
    'declare const engineOptions:NamespaceEngineOptions;createNamespaceEngine({...engineOptions,checks:{mode:"retained-only"},repairs:{mode:"retained-only"}});',
    '// @ts-expect-error Retained replay cannot contain an execution owner.',
    'createNamespaceEngine({...engineOptions,checks:{mode:"retained-only",owner:{}}});',
    'import {createNodeCommandExecutionUnit,type NodeCommandExecutionOptions} from "'+packageName+'/testing/execution";',
    'declare const command:NodeCommandExecutionOptions;createNodeCommandExecutionUnit({...command,commandKind:"compile"});',
    '// @ts-expect-error A non-test observation cannot be relabelled as structured test evidence.',
    'createNodeCommandExecutionUnit({...command,commandKind:"test"});',
    'void evidenceEvaluationPolicies;void gate;'
  ].join('\n'));
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
