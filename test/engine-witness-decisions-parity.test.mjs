import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {witnessContextBinding} from '../src/verification/witness-records.mjs';
import {repository,startQuickFix,cli} from './helpers/run-and-test-fixture.mjs';
import {run} from '../src/util.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG7sAAAAASUVORK5CYII=','base64');
const FILE='singularity/work-items/QF-1/evidence/value-screen.png';
const digest=`sha256:${createHash('sha256').update(PNG).digest('hex')}`;
const answers={'states-the-outcome':'yes','matches-the-criterion':'yes','current-for-this-change':'yes'};
const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));

test('SDK and CLI witness the same published bytes without approving, and stale or repeated reviews record nothing',async t=>{
  const repo=await repository(t,{implementCommands:false});
  await startQuickFix(repo,{retainedScreenshot:FILE});
  repo.sflow('prepare','implement');
  await writeFile(path.join(repo.root,'src/value.mjs'),'// @clause:QF-1:REQ-001 return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root,'test/value.test.mjs'),[
    "import test from 'node:test';","import assert from 'node:assert/strict';","import { value } from '../src/value.mjs';",
    '// @ac:QF-1:AC-001',"test('returns two', () => assert.equal(value, 2));",''].join('\n'));
  await mkdir(path.dirname(path.join(repo.root,FILE)),{recursive:true});
  await writeFile(path.join(repo.root,FILE),PNG);
  repo.sflow('prepare','implement');
  repo.sflow('phase','publish','implement','--authored','deterministic','--channel','kernel-generator');
  const workflowFile=path.join(repo.root,'singularity/work-items/QF-1/workflow.json');
  const before=JSON.parse(await readFile(workflowFile,'utf8'));
  const request={workId:'QF-1',clauseId:'qf-1:ac-001',slotName:'screen',file:FILE,
    expectedContext:witnessContextBinding(before),expectedFile:digest,answers,
    reason:'The reviewer inspected the exact retained display for this published generation.'};
  const previous={mode:process.env.NODE_ENV,identity:process.env.SINGULARITY_FLOW_TEST_IDENTITY};
  process.env.NODE_ENV='test';process.env.SINGULARITY_FLOW_TEST_IDENTITY='Run Test Reviewer';
  try {
    const api=createSflow({root:repo.root});
    const failed=await api.run('decision.witness',{...request,answers:{...answers,'matches-the-criterion':'no'}});
    assert.equal(failed.record.id,'WIT-001');assert.equal(failed.record.outcome,'failed');
    assert.equal(failed.phase,'implement');assert.equal(failed.currentPhase,'implement');
    assert.equal(repo.must('git',['rev-parse','HEAD']).trim(),failed.revision);

    const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-witness-',import.meta.url)));
    t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');
    await buildCliBundle({outdir});
    const bundled=run(process.execPath,[cli,'--no-model','decision','witness','QF-1',
      '--criterion',request.clauseId,'--slot','screen','--file',FILE,'--reason',request.reason,
      '--expected-context-sha256',request.expectedContext,'--expected-file-sha256',digest,
      '--confirm','states-the-outcome','--deny','matches-the-criterion','--confirm','current-for-this-change','--json'],
      {cwd:repo.root,allowFailure:true,env:{...repo.env,SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
    assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);
    const bundledRecord=JSON.parse(bundled.stdout).data.record;
    assert.equal(bundledRecord.id,'WIT-002');assert.equal(bundledRecord.outcome,'failed');
    assert.equal(bundledRecord.sha256,digest);

    const file=path.join(repo.base,'sdk-witness.json');
    const response=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,
      cli,'--no-model','decision','witness','QF-1','--criterion',request.clauseId,'--slot','screen','--file',FILE,
      '--expected-context-sha256',request.expectedContext,'--expected-file-sha256',digest,'--reason',request.reason,
      ...Object.keys(answers).flatMap(item=>['--confirm',item]),'--json'],{cwd:repo.root,allowFailure:true,
      env:{...repo.env,SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file}});
    assert.equal(response.status,0,response.stdout+'\n'+response.stderr);
    const actual=JSON.parse(response.stdout),observed=JSON.parse(await readFile(file,'utf8'));
    assert.equal(observed.operation,'decision.witness');
    assert.equal(observed.result.record.outcome,'met');
    assert.equal(observed.result.record.sha256,digest);
    assert.deepEqual(actual.data.record,observed.result.record);
    assert.equal(actual.data.commit,observed.result.revision);
    assert.equal(actual.data.pushed,observed.result.effects.pushed);
    const head=repo.must('git',['rev-parse','HEAD']);
    await assert.rejects(api.run('decision.witness',request),{code:'WITNESS_ALREADY_RECORDED'});
    assert.equal(repo.must('git',['rev-parse','HEAD']),head);

    await writeFile(path.join(repo.root,FILE),Buffer.concat([PNG,Buffer.from('changed')]));
    await assert.rejects(api.run('decision.witness',request),{code:'WITNESS_REVIEW_CHANGED'});
    assert.equal(repo.must('git',['rev-parse','HEAD']),head);
    await writeFile(path.join(repo.root,FILE),PNG);
    await assert.rejects(api.run('decision.witness',{...request,expectedContext:`sha256:${'a'.repeat(64)}`}),{code:'WITNESS_REVIEW_CHANGED'});
    await assert.rejects(api.run('decision.witness',{...request,clauseId:'QF-1:AC-999'}),{code:'WITNESS_CRITERION_UNKNOWN'});
    assert.equal(repo.must('git',['rev-parse','HEAD']),head);
    const after=JSON.parse(await readFile(workflowFile,'utf8'));
    assert.deepEqual(after.witnessRecords.map(record=>record.outcome),['failed','failed','met']);
    assert.equal(after.currentPhase,'implement');assert.equal(after.phases.implement.status,'in_progress');
    assert.equal(after.phases.implement.generation,1);assert.equal(after.phases.implement.generationCommit,null);
  } finally {
    if(previous.mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.mode;
    if(previous.identity===undefined)delete process.env.SINGULARITY_FLOW_TEST_IDENTITY;else process.env.SINGULARITY_FLOW_TEST_IDENTITY=previous.identity;
  }
});
