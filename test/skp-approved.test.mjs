import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIGURATION_BRANCH, ensureConfigurationBranch, inspectApprovedSkillPackage,
  loadStoryConfigurationSnapshot, resolveStoryConfigurationAuthority
} from '../src/configuration-branch.mjs';
import { skillInspectionView } from '../src/skp-package.mjs';
import { run } from '../src/util.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

async function approvedSkillFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-approved-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'application.git');
  run('git', ['init', '-q', '-b', 'main', source], { cwd: root });
  run('git', ['config', 'user.name', 'Skill Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'skill@example.com'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), '# Application\n');
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'application baseline'], { cwd: source });
  run('git', ['clone', '-q', '--bare', source, remote], { cwd: root });
  await ensureConfigurationBranch(remote);

  const publisher = path.join(root, 'publisher');
  run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, remote, publisher], { cwd: root });
  run('git', ['config', 'user.name', 'Skill Publisher'], { cwd: publisher });
  run('git', ['config', 'user.email', 'publisher@example.com'], { cwd: publisher });
  const skill = path.join(publisher, 'singularity', 'skills', 'threat-model');
  await mkdir(path.join(skill, 'references'), { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'),
    '# Threat model\nRead [checklist](references/checklist.md).\n## Outputs\n- `artifacts/threats.md`\n');
  await writeFile(path.join(skill, 'references', 'checklist.md'), 'Exact approved bytes\n');
  run('git', ['add', '-A'], { cwd: publisher });
  run('git', ['commit', '-qm', 'approve threat model skill'], { cwd: publisher });
  run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: publisher });

  const checkout = path.join(root, 'checkout');
  run('git', ['clone', '-q', '--single-branch', '--branch', 'main', remote, checkout], { cwd: root });
  return { root, remote, checkout };
}

