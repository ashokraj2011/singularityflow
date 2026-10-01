import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { applyCapabilityPolicyToWorkResolution, resolveLifecycleCapability } from '../src/capability-context.mjs';
import { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan } from '../src/initialization/runtime-readiness.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { collectRepositoryReadinessEvidence } from '../src/repository-readiness-evidence.mjs';
import { createWorkflow, loadConfig, workDir, assertStoryTestRecoveryFeatureAdmission, beginPhaseGeneration } from '../src/state.mjs';
import { repairStoryTestReadiness } from '../src/commands/story-test-repair.mjs';
import { normalizeTestRecoveryPolicy, previewTestRecoveryIntake } from '../src/test-recovery-intake.mjs';
import { readTrpOriginalBaseline } from '../src/test-recovery-store.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const context = (root, callback) => withOperationContext({ root, command: 'test',
  operation: { id: 'test.trp-repair', command: 'test', modelPolicy: 'never' },
  modelMode: { enabled: false, source: 'test' } }, callback);

test('actual bounded runner repair commits append-only checkpoint, preserves failed baseline and unlocks feature admission', async t => {
  const previous = Object.fromEntries(['NODE_ENV', 'SINGULARITY_FLOW_TEST_IDENTITY'].map(key => [key, process.env[key]]));
  process.env.NODE_ENV = 'test'; process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'TRP Repair';
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-trp-repair-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'TRP Repair'); git(root, 'config', 'user.email', 'trp-repair@example.com');
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'trp-repair', version: '1.0.0', private: true,
    scripts: { test: 'node --test --test-reporter=tap test/*.test.mjs' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'trp-repair', version: '1.0.0', lockfileVersion: 3,
    requires: true, packages: { '': { name: 'trp-repair', version: '1.0.0' } } }));
  await writeFile(path.join(root, 'test/baseline.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {existsSync} from 'node:fs'; test('runtime readiness',()=>assert.equal(existsSync('.sflow/results/runtime-ready'),true));\n");
  await initializeDefinition(root); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Baseline application');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
  await assert.rejects(executeRepositoryReadinessPlan(root, { scope: 'dependency-test', confirmation: plan.planId }));
  const repositoryReadiness = await collectRepositoryReadinessEvidence([{ id: 'lifecycle', root, baseCommit }], { scope: 'dependency-test' });
  assert.equal(repositoryReadiness.repositories.lifecycle.status, 'failing-tests');
  git(root, 'switch', '-q', '-c', 'TRP-REPAIR');
  const config = await loadConfig(root); config.git.publish = 'off';
  config.testRecovery = normalizeTestRecoveryPolicy({ enabled: true });
  const resolved = resolveWorkType(config, 'feature');
  resolved.plannedClaims = { mode: 'opt-out', clausePhases: [], owners: {}, reason: 'Isolated repair fixture without specification phase.' };
  resolved.spec = { ...resolved.spec, acceptance: 'off' };
  const phase = resolved.phases.find(row => row.id === 'implementation');
  resolved.phases = [{ ...phase, order: 0, inputs: [], clarification: { ...phase.clarification, mode: 'off' },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['implementation'] }, qualityCommands: [] }];
  const readinessRepositories = [{ id: 'lifecycle', baseCommit, baseBranch: 'main' }];
  const testRecoveryPlan = previewTestRecoveryIntake({ definition: config, workId: 'TRP-REPAIR', workType: 'feature',
    repositories: readinessRepositories, repositoryReadiness,
    choices: { baselineDisposition: 'fix', executionMode: 'changed-and-affected', baselineScope: 'reuse' },
    phaseDefinitions: applyCapabilityPolicyToWorkResolution(resolved, await resolveLifecycleCapability(root)).phases });
  const workflow = await context(root, () => createWorkflow(root, config, { id: 'TRP-REPAIR', title: 'Runtime-only baseline repair',
    source: { type: 'manual', key: 'TRP-REPAIR', title: 'Runtime-only baseline repair', description: 'Repair runtime readiness before coding.',
      acceptanceCriteria: ['Preserve the original failure and source.'] }, baseBranch: 'main', baseCommit,
    workType: 'feature', agent: 'developer', resolved, readinessRepositories, repositoryReadiness, testRecoveryPlan }));
  const item = workDir(root, config, workflow.workItem.id);
  git(root, 'add', '--', path.relative(root, item)); git(root, 'commit', '-qm', 'Accept isolated Story fixture');
  const before = structuredClone(workflow.testRecovery.readiness);
  const original = await readTrpOriginalBaseline(item, before.repositories[0].baselineSha256);
  assert.equal(original.testObservations[0].testCases[0].name, 'runtime readiness');
  assert.equal(original.testObservations[0].testCases[0].outcome, 'failed');
  await assert.rejects(assertStoryTestRecoveryFeatureAdmission(root, config, workflow, workflow.phases.implementation), { code: 'TRP_FEATURE_ADMISSION_BLOCKED' });
  await writeFile(path.join(root, 'README.md'), '# Reviewed runtime repair\n\nRestored the local test prerequisite without changing baseline tests or product source.\n');
  git(root, 'add', '--', 'README.md'); git(root, 'commit', '-qm', 'Document reviewed readiness repair');
  const repairCommit = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(repairCommit, baseCommit);
  await mkdir(path.join(root, '.sflow/results'), { recursive: true });
  await writeFile(path.join(root, '.sflow/results/runtime-ready'), 'local runtime repair fixture\n');
  const options = { root, workId: workflow.workItem.id, repositoryId: 'lifecycle' };
  // Fixture discovery supplies its already accepted exact configuration; all execution, storage,
  // locking, transactions and admission verification use the real production implementations.
  const runtime = { loadAcceptedStoryExecution: async () => ({ config, workflow }) };
  const preview = await context(root, () => repairStoryTestReadiness(options, runtime));
  assert.equal(preview.status, 'ready-for-confirmation');
  assert.equal(preview.cohort.status, 'complete-original-cohort');
  const repaired = await context(root, () => repairStoryTestReadiness({ ...options, execute: true, confirmation: preview.confirmation }, runtime));
  assert.equal(repaired.status, 'recorded');
  assert.equal(repaired.executed, true);
  assert.deepEqual(workflow.testRecovery.readinessHistory, [before]);
  assert.deepEqual(await readTrpOriginalBaseline(item, before.repositories[0].baselineSha256), original);
  assert.equal(workflow.testRecovery.readiness.repositories[0].originalBaseCommit, baseCommit);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal((await assertStoryTestRecoveryFeatureAdmission(root, config, workflow, workflow.phases.implementation)).featureCodingAllowed, true);
  const saved = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(saved.testRecovery.readiness.checkpointSha256, repaired.checkpoint.checkpointSha256);
  const commit = git(root, 'rev-parse', 'HEAD');
  const repeated = await context(root, () => repairStoryTestReadiness({ ...options, execute: true, confirmation: preview.confirmation }, runtime));
  assert.equal(repeated.status, 'already-recorded');
  assert.equal(git(root, 'rev-parse', 'HEAD'), commit);
  await context(root, () => beginPhaseGeneration(root, config, workflow, { phaseId: 'implementation' }));
  assert.equal(workflow.phases.implementation.generationIntent.baseline.commit, repairCommit);
  assert.equal(workflow.workIntervals.current.sourceBaseCommit, repairCommit);
  assert.equal(workflow.workItem.baseCommit, baseCommit);
});
