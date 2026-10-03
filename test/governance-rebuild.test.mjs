import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { activateGovernanceRebuild, planGovernanceRebuild, restoreGovernanceRebuild } from '../src/governance-rebuild.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Rebuild Tester', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

const sflow = (cwd, ...args) => run(process.execPath, [CLI, '--no-model', ...args], cwd);
const git = (cwd, ...args) => run('git', args, cwd).stdout.trim();

/**
 * A governed repository whose packaged convergence step predates its own artifact kind, with one
 * repository-owned workflow that no longer compiles and one Story on its own branch.
 */
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-governance-rebuild-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Rebuild Tester');
  git(root, 'config', 'user.email', 'rebuild@example.test');
  await writeFile(path.join(root, 'README.md'), '# Rebuild fixture\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  sflow(root, 'init');
  const file = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.worldModel.grounding = 'off';
  definition.git.publish = 'off';
  definition.repositoryReadiness = { ...(definition.repositoryReadiness ?? {}), requiredBeforeStory: false };
  definition.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(definition.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // The packaged convergence step as an older release shipped it.
  definition.phases.convergence.artifact.kind = 'verification-report';
  // A repository workflow that ends a Story without verifying or reviewing anything.
  definition.workTypes['team-sketch'] = { label: 'Team sketch', phases: ['intake', 'implementation'] };
  await writeFile(file, YAML.stringify(definition));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Govern the fixture');
  const remote = `${root}-remote.git`;
  t.after(() => rm(remote, { recursive: true, force: true }));
  run('git', ['init', '-q', '--bare', '-b', 'main', remote], root);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  sflow(root, 'start', 'POC-1', '--from-branch', 'main', '--work-type', 'poc-lite', '--title', 'One change', '--description', 'Prove the rebuild sees it.');
  git(root, 'checkout', '-q', 'main');
  return root;
}

test('the rebuild preview replaces framework items, keeps repository ones, recompiles everything and changes nothing', async (t) => {
  const root = await repository(t);
  const head = git(root, 'rev-parse', 'HEAD');
  const refs = git(root, 'for-each-ref', '--format=%(refname) %(objectname)');
  const plan = await planGovernanceRebuild(root);

  assert.match(plan.plan, /^grb-[0-9a-f]{24}$/);
  assert.equal(plan.configuration.mode, 'working-tree');
  assert.equal(plan.configuration.commit, head);
  const workflowFile = plan.replaced.find((entry) => entry.path === 'singularity/workflow.yml');
  assert.ok(workflowFile && workflowFile.before && workflowFile.after && workflowFile.before !== workflowFile.after,
    'the stale packaged convergence step is replaced');
  assert.ok(plan.kept.includes('workflow.approvalSecurity.profile'), 'a repository setting is kept as it is');

  const byId = new Map(plan.workflows.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get('team-sketch'), { id: 'team-sketch', owner: 'repository', status: 'failing' });
  assert.equal(byId.get('spec-driven-standard').status, 'ready');
  assert.ok(plan.workflows.filter((entry) => entry.owner === 'framework').every((entry) => entry.status === 'ready'));
  assert.deepEqual(plan.inactive, ['team-sketch'], 'a failing repository workflow must be named to stay inactive');
  assert.match(plan.workflowFindings.find((entry) => entry.id === 'team-sketch').findings[0].message, /\w/);

  const story = plan.storyDetails.find((entry) => entry.id === 'POC-1');
  assert.ok(story, 'every Story is listed for archiving');
  assert.deepEqual(story.locations.map((location) => location.ref), ['POC-1']);
  assert.equal(story.locations[0].commit, git(root, 'rev-parse', 'POC-1'));
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.ready, true);

  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'status', '--porcelain'), '', 'the preview leaves the checkout untouched');
  assert.equal(git(root, 'for-each-ref', '--format=%(refname) %(objectname)'), refs, 'and every ref');
});

test('the plan digest moves with any Story branch tip, and uncommitted governance blocks the plan', async (t) => {
  const root = await repository(t);
  const first = await planGovernanceRebuild(root);
  assert.equal((await planGovernanceRebuild(root)).plan, first.plan, 'nothing moved, so the plan is the same');

  git(root, 'checkout', '-q', 'POC-1');
  await writeFile(path.join(root, 'notes.md'), 'more work\n');
  git(root, 'add', 'notes.md');
  git(root, 'commit', '-qm', 'Move the Story branch');
  git(root, 'checkout', '-q', 'main');
  assert.notEqual((await planGovernanceRebuild(root)).plan, first.plan, 'a moved branch tip changes the plan');

  await writeFile(path.join(root, 'singularity/workflow.yml'), `${await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8')}# edited\n`);
  const dirty = await planGovernanceRebuild(root);
  assert.equal(dirty.ready, false);
  assert.ok(dirty.blockers.some((entry) => entry.code === 'GOVERNANCE_REBUILD_CONFIGURATION_DIRTY'));
});

