import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { proposeConfigurationChange } from '../src/configuration-proposal.mjs';
import { remoteFingerprint } from '../src/git-remote-diagnostics.mjs';
import { onboardRepository } from '../src/onboard.mjs';
import { planWorkflowImport, readWorkflowBundle, workflowTransferProposal } from '../src/workflow-transfer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function flow(root, ...args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Transfer Test',
      SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(root, '.git', 'test-transfer-outbox'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-transfer-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Workflow Transfer Test');
  git(root, 'config', 'user.email', 'workflow-transfer@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initialize workflow configuration');
  return root;
}

async function remoteTransferFixture(t) {
  const source = await repository(t);
  const root = await repository(t);
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-transfer-destination-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remoteA = path.join(base, 'authority-a.git');
  const remoteB = path.join(base, 'authority-b.git');
  for (const remote of [remoteA, remoteB]) {
    git(base, 'init', '-q', '--bare', '--initial-branch=main', remote);
    git(root, 'push', '-q', remote, 'HEAD:refs/heads/main', 'HEAD:refs/heads/sflow/config');
  }
  git(root, 'remote', 'add', 'origin', remoteA);
  const configuration = YAML.parse(await readFile(path.join(source, 'singularity/workflow.yml'), 'utf8'));
  configuration.workTypes['portable-feature'] = {
    ...structuredClone(configuration.workTypes.feature), label: 'Portable feature'
  };
  await writeFile(path.join(source, 'singularity/workflow.yml'), YAML.stringify(configuration));
  const bundleFile = path.join(base, 'portable-workflow.json');
  const exported = flow(source, 'workflow', 'export', '--workflow', 'portable-feature', '--out', bundleFile, '--json');
  assert.equal(exported.status, 0, exported.stderr);
  return { root, source, base, remoteA, remoteB, bundleFile,
    approved: git(root, 'rev-parse', 'HEAD') };
}

function importPreview(item) {
  const result = flow(item.root, 'workflow', 'import', item.bundleFile, '--dry-run', '--json');
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  return plan;
}

