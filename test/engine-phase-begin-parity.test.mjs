import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {createGitEngine} from '../src/engine-compatibility/git-publication.mjs';
import {repository,startQuickFix,cli} from './helpers/run-and-test-fixture.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
async function nativeEnvironment(repo,fn) {
  const saved=new Map(Object.keys(repo.env).map(key=>[key,process.env[key]]));
  Object.assign(process.env,repo.env);
  try{return await fn();}finally{for(const [key,value] of saved)value===undefined?delete process.env[key]:process.env[key]=value;}
}
async function observedCli(repo) {
  const file=path.join(repo.base,'begin.capture.json');
  const result=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,cli,
    '--no-model','phase','begin','implement','--work-id','QF-1','--json'],{
    cwd:repo.root,allowFailure:true,env:{...repo.env,SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  return {actual:JSON.parse(result.stdout),captured:JSON.parse(await readFile(file,'utf8'))};
}

test('SDK begin preserves native dirty-start refusal and local rollback; repeat verifies the exact issued receipt without Git publication',async t=>{
  const repo=await repository(t,{implementCommands:false});await startQuickFix(repo);
  await nativeEnvironment(repo,async()=>{
    const root=await realpath(repo.root),api=createSflow({root}),workflowFile=path.join(root,'singularity/work-items/QF-1/workflow.json');
    const sourceFile=path.join(root,'src/value.mjs'),source=await readFile(sourceFile),before=await readFile(workflowFile);
    const head=repo.must('git',['rev-parse','HEAD']),branch=repo.must('git',['branch','--show-current']);
    await writeFile(sourceFile,'export const value = 999;\n');
    await assert.rejects(api.beginPhase({workId:'QF-1',phaseId:'implement'}),error=>
      error.code==='GENERATION_DIRTY_START'&&error.details.workId==='QF-1'
        &&error.enginePhaseBegin.pendingStage==='begin'&&error.enginePhaseBegin.localEffectsMayExist===true);
    assert.equal(await readFile(sourceFile,'utf8'),'export const value = 999;\n','refusal preserves the caller\'s uncommitted application');
    assert.deepEqual(await readFile(workflowFile),before,'the native draft transaction rolls back its own failed attempt');
    await writeFile(sourceFile,source);

    const created=await api.beginPhase({workId:'QF-1',phaseId:'implement'});
    assert.equal(created.status,'begun');assert.equal(created.generation,1);assert.equal(created.effects.localOnly,true);
    const after=await readFile(workflowFile),workflow=JSON.parse(after),intent=workflow.phases.implement.generationIntent;
    assert.equal(workflow.phases.implement.generation,0);assert.equal(intent.status,'open');assert.equal(intent.id,created.intent.id);
    assert.equal(intent.receiptSha256,created.intent.sha256);assert.equal(intent.baseline.commit,created.intent.baselineCommit);
    assert.equal(JSON.stringify(created).includes(root),false);assert.equal('path' in created.intent,false);
    const status=repo.must('git',['status','--porcelain']);
    const actual=await observedCli(repo),retained=await api.run('phase.begin',{workId:'QF-1',phaseId:'implement'});
    assert.equal(actual.captured.operation,'phase.begin');assert.deepEqual(actual.captured.result,retained);
    assert.equal(retained.status,'retained');assert.equal(retained.effects.draftSaved,false);
    assert.deepEqual(actual.actual,intent,'the original CLI retry result has no new SDK envelope or local flags');
    assert.deepEqual(await createGitEngine({root}).engine.run('phase.begin',{phaseId:'implement'}),retained);
    assert.deepEqual(await readFile(workflowFile),after);assert.equal(repo.must('git',['status','--porcelain']),status);
    assert.equal(repo.must('git',['rev-parse','HEAD']),head);assert.equal(repo.must('git',['branch','--show-current']),branch);
    assert.deepEqual(await readFile(sourceFile),source);

    const receiptFile=path.join(root,intent.path),receiptBytes=await readFile(receiptFile),receipt=JSON.parse(receiptBytes);
    await writeFile(receiptFile,JSON.stringify({...receipt,generationIntentId:'wrong-intent'}));
    await assert.rejects(api.beginPhase({phaseId:'implement'}),error=>
      error.code==='GENERATION_INTENT_REQUIRED'&&error.enginePhaseBegin.pendingStage==='verify');
    assert.deepEqual(await readFile(workflowFile),after,'an invalid retained receipt is never silently replaced');
    assert.equal(repo.must('git',['rev-parse','HEAD']),head);
    await writeFile(receiptFile,receiptBytes);
  });
});

test('actual source and bundled CLI begin keep their native creation/retry JSON and original Story binding',async t=>{
  const repo=await repository(t,{implementCommands:false});await startQuickFix(repo);
  const created=await observedCli(repo);
  assert.equal(created.captured.result.status,'begun');assert.equal(created.actual.local,true);assert.equal(created.actual.lifecycleEvent,null);
  assert.equal(created.actual.id,created.captured.result.intent.id);assert.equal(created.actual.receiptSha256,created.captured.result.intent.sha256);
  const workflowFile=path.join(repo.root,'singularity/work-items/QF-1/workflow.json'),before=await readFile(workflowFile);
  const mismatch=repo.sflowJson('phase','begin','implement','--work-id','OTHER');
  assert.notEqual(mismatch.status,0);assert.deepEqual(await readFile(workflowFile),before);
  const source=await observedCli(repo);
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-phase-begin-sdk-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const bundled=run(process.execPath,[cli,'--no-model','phase','begin','implement','--work-id','QF-1','--json'],{
    cwd:repo.root,allowFailure:true,env:{...repo.env,SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
  assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);
  assert.deepEqual(JSON.parse(bundled.stdout),source.actual);assert.deepEqual(await readFile(workflowFile),before);
});