test('approved inspection consumes one verified snapshot and detects in-memory drift', async (t) => {
  const { checkout, remote } = await approvedSkillFixture(t);
  const authority = await resolveStoryConfigurationAuthority(checkout);
  const snapshot = await loadStoryConfigurationSnapshot(authority);
  const capture = await inspectApprovedSkillPackage(snapshot, 'threat-model');
  assert.deepEqual(capture.source, {
    kind: 'approved-configuration', branch: CONFIGURATION_BRANCH, commit: snapshot.sourceCommit
  });
  assert.equal(capture.contents.get('references/checklist.md').toString('utf8'),
    'Exact approved bytes\n');
  assert.equal(capture.metrics.fileReads, 0);
  assert.equal(capture.metrics.gitRequests, 0);
  assert.equal(capture.metrics.remoteCalls, 0);
  assert.equal(skillInspectionView(capture).executable, false);
  const same = await inspectApprovedSkillPackage(snapshot, 'threat-model', {
    expectedPackageSha256: capture.manifest.packageSha256
  });
  assert.equal(same.manifest.packageSha256, capture.manifest.packageSha256);
  await assert.rejects(inspectApprovedSkillPackage(snapshot, 'threat-model', {
    expectedPackageSha256: `sha256:${'0'.repeat(64)}`
  }), { code: 'SKP_SKILL_DRIFT' });
  await assert.rejects(inspectApprovedSkillPackage({}, 'threat-model'),
    { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' });

  // A checked-out but unapproved skill cannot fill a missing entry in the retained snapshot.
  const localOnly = path.join(checkout, 'singularity', 'skills', 'local-only');
  await mkdir(localOnly, { recursive: true });
  await writeFile(path.join(localOnly, 'SKILL.md'), '# Local only\n');
  await assert.rejects(inspectApprovedSkillPackage(snapshot, 'local-only'),
    { code: 'SKP_SKILL_MISSING' });

  // After the snapshot is loaded, neither the remote nor mutable checkout bytes are consulted.
  await rm(remote, { recursive: true, force: true });
  assert.equal((await inspectApprovedSkillPackage(snapshot, 'threat-model')).manifest.packageSha256,
    capture.manifest.packageSha256);
  const entry = snapshot.assets.find((item) =>
    item.relative === 'singularity/skills/threat-model/SKILL.md');
  entry.contents[0] ^= 1;
  await assert.rejects(inspectApprovedSkillPackage(snapshot, 'threat-model'),
    { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' });
});

test('skill approved CLI resolves approved authority, returns source commit, and stays read-only', async (t) => {
  const { root, remote, checkout } = await approvedSkillFixture(t);
  const before = run('git', ['status', '--porcelain'], { cwd: checkout }).stdout;
  const result = spawnSync(process.execPath, [CLI, 'skill', 'approved', 'threat-model', '--json'], {
    cwd: checkout, encoding: 'utf8', timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'skill.approved');
  assert.equal(response.operation.classification, 'read');
  assert.deepEqual(Object.values(response.effects), [false, false, false, false]);
  assert.equal(response.data.inspection.source.kind, 'approved-configuration');
  assert.equal(response.data.inspection.source.branch, CONFIGURATION_BRANCH);
  assert.match(response.data.inspection.source.commit, /^[0-9a-f]{40,64}$/u);
  assert.equal(response.data.inspection.executable, false);
  assert.equal(response.data.inspection.metrics.scope, 'package-inspector-only');
  assert.equal('remoteCalls' in response.data.inspection.metrics, false);
  assert.equal('gitRequests' in response.data.inspection.metrics, false);
  assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), '# Application\n');
  assert.equal(run('git', ['status', '--porcelain'], { cwd: checkout }).stdout, before);

  const mismatch = spawnSync(process.execPath, [CLI, 'skill', 'approved', 'threat-model',
    '--expected-package-sha256', `sha256:${'0'.repeat(64)}`, '--json'], {
    cwd: checkout, encoding: 'utf8', timeout: 30000
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /SKP_SKILL_DRIFT|confirmed package/u);

  const missing = spawnSync(process.execPath, [CLI, 'skill', 'approved', 'local-only', '--json'], {
    cwd: checkout, encoding: 'utf8', timeout: 30000
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SKP_SKILL_MISSING|exact SKILL\.md/u);

  const workspace = path.join(root, 'workspace');
  const selection = path.join(root, 'active-workspace.json');
  const registry = path.join(root, 'workspaces.json');
  const neutral = path.join(root, 'neutral');
  await mkdir(workspace);
  await mkdir(neutral);
  await writeFile(path.join(workspace, 'workspace.json'), `${JSON.stringify({
    version: 1, id: 'approved-skill-workspace', name: 'Approved skill workspace',
    anchor: { provider: 'workspace', key: 'approved-skill-workspace', title: 'Approved skill workspace' },
    leadRepository: 'app', capabilities: [],
    repositories: { app: {
      url: remote, defaultBranch: 'main', path: 'repos/app', capabilities: [],
      adoption: { mode: 'existing-clone', canonicalPath: checkout,
        proofHash: `sha256:${'0'.repeat(64)}`, reviewedAt: '2026-08-15T00:00:00.000Z' }
    } }
  }, null, 2)}\n`);
  await writeFile(selection, `${JSON.stringify({
    schemaVersion: 1, workspaceId: 'approved-skill-workspace',
    workspaceName: 'Approved skill workspace', workspacePath: workspace,
    repositoryId: 'app', repositoryPath: checkout, repositoryState: 'ready',
    branch: 'main', capabilities: [], repositoryCapabilities: [], storyId: null,
    selectedAt: '2026-08-15T00:00:00.000Z'
  }, null, 2)}\n`);
  const env = { ...process.env,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry };
  const routed = spawnSync(process.execPath, [CLI, 'skill', 'approved', 'threat-model', '--json'], {
    cwd: neutral, env, encoding: 'utf8', timeout: 30000
  });
  assert.equal(routed.status, 0, routed.stderr);
  assert.deepEqual(JSON.parse(routed.stdout).data.inspection.source,
    response.data.inspection.source);

  const local = path.join(neutral, 'local-skill');
  await mkdir(local);
  await writeFile(path.join(local, 'SKILL.md'), '# Explicit local skill\n');
  const inspected = spawnSync(process.execPath, [CLI, 'skill', 'inspect', local, '--json'], {
    cwd: neutral, env, encoding: 'utf8', timeout: 30000
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).data.inspection.source.kind, 'local-directory');
});

test('skill approved refuses a repository with no approved configuration authority', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-no-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main', root], { cwd: root });
  await mkdir(path.join(root, 'singularity', 'skills', 'local-only'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'skills', 'local-only', 'SKILL.md'),
    '# Not approved\n');
  const result = spawnSync(process.execPath, [CLI, 'skill', 'approved', 'local-only', '--json'], {
    cwd: root,
    env: { ...process.env,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, 'no-active-workspace.json'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'no-workspace-registry.json') },
    encoding: 'utf8', timeout: 30000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SKP_APPROVED_AUTHORITY_UNAVAILABLE|No approved configuration authority/u);
});