test('workflow import confirmation refuses byte-identical destination authority and commit changes, then permits fresh review-only proposal', async (t) => {
  const item = await remoteTransferFixture(t);
  const planA = importPreview(item);
  assert.deepEqual(planA.destinationAuthority, {
    kind: 'approved-configuration-ref', branch: 'sflow/config', commit: item.approved,
    sourceCommit: item.approved, remoteFingerprint: remoteFingerprint(item.remoteA)
  });
  const applicationHead = git(item.root, 'rev-parse', 'HEAD');
  const applicationIndex = git(item.root, 'write-tree');
  const applicationBytes = await readFile(path.join(item.root, 'singularity/workflow.yml'), 'utf8');
  const refsA = git(item.base, '--git-dir', item.remoteA, 'show-ref');
  const refsB = git(item.base, '--git-dir', item.remoteB, 'show-ref');
  git(item.root, 'remote', 'set-url', 'origin', item.remoteB);
  const staleRemote = flow(item.root, 'workflow', 'import', item.bundleFile,
    '--confirm', planA.planSha256, '--propose', '--json');
  assert.notEqual(staleRemote.status, 0);
  assert.match(staleRemote.stdout, /plan changed or was not confirmed/);
  assert.equal(git(item.base, '--git-dir', item.remoteA, 'show-ref'), refsA);
  assert.equal(git(item.base, '--git-dir', item.remoteB, 'show-ref'), refsB);
  const planB = importPreview(item);
  assert.equal(planB.targetStateSha256, planA.targetStateSha256);
  assert.notEqual(planB.planSha256, planA.planSha256);
  assert.equal(planB.destinationAuthority.remoteFingerprint, remoteFingerprint(item.remoteB));

  git(item.root, 'commit', '--allow-empty', '-qm', 'new approved identity with unchanged bytes');
  const changedCommit = git(item.root, 'rev-parse', 'HEAD');
  git(item.root, 'push', '-q', item.remoteB, 'HEAD:refs/heads/sflow/config');
  git(item.root, 'switch', '-q', '--detach', applicationHead);
  const changedRefsB = git(item.base, '--git-dir', item.remoteB, 'show-ref');
  const staleCommit = flow(item.root, 'workflow', 'import', item.bundleFile,
    '--confirm', planB.planSha256, '--propose', '--json');
  assert.notEqual(staleCommit.status, 0);
  assert.match(staleCommit.stdout, /plan changed or was not confirmed/);
  assert.equal(git(item.base, '--git-dir', item.remoteB, 'show-ref'), changedRefsB);
  const fresh = importPreview(item);
  assert.equal(fresh.targetStateSha256, planA.targetStateSha256);
  assert.equal(fresh.destinationAuthority.commit, changedCommit);
  assert.notEqual(fresh.planSha256, planB.planSha256);
  const applied = flow(item.root, 'workflow', 'import', item.bundleFile,
    '--confirm', fresh.planSha256, '--propose', '--json');
  assert.equal(applied.status, 0, `${applied.stderr}\n${applied.stdout}`);
  const proposal = JSON.parse(applied.stdout);
  assert.equal(proposal.reviewRequired, true);
  assert.equal(proposal.baseCommit, changedCommit);
  assert.equal(proposal.planSha256, fresh.planSha256);
  assert.equal(git(item.base, '--git-dir', item.remoteA, 'show-ref'), refsA);
  assert.equal(git(item.base, '--git-dir', item.remoteB, 'rev-parse', 'sflow/config'), changedCommit);
  const proposed = YAML.parse(git(item.base, '--git-dir', item.remoteB, 'show', `${proposal.branch}:singularity/workflow.yml`));
  assert.equal(proposed.workTypes['portable-feature'].label, 'Portable feature');
  assert.equal(git(item.root, 'rev-parse', 'HEAD'), applicationHead);
  assert.equal(git(item.root, 'write-tree'), applicationIndex);
  assert.equal(await readFile(path.join(item.root, 'singularity/workflow.yml'), 'utf8'), applicationBytes);
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('captured transfer expectation fences authority and commit races at the proposal owner before mutation', async (t) => {
  const item = await remoteTransferFixture(t);
  const bundle = await readWorkflowBundle(item.bundleFile);
  const captured = await withApprovedConfigurationRead(item.root, async () => {
    const plan = await planWorkflowImport(item.root, bundle);
    return workflowTransferProposal(plan, { expectedPlanSha256: plan.planSha256, requireApprovedDestination: true });
  }, { preferAuthority: true });
  const refsA = git(item.base, '--git-dir', item.remoteA, 'show-ref');
  const refsB = git(item.base, '--git-dir', item.remoteB, 'show-ref');
  git(item.root, 'remote', 'set-url', 'origin', item.remoteB);
  let mutations = 0;
  const proposal = { operation: 'import-workflows', subject: 'portable-feature', message: 'review transfer',
    ...captured, async mutate(target) { mutations += 1; return captured.mutate(target); } };
  await assert.rejects(() => proposeConfigurationChange(item.root, proposal),
    { code: 'CONFIGURATION_PROPOSAL_AUTHORITY_CHANGED' });
  assert.equal(mutations, 0);
  assert.equal(git(item.base, '--git-dir', item.remoteA, 'show-ref'), refsA);
  assert.equal(git(item.base, '--git-dir', item.remoteB, 'show-ref'), refsB);
  git(item.root, 'remote', 'set-url', 'origin', item.remoteA);
  git(item.root, 'commit', '--allow-empty', '-qm', 'source commit race');
  git(item.root, 'push', '-q', item.remoteA, 'HEAD:refs/heads/sflow/config');
  const changedRefs = git(item.base, '--git-dir', item.remoteA, 'show-ref');
  await assert.rejects(() => proposeConfigurationChange(item.root, proposal),
    { code: 'CONFIGURATION_PROPOSAL_AUTHORITY_CHANGED' });
  assert.equal(mutations, 0);
  assert.equal(git(item.base, '--git-dir', item.remoteA, 'show-ref'), changedRefs);
  await assert.rejects(() => captured.mutate(item.root),
    { code: 'WORKFLOW_TRANSFER_DESTINATION_CHANGED' });
  const proofRoot = path.join(item.base, 'wrong-ambient-repository');
  git(item.base, 'clone', '-q', '--single-branch', '--branch', 'sflow/config', item.remoteB, proofRoot);
  assert.equal(git(proofRoot, 'rev-parse', 'HEAD'), item.approved);
  const previousGitDir = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = path.join(proofRoot, '.git');
    await assert.rejects(() => captured.mutate(item.root),
      { code: 'WORKFLOW_TRANSFER_DESTINATION_CHANGED' });
  } finally {
    if (previousGitDir == null) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
  }
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('workflow copy and duplicate confirmations use the same exact destination fence', async (t) => {
  const item = await remoteTransferFixture(t);
  const preview = (command) => {
    const result = flow(item.root, 'workflow', command, 'feature', 'feature-copy',
      '--label', 'Feature copy', '--dry-run', '--json');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const planA = preview('copy');
  assert.equal(preview('duplicate').planSha256, planA.planSha256);
  git(item.root, 'remote', 'set-url', 'origin', item.remoteB);
  for (const command of ['copy', 'duplicate']) {
    const rejected = flow(item.root, 'workflow', command, 'feature', 'feature-copy',
      '--label', 'Feature copy', '--confirm', planA.planSha256, '--propose', '--json');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout, /plan changed or was not confirmed/);
  }
  const planB = preview('duplicate');
  assert.equal(planB.targetStateSha256, planA.targetStateSha256);
  assert.notEqual(planB.planSha256, planA.planSha256);
  const applied = flow(item.root, 'workflow', 'duplicate', 'feature', 'feature-copy',
    '--label', 'Feature copy', '--confirm', planB.planSha256, '--propose', '--json');
  assert.equal(applied.status, 0, `${applied.stderr}\n${applied.stdout}`);
  const proposal = JSON.parse(applied.stdout);
  assert.equal(proposal.reviewRequired, true);
  assert.equal(proposal.planSha256, planB.planSha256);
  assert.equal(git(item.base, '--git-dir', item.remoteA, 'rev-parse', 'sflow/config'), item.approved);
  assert.equal(git(item.base, '--git-dir', item.remoteB, 'rev-parse', 'sflow/config'), item.approved);
  const copied = YAML.parse(git(item.base, '--git-dir', item.remoteB, 'show', `${proposal.branch}:singularity/workflow.yml`));
  assert.equal(copied.workTypes['feature-copy'].label, 'Feature copy');
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('local approved configuration authoring stays available without a remote identity', async (t) => {
  const root = await repository(t);
  git(root, 'switch', '-q', '-c', 'sflow/config');
  const preview = flow(root, 'workflow', 'copy', 'feature', 'feature-copy',
    '--label', 'Local feature copy', '--dry-run', '--json');
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.destinationAuthority.remoteFingerprint, null);
  assert.equal(plan.destinationAuthority.commit, git(root, 'rev-parse', 'HEAD'));
  const remoteRefused = flow(root, 'workflow', 'copy', 'feature', 'feature-copy',
    '--label', 'Local feature copy', '--confirm', plan.planSha256, '--propose', '--json');
  assert.notEqual(remoteRefused.status, 0);
  assert.match(remoteRefused.stdout, /No exact approved remote workflow transfer destination/);
  assert.equal(git(root, 'status', '--porcelain=v1'), '');
  const applied = flow(root, 'workflow', 'copy', 'feature', 'feature-copy',
    '--label', 'Local feature copy', '--confirm', plan.planSha256, '--json');
  assert.equal(applied.status, 0, `${applied.stderr}\n${applied.stdout}`);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.resultType, 'workflow-copy');
  assert.equal(result.status, 'copied');
  const configuration = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(configuration.workTypes['feature-copy'].label, 'Local feature copy');
});

test('a working-tree-only confirmation cannot authorize a remote proposal when approved destination capture is absent', async (t) => {
  const root = await repository(t);
  const before = git(root, 'show-ref');
  const preview = flow(root, 'workflow', 'copy', 'feature', 'feature-copy',
    '--label', 'Feature copy', '--dry-run', '--json');
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.equal(Object.hasOwn(plan, 'destinationAuthority'), false);
  const applied = flow(root, 'workflow', 'copy', 'feature', 'feature-copy',
    '--label', 'Feature copy', '--confirm', plan.planSha256, '--propose', '--json');
  assert.notEqual(applied.status, 0);
  assert.match(applied.stdout, /No exact approved workflow transfer destination/);
  assert.equal(git(root, 'show-ref'), before);
  assert.equal(git(root, 'status', '--porcelain=v1'), '');
});

test('explicit local FOS transfer --propose preserves the uncommitted local review route', async (t) => {
  const root = await repository(t);
  git(root, 'branch', 'sflow/config');
  await onboardRepository(root, { authorityLocal: true });
  git(root, 'switch', '-q', 'sflow/config');
  const before = git(root, 'rev-parse', 'HEAD');
  const preview = flow(root, 'workflow', 'copy', 'feature', 'local-feature-copy',
    '--label', 'Local feature copy', '--dry-run', '--json');
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.destinationAuthority.remoteFingerprint, null);
  const applied = flow(root, 'workflow', 'copy', 'feature', 'local-feature-copy',
    '--label', 'Local feature copy', '--confirm', plan.planSha256, '--propose', '--json');
  assert.equal(applied.status, 0, `${applied.stderr}\n${applied.stdout}`);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.authorityMode, 'local');
  assert.equal(result.reviewRequired, false);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(root, 'remote'), '');
  const configuration = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(configuration.workTypes['local-feature-copy'].label, 'Local feature copy');
  assert.equal(git(root, 'diff', '--name-only'), 'singularity/workflow.yml');
});

