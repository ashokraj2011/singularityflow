import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';import {resolvePlatformProcess} from '../src/platform-process.mjs';import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('the offline installed application-review SDK preserves native values with all infrastructure and ambient time denied',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-application-review-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives');
  for(const folder of [artifact,consumer,archives])await mkdir(folder);
  const env=isolatedTestEnvironment(path.join(directory,'machine')),child=(executable,args,options)=>{
    const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;},
    npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"type":"module","private":true}\n');npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const fixture=await readFile(new URL('./fixtures/engine-application-review-values/native-v1.json',import.meta.url),'utf8'),
    cases=await readFile(new URL('./helpers/application-review-values-fixture.mjs',import.meta.url),'utf8'),
    source=(await readFile(new URL('./helpers/installed-application-review-values.mjs',import.meta.url),'utf8'))
      .replace("'__APPLICATION_REVIEW_ORACLE__'",JSON.stringify(fixture)).replace('__APPLICATION_REVIEW_CASES__',cases).replaceAll('@sdk-name@',packageName);
  await writeFile(path.join(consumer,'values.mjs'),source);const observed=JSON.parse(child(process.execPath,['values.mjs'],{cwd:consumer,env:{...env,PATH:''}}));
  assert.equal(observed.cases,85);assert.equal(observed.infrastructure,0);
  const types=path.join(consumer,'types.mts');await writeFile(types,[
    'import {applicationReviewPolicies,type ApplicationReviewValues,type ApplicationReviewRecordBytes} from "'+packageName+'/application-review";',
    'import type {SpecificationDigests} from "'+packageName+'/specifications";',
    'declare const bytes:ApplicationReviewRecordBytes;declare const digests:SpecificationDigests;const values:ApplicationReviewValues=applicationReviewPolicies(bytes,digests);',
    'const policy=values.normalizeApplicationReview({mode:"required",surface:"backend"});if(!policy)throw Error("Adopt a policy.");',
    'const session=values.newReviewSession({id:"review",subject:{kind:"story-phase",workId:"sample",phaseId:"delivery",generation:1},policy});',
    'values.appendReviewEvent(session,{actionId:"review-action",expectedRevision:0,type:"target-preparing",actor:{name:"Reviewer"},at:"2026-11-03T10:00:00.000Z"});',
    'const view=values.projectReview(session);const result=values.reviewCompletion(view,{targetCurrent:false,evidenceAvailable:false});const observed:boolean=result.reviewSatisfied;',
    '// @ts-expect-error An invented successful event is outside the protocol.',
    'values.appendReviewEvent(session,{actionId:"new-action",expectedRevision:0,type:"automatically-approved",actor:{},at:"now"});',
    '// @ts-expect-error Value projection cannot accept an approval flag.',
    'values.reviewCompletion(view,{targetCurrent:true,evidenceAvailable:true,approved:true});',
    '// @ts-expect-error Values expose no execution or approval method.',
    'values.approve(session);void observed;'
  ].join('\n'));
  const program=ts.createProgram([types],{noEmit:true,strict:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(row=>ts.flattenDiagnosticMessageText(row.messageText,'\n')),[]);
});
