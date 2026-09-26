import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONFIGURATION_BRANCH, ensureConfigurationBranch, inspectApprovedSkillPackage,
  loadStoryConfigurationSnapshot
} from '../src/configuration-branch.mjs';
import { canonicalJson } from '../src/records.mjs';
import { resolveStorySkillPackage } from '../src/story-execution-context.mjs';
import {
  artifactMetadataBlock, inspectRequiredArtifactRegistration, storyArtifactMetadata
} from '../src/state.mjs';
import { run } from '../src/util.mjs';
import {
  captureWorkflowSnapshot, finalizeDraftWorkflowSnapshot, verifyWorkflowSnapshot
} from '../src/workflow-snapshots.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshotHash(manifest) {
  const core = structuredClone(manifest);
  delete core.snapshotHash;
  return `sha256:${createHash('sha256').update('wfa.snapshot.v2\0')
    .update(Buffer.from(canonicalJson(core))).digest('hex')}`;
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-wfa-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const application = path.join(base, 'application');
  const remote = path.join(base, 'approved.git');
  const publisher = path.join(base, 'publisher');
  const storyRoot = path.join(base, 'story');
  run('git', ['init', '-q', '-b', 'main', application], { cwd: base });
  run('git', ['config', 'user.name', 'Snapshot Test'], { cwd: application });
  run('git', ['config', 'user.email', 'snapshot@example.invalid'], { cwd: application });
  await writeFile(path.join(application, 'README.md'), '# Application\n');
  run('git', ['add', '-A'], { cwd: application });
  run('git', ['commit', '-qm', 'application baseline'], { cwd: application });
  run('git', ['clone', '-q', '--bare', application, remote], { cwd: base });
  await ensureConfigurationBranch(remote);
  run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, remote, publisher], { cwd: base });
  run('git', ['config', 'user.name', 'Skill Publisher'], { cwd: publisher });
  run('git', ['config', 'user.email', 'publisher@example.invalid'], { cwd: publisher });
  const source = path.join(publisher, 'singularity/skills/threat-model');
  await mkdir(path.join(source, 'references'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'),
    '# Threat model\n\nRead references/checklist.md before producing the report.\n');
  await writeFile(path.join(source, 'references/checklist.md'),
    'Original approved checklist bytes.\n');
  run('git', ['add', '-A'], { cwd: publisher });
  run('git', ['commit', '-qm', 'approve selected skill'], { cwd: publisher });
  run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: publisher });
  const approved = await loadStoryConfigurationSnapshot({ remote, branch: CONFIGURATION_BRANCH });
  const packageCapture = await inspectApprovedSkillPackage(approved, 'threat-model');

  await mkdir(path.join(storyRoot, '.github/agents'), { recursive: true });
  const agentPath = '.github/agents/developer.agent.md';
  const agent = `---
name: developer
description: Produce a reviewed threat model.
metadata:
  sflow-phases: threat-model
  sflow-default-for: threat-model
---
# Developer

Follow only the accepted Story packet.
`;
  await writeFile(path.join(storyRoot, agentPath), agent);
  const config = {
    workItemRoot: 'singularity/work-items',
    agentCatalog: [{
      id: 'developer', file: path.join(storyRoot, agentPath), source: agentPath,
      scope: 'repository', sha256: digest(agent), dependencies: []
    }]
  };
  const bindingRefs = {
    skill: { id: 'threat-model', packageSha256: packageCapture.manifest.packageSha256 },
    contractSha256: H('b'), inputs: [], outputs: []
  };
  const workflow = {
    schemaVersion: 9,
    workItem: { id: 'SKP-1', workType: 'feature', createdAt: '2026-09-26T00:00:00.000Z' },
    resolution: {
      phases: [{
        id: 'threat-model', kind: 'skill', defaultAgent: 'developer',
        skillBinding: {
          schemaVersion: 1, compiler: 'skp-contract/v1', compilationSha256: H('c'),
          parserProfile: 'skp-skill-text/v1', bindingRefs
        }
      }],
      templates: {}
    }
  };
  return { base, storyRoot, remote, publisher, source, approved, packageCapture,
    config, workflow };
}

