/** Archiving and deleting workflows [docs/SPEC-WORKFLOW-RETIREMENT-v1.md]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import {
  assertWorkflowNotArchived, firstLiveStoryWorkflow, parseWorkflowArchive, workflowArchived
} from '../src/workflow-archive.mjs';
import { assertDeleteStoriesClear, workflowDeleteStories } from '../src/workflow-retirement.mjs';
import { selectWorkType } from '../src/session.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function flow(root, ...args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Retirement Test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git', 'test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git', 'test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.git', 'test-leads.json'),
      SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(root, '.git', 'test-transfer-outbox'),
      SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(root, '.git', 'test-workflow-builds') }
  });
}

function json(result) {
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

/** The refusal a --json command prints: `{ error: { code, message, details } }`. */
function refusal(result) {
  assert.notEqual(result.status, 0, result.stdout);
  return JSON.parse(result.stdout || result.stderr).error;
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-retirement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Workflow Retirement Test');
  git(root, 'config', 'user.email', 'workflow-retirement@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initialize workflow configuration');
  return root;
}

/** An independent duplicate of `feature`: its own renamed steps, agents, skills and templates. */
function duplicate(root, target = 'mine') {
  const preview = json(flow(root, 'workflow', 'duplicate', 'feature', target, '--label', 'Mine', '--dry-run', '--json'));
  json(flow(root, 'workflow', 'duplicate', 'feature', target, '--label', 'Mine', '--resolve-all', 'suggested',
    '--confirm', preview.planSha256, '--json'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', `duplicate ${target}`);
}

const yaml = async (root, relative) => YAML.parse(await readFile(path.join(root, relative), 'utf8'));

test('deleting an independent duplicate removes exactly what it added and keeps a backup', async (t) => {
  const root = await repository(t);
  const before = git(root, 'rev-parse', 'HEAD');
  duplicate(root);
  const plan = json(flow(root, 'workflow', 'delete', 'mine', '--dry-run', '--json'));
  assert.equal(plan.resultType, 'workflow-delete-plan');
  assert.match(plan.planSha256, /^sha256:[a-f0-9]{64}$/u);
  const kinds = new Set(plan.removed.map((entry) => entry.kind));
  for (const kind of ['story.workflow', 'story.phases', 'agent', 'template-file']) assert.ok(kinds.has(kind), kind);
  // Approval groups are governance identities shared with every workflow: always kept, with their users.
  assert.ok(plan.kept.every((entry) => entry.kind === 'story.approvalAuthorities' && entry.usedBy.includes('story:feature')));
  // Nothing changed by the preview.
  assert.equal(git(root, 'status', '--porcelain=v1'), '');

  const deleted = json(flow(root, 'workflow', 'delete', 'mine', '--confirm', plan.planSha256, '--json'));
  assert.equal(deleted.status, 'deleted');
  assert.ok((await stat(deleted.backup.path)).isFile(), 'the backup bundle is written before anything is removed');
  // Exactly the state before the duplicate: every dependency it added is gone, nothing else changed.
  assert.equal(git(root, 'diff', '--stat', before, '--', '.'), '');
  assert.equal(json(flow(root, 'workflow', 'validate', '--json')).valid, true);
  // The backup restores it.
  const restore = json(flow(root, 'workflow', 'import', deleted.backup.path, '--dry-run', '--json'));
  assert.equal(restore.status, 'ready');
});

test('a linked copy shares every dependency, so its delete removes only the workflow', async (t) => {
  const root = await repository(t);
  const preview = json(flow(root, 'workflow', 'copy', 'feature', 'feature-copy', '--label', 'Feature copy', '--dry-run', '--json'));
  json(flow(root, 'workflow', 'copy', 'feature', 'feature-copy', '--label', 'Feature copy', '--confirm', preview.planSha256, '--json'));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'copy');
  const plan = json(flow(root, 'workflow', 'delete', 'feature-copy', '--dry-run', '--json'));
  assert.deepEqual(plan.removed, [{ kind: 'story.workflow', id: 'feature-copy' }]);
  assert.ok(plan.kept.some((entry) => entry.kind === 'story.phases' && entry.usedBy.includes('story:feature')));
  assert.ok(plan.kept.some((entry) => entry.kind === 'agent' && entry.usedBy.includes('story:feature')));
});

test('an archived workflow still counts as a user, so delete keeps what it needs', async (t) => {
  const root = await repository(t);
  duplicate(root);
  const copy = json(flow(root, 'workflow', 'copy', 'mine', 'mine-copy', '--label', 'Mine copy', '--dry-run', '--json'));
  json(flow(root, 'workflow', 'copy', 'mine', 'mine-copy', '--label', 'Mine copy', '--confirm', copy.planSha256, '--json'));
  json(flow(root, 'workflow', 'archive', 'mine-copy', '--reason', 'Replaced', '--json'));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'copy and archive');
  const plan = json(flow(root, 'workflow', 'delete', 'mine', '--dry-run', '--json'));
  assert.deepEqual(plan.removed, [{ kind: 'story.workflow', id: 'mine' }]);
  assert.ok(plan.kept.some((entry) => entry.kind === 'agent' && entry.usedBy.includes('story:mine-copy')));
});

