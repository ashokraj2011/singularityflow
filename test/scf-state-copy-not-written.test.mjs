/**
 * SPEC-SCF stage 4: SFlow writes no copy of the configuration to the state branch [SCF:REQ-003].
 *
 * sflow/config is the configuration. An upgrade that publishes, `capability publish`, and a
 * capability activation each used to rebuild the state branch's `configuration/` copy as well; now
 * none of them writes it. An old copy that is already there stays exactly as it was (nothing is
 * rewritten), and the organisation read takes the map from sflow/config, never from that copy.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { run } from '../src/util.mjs';
import { rememberWorkspace } from '../src/workspace.mjs';
import { withAgentsHomeSetting } from '../src/initialization-assets.mjs';
import { refreshWorkspaceConfigurations } from '../src/workspace-configuration-refresh.mjs';
import {
  activateCapabilityProposal, capabilityFsck, mapCapability, publishOrganisationCapabilityMap, readOrganisation
} from '../src/organisation.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
process.env.SINGULARITY_FLOW_CONFIGURATION_OBJECT_STORE = 'off';
if (process.platform === 'darwin') process.env.TMPDIR = '/tmp';

const roots = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function scratch(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
const git = (cwd, args) => run('git', args, { cwd }).stdout.trim();
const bare = (remote, args) => run('git', ['--git-dir', remote, ...args]).stdout.trim();
const ref = (remote, name) => run('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', name],
  { allowFailure: true }).stdout.trim() || null;
/** Every commit on the state branch that touched its configuration copy. */
const copyCommits = (remote) => bare(remote, ['log', '--format=%H', 'refs/heads/state', '--', 'configuration',
  'singularity/workflow.yml', 'singularity/capabilities.yml', 'singularity/portfolio.yml'])
  .split('\n').filter(Boolean);

/** A state branch as the ledger starts it, carrying an old configuration copy an earlier build wrote. */
async function stateWithOldCopy(root, remote) {
  const state = path.join(root, 'state-publisher');
  run('git', ['init', '-q', '--initial-branch=state', state]);
  git(state, ['config', 'user.name', 'State Test']);
  git(state, ['config', 'user.email', 'state@example.test']);
  await mkdir(path.join(state, 'ledger'), { recursive: true });
  await writeFile(path.join(state, 'README.md'), '# Singularity Flow Capability Ledger\n\nAppend-only ledger.\n');
  await writeFile(path.join(state, 'ledger/head.json'), `${JSON.stringify({
    schemaVersion: 1, sequence: 0, entryHash: null, previousHeadHash: null, updatedAt: '2026-01-01T00:00:00.000Z'
  })}\n`);
  git(state, ['add', '-A']);
  git(state, ['commit', '-qm', 'Initialize Singularity Flow capability ledger']);
  await mkdir(path.join(state, 'configuration'), { recursive: true });
  await writeFile(path.join(state, 'configuration/manifest.json'), `${JSON.stringify({
    format: 'singularity-flow-configuration-mirror/v2', layout: 'canonical-paths',
    source: { branch: 'sflow/config', commit: '0'.repeat(40) }, files: {}, assets: {}
  }, null, 2)}\n`);
  git(state, ['add', '-A']);
  git(state, ['commit', '-qm', 'An old configuration copy, written by an earlier build']);
  git(state, ['push', '-q', remote, 'HEAD:refs/heads/state']);
}

async function registeredRepository(root) {
  const remote = path.join(root, 'application.git');
  const repository = path.join(root, 'workspace', 'repos', 'application');
  run('git', ['init', '-q', '--bare', '--initial-branch=main', remote]);
  run('git', ['init', '-q', '--initial-branch=main', repository]);
  git(repository, ['config', 'user.name', 'Configuration Test']);
  git(repository, ['config', 'user.email', 'configuration@example.test']);
  await writeFile(path.join(repository, 'application.txt'), 'application source\n');
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-qm', 'Initialize application']);
  git(repository, ['push', '-q', remote, 'main']);
  // An older approved configuration: the upgrade has something to publish.
  const publisher = path.join(root, 'configuration-publisher');
  run('git', ['init', '-q', '--initial-branch=sflow/config', publisher]);
  git(publisher, ['config', 'user.name', 'Configuration Test']);
  git(publisher, ['config', 'user.email', 'configuration@example.test']);
  const workflow = YAML.parse(withAgentsHomeSetting(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8')));
  delete workflow.phases.implementation.generation.task;
  await mkdir(path.join(publisher, 'singularity'), { recursive: true });
  await writeFile(path.join(publisher, 'singularity/workflow.yml'), YAML.stringify(workflow));
  git(publisher, ['add', '-A']);
  git(publisher, ['commit', '-qm', 'Retain older workflow policy']);
  git(publisher, ['push', '-q', remote, 'HEAD:refs/heads/sflow/config']);
  const workspaceRoot = path.join(root, 'workspace');
  const manifest = {
    version: 1, id: 'application-workspace', name: 'application workspace', path: workspaceRoot,
    anchor: { provider: 'workspace', key: 'application-workspace', title: 'application workspace' },
    leadRepository: 'application',
    repositories: { application: { id: 'application', url: remote, defaultBranch: 'main', required: true,
      path: 'repos/application', role: 'lead', capabilities: [] } }
  };
  const registry = path.join(root, 'workspaces.json');
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rememberWorkspace(registry, manifest);
  return { remote, registry };
}

test('an upgrade that publishes to sflow/config writes no configuration copy to the state branch', async () => {
  const root = await scratch('sflow-scf-state-refresh-');
  const { remote, registry } = await registeredRepository(root);
  await stateWithOldCopy(root, remote);
  const stateBefore = ref(remote, 'refs/heads/state');
  const copyBefore = copyCommits(remote);
  const configurationBefore = ref(remote, 'refs/heads/sflow/config');

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.results[0].status, 'would-update', JSON.stringify(preview.results[0]));
  for (const field of ['stateChanged', 'stateStatus', 'stateCommit', 'missingStatePaths']) {
    assert.equal(Object.hasOwn(preview.results[0], field), false, `the preview says nothing about a state copy (${field})`);
  }

  const applied = await refreshWorkspaceConfigurations({ registryFile: registry });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(applied.results[0].status, 'updated');
  assert.notEqual(ref(remote, 'refs/heads/sflow/config'), configurationBefore, 'sflow/config holds the build\'s configuration');
  assert.equal(ref(remote, 'refs/heads/state'), stateBefore, 'the state branch did not move');
  assert.deepEqual(copyCommits(remote), copyBefore, 'the old copy stays exactly as it was');

  // Run again: the repository is current, not "stale" for want of a copy.
  const again = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(again.results[0].status, 'current', JSON.stringify(again.results[0]));
  assert.equal(ref(remote, 'refs/heads/state'), stateBefore);
});

test('a first upgrade that creates sflow/config creates no state branch copy either', async () => {
  const root = await scratch('sflow-scf-state-bootstrap-');
  const { remote, registry } = await registeredRepository(root);
  bare(remote, ['update-ref', '-d', 'refs/heads/sflow/config']);
  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.results[0].status, 'would-initialize', JSON.stringify(preview.results[0]));
  const applied = await refreshWorkspaceConfigurations({ registryFile: registry, confirmPlan: preview.planId });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.ok(ref(remote, 'refs/heads/sflow/config'), 'sflow/config was created');
  assert.equal(ref(remote, 'refs/heads/state'), null, 'no state branch was written to hold a copy');
});