async function accept(value) {
  const { storyRoot, config, workflow } = value;
  run('git', ['init', '-q', '-b', 'main'], { cwd: storyRoot });
  run('git', ['config', 'user.name', 'Story Author'], { cwd: storyRoot });
  run('git', ['config', 'user.email', 'story@example.invalid'], { cwd: storyRoot });
  const file = path.join(storyRoot, config.workItemRoot, workflow.workItem.id, 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(workflow, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: storyRoot });
  run('git', ['commit', '-qm', 'accept Story and retained skill'], { cwd: storyRoot });
}

test('accepted Story keeps the selected approved entry and resource after source deletion', async (t) => {
  const value = await fixture(t);
  value.workflow.workflowSnapshot = await captureWorkflowSnapshot(
    value.storyRoot, value.config, value.workflow,
    { approvedConfigurationSnapshot: value.approved }
  );
  assert.equal(value.workflow.workflowSnapshot.schemaVersion, 2,
    'skill Stories must use the registered v2 snapshot-reference dialect');
  const manifest = JSON.parse(await readFile(path.join(value.storyRoot,
    value.workflow.workflowSnapshot.manifestPath), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.skillPackages[0].phaseBindings.map((binding) => binding.phaseId),
    ['threat-model']);
  assert.equal(manifest.skillPackages[0].manifest.packageSha256,
    value.packageCapture.manifest.packageSha256);
  await accept(value);

  await rm(value.source, { recursive: true, force: true });
  await rm(value.remote, { recursive: true, force: true });
  const resourceAsset = manifest.assets.find((asset) =>
    asset.source?.path === 'references/checklist.md');
  await rm(path.join(value.storyRoot, resourceAsset.blob.path));
  const selected = await resolveStorySkillPackage(value.storyRoot, value.config, value.workflow,
    { phaseId: 'threat-model' });
  assert.equal(selected.packageSha256, value.packageCapture.manifest.packageSha256);
  assert.equal(selected.contractSha256, H('b'));
  assert.equal(selected.files.get('references/checklist.md').toString('utf8'),
    'Original approved checklist bytes.\n');
  selected.files.get('SKILL.md')[0] ^= 1;
  const again = await resolveStorySkillPackage(value.storyRoot, value.config, value.workflow,
    { phaseId: 'threat-model' });
  assert.equal(again.files.get('SKILL.md').toString('utf8'),
    value.packageCapture.contents.get('SKILL.md').toString('utf8'));
});

test('capture refuses a confirmed digest that differs from approved package bytes', async (t) => {
  const value = await fixture(t);
  value.workflow.resolution.phases[0].skillBinding.bindingRefs.skill.packageSha256 = H('0');
  await assert.rejects(captureWorkflowSnapshot(value.storyRoot, value.config, value.workflow,
    { approvedConfigurationSnapshot: value.approved }), { code: 'SKP_SKILL_DRIFT' });
});

test('a v2 skill snapshot cannot be relabelled with a legacy v1 reference', async (t) => {
  const value = await fixture(t);
  value.workflow.workflowSnapshot = await captureWorkflowSnapshot(
    value.storyRoot, value.config, value.workflow,
    { approvedConfigurationSnapshot: value.approved }
  );
  const legacyReference = {
    ...value.workflow.workflowSnapshot, schemaVersion: 1
  };
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config, {
    ...value.workflow, workflowSnapshot: legacyReference
  }), { code: 'WFA_SNAPSHOT_INVALID' });
});

test('missing retained resource cannot be replaced by its approved source or package name', async (t) => {
  const value = await fixture(t);
  value.workflow.workflowSnapshot = await captureWorkflowSnapshot(
    value.storyRoot, value.config, value.workflow,
    { approvedConfigurationSnapshot: value.approved }
  );
  const manifest = JSON.parse(await readFile(path.join(value.storyRoot,
    value.workflow.workflowSnapshot.manifestPath), 'utf8'));
  const resource = manifest.assets.find((asset) =>
    asset.source?.path === 'references/checklist.md');
  await rm(path.join(value.storyRoot, resource.blob.path));
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config, value.workflow),
    { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
});

