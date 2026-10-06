import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { validateStoryStartRequestShape } from '../src/cli-entry.mjs';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function invoke(command, argv, cwd, { allowFailure = false, probe = false } = {}) {
  const result = spawnSync(command, argv, {
    cwd, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Local Story Tester',
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(cwd, '.fixture-active-workspace.json'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(cwd, '.fixture-workspaces.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(cwd, '.fixture-leads.json'),
      SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: path.join(cwd, '.git', 'fixture-config-cache'),
      ...(probe ? { SINGULARITY_FLOW_SUBPROCESS_PROBE: '1' } : {})
    }
  });
  if (!allowFailure) assert.equal(result.status, 0, `${command} ${argv.join(' ')}\n${result.stderr}`);
  return result;
}

async function fixture(t, { initialize = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-fast-local-start-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'checkout');
  await mkdir(root);
  const git = (...argv) => invoke('git', argv, root).stdout.trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Local Story Tester');
  git('config', 'user.email', 'local.story@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Story fixture\n');
  if (initialize) invoke(process.execPath, [bin, 'init'], root);
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const remote = path.join(base, 'remote.git');
  invoke('git', ['init', '--bare', '-q', '-b', 'main', remote], base);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  return { root, git };
}

function assertLocalOnlyRefusal(result, git, expected, before) {
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).error.message, expected);
  assert.doesNotMatch(result.stderr, /\bgit (?:ls-remote|fetch|clone|worktree add)\b/u,
    'deterministic launch inputs must refuse before authority or transport work');
  assert.equal(git('rev-parse', 'HEAD'), before.head);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('worktree', 'list', '--porcelain'), before.worktrees);
}

test('isolated Story ID, source selection, and base-option refusals are local-only', async (t) => {
  const { root, git } = await fixture(t);
  const before = { head: git('rev-parse', 'HEAD'), worktrees: git('worktree', 'list', '--porcelain') };
  for (const [id, extra, expected] of [
    ['bad/id', [], /Work ID|portable/u],
    ['LOCAL-SOURCE', ['--jira', '--story-file', 'not-read.json'], /Choose exactly one/u],
    ['LOCAL-BASE', ['--base', 'main'], /Choose either --from-branch/u],
    ['LOCAL-REF', ['--ref', 'invalid..branch'], /Invalid Git branch/u]
  ]) {
    const result = invoke(process.execPath, [bin, 'start', id, '--json', '--isolated-worktree',
      '--from-branch', 'main', ...extra], root, { allowFailure: true, probe: true });
    assertLocalOnlyRefusal(result, git, expected, before);
  }
});

test('root dispatch applies pure Story shape guards without consulting workspace authority', () => {
  assert.throws(() => validateStoryStartRequestShape('start', ['start', 'bad/id'], {}),
    (error) => error.code === 'WORK_ID_INVALID');
  assert.throws(() => validateStoryStartRequestShape('start', ['start', 'STORY-SOURCE'],
    { jira: true, 'story-file': 'not-read.json' }), /Choose exactly one/u);
  assert.throws(() => validateStoryStartRequestShape('workspace', ['workspace', 'branches'],
    { 'preflight-story': 'CON' }), (error) => error.code === 'WORK_ID_INVALID');
  assert.doesNotThrow(() => validateStoryStartRequestShape('start', ['start', 'OLD.STORY-7'], {}));
  assert.doesNotThrow(() => validateStoryStartRequestShape('start', ['start', 'équipe-7'], {}),
    'portable Unicode IDs remain subject to the selected workflow, not a guessed default policy');
  assert.doesNotThrow(() => validateStoryStartRequestShape('workspace', ['workspace', 'list'], {}));
});

