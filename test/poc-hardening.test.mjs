import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { runQualityCommand } from '../src/quality-command-runner.mjs';
import { assertSourceBoundary, isTestAutomationPath } from '../src/source-boundary.mjs';
import { storyPullRequestPlan } from '../src/pull-request.mjs';
import { setAgentSession } from '../src/session.mjs';
import { approvePhase, createWorkflow, loadConfig } from '../src/state.mjs';
import { run } from '../src/util.mjs';

test('quality commands stream output larger than spawnSync buffers without false failure', async () => {
  const result = await runQualityCommand(process.execPath, [
    '-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"
  ], { timeoutMs: 10_000, captureBytes: 8 * 1024 });
  assert.equal(result.status, 0);
  assert.equal(result.error, null);
  assert.equal(result.stdoutBytes, 2 * 1024 * 1024);
  assert.equal(result.stdoutTruncated, true);
  assert.match(result.stdout, /output bytes omitted/);
});

test('the POC source boundary admits automation and refuses product code', () => {
  for (const file of [
    'tests/checkout.spec.ts',
    'e2e/page-objects/checkout.page.ts',
    'playwright.config.ts',
    'packages/web/__tests__/checkout.test.ts'
  ]) assert.equal(isTestAutomationPath(file), true, file);
  for (const file of ['src/checkout.ts', 'src/pages/checkout.tsx', 'package.json']) {
    assert.equal(isTestAutomationPath(file), false, file);
  }
  assert.doesNotThrow(() => assertSourceBoundary('test-automation', ['tests/checkout.spec.ts'], { phaseId: 'poc-test-generation' }));
  assert.throws(
    () => assertSourceBoundary('test-automation', ['src/checkout.ts'], { phaseId: 'poc-test-generation' }),
    (error) => error.code === 'SOURCE_BOUNDARY_VIOLATION' && /src\/checkout\.ts/.test(error.message)
  );
});

test('pull-request preview exposes lifecycle blockers until every governed phase is complete', async () => {
  const workflow = {
    workItem: { id: 'POC-PR-1', title: 'POC regression', workType: 'poc-workflow', branch: 'POC-PR-1', baseBranch: 'main' },
    status: 'in_progress',
    currentPhase: 'poc-intake',
    phaseOrder: ['poc-intake', 'poc-validation'],
    phases: {
      'poc-intake': { id: 'poc-intake', status: 'in_progress', approvals: [] },
      'poc-validation': { id: 'poc-validation', status: 'not_started', approvals: [] }
    },
    history: []
  };
  const preview = await storyPullRequestPlan('/tmp', {}, workflow);
  assert.ok(preview.blockedBy.some((blocker) => /workflow is in_progress at poc-intake/.test(blocker)));
  assert.ok(preview.blockedBy.includes('poc-validation is not_started'));

  workflow.status = 'complete';
  workflow.currentPhase = null;
  for (const phase of Object.values(workflow.phases)) phase.status = 'approved';
  const ready = await storyPullRequestPlan('/tmp', {}, workflow);
  assert.deepEqual(ready.blockedBy, []);
});

test('a phase cannot advance until every required authority group has decided', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-poc-authorities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'POC Author'], { cwd: root });
  run('git', ['config', 'user.email', 'poc.author@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# POC authority coverage\n');
  await initializeDefinition(root);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'initialize'], { cwd: root });
  run('git', ['switch', '-c', 'POC-AUTH-1'], { cwd: root });
  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'poc-workflow');
  const publication = resolved.phases.find((phase) => phase.id === 'poc-publication-review');
  resolved.phases = [{ ...publication, order: 0, inputs: [] }];
  const first = { name: 'Quality Reviewer', email: 'quality@example.com', login: null };
  await setAgentSession(root, config, first, 'poc-validator', 'POC-AUTH-1', { phaseId: publication.id, source: 'test' });
  const workflow = await createWorkflow(root, config, {
    id: 'POC-AUTH-1',
    title: 'Require independent functions',
    source: { type: 'manual', key: 'POC-AUTH-1', title: 'Require independent functions', description: 'Prove authority coverage.', acceptanceCriteria: [], targetOrigin: 'https://staging.example.test' },
    baseBranch: 'main', workType: 'poc-workflow', agent: 'poc-validator', resolved
  });
  workflow.phases[publication.id].status = 'awaiting_approval';
  workflow.phases[publication.id].generation = 1;
  const one = await approvePhase(root, config, workflow, { phaseId: publication.id, persist: false });
  assert.equal(one.approval.authorityGroup, 'quality-reviewers');
  assert.equal(workflow.status, 'in_progress');
  assert.equal(workflow.phases[publication.id].status, 'awaiting_approval');

  const second = { name: 'Engineering Reviewer', email: 'engineering@example.com', login: null };
  await setAgentSession(root, config, second, 'poc-validator', 'POC-AUTH-1', { phaseId: publication.id, source: 'test' });
  const two = await approvePhase(root, config, workflow, { phaseId: publication.id, persist: false });
  assert.equal(two.approval.authorityGroup, 'engineering-reviewers');
  assert.equal(workflow.status, 'complete');
  assert.equal(workflow.phases[publication.id].status, 'approved');
});
