import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {createGitPhaseDraftCheckEngine} from '../src/engine-compatibility/git-phase-entry.mjs';
import {startedSpecificationStory,publishedPlanningStory,specification,CLI} from './helpers/submitted-planning-story.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
function environment(extra={}) {
  const env={...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'off',...extra};
  delete env.SINGULARITY_FLOW_NO_MODEL;return env;
}
async function observedCli(f,phase,{forAgent=false}={}) {
  const file=path.join(f.directory,'draft-check.capture.json');
  const result=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,CLI,
    'phase','draft-check',phase,'--work-id',f.id,...(forAgent?['--for-agent']:[]),'--json'],{
    cwd:f.root,allowFailure:true,env:environment({SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file,SINGULARITY_FLOW_AGENT_OUTPUT:'full'})});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  return {actual:JSON.parse(result.stdout),captured:JSON.parse(await readFile(file,'utf8'))};
}
const configure=config=>{config.session.workItemSelection='reuse';config.phases.specification.clarification={mode:'off'};};

test('native draft-check SDK/CLI keep repair findings and ready health distinct from the publication worktree gate',async t=>{
  const id='SDK-DRAFT',f={...await startedSpecificationStory(t,id,{configure}),id};
  const root=await realpath(f.root),api=createSflow({root}),workflowFile=path.join(f.item,'workflow.json'),artifactFile=path.join(f.item,'artifacts/specification/spec.md');
  const before=await readFile(workflowFile),draft=await readFile(artifactFile),head=f.git('rev-parse','HEAD'),status=f.git('status','--porcelain');
  const red=await api.draftCheckPhase({workId:id,phaseId:'specification'}),observed=await observedCli(f,'specification');
  assert.equal(red.status,'correction-required');assert.equal(observed.captured.operation,'phase.draft-check');
  assert.deepEqual(observed.captured.result,red);assert.equal(observed.actual.status,red.status);
  assert.deepEqual(observed.actual.findings.map(row=>row.code),red.manifest.findings.map(row=>row.code));
  assert.equal(observed.actual.commands.publish,null);assert.ok(observed.actual.commandGuidance.recover);
  assert.deepEqual(await readFile(workflowFile),before);assert.deepEqual(await readFile(artifactFile),draft);
  assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(f.git('status','--porcelain'),status);
  const agent=await createGitPhaseDraftCheckEngine({root,authoringAgent:true}).engine.run('phase.draft-check',{workId:id,phaseId:'specification'});
  assert.deepEqual((await observedCli(f,'specification',{forAgent:true})).captured.result,agent);

  await writeFile(artifactFile,specification(id,1));f.cli('prepare','specification');f.cli('artifact','scan','--phase','specification');
  const ready=await api.draftCheckPhase({phaseId:'specification'}),source=await observedCli(f,'specification');
  assert.equal(ready.status,'ready',JSON.stringify(ready.manifest.findings));assert.deepEqual(source.captured.result,ready);
  assert.equal(ready.manifest.publicationReadinessInspected,false);assert.equal('admittedForAttempt' in ready.manifest,false);
  f.git('add',path.relative(f.root,artifactFile));const staged=f.git('diff','--cached'),authored=await readFile(artifactFile);
  assert.equal((await api.draftCheckPhase({phaseId:'specification'})).status,'ready','draft health does not include the publication index gate');
  const prepublish=await api.prepublishPhase({phaseId:'specification'});
  assert.equal(prepublish.status,'correction-required');
  assert.ok(prepublish.manifest.findings.some(row=>row.code==='LIFECYCLE_STAGED_GOVERNED_REVIEW_REQUIRED'));
  assert.equal(f.git('diff','--cached'),staged);assert.deepEqual(await readFile(artifactFile),authored);assert.equal(f.git('rev-parse','HEAD'),head);
});

test('retained draft-check preserves its published generation, native source/bundle projection and successor recovery',async t=>{
  const id='SDK-DRAFT-RETAINED',f={...await publishedPlanningStory(t,id,{configure}),id};
  const root=await realpath(f.root),api=createSflow({root}),file=path.join(f.item,'workflow.json'),artifact=path.join(f.item,'artifacts/planning/plan.md');
  const before=await readFile(file),authored=await readFile(artifact),head=f.git('rev-parse','HEAD');
  const result=await api.run('phase.draft-check',{workId:id,phaseId:'planning'}),source=await observedCli(f,'planning');
  assert.deepEqual(source.captured.result,result);assert.equal(result.generation,1);assert.equal(result.manifest.inspectionStage,'published');
  assert.equal(source.actual.commands.publish,null);assert.equal(result.effects.committed,false);assert.equal(result.effects.pushed,false);
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-phase-draft-sdk-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const bundled=run(process.execPath,[CLI,'phase','draft-check','planning','--work-id',id,'--json'],{
    cwd:f.root,allowFailure:true,env:environment({SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir})});
  assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);const actual=JSON.parse(bundled.stdout);
  for(const key of ['status','generation','findings','advisories','commands','commandGuidance','correction','artifact','producer'])assert.deepEqual(actual[key],source.actual[key],key);
  await assert.rejects(api.run('phase.draft-check',{phaseId:'specification'}),{code:'PHASE_DRAFT_NOT_ACTIVE'});
  assert.deepEqual(await readFile(file),before);assert.deepEqual(await readFile(artifact),authored);assert.equal(f.git('rev-parse','HEAD'),head);

  await writeFile(artifact,'# Plan\n\nTODO changed retained bytes.\n');
  const changed=await api.draftCheckPhase({phaseId:'planning'}),repair=await observedCli(f,'planning');
  assert.deepEqual(repair.captured.result,changed);assert.equal(changed.status,'correction-required');assert.equal(changed.generation,1);
  assert.equal(changed.manifest.correction.requiresNewGeneration,true);assert.equal(changed.manifest.correction.sameTurn,false);
  assert.equal(repair.actual.commands.publish,null);assert.match(repair.actual.commands.next,/recover/);
  assert.deepEqual(await readFile(file),before);assert.equal(f.git('rev-parse','HEAD'),head);
});