test('isolated ungoverned local name refuses before authority, fetch, or worktree creation', async (t) => {
  const { root, git } = await fixture(t);
  git('branch', 'LOCAL-OCCUPIED');
  await writeFile(path.join(root, 'unrelated-draft.txt'), 'preserve unrelated work\n');
  const before = { head: git('rev-parse', 'HEAD'), worktrees: git('worktree', 'list', '--porcelain') };
  const result = invoke(process.execPath, [bin, 'start', 'LOCAL-OCCUPIED', '--json',
    '--isolated-worktree', '--from-branch', 'main'], root, { allowFailure: true, probe: true });
  assertLocalOnlyRefusal(result, git, /neither governed Story state nor a materialized Story seed/u, before);
  assert.equal(await readFile(path.join(root, 'unrelated-draft.txt'), 'utf8'),
    'preserve unrelated work\n');
});

test('Story intake uses latest approved authority instead of the prior checkout workflow', async (t) => {
  const { root, git } = await fixture(t, { initialize: true });
  git('switch', '-qc', 'sflow/config');
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const approved = YAML.parse(await readFile(workflowPath, 'utf8'));
  approved.workTypes.feature.label = 'Latest approved Story profile';
  await writeFile(workflowPath, YAML.stringify(approved));
  git('add', 'singularity/workflow.yml');
  git('commit', '-qm', 'approved current Story policy');
  git('push', '-q', 'origin', 'sflow/config');
  git('switch', '-q', 'main');
  git('switch', '-qc', 'PRIOR-CHECKOUT');
  const beforeHead = git('rev-parse', 'HEAD');
  const result = invoke(process.execPath, [bin, 'workspace', 'branches', '--intake', '--json'], root);
  const response = JSON.parse(result.stdout);
  assert.equal(response.intake.storyWorkflows.find((row) => row.id === 'feature').label,
    'Latest approved Story profile');
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(git('branch', '--show-current'), 'PRIOR-CHECKOUT');
  assert.equal(YAML.parse(await readFile(workflowPath, 'utf8')).workTypes.feature.label, 'Feature');
});

test('isolated Story start resolves sflow/config when the launch workflow is missing', async (t) => {
  const { root, git } = await fixture(t, { initialize: true });
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  git('switch', '-qc', 'sflow/config');
  git('push', '-q', 'origin', 'sflow/config');
  git('switch', '-q', 'main');
  git('rm', '-q', 'singularity/workflow.yml');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: {
    test: 'node -e "require(\'fs\').writeFileSync(\'unexpected-test.txt\',\'ran\')"'
  } }));
  git('add', '.'); git('commit', '-qm', 'Application base keeps configuration on authority branch');
  git('push', '-q', 'origin', 'main');
  const beforeHead = git('rev-parse', 'HEAD');
  const id = 'AUTHORITY-MISSING';
  const preview = JSON.parse(invoke(process.execPath, [bin, 'workspace', 'branches', '--json', '--intake',
    '--preflight-story', id, '--selected-base-only', '--from-branch', 'main', '--work-type', 'feature',
    '--mint-intake-receipt'], root).stdout);
  assert.equal(preview.preflight.passed, true, JSON.stringify(preview.preflight));
  const result = invoke(process.execPath, [bin, 'start', id, '--json', '--isolated-worktree',
    '--from-branch', 'main', '--work-type', 'feature', '--title', 'Start from approved authority',
    '--intake-receipt', preview.preflight.intakeReceipt.id], root, { allowFailure: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const started = JSON.parse(result.stdout).data;
  assert.equal(started.readiness.ready, true);
  assert.equal(started.readiness.authority.branch, 'sflow/config');
  assert.equal(YAML.parse(await readFile(path.join(started.repositoryPath, 'singularity/workflow.yml'), 'utf8'))
    .workTypes.feature.label, 'Feature');
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '',
    'starting from approved authority must preserve the launch checkout source');
  await assert.rejects(readFile(workflowPath), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(started.repositoryPath, 'unexpected-test.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'unexpected-test.txt')), { code: 'ENOENT' });
});

test('isolated Story start without any workflow authority refuses cleanly instead of crashing', async (t) => {
  const { root, git } = await fixture(t);
  const before = { head: git('rev-parse', 'HEAD'), worktrees: git('worktree', 'list', '--porcelain') };
  const result = invoke(process.execPath, [bin, 'start', 'NO-AUTHORITY', '--json', '--isolated-worktree',
    '--from-branch', 'main', '--work-type', 'feature', '--title', 'Unavailable configuration',
    '--description', 'Missing authority must not create a Story.'], root, { allowFailure: true });
  assert.notEqual(result.status, 0);
  const refusal = JSON.parse(result.stdout);
  assert.equal(refusal.error.code, 'STORY_CONFIGURATION_AUTHORITY_MISSING');
  assert.match(refusal.error.message, /Missing singularity\/workflow\.yml.*approved sflow\/config/iu);
  assert.doesNotMatch(refusal.error.message, /Cannot read properties/iu);
  assert.deepEqual(refusal.remediationPlan.steps.slice(0, 2).map(step => step.command), [
    'singularity-flow workspace doctor --network --json',
    'singularity-flow workspace reinitialize --dry-run --json'
  ]);
  assert.equal(refusal.remediationPlan.retry.automatic, false);
  assert.match(refusal.remediationPlan.steps[2].label, /refresh intake and retry the same Story ID/u);
  assert.equal(git('rev-parse', 'HEAD'), before.head);
  assert.equal(git('worktree', 'list', '--porcelain'), before.worktrees);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('branch', '--list', 'NO-AUTHORITY'), '');
});