test('activation backs up, commits only governance files, archives every Story read-only, and restores', async (t) => {
  const root = await repository(t);
  const head = git(root, 'rev-parse', 'HEAD');
  const plan = await planGovernanceRebuild(root);
  const actor = { name: 'Rebuild Tester', email: 'rebuild@example.test' };
  const refusal = (code) => (error) => error.code === code && error.exitCode === 2;
  await assert.rejects(activateGovernanceRebuild(root, { confirmation: plan.plan, actor }), refusal('GOVERNANCE_REBUILD_INACTIVE_UNCONFIRMED'),
    'a failing repository workflow must be named before it is left unstartable');
  await assert.rejects(activateGovernanceRebuild(root, { confirmation: plan.plan, acceptInactive: ['team-sketch'], strict: true, actor }),
    refusal('GOVERNANCE_REBUILD_STRICT_INACTIVE'));
  await assert.rejects(activateGovernanceRebuild(root, { confirmation: 'grb-000000000000000000000000', acceptInactive: ['team-sketch'], actor }),
    refusal('GOVERNANCE_REBUILD_PLAN_STALE'));
  assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'a refused activation changes nothing');

  const before = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  const result = await activateGovernanceRebuild(root, { confirmation: plan.plan, acceptInactive: ['team-sketch'], actor });
  assert.equal(git(root, 'rev-parse', 'HEAD^'), head, 'one commit on the checked-out branch');
  assert.equal(result.commit, git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(result.invariants, { onlyGovernanceFilesChanged: true, otherRefsUnchanged: true, repositoryDefinitionsKept: true });
  const changed = git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort();
  assert.deepEqual(changed, [...plan.replaced.map((entry) => entry.path), 'singularity/governance/archive.json', result.receiptPath].sort());
  const after = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(after.phases.convergence.artifact.kind, 'convergence-report', 'the framework step is rebuilt');
  assert.deepEqual(after.workTypes['team-sketch'], before.workTypes['team-sketch'], 'the repository workflow keeps its bytes');
  const archive = JSON.parse(await readFile(path.join(root, 'singularity/governance/archive.json'), 'utf8'));
  assert.deepEqual(archive.stories.map((story) => story.id), ['POC-1']);
  assert.match(archive.stories[0].createdAt, /^\d{4}-/);
  const receipt = JSON.parse(await readFile(path.join(root, result.receiptPath), 'utf8'));
  assert.deepEqual(receipt.inactive, ['team-sketch']);
  assert.equal(receipt.archived.length, 1);
  run('git', ['bundle', 'verify', path.join(result.backup.directory, 'refs.bundle')], root);
  assert.equal(git(root, 'status', '--porcelain'), '');

  const again = await planGovernanceRebuild(root);
  assert.deepEqual(again.replaced, [], 'nothing is left to replace');
  assert.deepEqual(again.storyDetails, [], 'and every Story is already archived');

  // A Story cut before the rebuild finds the registry on the branch it was cut from.
  git(root, 'checkout', '-q', 'POC-1');
  const cancelled = run(process.execPath, [CLI, '--no-model', 'cancel', 'POC-1', '--confirm', 'POC-1', '--reason', 'No longer needed after the rebuild.'], root, { allowFailure: true });
  assert.notEqual(cancelled.status, 0);
  assert.match(`${cancelled.stdout}${cancelled.stderr}`, /archived by governance rebuild grb-[0-9a-f]{24}/);
  git(root, 'checkout', '-q', 'main');

  const preview = await restoreGovernanceRebuild(root, { plan: plan.plan });
  assert.equal(preview.restored, null);
  assert.ok(preview.preview.restores.some((entry) => entry.path === 'singularity/governance/archive.json' && entry.action === 'remove'));
  const restored = await restoreGovernanceRebuild(root, { plan: plan.plan, confirm: plan.plan });
  assert.equal(git(root, 'rev-parse', 'HEAD^'), result.commit, 'the restore is a new commit; history is kept');
  assert.equal(restored.restored, git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'diff', '--name-only', head, 'HEAD'), '', 'every file is back as it was before the rebuild');
});

test('the CLI previews the plan, refuses an incomplete confirmation, and activates the exact plan', async (t) => {
  const root = await repository(t);
  const preview = JSON.parse(sflow(root, 'governance', 'rebuild', '--dry-run', '--json').stdout);
  assert.equal(preview.operation.id, 'governance.rebuild.preview');
  assert.match(preview.data.plan.plan, /^grb-/);
  assert.match(preview.next[0].command, new RegExp(`--confirm-plan ${preview.data.plan.plan} --accept-inactive team-sketch$`));
  const text = sflow(root, 'governance', 'rebuild', '--dry-run').stdout;
  assert.match(text, /Framework files replaced \(\d+\):/);
  assert.match(text, /team-sketch \(repository\)/);
  assert.match(text, /Stories to archive \(1\):\n {2}POC-1 \(in_progress\)/);
  const refused = run(process.execPath, [CLI, '--no-model', 'governance', 'rebuild', '--confirm-plan', preview.data.plan.plan], root, { allowFailure: true });
  assert.equal(refused.status, 2);
  assert.match(`${refused.stdout}${refused.stderr}`, /--accept-inactive: team-sketch/);
  const activated = JSON.parse(sflow(root, 'governance', 'rebuild', '--confirm-plan', preview.data.plan.plan, '--accept-inactive', 'team-sketch', '--json').stdout);
  assert.equal(activated.operation.id, 'governance.rebuild');
  assert.equal(activated.data.archived, 1);
});
