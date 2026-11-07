import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSflow } from '../src/api.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { loadSession } from '../src/session.mjs';
import { run } from '../src/util.mjs';
import { submittedPlanningStory, CLI } from './helpers/submitted-planning-story.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { bundledCliUrl } from '../src/bundled-cli.mjs';

const previous = { ...process.env };
let machine;
before(async () => {
  machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-engine-reject-machine-'));
  process.env = isolatedTestEnvironment(machine);
});
after(async () => { process.env = previous; await rm(machine, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const rootOf = f => path.resolve(f.item, '../../..');
const capture = fileURLToPath(new URL('./helpers/capture-engine-operation.mjs', import.meta.url));

test('native SDK rejection refuses invalid scope without a commit and records an exact earlier-phase return', async t => {
  const id = 'ENGINE-RETURN', f = await submittedPlanningStory(t, id), root = rootOf(f), api = createSflow({ root });
  const before = f.git('rev-parse', 'HEAD'), input = { workId: id, phaseId: 'planning', target: 'specification', reason: 'Clarify the approved boundary.' };
  await assert.rejects(api.rejectPhase({ ...input, clauseIds: ['UNKNOWN:REQ-001'] }), /unknown specification clause/);
  await assert.rejects(api.rejectPhase({ ...input, members: ['plan.md'] }), { code: 'REJECT_MEMBER_UNKNOWN' });
  await assert.rejects(api.rejectPhase({ ...input, reason: ' ' }), /comment is required/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  const receipt = await api.rejectPhase({ ...input, clauseIds: [`${id}:REQ-002`], members: ['spec.md'] });
  assert.equal(receipt.status, 'recorded'); assert.equal(receipt.generation, 1); assert.equal(receipt.currentPhase, 'specification');
  assert.equal(receipt.effects.committed, true); assert.equal(receipt.effects.pushed, true);
  assert.equal(f.git('rev-parse', 'HEAD'), receipt.revision);
  const accepted = await loadAcceptedStoryExecution(root, id), change = accepted.workflow.changeRequests.at(-1);
  assert.equal(change.id, receipt.changeRequest.id); assert.equal(change.sourcePhase, 'planning'); assert.equal(change.sourceGeneration, 1);
  assert.equal(change.targetPhase, 'specification'); assert.equal(change.comment, input.reason);
  assert.equal(change.authorityGroup, receipt.changeRequest.authorityGroup);
  assert.deepEqual(accepted.workflow.phases.specification.surgicalReopen.members, ['spec.md']);
  assert.equal(accepted.workflow.phases.planning.approvals.at(-1).decision, 'rejected');
  assert.equal((await loadSession(root)).phaseId, 'specification');
});

test('the actual CLI command result projects its captured registry rejection without changing presentation', async t => {
  const id = 'ENGINE-CLI-RETURN', f = await submittedPlanningStory(t, id), root = rootOf(f);
  const file = path.join(path.dirname(root), 'rejection.capture.json'), command = path.join(path.dirname(root), 'command.capture.json');
  const response = run(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', '--import', capture,
    CLI, '--no-model', 'reject', 'planning', '--work-id', id, '--to', 'planning', '--reason', 'Expand the implementation plan.', '--json'], {
    cwd: root, allowFailure: true, env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off',
      SINGULARITY_FLOW_TEST_ENGINE_CAPTURE: file, SINGULARITY_FLOW_TEST_COMMAND_CAPTURE: command }
  });
  assert.equal(response.status, 0, response.stdout + '\n' + response.stderr);
  const captured = JSON.parse(await readFile(file, 'utf8')), actual = JSON.parse(await readFile(command, 'utf8'));
  assert.equal(captured.operation, 'phase.reject'); assert.equal(actual.operation.id, 'reject');
  assert.equal(actual.subject.id, captured.result.subject.id);
  assert.equal(actual.data.changeRequestId, captured.result.changeRequest.id);
  assert.equal(f.git('rev-parse', 'HEAD'), captured.result.revision);
  assert.match(response.stdout, /Requesting changes to planning, returning work to planning/);
  assert.match(response.stdout, /Recorded CR-001\. Comment: Expand the implementation plan\./);
  const accepted = await loadAcceptedStoryExecution(root, id);
  assert.equal(accepted.workflow.currentPhase, 'planning'); assert.equal(accepted.workflow.phases.planning.status, 'in_progress');
});

test('rejection authority comes from the native actor and the pinned source-phase reviewers', async t => {
  const id = 'ENGINE-REJECT-AUTHORITY', f = await submittedPlanningStory(t, id, { configure(config) {
    config.approvalAuthorities['restricted-reviewers'] = { label: 'Restricted reviewers', allowAnyGitIdentity: false,
      members: [{ email: 'authorized.reviewer@example.test' }] };
    config.phases.planning.approval.authorities = ['restricted-reviewers'];
  } }), root = rootOf(f), before = f.git('rev-parse', 'HEAD');
  await assert.rejects(createSflow({ root }).rejectPhase({ workId: id, phaseId: 'planning', target: 'planning', reason: 'Review requested.' }),
    { code: 'APPROVAL_IDENTITY_NOT_AUTHORIZED' });
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal((await loadAcceptedStoryExecution(root, id)).workflow.changeRequests?.length ?? 0, 0);
});

test('an actually bundled rejection retains legacy Work-ID/phase grammar and native transaction presentation', async t => {
  const id = 'ENGINE-BUNDLE-RETURN', f = await submittedPlanningStory(t, id), root = rootOf(f);
  const outdir = await mkdtemp(fileURLToPath(new URL('../.bundle-test-rejection-', import.meta.url)));
  t.after(() => rm(outdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { buildCliBundle } = await import('../scripts/build-cli-bundle.mjs'); await buildCliBundle({ outdir });
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'auto', SINGULARITY_FLOW_BUNDLE_DIR: outdir };
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  assert.ok(bundledCliUrl(packageRoot, env)?.startsWith(pathToFileURL(outdir + path.sep).href));
  const response = run(process.execPath, [CLI, '--no-model', 'reject', id, '--phase', 'planning', '--to', 'specification',
    '--member', 'spec.md', '--reason', 'Correct the accepted requirement.', '--json'], { cwd: root, env, allowFailure: true });
  assert.equal(response.status, 0, response.stdout + '\n' + response.stderr);
  assert.match(response.stdout, /Recorded CR-001\. Comment: Correct the accepted requirement\./);
  assert.match(response.stdout, /Members to regenerate: spec\.md/);
  const accepted = await loadAcceptedStoryExecution(root, id), change = accepted.workflow.changeRequests.at(-1);
  assert.equal(accepted.workflow.currentPhase, 'specification'); assert.equal(change.sourcePhase, 'planning');
  assert.deepEqual(change.members, ['spec.md']); assert.equal(change.targetPhase, 'specification');
  assert.equal(f.git('rev-parse', 'HEAD'), f.git('rev-parse', `refs/remotes/origin/${id}`));
});

test('a failed session projection and notice observer cannot hide an already committed rejection', async t => {
  const id = 'ENGINE-REJECT-TAIL', f = await submittedPlanningStory(t, id), root = rootOf(f);
  const sessionUrl = new URL('../src/session.mjs', import.meta.url).href, apiUrl = new URL('../src/api.mjs', import.meta.url).href;
  const script = `import {mock} from 'node:test';
    const session=await import(${JSON.stringify(sessionUrl)});
    mock.module(${JSON.stringify(sessionUrl)},{namedExports:{...session,activateWorkItemSession:async()=>{
      throw Object.assign(new Error('local session unavailable'),{code:'EACCES'});}}});
    const {createSflow}=await import(${JSON.stringify(apiUrl)});
    const api=createSflow({root:${JSON.stringify(root)},notice:()=>{throw new Error('observer unavailable');}});
    const receipt=await api.rejectPhase({workId:${JSON.stringify(id)},phaseId:'planning',target:'planning',reason:'Clarify the plan.'});
    console.log(JSON.stringify({receipt,notices:(await api.notifications()).map(n=>({code:n.code,errorCode:n.error?.code,workId:n.workId}))}));`;
  const response = run(process.execPath, ['--experimental-test-module-mocks','--no-warnings','--input-type=module','-e',script],
    { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, allowFailure: true });
  assert.equal(response.status, 0, response.stdout + '\n' + response.stderr);
  const result = JSON.parse(response.stdout);
  assert.equal(result.receipt.status, 'recorded'); assert.equal(f.git('rev-parse', 'HEAD'), result.receipt.revision);
  assert.deepEqual(result.notices, [{ code: 'transition.tail-failed', errorCode: 'EACCES', workId: id }]);
  assert.equal((await loadAcceptedStoryExecution(root, id)).workflow.changeRequests.at(-1).id, result.receipt.changeRequest.id);
});