test('seeded workflows can be archived but not deleted; the default and the last workflow need care', async (t) => {
  const root = await repository(t);
  const seeded = refusal(flow(root, 'workflow', 'delete', 'feature', '--dry-run', '--json'));
  assert.equal(seeded.code, 'SEEDED_WORKFLOW_READ_ONLY');
  assert.match(seeded.details.nextAction, /workflow archive story:feature --propose/u);

  // `feature` is the default workflow when none is configured.
  const needsDefault = refusal(flow(root, 'workflow', 'archive', 'feature', '--json'));
  assert.equal(needsDefault.code, 'WORKFLOW_DEFAULT_REPLACEMENT_REQUIRED');
  assert.equal(refusal(flow(root, 'workflow', 'archive', 'feature', '--new-default', 'feature', '--json')).code,
    'WORKFLOW_DEFAULT_REPLACEMENT_INVALID');
  const archived = json(flow(root, 'workflow', 'archive', 'feature', '--new-default', 'bugfix', '--reason', 'Not used here', '--json'));
  assert.equal(archived.status, 'archived');
  assert.equal((await yaml(root, 'singularity/workflow.yml')).delivery.defaultWorkflowProfile, 'bugfix');
  assert.deepEqual((await yaml(root, 'singularity/workflow-archive.yml')).archived.story.feature, { reason: 'Not used here' });
  assert.equal(json(flow(root, 'workflow', 'archive', 'feature', '--json')).status, 'already-archived');
  const listed = json(flow(root, 'workflow', 'list', '--json'));
  const rows = Array.isArray(listed) ? listed : listed.workflows ?? [];
  if (rows.length) assert.equal(rows.find((row) => row.id === 'feature')?.archived, true);
  assert.equal(json(flow(root, 'workflow', 'restore', 'feature', '--json')).status, 'restored');
  assert.deepEqual((await yaml(root, 'singularity/workflow-archive.yml')).archived ?? {}, {});
});

