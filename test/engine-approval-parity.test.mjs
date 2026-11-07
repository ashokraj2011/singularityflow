import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {createGitEngine} from '../src/engine-compatibility/git-publication.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {submittedApprovalBinding} from '../src/kernel/approval-policy.mjs';
import {phaseApprovalCommandResult} from '../src/commands/approve.mjs';
import {submittedPlanningStory,CLI} from './helpers/submitted-planning-story.mjs';
import {run} from '../src/util.mjs';

const lastJson=text=>{const starts=[...String(text).matchAll(/^\{$/gmu)];return JSON.parse(starts.length?String(text).slice(starts.at(-1).index):text);};
const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));

async function asReviewer(name, action) {
  const previous = process.env.SINGULARITY_FLOW_TEST_IDENTITY;
  const previousMode = process.env.NODE_ENV;
  // Only these disposable repositories use the product's existing test-identity boundary.
  process.env.NODE_ENV = 'test';
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = name;
  try { return await action(); }
  finally {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_TEST_IDENTITY;
    else process.env.SINGULARITY_FLOW_TEST_IDENTITY = previous;
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
  }
}

test('the SDK needs the exact review confirmation and records the same authorized approval',async t=>{
  const f=await submittedPlanningStory(t,'ENGINE-APPROVE');
  const root=path.resolve(f.item,'../../..');
  const accepted=await loadAcceptedStoryExecution(root,'ENGINE-APPROVE');
  const binding=createGitEngine({root});
  const input={workId:'ENGINE-APPROVE',phaseId:'planning'};
  const before=f.git('rev-parse','HEAD');
  await assert.rejects(binding.engine.approvePhase(input),{code:'ENGINE_APPROVAL_CONFIRMATION_REQUIRED'});
  assert.equal(f.git('rev-parse','HEAD'),before);
  const confirmation=submittedApprovalBinding(accepted.workflow,accepted.workflow.phases.planning);
  await assert.rejects(binding.engine.approvePhase({...input,confirmation:{...confirmation,generation:2}}),{code:'ENGINE_APPROVAL_CONFIRMATION_STALE'});
  assert.equal(f.git('rev-parse','HEAD'),before);
  const receipt=await binding.engine.approvePhase({...input,confirmation});
  assert.equal(receipt.status,'recorded');assert.equal(receipt.approval.thresholdReached,true);
  assert.equal(receipt.approval.selfApproval,binding.presentation().result.approval.selfApproval,
    'the SDK reports the native actor attribution rather than inferring reviewer independence');
  assert.equal(receipt.approval.reviewPacket,confirmation.reviewPacketSha256);
  assert.equal(receipt.currentPhase,'implementation');
  assert.equal(f.git('rev-parse','HEAD'),receipt.revision);
  const projected=phaseApprovalCommandResult(receipt,binding.presentation());
  assert.equal(projected.data.commit,receipt.revision);
  assert.equal(projected.data.reviewer,receipt.approval.actorId);
  assert.equal(projected.data.reviewPacketSha256,receipt.approval.reviewPacket);
});

test('a selection receipt authorizes the same SDK boundary and is consumed only after commit',async t=>{
  const f=await submittedPlanningStory(t,'ENGINE-RECEIPT');
  const root=path.resolve(f.item,'../../..');
  const begun=JSON.parse(f.cli('choices','begin','approve','ENGINE-RECEIPT','--json').stdout);
  f.cli('choices','answer',begun.token,'phase-confirmation','planning','--json');
  const input={workId:'ENGINE-RECEIPT',phaseId:'planning',selectionReceipt:begun.token};
  const result=await createSflow({root}).approvePhase(input);
  assert.equal(result.approval.thresholdReached,true);
  const receiptFile=path.join(f.git('rev-parse','--absolute-git-dir'),'singularity-flow','choices',`${begun.token}.json`);
  await assert.rejects(readFile(receiptFile),{code:'ENOENT'});
});

test('the real CLI approval output projects its actual captured SDK receipt',async t=>{
  const f=await submittedPlanningStory(t,'ENGINE-CLI-APPROVE');
  const root=path.resolve(f.item,'../../..');
  const file=path.join(path.dirname(root),'sdk-receipt.json');
  const response=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,
    CLI,'--no-model','approve','planning','--work-id','ENGINE-CLI-APPROVE','--yes','--json'],{
    cwd:root,env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file},allowFailure:true
  });
  assert.equal(response.status,0,response.stdout+'\n'+response.stderr);
  const actual=lastJson(response.stdout);
  const captured=JSON.parse(await readFile(file,'utf8'));
  assert.equal(captured.operation,'phase.approve');
  assert.equal(actual.operation.id,'approve');
  assert.equal(actual.subject.id,captured.result.subject.id);
  assert.equal(actual.data.commit,captured.result.revision);
  assert.equal(actual.data.pushed,captured.result.effects.pushed);
  assert.equal(actual.data.reviewer,captured.result.approval.actorId);
  assert.equal(actual.data.authorityGroup,captured.result.approval.authorityGroup);
  assert.equal(actual.data.reviewPacketSha256,captured.result.approval.reviewPacket);
  assert.equal(actual.data.artifactSetSha256,captured.result.approval.artifactSet);
  assert.equal(actual.outcome.slots.reached,captured.result.approval.thresholdReached);
  assert.equal(f.git('rev-parse','HEAD'),captured.result.revision);
});

