import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {createGitPhasePrepublishEngine} from '../src/engine-compatibility/git-phase-entry.mjs';
import {startedSpecificationStory,publishedPlanningStory,specification,CLI} from './helpers/submitted-planning-story.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
function environment(extra={}) {
  const env={...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'off',...extra};
  delete env.SINGULARITY_FLOW_NO_MODEL;return env;
}
async function observedCli(f,phase,{forAgent=false}={}) {
  const file=path.join(f.directory,'prepublish.capture.json');
  const result=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,CLI,
    'phase','prepublish',phase,'--work-id',f.id,...(forAgent?['--for-agent']:[]),'--json'],{
    cwd:f.root,allowFailure:true,env:environment({SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file,SINGULARITY_FLOW_AGENT_OUTPUT:'full'})});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  return {actual:JSON.parse(result.stdout),captured:JSON.parse(await readFile(file,'utf8'))};
}
const configure=config=>{config.session.workItemSelection='reuse';config.phases.specification.clarification={mode:'off'};};

test('SDK and CLI prepublish retain repair guidance, ready admission and staged-file review without changing draft bytes or Git',async t=>{
  const id='SDK-PREPUBLISH',f={...await startedSpecificationStory(t,id,{configure}),id};
  const root=await realpath(f.root),api=createSflow({root}),workflowFile=path.join(f.item,'workflow.json'),artifactFile=path.join(f.item,'artifacts/specification/spec.md');
  const before=await readFile(workflowFile),draft=await readFile(artifactFile),head=f.git('rev-parse','HEAD'),status=f.git('status','--porcelain');
  const red=await api.prepublishPhase({workId:id,phaseId:'specification'}),observed=await observedCli(f,'specification');
  assert.equal(red.status,'correction-required');assert.equal(observed.captured.operation,'phase.prepublish');assert.deepEqual(observed.captured.result,red);
  assert.equal(observed.actual.status,red.status);assert.deepEqual(observed.actual.readiness,red.manifest.readiness);
  assert.equal(observed.actual.commands.publish,null);assert.ok(observed.actual.commandGuidance.recover);
  assert.deepEqual(observed.actual.findings.map(row=>row.code),red.manifest.findings.map(row=>row.code));
  assert.deepEqual(await readFile(workflowFile),before);assert.deepEqual(await readFile(artifactFile),draft);
  assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(f.git('status','--porcelain'),status);
  const agent=await createGitPhasePrepublishEngine({root,authoringAgent:true}).engine.run('phase.prepublish',{workId:id,phaseId:'specification'});
  assert.deepEqual((await observedCli(f,'specification',{forAgent:true})).captured.result,agent,'agent projection is trusted host context, not operation input');

  await writeFile(artifactFile,specification(id,1));f.cli('prepare','specification');f.cli('artifact','scan','--phase','specification');
  const ready=await api.prepublishPhase({phaseId:'specification'});
  assert.equal(ready.status,'ready',JSON.stringify(ready.manifest.findings));
  assert.equal(ready.manifest.finalBindingChecked,false);assert.equal(ready.effects.testsRun,false);
  const readyNative=await observedCli(f,'specification');assert.deepEqual(readyNative.captured.result,ready);assert.ok(readyNative.actual.commands.publish);
  const authored=await readFile(artifactFile);
  f.git('add',path.relative(f.root,artifactFile));const staged=f.git('diff','--cached');
  const held=await api.prepublishPhase({phaseId:'specification'});
  assert.equal(held.status,'correction-required');
  const worktree=held.manifest.findings.find(row=>row.code==='LIFECYCLE_STAGED_GOVERNED_REVIEW_REQUIRED');
  assert.ok(worktree,JSON.stringify(held.manifest.findings));assert.equal(worktree.policy.classification,'worktree-review');
  assert.equal(worktree.policy.automaticRiskAcceptance,false);assert.equal(f.git('diff','--cached'),staged);
  assert.deepEqual(await readFile(artifactFile),authored);assert.equal(f.git('rev-parse','HEAD'),head);
});

test('retained prepublish keeps its exact published generation and source/bundled CLI result without offering another publication',async t=>{
  const id='SDK-PREPUBLISH-RETAINED',f={...await publishedPlanningStory(t,id,{configure}),id};
  const root=await realpath(f.root),api=createSflow({root}),file=path.join(f.item,'workflow.json');
  const before=await readFile(file),head=f.git('rev-parse','HEAD');
  const result=await api.run('phase.prepublish',{workId:id,phaseId:'planning'}),source=await observedCli(f,'planning');
  assert.deepEqual(source.captured.result,result);assert.equal(result.generation,1);assert.equal(result.manifest.inspectionStage,'published');
  assert.equal(result.manifest.readiness.publicationTransaction,'already-published');assert.equal(source.actual.commands.publish,null);
  assert.equal(result.effects.committed,false);assert.equal(result.effects.pushed,false);assert.equal(result.effects.approvalRecorded,false);
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-phase-prepublish-sdk-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const bundled=run(process.execPath,[CLI,'phase','prepublish','planning','--work-id',id,'--json'],{
    cwd:f.root,allowFailure:true,env:environment({SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir})});
  assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);const actual=JSON.parse(bundled.stdout);
  for(const key of ['status','generation','readiness','findings','commands','commandGuidance','correction','artifact','producer'])assert.deepEqual(actual[key],source.actual[key],key);
  assert.deepEqual(await readFile(file),before);assert.equal(f.git('rev-parse','HEAD'),head);
});