test('delete cleans references outside workflows, trims a shared agent, and the result validates', async (t) => {
  const root = await repository(t);
  duplicate(root);
  const story = await yaml(root, 'singularity/workflow.yml');
  const own = story.workTypes.mine.phases.find((id) => !story.workTypes.feature.phases.includes(id));
  const shared = story.workTypes.feature.phases[0];
  assert.ok(own && shared);
  story.documents = { ...(story.documents ?? {}), allowedPhases: [...new Set([...(story.documents?.allowedPhases ?? []), own, shared])] };
  story.contextPolicy = { ...(story.contextPolicy ?? {}), phaseOverrides: { ...(story.contextPolicy?.phaseOverrides ?? {}), [own]: 'new' } };
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(story));
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/shared-helper.agent.md'), [
    '---', 'name: shared-helper', 'description: Helps two workflows.', 'metadata:',
    `  sflow-label: "Shared helper"`, `  sflow-phases: "${own}, ${shared}"`, '---', '', '# Shared helper', ''].join('\n'));
  const impact = await yaml(root, 'singularity/impact.yml').catch(() => null);
  if (impact?.studies?.length) {
    impact.studies[0].eligibility.workTypes.push('mine');
    await writeFile(path.join(root, 'singularity/impact.yml'), YAML.stringify(impact));
  }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'references');

  const plan = json(flow(root, 'workflow', 'delete', 'mine', '--dry-run', '--json'));
  assert.deepEqual(plan.trimmed.find((entry) => entry.id === 'shared-helper')?.steps, [own]);
  const kinds = plan.cleanups.map((entry) => entry.kind);
  for (const kind of ['document-allowed-steps', 'context-step-overrides']) assert.ok(kinds.includes(kind), kind);
  if (impact?.studies?.length) assert.ok(kinds.includes('impact-eligibility'));
  json(flow(root, 'workflow', 'delete', 'mine', '--confirm', plan.planSha256, '--json'));

  const after = await yaml(root, 'singularity/workflow.yml');
  assert.ok(!after.documents.allowedPhases.includes(own) && after.documents.allowedPhases.includes(shared));
  assert.equal(Object.hasOwn(after.contextPolicy.phaseOverrides ?? {}, own), false);
  const agent = await readFile(path.join(root, '.github/agents/shared-helper.agent.md'), 'utf8');
  assert.match(agent, new RegExp(`sflow-phases: "${shared}"`, 'u'), 'the shared agent loses only the removed step');
  if (impact?.studies?.length) assert.ok(!(await yaml(root, 'singularity/impact.yml')).studies[0].eligibility.workTypes.includes('mine'));
  assert.equal(json(flow(root, 'workflow', 'validate', '--json')).valid, true);
});

test('a confirmation binds the exact plan; a changed configuration needs a new preview', async (t) => {
  const root = await repository(t);
  duplicate(root);
  const plan = json(flow(root, 'workflow', 'delete', 'mine', '--dry-run', '--json'));
  const story = await yaml(root, 'singularity/workflow.yml');
  story.workTypes.feature.phases = story.workTypes.feature.phases.slice();
  story.workTypes.bugfix.label = 'Bugfix, changed after the preview';
  story.workTypes.bugfix.phases = [...new Set([...story.workTypes.bugfix.phases, ...story.workTypes.mine.phases.slice(0, 1)])];
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(story));
  const stale = refusal(flow(root, 'workflow', 'delete', 'mine', '--confirm', plan.planSha256, '--json'));
  assert.equal(stale.code, 'WORKFLOW_DELETE_PLAN_STALE');
  assert.equal(refusal(flow(root, 'workflow', 'delete', 'mine', '--json')).code, 'WORKFLOW_DELETE_CONFIRMATION_REQUIRED');
});

test('the archive file is exact, and new Stories never choose an archived workflow', async () => {
  const archive = parseWorkflowArchive('version: 1\narchived:\n  story:\n    old-flow: { reason: Replaced }\n');
  assert.equal(workflowArchived(archive, 'story', 'old-flow'), true);
  assert.equal(workflowArchived(archive, 'initiative', 'old-flow'), false);
  for (const text of ['version: 2\n', 'version: 1\nextra: true\n', 'version: 1\narchived:\n  story:\n    Old: {}\n',
    'version: 1\narchived:\n  story:\n    x: { note: y }\n']) {
    assert.throws(() => parseWorkflowArchive(text), { code: 'WORKFLOW_ARCHIVE_INVALID' }, text);
  }
  assert.throws(() => assertWorkflowNotArchived(archive, 'old-flow'), (error) => error.code === 'WORKFLOW_ARCHIVED'
    && /workflow restore old-flow --propose/u.test(error.details.nextAction.command));
  assert.doesNotThrow(() => assertWorkflowNotArchived(archive, 'feature'));
  assert.equal(firstLiveStoryWorkflow({ 'old-flow': {}, feature: {} }, archive), 'feature');
  const offered = [];
  await selectWorkType({ workTypes: { 'old-flow': {}, feature: {} } }, {
    exclude: ['old-flow'], selection: 'feature', choose: undefined
  }).then((choice) => offered.push(choice)).catch(() => offered.push(null));
  assert.notEqual(offered[0], 'old-flow');
});