test('workflow export writes one portable bundle for several selected workflows', async (t) => {
  const root = await repository(t);
  const output = path.join(root, 'selected-workflows.sflow-workflows.json');
  const result = flow(root,
    'workflow', 'export',
    '--workflow', 'feature', '--workflow', 'bugfix',
    '--out', output, '--json');

  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.resultType, 'workflow-export');
  assert.equal(receipt.status, 'exported');
  assert.equal(receipt.outputPath, output);
  assert.match(receipt.bundleSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(receipt.workflows.map((entry) => entry.id), ['bugfix', 'feature']);
  assert.ok(receipt.summary.phases > 0);
  assert.ok(receipt.summary.templates > 0);
  assert.ok(receipt.summary.agents > 0);
  assert.ok(receipt.dependencies.workflows.includes('story:feature'));
  assert.ok(receipt.dependencies.phases.includes('story:implementation'));

  const bundle = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(bundle.kind, 'sflow-workflow-bundle');
  assert.equal(bundle.schemaVersion, 4);
  assert.equal(bundle.bundleSha256, receipt.bundleSha256);
  assert.deepEqual(bundle.workflows.map((entry) => `${entry.governs}:${entry.id}`), [
    'story:bugfix', 'story:feature'
  ]);
  assert.ok(Object.hasOwn(bundle.objects.story.workTypes, 'bugfix'));
  assert.ok(Object.hasOwn(bundle.objects.story.workTypes, 'feature'));
  assert.ok(bundle.assets.some((asset) => asset.kind === 'template'));
  assert.ok(bundle.assets.some((asset) => asset.kind === 'agent'));
});

