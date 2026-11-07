import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createSflow} from '../src/api.mjs';
import {createGitEngine} from '../src/engine-compatibility/git-publication.mjs';
import {phaseSubmissionCommandResult} from '../src/commands/submit.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {withCommandReadScope} from '../src/read-scope.mjs';
import {publishedPlanningStory} from './helpers/submitted-planning-story.mjs';
import {publishedSpecificationStory} from './helpers/source-review-fixture.mjs';
import {run} from '../src/util.mjs';
import {fileURLToPath} from 'node:url';
import {resolvePersonalization} from '../src/personalization.mjs';

const cli=fileURLToPath(new URL('../bin/singularity-flow.mjs',import.meta.url));
const invoke=(root,args)=>run(process.execPath,[cli,...args,'--json'],{
  cwd:root,env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_BUNDLE:'off'},allowFailure:true
});

test('SDK submission and the CLI retry share exact bound JSON and never resubmit',async t=>{
  const f=await publishedPlanningStory(t,'ENGINE-SUBMIT');
  const binding=createGitEngine({root:f.root});
  const input={workId:'ENGINE-SUBMIT',phaseId:'planning',runChecks:false};
  const first=await binding.engine.submitPhase(input);
  assert.equal(first.status,'awaiting-approval');
  assert.equal(first.effects.committed,true);
  assert.equal(f.git('rev-parse','HEAD'),first.revision);
  const native=binding.presentation();
  const projected=phaseSubmissionCommandResult(first,native);
  assert.equal(projected.data.commit,first.revision);
  assert.equal(projected.data.reviewPacket,first.submission.reviewPacket);
  const workflowFile=path.join(f.item,'workflow.json');
  const bytes=await readFile(workflowFile,'utf8');
  const retry=await binding.engine.run('phase.submit',input);
  assert.equal(retry.status,'retained');
  assert.equal(retry.generation,first.generation);
  const response=invoke(f.root,['submit','planning','--work-id','ENGINE-SUBMIT','--skip-checks']);
  assert.equal(response.status,0,response.stderr||response.stdout);
  const actual=JSON.parse(response.stdout);
  const expected=phaseSubmissionCommandResult(retry,binding.presentation());
  for(const key of ['operation','subject','outcome','effects']) assert.deepEqual(actual[key],expected[key],key);
  assert.deepEqual(actual.data,{...expected.data,personalization:resolvePersonalization({root:f.root})},
    'only the host adds the same Git-identity presentation context');
  assert.equal(f.git('rev-parse','HEAD'),first.revision);
  assert.equal(await readFile(workflowFile,'utf8'),bytes,'a retry cannot rewrite lifecycle records');
  assert.equal((await createSflow({root:f.root}).submitPhase(input)).status,'retained');
});

test('a fresh SDK submission does not reuse an outer host preview after its commit',async t=>{
  const f=await publishedPlanningStory(t,'ENGINE-SUBMIT-FRESH');
  const api=createSflow({root:f.root});
  await withCommandReadScope(async()=>{
    const before=await loadAcceptedStoryExecution(f.root,'ENGINE-SUBMIT-FRESH');
    assert.equal(before.workflow.phases.planning.status,'in_progress');
    const result=await api.submitPhase({workId:'ENGINE-SUBMIT-FRESH',phaseId:'planning',runChecks:false});
    assert.equal(result.status,'awaiting-approval');
    assert.equal((await loadAcceptedStoryExecution(f.root,'ENGINE-SUBMIT-FRESH')).workflow.phases.planning.status,'in_progress');
    assert.equal((await api.submitPhase({workId:'ENGINE-SUBMIT-FRESH',phaseId:'planning'})).status,'retained');
  });
});

test('an explicitly approval-free phase completes through the SDK and activates the committed successor',async t=>{
  const f=await publishedPlanningStory(t,'ENGINE-SUBMIT-NONE',{configure(configuration){
    configuration.workTypes['spec-driven-standard'].phaseOverrides.planning.approval={mode:'none'};
  }});
  const result=await createSflow({root:f.root}).submitPhase({workId:'ENGINE-SUBMIT-NONE',phaseId:'planning',runChecks:false});
  assert.equal(result.status,'completed');
  assert.equal(result.submission.approvalMode,'none');
  assert.equal(result.submission.currentPhase,'implementation');
  assert.equal(result.effects.committed,true);
  const after=await loadAcceptedStoryExecution(f.root,'ENGINE-SUBMIT-NONE');
  assert.equal(after.workflow.phases.planning.status,'approved');
  assert.equal(after.workflow.currentPhase,'implementation');
  const {loadSession}=await import('../src/session.mjs');
  const session=await loadSession(f.root);
  assert.equal(session.phaseId,'implementation');
});

test('the same source-review hold preserves refusal meaning and authorship through SDK and CLI',async t=>{
  const f=await publishedSpecificationStory(t);
  const before=run('git',['rev-parse','HEAD'],{cwd:f.root}).stdout;
  let refused;
  await assert.rejects(createSflow({root:f.root}).submitPhase({workId:'REVIEW-1',phaseId:f.phaseId,runChecks:false}),error=>{
    refused=error;return error.code==='SOURCE_REVIEW_REQUIRED';
  });
  const response=invoke(f.root,['submit',f.phaseId,'--work-id','REVIEW-1','--skip-checks']);
  assert.notEqual(response.status,0);
  const actual=JSON.parse(response.stdout);
  assert.equal(actual.error.code,refused.code);
  assert.equal(actual.error.message,refused.message.replace(/\s+/gu,' '), 'the CLI keeps its existing compact error rendering');
  assert.equal(run('git',['rev-parse','HEAD'],{cwd:f.root}).stdout,before);
});
