import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {createGitEngine} from '../src/engine-compatibility/git-publication.mjs';
import {phaseReview as legacyReview} from '../src/commands/shared/phase-review.mjs';
import {phaseReview as nativeReview} from '../src/engine-compatibility/native-phase-review.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {publishedPlanningStory,startedSpecificationStory,CLI} from './helpers/submitted-planning-story.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function submitted(t,id) {
  const fixture=await publishedPlanningStory(t,id);
  fixture.cli('submit','planning','--skip-checks');
  return fixture;
}
async function observedCli(f) {
  const file=path.join(f.directory,'phase-review.capture.json');
  const result=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,
    CLI,'--no-model','phase','show','planning','--json'],{cwd:f.root,allowFailure:true,
      env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  return {actual:JSON.parse(result.stdout),captured:JSON.parse(await readFile(file,'utf8'))};
}

test('native SDK and CLI review share verified references while CLI output and terminal consent stay in their host',async t=>{
  const id='SDK-REVIEW',f=await submitted(t,id),api=createSflow({root:f.root});
  const file=path.join(f.root,'singularity/work-items',id,'workflow.json'),before=await readFile(file),head=f.git('rev-parse','HEAD');
  const terminal=path.resolve(f.root,f.git('rev-parse','--git-dir'),'singularity-flow/terminal-reviews');
  assert.equal(existsSync(terminal),false);assert.equal(legacyReview,nativeReview);
  const sdk=await api.run('phase.review',{workId:id,phaseId:'planning'});
  assert.equal(sdk.manifest.integrity,'matched');assert.equal(sdk.manifest.reviewBinding.generation,1);
  assert.ok(sdk.manifest.items.some(item=>item.primary));assert.ok(sdk.manifest.items.some(item=>item.role==='agent-brief'));
  assert.equal(JSON.stringify(sdk).includes(f.root),false);assert.equal(JSON.stringify(sdk).includes('## Agent brief'),false);
  const {actual,captured}=await observedCli(f);
  assert.equal(captured.operation,'phase.review');assert.deepEqual(captured.result.manifest,sdk.manifest);
  for(const item of sdk.manifest.items) {
    const document=actual.documents.find(document=>document.id===item.id);assert.ok(document,item.id);
    assert.equal(document.sha256,item.observed.sha256);assert.equal(document.generation,item.reference.generation);
  }
  assert.equal(actual.reviewBinding.reviewPacketSha256,sdk.manifest.reviewBinding.packetSha256);
  assert.ok(actual.documents[0].content,'the old full JSON presentation is retained');
  assert.equal('manifest' in actual,false,'the SDK contract is projected separately from legacy CLI JSON');
  const aggregate=await createGitEngine({root:f.root}).engine.run('phase.review',{workId:id,phaseId:'planning'});
  assert.deepEqual(aggregate.manifest,sdk.manifest,'full and narrow compositions share the same registry and native port');
  const historical=await api.run('phase.review',{phaseId:'specification'});
  assert.equal(historical.manifest.reviewBinding,null);assert.equal(historical.phase,'specification');
  assert.equal(f.git('rev-parse','HEAD'),head);assert.deepEqual(await readFile(file),before);assert.equal(existsSync(terminal),false);

  const loader=`export async function resolve(specifier,context,next){
    if(specifier.endsWith('/git-publication.mjs')||specifier.endsWith('/commands/legacy.mjs'))throw Error('Eager mutation/legacy runtime: '+specifier);
    return next(specifier,context);
  }`;
  const source=`import {register} from 'node:module';
    register(${JSON.stringify('data:text/javascript,'+encodeURIComponent(loader))},import.meta.url);
    const {createSflow}=await import(${JSON.stringify(new URL('../src/api.mjs',import.meta.url).href)});
    const result=await createSflow({root:${JSON.stringify(f.root)}}).run('phase.review',{phaseId:'planning'});
    console.log(JSON.stringify({status:result.status,integrity:result.manifest.integrity}));`;
  const narrow=run(process.execPath,['--input-type=module','-e',source],{cwd:f.root,allowFailure:true});
  assert.equal(narrow.status,0,narrow.stdout+'\n'+narrow.stderr);
  assert.deepEqual(JSON.parse(narrow.stdout),{status:'inspected',integrity:'matched'});
});

