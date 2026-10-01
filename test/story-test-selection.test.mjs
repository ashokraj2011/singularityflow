import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planStoryTestSelection, confirmStoryTestSelection } from '../src/commands/story-test-selection.mjs';
import { sourceTreeHash } from '../src/state.mjs';
import { captureWorkflowSnapshot } from '../src/workflow-snapshots.mjs';
import { createTrpFixture } from './test-recovery-policy.fixture.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-trp-selection-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentPath = '.github/agents/developer.agent.md';
  const templatePath = 'singularity/templates/code.md';
  const agent = '---\nname: developer\ndescription: Implement Story.\nmetadata:\n  sflow-phases: code\n  sflow-default-for: code\n---\n# Developer\n';
  const template = '# Implementation\nWork: {{work.id}}\n';
  for (const directory of ['test', 'src', path.dirname(agentPath), path.dirname(templatePath)]) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, agentPath), agent);
  await writeFile(path.join(root, templatePath), template);
  await writeFile(path.join(root, 'test/changed.test.mjs'), "import test from 'node:test'; test('selected', () => {});\n");
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.name', 'TRP Reviewer']);
  git(root, ['config', 'user.email', 'trp@example.invalid']); git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const core = createTrpFixture();
  const agreementPath = 'singularity/work-items/story-1/context/test-recovery/agreements/revision-1.json';
  await mkdir(path.dirname(path.join(root, agreementPath)), { recursive: true });
  await writeFile(path.join(root, agreementPath), JSON.stringify(core.agreement));
  const command = { id: 'node-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'node-tap', path: '.sflow/results/node.tap', minimumDiscovered: 1, minimumPassed: 1 } };
  const config = { workItemRoot: 'singularity/work-items', templatesRoot: 'singularity/templates', git: { publish: 'off' },
    agentCatalog: [{ id: 'developer', file: path.join(root, agentPath), source: agentPath, scope: 'repository', sha256: digest(agent), dependencies: [] }] };
  const phase = { id: 'code', generation: 1, status: 'generated', writeScope: 'source-and-artifact', sourceBoundary: 'unrestricted',
    generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' }, qualityCommands: [command] };
  const workflow = { schemaVersion: 5, workItem: { id: 'story-1', title: 'Selection test', workType: 'feature', branch: 'main', createdAt: '2026-10-02T00:00:00Z' },
    currentPhase: 'code', phaseOrder: ['code'], phases: { code: phase },
    resolution: { phases: [{ ...phase, template: 'code.md', defaultAgent: 'developer' }],
      templates: { code: { path: templatePath, sha256: digest(template) } },
      testRecovery: { enabled: true, riskAuthorities: ['reviewers'] },
      approvalAuthorities: { reviewers: { label: 'Reviewers', allowAnyGitIdentity: false, members: [{ email: 'trp@example.invalid' }] } } },
    testRecovery: { agreementPath, agreementSha256: core.agreement.recordSha256, validationEpoch: 1, selectionConfirmations: [] } };
  phase.deliveryEvidence = { generation: 1, baselineCommit: base, sourcePaths: [], testPaths: ['test/changed.test.mjs'],
    sourceTreeSha256: await sourceTreeHash(root, config, workflow),
    changeSet: { entries: [{ status: 'modified', oldPath: 'test/changed.test.mjs', newPath: 'test/changed.test.mjs' }] } };
  workflow.workflowSnapshot = await captureWorkflowSnapshot(root, config, workflow);
  const workflowPath = path.join(root, 'singularity/work-items/story-1/workflow.json');
  await writeFile(workflowPath, JSON.stringify(workflow, null, 2));
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'Accept Story snapshot']);
  return { root, config, workflow, workflowPath };
}

test('read-only command plan uses accepted snapshot and reports expansion without executing tests', async (t) => {
  const value = await fixture(t);
  const before = git(value.root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const bytes = await readFile(value.workflowPath, 'utf8');
  const plan = await planStoryTestSelection(value.root, value.config, value.workflow);
  assert.equal(plan.status, 'blocked'); assert.equal(plan.executed, false); assert.equal(plan.observedOutcome, 'not-run');
  assert.equal(plan.preview.manifest.fullSuiteEquivalent, true);
  assert.deepEqual(plan.legalActions[0].args.slice(0, 2), ['test-policy', 'confirm']);
  assert.equal(await readFile(value.workflowPath, 'utf8'), bytes);
  assert.equal(git(value.root, ['status', '--porcelain=v1', '--untracked-files=all']), before);
  const names = await readdir(path.join(value.root, 'singularity/work-items/story-1/context/test-recovery'));
  assert.deepEqual(names, ['agreements']);
});

test('confirmation digest cannot replace live terminal review or mutate Story state', async (t) => {
  const value = await fixture(t);
  const plan = await planStoryTestSelection(value.root, value.config, value.workflow);
  const before = git(value.root, ['rev-parse', 'HEAD']);
  await assert.rejects(confirmStoryTestSelection(value.root, value.config, value.workflow,
    { confirmation: plan.planDigest }), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  assert.equal(git(value.root, ['rev-parse', 'HEAD']), before);
  assert.deepEqual(value.workflow.testRecovery.selectionConfirmations, []);
  assert.equal(git(value.root, ['status', '--porcelain=v1', '--untracked-files=all']), '');
});

test('plan rejects mutable policy changes and noncurrent phases before review', async (t) => {
  const value = await fixture(t);
  await assert.rejects(planStoryTestSelection(value.root, value.config, value.workflow, { phaseId: 'old-code' }), { code: 'TRP_SELECTION_PHASE_INVALID' });
  value.workflow.resolution.testRecovery.riskAuthorities = ['attacker'];
  await assert.rejects(planStoryTestSelection(value.root, value.config, value.workflow), { code: 'WFA_SNAPSHOT_INVALID' });
});

test('stale confirmation cannot present a different cohort', async (t) => {
  const value = await fixture(t);
  await assert.rejects(confirmStoryTestSelection(value.root, value.config, value.workflow,
    { confirmation: `sha256:${'a'.repeat(64)}` }), { code: 'TRP_TEST_SELECTION_CONFIRMATION_STALE' });
  await assert.rejects(confirmStoryTestSelection(value.root, value.config, value.workflow,
    { confirmation: 'yes' }), { code: 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED' });
});