test('an unfinished Story with no pinned workflow copy blocks the delete; pinned ones keep running', async (t) => {
  const root = await repository(t);
  const item = (id, snapshot) => {
    const directory = path.join(root, 'singularity/work-items', id);
    return mkdir(directory, { recursive: true }).then(() => writeFile(path.join(directory, 'workflow.json'),
      JSON.stringify({ workItem: { id }, ...(snapshot ? { workflowSnapshot: { revision: 1 } } : {}) })));
  };
  await item('PIN-1', true); await item('OLD-1', false);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'stories');
  const commit = git(root, 'rev-parse', 'HEAD');
  const pointers = async () => ({ items: [
    { id: 'PIN-1', workType: 'mine', status: 'in_progress', branch: 'PIN-1', commitOid: commit },
    { id: 'OLD-1', workType: 'mine', status: 'in_progress', branch: 'OLD-1', commitOid: commit },
    { id: 'DONE-1', workType: 'mine', status: 'closed', branch: 'DONE-1', commitOid: commit },
    { id: 'MISSING-1', workType: 'mine', status: 'in_progress', branch: 'MISSING-1', commitOid: commit },
    { id: 'OTHER-1', workType: 'feature', status: 'in_progress', branch: 'OTHER-1', commitOid: commit }
  ] });
  const stories = await workflowDeleteStories(root, {}, 'mine', { ledgerStoryPointers: pointers });
  assert.deepEqual(stories.pinned.map((story) => story.id), ['PIN-1']);
  assert.deepEqual(stories.unpinned.map((story) => story.id), ['OLD-1']);
  assert.deepEqual(stories.unchecked.map((story) => story.id), ['MISSING-1']);
  assert.throws(() => assertDeleteStoriesClear(stories, 'mine'), (error) => error.code === 'WORKFLOW_DELETE_STORIES_UNPINNED'
    && /OLD-1/u.test(error.message) && /workflow archive mine/u.test(error.details.nextAction.command));
  assert.doesNotThrow(() => assertDeleteStoriesClear({ ...stories, unpinned: [] }, 'mine'));
});

test('a confirmed delete with --propose is a review branch; approved configuration is unchanged until activation', async (t) => {
  const root = await repository(t);
  duplicate(root);
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-retirement-remote-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'authority.git');
  git(base, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(root, 'push', '-q', remote, 'HEAD:refs/heads/main', 'HEAD:refs/heads/sflow/config');
  git(root, 'remote', 'add', 'origin', remote);
  const approved = git(base, '--git-dir', remote, 'rev-parse', 'sflow/config');

  const plan = json(flow(root, 'workflow', 'delete', 'mine', '--dry-run', '--json'));
  assert.ok(plan.destinationAuthority, 'the plan binds the approved configuration it read');
  const proposed = json(flow(root, 'workflow', 'delete', 'mine', '--confirm', plan.planSha256, '--propose', '--json'));
  assert.equal(proposed.reviewRequired, true);
  assert.ok((await stat(proposed.backup.path)).isFile());
  assert.equal(git(base, '--git-dir', remote, 'rev-parse', 'sflow/config'), approved, 'approved configuration is unchanged');
  const proposedConfig = YAML.parse(git(base, '--git-dir', remote, 'show', `${proposed.branch}:singularity/workflow.yml`));
  assert.equal(Object.hasOwn(proposedConfig.workTypes, 'mine'), false);
  const removedAgent = plan.removed.find((entry) => entry.kind === 'agent');
  const listed = git(base, '--git-dir', remote, 'ls-tree', '-r', '--name-only', proposed.branch);
  assert.ok(!listed.split('\n').includes(removedAgent.path), 'the proposal removes the workflow\'s own files');
  assert.equal(git(root, 'status', '--porcelain=v1'), '', 'the application checkout is not changed');
  // A retargeted remote invalidates the confirmation: the plan bound the destination it read.
  const other = path.join(base, 'other.git');
  git(base, 'init', '-q', '--bare', '--initial-branch=main', other);
  git(root, 'push', '-q', other, 'HEAD:refs/heads/main', 'HEAD:refs/heads/sflow/config');
  git(root, 'remote', 'set-url', 'origin', other);
  assert.equal(refusal(flow(root, 'workflow', 'delete', 'mine', '--confirm', plan.planSha256, '--propose', '--json')).code,
    'WORKFLOW_DELETE_PLAN_STALE');
});