test('missing retained members and edited primary bytes cannot disappear or acquire a false submitted binding',async t=>{
  const id='SDK-REVIEW-MISSING',f=await submitted(t,id),api=createSflow({root:f.root});
  const accepted=await loadAcceptedStoryExecution(f.root,id),phase=accepted.workflow.phases.planning;
  const file=path.join(f.root,'singularity/work-items',id,phase.requiredArtifact.path),original=await readFile(file);
  const head=f.git('rev-parse','HEAD'),initial=await api.run('phase.review',{phaseId:'planning'});
  const primary=initial.manifest.items.find(item=>item.primary);assert.ok(primary);assert.equal(primary.observed.sha256,digest(original));
  await rm(file);
  const missing=await api.run('phase.review',{phaseId:'planning'}),absent=missing.manifest.items.find(item=>item.primary);
  assert.equal(missing.manifest.integrity,'unavailable');assert.equal(missing.manifest.reviewBinding,null);
  assert.equal(absent.reference.id,primary.reference.id);assert.equal(absent.expected.sha256,primary.expected.sha256);
  assert.equal(absent.observed,null);assert.match(absent.error.message,/not a regular file/u);
  assert.equal(absent.error.cause.code,'ENOENT');assert.equal(absent.error.cause.syscall,'lstat');
  await writeFile(file,original);
  const restored=await api.run('phase.review',{phaseId:'planning'});
  assert.equal(restored.manifest.integrity,'matched');assert.deepEqual(restored.manifest.items,initial.manifest.items);
  await writeFile(file,Buffer.concat([original,Buffer.from('\nUnpublished local change.\n')]));
  const changed=await api.run('phase.review',{phaseId:'planning'}),edited=changed.manifest.items.find(item=>item.primary);
  assert.equal(changed.manifest.integrity,'changed');assert.equal(changed.manifest.reviewBinding,null);
  assert.equal(edited.expected.sha256,primary.expected.sha256);assert.notEqual(edited.observed.sha256,primary.observed.sha256);
  assert.equal(edited.reference.id,primary.reference.id);assert.equal(f.git('rev-parse','HEAD'),head);
  await writeFile(file,original);
  const source=`import {mock} from 'node:test';import * as nativeFs from 'node:fs/promises';
    const target=${JSON.stringify(file)}, {default:ignored,...named}=nativeFs;
    const denied=async candidate=>{if(candidate===target)throw Object.assign(new Error('stat denied by the volume'),{code:'EACCES',errno:-13,syscall:'lstat',path:target});return nativeFs.lstat(candidate);};
    mock.module('node:fs/promises',{namedExports:{...named,lstat:denied},defaultExport:{...nativeFs.default,lstat:denied}});
    const {createSflow}=await import(${JSON.stringify(new URL('../src/api.mjs',import.meta.url).href)});
    const inspected=await createSflow({root:${JSON.stringify(f.root)}}).run('phase.review',{phaseId:'planning'});
    const document=inspected.manifest.items.find(item=>item.primary);
    console.log(JSON.stringify({integrity:inspected.manifest.integrity,error:document.error}));`;
  const permission=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--input-type=module','-e',source],{cwd:f.root,allowFailure:true});
  assert.equal(permission.status,0,permission.stdout+'\n'+permission.stderr);
  const denied=JSON.parse(permission.stdout);assert.equal(denied.integrity,'unavailable');
  assert.equal(denied.error.cause.code,'EACCES');assert.equal(denied.error.cause.errno,-13);assert.equal(denied.error.cause.path,file);
});

test('draft and bounded reads remain unbound, and the packaged CLI uses the registered query path',async t=>{
  const id='SDK-REVIEW-DRAFT',f=await startedSpecificationStory(t,id,{configure(config){config.documents.maxPreviewBytes=96;}});
  f.cli('prepare','specification');
  const api=createSflow({root:f.root}),head=f.git('rev-parse','HEAD'),result=await api.run('phase.review',{phaseId:'specification'});
  assert.equal(result.generation,0);assert.equal(result.manifest.integrity,'unbound');assert.equal(result.manifest.reviewBinding,null);
  assert.equal(result.manifest.budgets.previewBytes,96);assert.equal(result.manifest.items[0].expected,null);
  assert.equal(result.manifest.items[0].observed.sha256.length,64);
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-phase-review-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const bundled=run(process.execPath,[CLI,'--no-model','phase','show','specification','--json'],{cwd:f.root,allowFailure:true,
    env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
  assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);
  const actual=JSON.parse(bundled.stdout);assert.equal(actual.generation,0);assert.equal(actual.documents[0].previewBytes,96);
  assert.equal(actual.documents[0].truncated,true);assert.equal(actual.reviewBinding,null);assert.equal(f.git('rev-parse','HEAD'),head);
});