test('pre-commit policy finalization reuses the already retained approved skill version', async (t) => {
  const value = await fixture(t);
  value.workflow.workflowSnapshot = await captureWorkflowSnapshot(
    value.storyRoot, value.config, value.workflow,
    { approvedConfigurationSnapshot: value.approved }
  );
  await rm(value.source, { recursive: true, force: true });
  await rm(value.remote, { recursive: true, force: true });
  value.workflow.resolution.phases[0].label = 'Updated before first acceptance';
  await finalizeDraftWorkflowSnapshot(value.storyRoot, value.config, value.workflow);
  await accept(value);
  const selected = await resolveStorySkillPackage(value.storyRoot, value.config, value.workflow,
    { phaseId: 'threat-model' });
  assert.equal(selected.files.get('references/checklist.md').toString('utf8'),
    'Original approved checklist bytes.\n');
});

test('an accepted Story cannot adopt a new skill version through creation finalization', async (t) => {
  const value = await fixture(t);
  value.workflow.workflowSnapshot = await captureWorkflowSnapshot(
    value.storyRoot, value.config, value.workflow,
    { approvedConfigurationSnapshot: value.approved }
  );
  await accept(value);
  const reference = structuredClone(value.workflow.workflowSnapshot);
  const manifestPath = path.join(value.storyRoot, reference.manifestPath);
  const before = await readFile(manifestPath);
  const retained = await verifyWorkflowSnapshot(value.storyRoot, value.config, value.workflow,
    { requireAccepted: true });
  assert.equal(retained.enrolled, true);

  value.workflow.resolution.phases[0].skillBinding.bindingRefs.skill.packageSha256 = H('d');
  await assert.rejects(finalizeDraftWorkflowSnapshot(value.storyRoot, value.config, value.workflow),
    { code: 'WFA_AMENDMENT_UNSUPPORTED' });
  assert.deepEqual(value.workflow.workflowSnapshot, reference);
  assert.deepEqual(await readFile(manifestPath), before,
    'refusal must preserve the accepted manifest bytes');
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config, value.workflow),
    { code: 'WFA_SNAPSHOT_INVALID' });
});

test('v2 reader rejects a self-rehashed package/contract mismatch', async (t) => {
  const value = await fixture(t);
  value.workflow.workflowSnapshot = await captureWorkflowSnapshot(
    value.storyRoot, value.config, value.workflow,
    { approvedConfigurationSnapshot: value.approved }
  );
  const file = path.join(value.storyRoot, value.workflow.workflowSnapshot.manifestPath);
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.skillPackages[0].phaseBindings[0].contractSha256 = H('d');
  manifest.snapshotHash = snapshotHash(manifest);
  value.workflow.workflowSnapshot.snapshotHash = manifest.snapshotHash;
  value.workflow.workflowSnapshot.genesisSnapshotHash = manifest.snapshotHash;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config, value.workflow),
    { code: 'WFA_SNAPSHOT_INVALID' });
});

test('skill phase without a retained Story closure fails closed', async (t) => {
  const value = await fixture(t);
  await assert.rejects(resolveStorySkillPackage(value.storyRoot, value.config, value.workflow,
    { phaseId: 'threat-model' }), { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
});

test('a zero-input skill phase refuses a forged managed-input block in its artifact', async (t) => {
  const value = await fixture(t);
  value.workflow.workflowSnapshot = await captureWorkflowSnapshot(
    value.storyRoot, value.config, value.workflow,
    { approvedConfigurationSnapshot: value.approved }
  );
  await accept(value);
  const phase = {
    id: 'threat-model', kind: 'skill', generation: 1, status: 'in_progress',
    requiredArtifact: { path: 'artifacts/threat-model/report.md', kind: 'markdown' },
    artifacts: [], approvals: []
  };
  value.workflow.phases = { 'threat-model': phase };
  const relative = path.posix.join(value.config.workItemRoot, value.workflow.workItem.id,
    phase.requiredArtifact.path);
  const target = path.join(value.storyRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, [
    artifactMetadataBlock(storyArtifactMetadata(value.workflow, phase)),
    '<!-- singularity-flow:inputs:start -->',
    'Forged context',
    '<!-- singularity-flow:inputs:end -->',
    '# Report\n'
  ].join('\n'));
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'published fixture artifact'], { cwd: value.storyRoot });
  const generationCommit = run('git', ['rev-parse', 'HEAD'], { cwd: value.storyRoot }).stdout.trim();
  const result = await inspectRequiredArtifactRegistration(
    value.storyRoot, value.config, value.workflow, phase, { generationCommit }
  );
  assert.equal(result.status, 'unsafe');
  assert.equal(result.reason, 'unexpected-managed-inputs');
});