test('isolated Story start still enforces approved non-test prerequisites without a launch workflow', async (t) => {
  const { root, git } = await fixture(t, { initialize: true });
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  git('switch', '-qc', 'sflow/config');
  const approved = YAML.parse(await readFile(workflowPath, 'utf8'));
  approved.repositoryReadiness.requiredBeforeStory = true;
  approved.repositoryReadiness.build = 'required';
  await writeFile(workflowPath, YAML.stringify(approved));
  git('add', 'singularity/workflow.yml'); git('commit', '-qm', 'Required approved build prerequisite');
  git('push', '-q', 'origin', 'sflow/config');
  const authorityHead = git('rev-parse', 'sflow/config');
  git('switch', '-q', 'main');
  git('rm', '-q', 'singularity/workflow.yml');
  git('commit', '-qm', 'No branch-local workflow'); git('push', '-q', 'origin', 'main');
  const before = { head: git('rev-parse', 'HEAD'), worktrees: git('worktree', 'list', '--porcelain') };
  const result = invoke(process.execPath, [bin, 'start', 'AUTHORITY-REQUIRED', '--json', '--isolated-worktree',
    '--from-branch', 'main', '--work-type', 'feature', '--title', 'Required approved prerequisite',
    '--description', 'Start must enforce approved non-test prerequisites.',
    '--readiness-baseline', 'defer'], root, { allowFailure: true, probe: true });
  assert.notEqual(result.status, 0);
  const refusal = JSON.parse(result.stdout);
  assert.equal(refusal.error.code, 'STORY_REPOSITORY_READINESS_REQUIRED', JSON.stringify(refusal));
  assert.doesNotMatch(refusal.error.message, /Cannot read properties/iu);
  assert.doesNotMatch(result.stderr, /\bgit worktree add\b/u,
    'approved configuration is recovered before launch admission; no disposable worktree is needed to discover this blocker');
  assert.equal(git('rev-parse', 'HEAD'), before.head);
  assert.equal(git('worktree', 'list', '--porcelain'), before.worktrees);
  assert.equal(git('rev-parse', 'origin/sflow/config'), authorityHead);
  assert.equal(git('branch', '--show-current'), 'main');
});