test('workflow import dry-run reports exact reuse without changing configuration', async (t) => {
  const root = await repository(t);
  const output = path.join(root, 'feature.sflow-workflows.json');
  const exported = flow(root, 'workflow', 'export', '--workflow', 'feature', '--out', output, '--json');
  assert.equal(exported.status, 0, exported.stderr);
  const workflowFile = path.join(root, 'singularity', 'workflow.yml');
  const before = await readFile(workflowFile, 'utf8');

  const preview = flow(root, 'workflow', 'import', output, '--dry-run', '--json');

  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.resultType, 'workflow-import-plan');
  assert.equal(plan.status, 'ready');
  assert.match(plan.planSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(plan.operations.conflicts.length, 0);
  assert.ok(plan.operations.reuse.some((entry) =>
    entry.kind === 'story.workTypes' && entry.id === 'feature'));
  assert.equal(await readFile(workflowFile, 'utf8'), before);
});

test('workflow copy and duplicate previews are deterministic linked-copy plans', async (t) => {
  const root = await repository(t);
  const workflowFile = path.join(root, 'singularity', 'workflow.yml');
  const before = await readFile(workflowFile, 'utf8');

  const copied = flow(root,
    'workflow', 'copy', 'feature', 'feature-copy', '--label', 'Feature copy', '--dry-run', '--json');
  const duplicated = flow(root,
    'workflow', 'duplicate', 'feature', 'feature-copy', '--label', 'Feature copy', '--dry-run', '--json');

  assert.equal(copied.status, 0, copied.stderr);
  assert.equal(duplicated.status, 0, duplicated.stderr);
  const copyPlan = JSON.parse(copied.stdout);
  const duplicatePlan = JSON.parse(duplicated.stdout);
  assert.equal(copyPlan.resultType, 'workflow-copy-plan');
  assert.equal(copyPlan.status, 'ready');
  assert.equal(copyPlan.sharedDependencies.linked, true);
  assert.deepEqual(copyPlan.operations.add, [{ kind: 'story.workflow', id: 'feature-copy' }]);
  assert.ok(copyPlan.operations.reuse.some((entry) => entry.kind === 'story.phase'));
  assert.equal(duplicatePlan.planSha256, copyPlan.planSha256);
  assert.equal(await readFile(workflowFile, 'utf8'), before);

  const applied = flow(root,
    'workflow', 'copy', 'feature', 'feature-copy', '--label', 'Feature copy',
    '--confirm', copyPlan.planSha256, '--json');
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.resultType, 'workflow-copy');
  assert.equal(result.status, 'copied');
  const after = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.deepEqual(after.workTypes['feature-copy'], {
    ...after.workTypes.feature,
    label: 'Feature copy'
  });
});
