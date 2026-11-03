import test from 'node:test'; import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises'; import path from 'node:path';
import { resolveRepositoryCommitPolicy, resolveCommitTracking } from '../src/repository-commit-policy/context.mjs';
import { planRepositoryCommit, issuedCommitPolicyPlan, assertCommitPlanCurrent } from '../src/repository-commit-policy/plan.mjs';
import { retainCommitPolicyRecord, readCommitPolicyRecord, writeCommitPolicyOperation, readCommitPolicyOperation } from '../src/repository-commit-policy/records.mjs';
import { rcpFixture, registeredRcpPolicy } from './helpers/rcp-fixture.mjs';
import {createHash} from 'node:crypto';

test('an exact approved owner plan resolves immutable Jira identity without borrowing its parent Epic', async t => {
  const f = await rcpFixture(t); const tree = await f.candidate();
  const plan = await planRepositoryCommit(f.root, { subject: f.subject, purpose: 'story', ref: f.ref, tree, parents: [f.parent], message: 'Add endpoint', allowedPaths: ['source.js'] });
  assert.equal(plan.proposedMessage, 'WEB-221: Add endpoint');
  assert.equal(plan.tracking.reference.immutableIssueId, 'issue-221');
  assert.deepEqual(plan.paths, ['source.js']); assert.equal(plan.approval, 'not-implied');
  assert.equal(issuedCommitPolicyPlan(plan).root, f.root);
  await assertCommitPlanCurrent(plan);
  assert.throws(() => issuedCommitPolicyPlan(JSON.parse(JSON.stringify(plan))), { code: 'RCP_PLAN_UNISSUED' });
});
test('branch agreement and a canonical Story mismatch are refused before a commit can exist', async t => {
  const defaults = registeredRcpPolicy();
  const f = await rcpFixture(t, registeredRcpPolicy({ tracking: { ...defaults.tracking, requireBranchAgreement: true } }));
  const binding = await resolveRepositoryCommitPolicy(f.root);
  await assert.rejects(resolveCommitTracking(binding, { subject: f.subject, purpose: 'story', ref: 'refs/heads/WEB-222' }), { code: 'RCP_TRACKING_KEY_MISMATCH' });
  await writeFile(f.workflowPath, JSON.stringify({ ...f.workflow, workItem: { id: 'OTHER-1' } }));
  await assert.rejects(resolveCommitTracking(binding, { subject: f.subject, purpose: 'story', ref: f.ref }), { code: 'RCP_TRACKING_KEY_MISMATCH' });
  assert.equal(f.git(f.root, ['rev-parse', 'HEAD']), f.parent);
});
test('Epic and standalone run commits require their explicitly admitted real reference', async t => {
  const f = await rcpFixture(t); const binding = await resolveRepositoryCommitPolicy(f.root);
  for (const subject of [{ kind: 'initiative', id: 'EPIC-10' }, { kind: 'run', id: 'run-1' }]) {
    await assert.rejects(resolveCommitTracking(binding, { subject, purpose: subject.kind, ref: f.ref }), { code: 'RCP_TRACKING_KEY_REQUIRED' });
  }
  assert.equal(f.git(f.root, ['rev-parse', 'HEAD']), f.parent);
});
test('a changed hook, source mapping or ref cannot reuse the earlier policy plan', async t => {
  const f = await rcpFixture(t), tree = await f.candidate();
  const plan = await planRepositoryCommit(f.root, { subject: f.subject, ref: f.ref, tree, parents: [f.parent], message: 'Add endpoint' });
  await writeFile(path.join(f.root, '.git/hooks/commit-msg'), '#!/bin/sh\nexit 0\n');
  await assert.rejects(assertCommitPlanCurrent(plan), { code: 'RCP_PLAN_STALE' });
});
test('validation records live outside their own tree, keep immutable references and survive operation reload', async t => {
  const f = await rcpFixture(t), tree = await f.candidate();
  const reference = await retainCommitPolicyRecord(f.root, 'attempt', { status: 'passed', prospectiveTree: tree, messageSha256: 'bound-message', execution: 'registered-checks', nativeHookExecution: 'not-executed' });
  const record = await readCommitPolicyRecord(f.root, reference);
  assert.equal(record.prospectiveTree, tree);
  const id = `sha256:${'1'.repeat(64)}`;
  await writeCommitPolicyOperation(f.root, id, { stage: 'validated', changedNormalizationAttempts: 2, attempts: [reference] });
  const reloaded = await readCommitPolicyOperation(f.root, id);
  assert.equal(reloaded.changedNormalizationAttempts, 2);
  assert.equal(f.git(f.root, ['rev-parse', 'HEAD']), f.parent);
  assert.equal(await readFile(path.join(f.root, 'source.js'), 'utf8'), 'export const value = 2;\n');
});

test('registered equivalence cannot claim coverage of the actual unqualified pre-push invocation', async t => {
  const script = '#!/bin/sh\nexit 0\n', policy = registeredRcpPolicy();
  policy.profiles['message-v1'].coverage.push({stage:'pre-push', path:'@hooks/pre-push', sha256:`sha256:${createHash('sha256').update(script).digest('hex')}`, checks:['message']});
  const f = await rcpFixture(t,policy); await writeFile(path.join(f.root,'.git/hooks/pre-push'),script,{mode:0o755});
  await assert.rejects(planRepositoryCommit(f.root,{subject:f.subject,ref:f.ref,tree:await f.candidate(),parents:[f.parent],message:'Change endpoint'}),{code:'RCP_VALIDATION_UNSUPPORTED'});
  assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
});