/** One lead repository with an approved map, as `capability map` and a review merge leave it. */
async function leadWithMap(root) {
  const remote = path.join(root, 'platform.git');
  run('git', ['init', '-q', '-b', 'main', '--bare', remote]);
  const seed = path.join(root, 'platform-seed');
  run('git', ['init', '-q', '-b', 'main', seed]);
  git(seed, ['config', 'user.email', 'lead@example.test']);
  git(seed, ['config', 'user.name', 'Lead Test']);
  await writeFile(path.join(seed, 'README.md'), '# platform\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-qm', 'Initial']);
  git(seed, ['push', '-q', remote, 'main:main']);
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(root, 'leads.json');
  const first = await mapCapability(remote, { capabilityId: 'commerce', name: 'Commerce', kind: 'collection' });
  const review = path.join(root, 'review');
  run('git', ['clone', '-q', '--no-local', remote, review]);
  git(review, ['config', 'user.email', 'reviewer@example.test']);
  git(review, ['config', 'user.name', 'Review Test']);
  git(review, ['fetch', '-q', 'origin', first.branch]);
  git(review, ['switch', '-q', first.baseBranch]);
  git(review, ['merge', '--ff-only', `origin/${first.branch}`]);
  git(review, ['push', '-q', 'origin', `HEAD:${first.baseBranch}`]);
  return remote;
}

test('capability publish and a capability activation leave the state branch\'s configuration copy untouched', async () => {
  const root = await scratch('sflow-scf-state-capability-');
  const remote = await leadWithMap(root);
  await stateWithOldCopy(root, remote);
  const copyBefore = copyCommits(remote);

  const published = await publishOrganisationCapabilityMap(remote);
  assert.equal(Object.hasOwn(published, 'published'), false, 'capability publish no longer reports a copy');
  assert.ok(published.portability, 'it publishes the delivery locators only');
  assert.deepEqual(copyCommits(remote), copyBefore);

  const proposed = await mapCapability(remote, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection', parent: 'commerce'
  });
  const activated = await activateCapabilityProposal(remote, proposed.branch, {
    confirm: proposed.commit, acknowledgeUnprotected: true
  });
  assert.equal(activated.activated, true, JSON.stringify(activated));
  assert.equal(activated.audit.recorded, true, 'the activation audit is still recorded on the state branch');
  assert.equal(Object.hasOwn(activated, 'projection'), false);
  assert.ok(['activated', 'activation-complete-portability-pending'].includes(activated.status), activated.status);
  assert.match(bare(remote, ['show', 'sflow/config:singularity/capabilities.yml']), /calculator/);
  assert.deepEqual(copyCommits(remote), copyBefore, 'the activation wrote no configuration copy');
  const tree = bare(remote, ['ls-tree', '-r', '--name-only', 'refs/heads/state', '--', 'configuration']).split('\n').filter(Boolean);
  assert.deepEqual(tree, ['configuration/manifest.json'], 'only the old copy\'s file is there, unchanged');

  // The organisation read takes the map from sflow/config, not from the state branch.
  const organisation = await readOrganisation(remote, { refresh: true });
  assert.equal(organisation.sourceBranch, 'sflow/config');
  assert.equal(Object.hasOwn(organisation, 'stateProjection'), false);
  assert.ok(organisation.capabilities.some((capability) => capability.id === 'commerce'));
  const fsck = await capabilityFsck(remote);
  assert.equal(fsck.checks.some((check) => check.id === 'state-projection'), false, 'no check for a copy that is never written');
});
