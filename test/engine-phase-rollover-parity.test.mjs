import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {repository,startQuickFix,cli} from './helpers/run-and-test-fixture.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
async function nativeEnvironment(repo,fn) {
  const saved=new Map(Object.keys(repo.env).map(key=>[key,process.env[key]]));Object.assign(process.env,repo.env);
  try{return await fn();}finally{for(const [key,value] of saved)value===undefined?delete process.env[key]:process.env[key]=value;}
}
async function publishedCode(t) {
  const repo=await repository(t,{implementCommands:false});await startQuickFix(repo);
  repo.sflow('phase','begin','implement');
  await writeFile(path.join(repo.root,'src/value.mjs'),'// @clause:QF-1:AC-001 the approved exported value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root,'test/value.test.mjs'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    +"import {value} from '../src/value.mjs';\n// @ac:QF-1:AC-001\ntest('value is two',()=>assert.equal(value,2));\n");
  repo.sflow('prepare','implement');repo.sflow('phase','publish','implement');
  await writeFile(path.join(repo.root,'src/value.mjs'),'// @clause:QF-1:AC-001 an unpublished successor\nexport const value = 3;\n');
  return repo;
}
async function observedCli(repo,confirm=null) {
  const file=path.join(repo.base,'rollover.capture.json');
  const result=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,cli,
    '--no-model','phase','rollover','implement','--work-id','QF-1',...(confirm?['--confirm',confirm]:[]),'--json'],{
    cwd:repo.root,allowFailure:true,env:{...repo.env,SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  return {actual:JSON.parse(result.stdout),captured:JSON.parse(await readFile(file,'utf8'))};
}

test('native SDK rollover previews without writes, refuses changed confirmations and preserves the prior publication when opening a successor',async t=>{
  const repo=await publishedCode(t);
  await nativeEnvironment(repo,async()=>{
    const root=await realpath(repo.root),api=createSflow({root}),file=path.join(root,'singularity/work-items/QF-1/workflow.json');
    const before=await readFile(file),workflow=JSON.parse(before),source=await readFile(path.join(root,'src/value.mjs'));
    const head=repo.must('git',['rev-parse','HEAD']),index=repo.must('git',['write-tree']),status=repo.must('git',['status','--porcelain']);
    const preview=await api.rolloverPhase({workId:'QF-1',phaseId:'implement'}),observed=await observedCli(repo);
    assert.equal(preview.status,'preview');assert.equal(observed.captured.operation,'phase.rollover');assert.deepEqual(observed.captured.result,preview);
    for(const key of ['workId','phase','fromGeneration','toGeneration','confirmation','changeSetDigest','currentResultDigest'])assert.deepEqual(observed.actual[key],preview.plan[key],key);
    assert.equal(observed.actual.mutates,false);assert.deepEqual(await readFile(file),before);assert.equal(repo.must('git',['status','--porcelain']),status);
    assert.equal(JSON.stringify(preview).includes(root),false);assert.equal('command' in preview.plan,false);
    await assert.rejects(api.rolloverPhase({confirm:`sha256:${'0'.repeat(64)}`}),{code:'GENERATION_ROLLOVER_STALE'});
    const stale=repo.sflowJson('phase','rollover','implement','--confirm',`sha256:${'0'.repeat(64)}`);
    assert.equal(stale.status,1);assert.equal(stale.value.error.code,'GENERATION_ROLLOVER_STALE');
    assert.deepEqual(stale.value.error.details,{workId:'QF-1',phase:'implement'},'the existing CLI presenter keeps only its public refusal fields');
    assert.ok(stale.value.error.message.includes(preview.plan.confirmation));
    assert.deepEqual(await readFile(file),before);

    await writeFile(path.join(root,'src/value.mjs'),source.toString().replace('value = 3','value = 4'));
    await assert.rejects(api.run('phase.rollover',{confirm:preview.plan.confirmation}),{code:'GENERATION_ROLLOVER_STALE'});
    const fresh=await api.rolloverPhase({phaseId:'implement'});assert.notEqual(fresh.plan.confirmation,preview.plan.confirmation);
    const result=await api.rolloverPhase({confirm:fresh.plan.confirmation});assert.equal(result.status,'begun');assert.equal(result.generation,2);
    const stored=JSON.parse(await readFile(file));assert.equal(stored.phases.implement.generation,1);
    assert.equal(stored.phases.implement.generationIntent.generation,2);assert.equal(stored.phases.implement.generationIntent.status,'open');
    assert.equal(stored.phases.implement.generationIntent.id,result.intent.id);assert.equal(stored.phases.implement.generationIntent.receiptSha256,result.intent.sha256);
    assert.deepEqual(stored.phases.implement.generationPublications,workflow.phases.implement.generationPublications);
    assert.equal(repo.must('git',['rev-parse','HEAD']),head);assert.equal(repo.must('git',['write-tree']),index);
    assert.equal(result.effects.testsRun,false);assert.equal(result.effects.approvalRecorded,false);assert.equal(result.effects.committed,false);
  });
});

test('source and bundled CLI rollover preserve native preview and creation output, using the registered operation',async t=>{
  const repo=await publishedCode(t),file=path.join(repo.root,'singularity/work-items/QF-1/workflow.json');
  const before=await readFile(file),head=repo.must('git',['rev-parse','HEAD']),source=await observedCli(repo);
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-phase-rollover-sdk-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const bundled=run(process.execPath,[cli,'--no-model','phase','rollover','implement','--work-id','QF-1','--json'],{
    cwd:repo.root,allowFailure:true,env:{...repo.env,SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
  assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);assert.deepEqual(JSON.parse(bundled.stdout),source.actual);
  assert.deepEqual(await readFile(file),before);const opened=await observedCli(repo,source.actual.confirmation);
  assert.equal(opened.captured.result.status,'begun');assert.equal(opened.actual.mutates,true);
  assert.equal(opened.actual.generationIntent.id,opened.captured.result.intent.id);assert.equal(opened.actual.generationIntent.receiptSha256,opened.captured.result.intent.sha256);
  assert.equal(opened.actual.generationIntent.generation,2);assert.equal(repo.must('git',['rev-parse','HEAD']),head);
});
