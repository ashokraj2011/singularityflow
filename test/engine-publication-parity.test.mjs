import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from '../src/util.mjs';
import {createSflow} from '../src/api.mjs';
import {createGitEngine} from '../src/engine-compatibility/git-publication.mjs';
import {phasePublicationJson} from '../src/commands/phase-lifecycle.mjs';
import {publishedSpecificationStory} from './helpers/source-review-fixture.mjs';
import {withCommandReadScope} from '../src/read-scope.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';

const cli=fileURLToPath(new URL('../bin/singularity-flow.mjs',import.meta.url));

for (const copied of [false,true]) test(`SDK and CLI publication parity for ${copied?'custom':'packaged'} phases and legacy records`,async t=>{
  const f=await publishedSpecificationStory(t,{copied});
  const input={workId:'REVIEW-1',phaseId:f.phaseId,authored:'human',channel:'manual-in-place'};
  const binding=createGitEngine({root:f.root});
  const callCli=()=>JSON.parse(run(process.execPath,[cli,'phase','publish',f.phaseId,'--work-id','REVIEW-1',
    '--authored','human','--channel','manual-in-place','--json'],{
      cwd:f.root,env:{...process.env,SINGULARITY_FLOW_BUNDLE:'off',NODE_ENV:'test'}
    }).stdout);
  const first=await binding.engine.run('phase.publish',input);
  assert.equal(first.status,'retained');
  assert.deepEqual(callCli(),phasePublicationJson(first,binding.presentation()));
  const phase=binding.presentation().phase;
  const artifact=path.join(f.root,'singularity/work-items/REVIEW-1',phase.requiredArtifact.path);
  const original=await readFile(artifact,'utf8');
  await writeFile(artifact,original+'\n## Publication detail\n\nThe specification preserves the confirmed draft behavior and its exact acceptance outcomes.\n');
  const api=createSflow({root:f.root});
  const published=await api.run('phase.publish',input);
  assert.equal(published.status,'published');
  assert.equal(published.generation,2);
  assert.deepEqual(published.effects,{committed:true,pushed:false});
  assert.equal(run('git',['rev-parse','HEAD'],{cwd:f.root}).stdout.trim(),published.revision);
  assert.equal(published.contract,'sflow-engine/v1');
  assert.equal('commandGuidance' in published,false);
  assert.equal('outcomeReview' in published,false,'host command rendering stays outside SDK results');
  const retry=await binding.engine.publishPhase(input);
  assert.equal(retry.revision,published.revision);
  assert.deepEqual(callCli(),phasePublicationJson(retry,binding.presentation()));
  assert.equal((await api.publishPhase(input)).revision,published.revision,'typed helper uses the same operation');
  await writeFile(artifact,(await readFile(artifact,'utf8'))+'\nThe next publication keeps the same scope and records only this supporting explanation.\n');
  const fromCli=callCli();
  assert.equal(fromCli.status,'published');
  assert.equal(fromCli.generation,3);
  const fromSdk=await binding.engine.run('phase.publish',input);
  assert.equal(fromSdk.status,'retained');
  assert.equal(fromSdk.revision,fromCli.commit);
  assert.equal(fromSdk.generation,3);
  assert.deepEqual(callCli(),phasePublicationJson(fromSdk,binding.presentation()));
});

test('the SDK and CLI preserve an unknown phase refusal without writes',async t=>{
  const f=await publishedSpecificationStory(t);
  const before=run('git',['rev-parse','HEAD'],{cwd:f.root}).stdout;
  let native;
  await assert.rejects(createSflow({root:f.root}).run('phase.publish',{workId:'REVIEW-1',phaseId:'absent'}),error=>{
    native=error;return /Unknown or unavailable phase/.test(error.message);
  });
  const result=run(process.execPath,[cli,'phase','publish','absent','--work-id','REVIEW-1','--json'],{
    cwd:f.root,env:{...process.env,SINGULARITY_FLOW_BUNDLE:'off',NODE_ENV:'test'},allowFailure:true
  });
  assert.notEqual(result.status,0);
  const envelope=JSON.parse(result.stdout);
  assert.equal(envelope.error.message,native.message);
  assert.equal(envelope.error.code,native.code??'SINGULARITY_FLOW_ERROR');
  assert.equal(run('git',['rev-parse','HEAD'],{cwd:f.root}).stdout,before);
});

test('SDK mutations never inherit an advisory host read snapshot across publication',async t=>{
  const f=await publishedSpecificationStory(t);
  const input={workId:'REVIEW-1',phaseId:f.phaseId,authored:'human'};
  const api=createSflow({root:f.root});
  await withCommandReadScope(async()=>{
    const before=await loadAcceptedStoryExecution(f.root,'REVIEW-1');
    assert.equal(before.workflow.phases[f.phaseId].generation,1);
    const artifact=path.join(f.root,'singularity/work-items/REVIEW-1',before.workflow.phases[f.phaseId].requiredArtifact.path);
    await writeFile(artifact,(await readFile(artifact,'utf8'))+'\n## Host isolation\n\nPublication reads current accepted state independently of its caller preview.\n');
    const published=await api.run('phase.publish',input);
    assert.equal(published.generation,2);
    assert.equal((await loadAcceptedStoryExecution(f.root,'REVIEW-1')).workflow.phases[f.phaseId].generation,1,
      'the caller still has its old advisory snapshot, so this tests an actual stale scope');
    const retry=await api.run('phase.publish',input);
    assert.equal(retry.status,'retained');
    assert.equal(retry.generation,2);
    assert.equal(retry.revision,published.revision);
  });
});
