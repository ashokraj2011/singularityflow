import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('installed cause rules reproduce the original capture with infrastructure and clocks denied',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-test-causes-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives');
  for(const folder of [artifact,consumer,archives])await mkdir(folder);
  const env=isolatedTestEnvironment(path.join(directory,'machine')),child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const capture=JSON.parse(await readFile(new URL('./fixtures/test-run-cause-values/native-v1.json',import.meta.url),'utf8')),
    risks=JSON.parse(await readFile(new URL('./fixtures/test-run-risk-values/native-v1.json',import.meta.url),'utf8')),
    riskHelper=(await readFile(new URL('./helpers/test-run-risk-values-fixture.mjs',import.meta.url),'utf8')).replace('export function','function'),
    helper=(await readFile(new URL('./helpers/test-run-cause-values-fixture.mjs',import.meta.url),'utf8')).replace('export function','function');
  await writeFile(path.join(consumer,'values.mjs'),[
    'import assert from "node:assert/strict";import {registerHooks} from "node:module";',
    'const hook=registerHooks({resolve(specifier,context,next){if(specifier.startsWith("node:"))throw Error("Unexpected infrastructure "+specifier);return next(specifier,context);}});',
    'const {testRunCausePolicies}=await import("'+packageName+'/testing/causes"),rules=testRunCausePolicies({toBytes:value=>Buffer.from(value)});',
    'const {testRunRiskRecordPolicies}=await import("'+packageName+'/testing/risks"),riskValues=testRunRiskRecordPolicies(rules);',
    'Date.now=()=>{throw Error("No ambient cause clock");};',helper,
    riskHelper,'const expectedRisks='+JSON.stringify(risks.cases)+';',
    'for(const [index,row]of testRunRiskValueCases(riskValues).entries())assert.deepEqual(row,expectedRisks[index],row.name);',
    'const expected='+JSON.stringify(capture.cases)+';',
    'for(const [index,row]of testRunCauseValueCases(rules).entries())assert.deepEqual(row,expected[index],row.name);',
    'assert.throws(()=>{rules.TEST_RUN_CAUSES["syntax-error"][0]="environment";},TypeError);hook.deregister();'
  ].join('\n'));child(process.execPath,['values.mjs'],{cwd:consumer,env:{...env,PATH:''}});
  const types=path.join(consumer,'types.mts');await writeFile(types,[
    'import {testRunCausePolicies,type TestRunCause} from "'+packageName+'/testing/causes";',
    'import {testRunRiskRecordPolicies} from "'+packageName+'/testing/risks";',
    'const values=testRunCausePolicies({toBytes:value=>typeof value==="string"?new TextEncoder().encode(value):new Uint8Array(value)});',
    'const risks=testRunRiskRecordPolicies(values);',
    '// @ts-expect-error Risk values cannot authenticate or retain an approval.',
    'risks.approve();',
    '// @ts-expect-error Risk values require an explicit timestamp and reviewer metadata.',
    'risks.recordTestRunRisk({}, {phaseId:"assess"});',
    'const cause:TestRunCause=values.classifyTestRunCause({check:{status:"failed",stderr:"SyntaxError: invalid"},changedPaths:["src/app.js"]});',
    '// @ts-expect-error Classification is not a human risk acceptance operation.',
    'values.acceptRisk(cause);',
    '// @ts-expect-error No authority or successful flag may replace an observed check.',
    'values.classifyTestRunCause({approved:true});',
    '// @ts-expect-error Byte normalization must be bound explicitly.',
    'testRunCausePolicies({});',
    '// @ts-expect-error The descriptive table cannot be rewritten.',
    'values.TEST_RUN_CAUSES["syntax-error"][0]="environment";'
  ].join('\n'));
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