test('native SDK approvals retain partial thresholds and reject a duplicate reviewer without another commit', async t => {
  const id = 'ENGINE-TWO-REVIEWS';
  const f = await submittedPlanningStory(t, id, {configure(config) {
    config.phases.planning.approval.minimum = 2;
  }});
  const root = path.resolve(f.item, '../../..');
  const accepted = await loadAcceptedStoryExecution(root, id);
  const input = {workId: id, phaseId: 'planning',
    confirmation: submittedApprovalBinding(accepted.workflow, accepted.workflow.phases.planning)};
  const api = createSflow({root});
  const first = await asReviewer('Engine Reviewer One', () => api.approvePhase(input));
  assert.equal(first.status, 'recorded');
  assert.equal(first.approval.thresholdReached, false);
  assert.equal(first.currentPhase, 'planning');
  assert.equal(f.git('rev-parse', 'HEAD'), first.revision);
  await asReviewer('Engine Reviewer One', () => assert.rejects(api.approvePhase(input),
    {code: 'APPROVAL_IDENTITY_ALREADY_RECORDED'}));
  assert.equal(f.git('rev-parse', 'HEAD'), first.revision);
  const second = await asReviewer('Engine Reviewer Two', () => api.approvePhase(input));
  assert.equal(second.approval.thresholdReached, true);
  assert.equal(second.currentPhase, 'implementation');
  assert.notEqual(second.approval.actorId, first.approval.actorId);
  const final = await loadAcceptedStoryExecution(root, id);
  assert.equal(final.workflow.phases.planning.approvals.length, 2);
});

test('the SDK derives reviewer authority from the native identity instead of its caller', async t => {
  const id = 'ENGINE-RESTRICTED';
  const f = await submittedPlanningStory(t, id, {configure(config) {
    config.approvalAuthorities['engine-reviewers'] = {label: 'Engine reviewers', allowAnyGitIdentity: false,
      members: [{email: 'approved.reviewer@example.com'}]};
    config.phases.planning.approval.authorities = ['engine-reviewers'];
  }});
  const root = path.resolve(f.item, '../../..');
  const accepted = await loadAcceptedStoryExecution(root, id);
  const input = {workId: id, phaseId: 'planning',
    confirmation: submittedApprovalBinding(accepted.workflow, accepted.workflow.phases.planning)};
  const api = createSflow({root});
  const before = f.git('rev-parse', 'HEAD');
  await asReviewer('Unauthorized Guest', () => assert.rejects(api.approvePhase(input),
    {code: 'APPROVAL_IDENTITY_NOT_AUTHORIZED'}));
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  const approved = await asReviewer('Approved Reviewer', () => api.approvePhase(input));
  assert.equal(approved.approval.authorityGroup, 'engine-reviewers');
  assert.equal(approved.approval.actorId, 'approved.reviewer@example.com');
});

test('an SDK approval remains committed when session refresh and the headless notice observer fail', async t => {
  const id = 'ENGINE-POST-FAILURE';
  const f = await submittedPlanningStory(t, id);
  const root = path.resolve(f.item, '../../..');
  const sessionUrl = new URL('../src/session.mjs', import.meta.url).href;
  const apiUrl = new URL('../src/api.mjs', import.meta.url).href;
  const acceptedUrl = new URL('../src/accepted-story-execution.mjs', import.meta.url).href;
  const policyUrl = new URL('../src/kernel/approval-policy.mjs', import.meta.url).href;
  const script = `import {mock} from 'node:test';
    const session=await import(${JSON.stringify(sessionUrl)});
    mock.module(${JSON.stringify(sessionUrl)},{namedExports:{...session,
      activateWorkItemSession:async()=>{throw Object.assign(new Error('session refresh fixture'),{code:'LOCAL_SESSION_FIXTURE'});}}});
    const {createSflow}=await import(${JSON.stringify(apiUrl)});
    const {loadAcceptedStoryExecution}=await import(${JSON.stringify(acceptedUrl)});
    const {submittedApprovalBinding}=await import(${JSON.stringify(policyUrl)});
    const root=${JSON.stringify(root)},id=${JSON.stringify(id)};
    const accepted=await loadAcceptedStoryExecution(root,id);
    const api=createSflow({root,notice:()=>{throw new Error('observer fixture');}});
    const receipt=await api.approvePhase({workId:id,phaseId:'planning',
      confirmation:submittedApprovalBinding(accepted.workflow,accepted.workflow.phases.planning)});
    const notices=await api.notifications();
    console.log(JSON.stringify({receipt,notices:notices.map(n=>({code:n.code,workId:n.workId,errorCode:n.error?.code}))}));`;
  const response = run(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', '--input-type=module', '-e', script],
    {cwd: root, env: {...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester'}, allowFailure: true});
  assert.equal(response.status, 0, response.stdout+'\n'+response.stderr);
  const result = lastJson(response.stdout);
  assert.equal(result.receipt.status, 'recorded');
  assert.equal(result.receipt.approval.thresholdReached, true);
  assert.equal(f.git('rev-parse', 'HEAD'), result.receipt.revision);
  assert.deepEqual(result.notices, [{code: 'transition.tail-failed', workId: id, errorCode: 'LOCAL_SESSION_FIXTURE'}]);
  const accepted = await loadAcceptedStoryExecution(root, id);
  assert.equal(accepted.workflow.phases.planning.status, 'approved');
  assert.equal(accepted.workflow.currentPhase, 'implementation');
});