test('isolated start self-heals missing local workflow and tracking refs from remote approved authority', async (t) => {
  const { root, git } = await fixture(t, { initialize: true });
  git('switch', '-qc', 'sflow/config');
  const file = path.join(root, 'singularity/workflow.yml');
  const approved = YAML.parse(await readFile(file, 'utf8'));
  approved.workTypes.feature.label = 'Recovered approved workflow';
  approved.approvalSecurity.autoEnrollNewIdentities = false;
  for (const group of Object.values(approved.approvalAuthorities)) {
    group.members = [{ name: 'Local Story Tester', email: 'local.story.tester@example.com' }];
  }
  await writeFile(file, YAML.stringify(approved));
  git('add', '.'); git('commit', '-qm', 'Approved recovery fixture');
  git('push', '-q', 'origin', 'sflow/config');
  const approvedCommit = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  git('rm', '-q', 'singularity/workflow.yml');
  git('commit', '-qm', 'Application branch has no local configuration');
  git('push', '-q', 'origin', 'main');
  git('update-ref', '-d', 'refs/heads/sflow/config');
  git('update-ref', '-d', 'refs/remotes/origin/sflow/config');
  const beforeHead = git('rev-parse', 'HEAD');
  const result = invoke(process.execPath, [bin, 'start', 'SELF-HEAL', '--json', '--isolated-worktree',
    '--from-branch', 'main', '--work-type', 'feature', '--title', 'Recovered configuration',
    '--description', 'Restore only approved configuration into the new managed Story.'], root, { allowFailure: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const started = JSON.parse(result.stdout).data;
  assert.equal(started.readiness.ready, true);
  assert.equal(started.readiness.authority.commit, approvedCommit);
  assert.equal(YAML.parse(await readFile(path.join(started.repositoryPath, 'singularity/workflow.yml'), 'utf8'))
    .workTypes.feature.label, 'Recovered approved workflow');
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(git('branch', '--show-current'), 'main');
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const remote = git('remote', 'get-url', 'origin');
  assert.equal(invoke('git', ['--git-dir', remote, 'rev-parse', 'sflow/config'], root).stdout.trim(), approvedCommit,
    'automatic recovery must not recreate or publish shared configuration');
});

test('self-healing never downgrades invalid approved authority to valid checkout policy', async (t) => {
  const { root, git } = await fixture(t, { initialize: true });
  git('switch', '-qc', 'sflow/config');
  const file = path.join(root, 'singularity/workflow.yml');
  const approved = YAML.parse(await readFile(file, 'utf8'));
  approved.repositoryReadiness.unsupportedFuturePolicy = true;
  await writeFile(file, YAML.stringify(approved));
  git('add', '.'); git('commit', '-qm', 'Unsupported approved policy');
  git('push', '-q', 'origin', 'sflow/config');
  const approvedCommit = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  const beforeHead = git('rev-parse', 'HEAD');
  const beforeTrees = git('worktree', 'list', '--porcelain');
  const result = invoke(process.execPath, [bin, 'start', 'NO-DOWNGRADE', '--json', '--isolated-worktree',
    '--from-branch', 'main', '--work-type', 'feature', '--title', 'Do not bypass approved policy'], root,
  { allowFailure: true, probe: true });
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).error.message, /unsupportedFuturePolicy/u);
  assert.doesNotMatch(result.stderr, /\bgit worktree add\b/u);
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(git('worktree', 'list', '--porcelain'), beforeTrees);
  assert.equal(git('branch', '--list', 'NO-DOWNGRADE'), '');
  assert.equal(git('rev-parse', 'sflow/config'), approvedCommit);
});

test('Story preflight defers a portable Unicode ID to the exact configured policy', async (t) => {
  const { root, git } = await fixture(t, { initialize: true });
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.idPattern = '^[A-Za-zé0-9][A-Za-zé0-9._-]{0,63}$';
  definition.git.publish = 'off';
  await writeFile(workflowPath, YAML.stringify(definition));
  git('add', 'singularity/workflow.yml');
  git('commit', '-qm', 'custom portable identifier policy');
  git('push', '-q', 'origin', 'main');
  const response = JSON.parse(invoke(process.execPath, [bin, 'workspace', 'branches', '--json',
    '--preflight-story', 'équipe-7', '--selected-base-only',
    '--from-branch', 'main', '--work-type', 'feature'
  ], root).stdout);
  assert.equal(response.preflight.storyBranch, 'équipe-7');
  assert.equal(response.preflight.passed, true, JSON.stringify(response.preflight));
  assert.equal(git('branch', '--show-current'), 'main');
});
