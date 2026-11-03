import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises'; import path from 'node:path';
import { rcpFixture, registeredRcpPolicy } from './helpers/rcp-fixture.mjs';
import { planRepositoryCommit } from '../src/repository-commit-policy/plan.mjs';
import { validateRegisteredCommitPlan, normalizeCommitCandidate } from '../src/repository-commit-policy/checks.mjs';
import { readCommitPolicyOperation } from '../src/repository-commit-policy/records.mjs';

function contentPolicy() {
  const policy = registeredRcpPolicy(), profile = policy.profiles['message-v1'];
  profile.checks.push({ id: 'whitespace', rule: 'no-trailing-whitespace', paths: ['source.js'] });
  profile.coverage.push({ stage: 'repository-content', checks: ['whitespace'] });
  profile.normalization = { maximumChangedAttempts: 2, steps: [{ rule: 'trim-trailing-whitespace', paths: ['source.js'] }] };
  return policy;
}
const plan = async (f, text) => planRepositoryCommit(f.root, { subject: f.subject, ref: f.ref,
  tree: await f.candidate(text), parents: [f.parent], message: 'Change endpoint', allowedPaths: ['source.js'] });
test('registered content checks bind exact Git blobs, retain rejected attempts and never claim native hooks ran', async t => {
  const f = await rcpFixture(t, contentPolicy());
  const draft = await plan(f, 'export const value = 2;  \n');
  await assert.rejects(validateRegisteredCommitPlan(draft), error => {
    assert.equal(error.code, 'RCP_CONTENT_REJECTED');
    assert.equal(error.details.checks.find(check => check.id === 'whitespace').status, 'rejected'); return true;
  });
  assert.equal(await readFile(path.join(f.root, 'source.js'), 'utf8'), 'export const value = 2;  \n');
  assert.equal(f.git(f.root, ['rev-parse', 'HEAD']), f.parent);
  const clean = await plan(f, 'export const value = 2;\n'), result = await validateRegisteredCommitPlan(clean);
  assert.equal(result.record.status, 'passed'); assert.equal(result.record.nativeHookExecution, 'not-executed');
});
test('normalization stays in authorized authoring scope and its finite changed-attempt budget survives reload', async t => {
  const f = await rcpFixture(t, contentPolicy()), operationId = `sha256:${'2'.repeat(64)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const draft = await plan(f, `export const value = ${attempt + 1};  \n`);
    const result = await normalizeCommitCandidate(draft, { operationId, beforeSourceFreeze: true, allowedPaths: ['source.js'], assertWriteAllowed: async file => assert.equal(file, 'source.js') });
    assert.equal(result.status, 'candidate-changed'); assert.equal(result.changedNormalizationAttempts, attempt);
  }
  const third = await plan(f, 'export const value = 4;  \n');
  await assert.rejects(normalizeCommitCandidate(third, { operationId, beforeSourceFreeze: true, allowedPaths: ['source.js'], assertWriteAllowed: async () => {} }), { code: 'RCP_NORMALIZATION_BUDGET_EXHAUSTED' });
  assert.equal((await readCommitPolicyOperation(f.root, operationId)).changedNormalizationAttempts, 2);
  assert.equal(await readFile(path.join(f.root, 'source.js'), 'utf8'), 'export const value = 4;  \n');
});
test('a frozen publication or an unrelated path does not authorize automatic formatter writes', async t => {
  const f = await rcpFixture(t, contentPolicy()), draft = await plan(f, 'export const value = 2;  \n');
  await assert.rejects(normalizeCommitCandidate(draft, { operationId: `sha256:${'3'.repeat(64)}` }), { code: 'RCP_CANDIDATE_CHANGED' });
  await assert.rejects(normalizeCommitCandidate(draft, { operationId: `sha256:${'3'.repeat(64)}`, beforeSourceFreeze: true, allowedPaths: ['other.js'], assertWriteAllowed: async () => {} }), { code: 'RCP_HOOK_EFFECT_OUT_OF_SCOPE' });
  assert.equal(await readFile(path.join(f.root, 'source.js'), 'utf8'), 'export const value = 2;  \n');
});
