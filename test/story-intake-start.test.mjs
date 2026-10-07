/**
 * Story start with an intake receipt: verify what the readiness preview saw, in one wave. `[perf]`
 *
 * The receipt authorizes nothing. These tests hold the two sides of that: with a receipt a start
 * makes one concurrent observation and dry run and then its push, and whatever the wave cannot
 * confirm (a moved base or configuration, an edited, foreign or reused receipt, another request, the
 * kill switch) runs the ordinary start, which still succeeds. A Story started either way is the same.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { onboardRepository } from '../src/onboard.mjs';
import { storyWorktreePath } from '../src/story-worktree.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');
const posix = { skip: process.platform === 'win32' ? 'Story intake receipts are POSIX-only.' : false };
const EMAIL = 'story.publisher@example.com';

test('old required-baseline policies start with pending tests and never install or execute them', posix, async t => {
  const { root } = await repository(t);
  git(root, 'fetch', '-q', 'origin');
  git(root, 'merge', '--ff-only', 'origin/sflow/config');
  const file = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.repositoryReadiness.requiredBeforeStory = true;
  definition.repositoryReadiness.baselinePolicy = 'required';
  definition.initialization = { proof: { preStory: { requiredBeforeStory: true,
    structuredTests: 'required', dependencyHydration: 'when-detected' } } };
  await writeFile(file, YAML.stringify(definition));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'intake-baseline', private: true,
    scripts: { test: 'node --test', postinstall: 'node -e "require(\'fs\').writeFileSync(\'unexpected-install.txt\',\'ran\')"' } }));
  await writeFile(path.join(root, 'failing.test.mjs'), 'import test from "node:test"; test("pre-existing failure", () => { throw Error("known"); });\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Baseline choice policy and existing test');
  git(root, 'push', '-q', 'origin', 'main', 'main:refs/heads/sflow/config');
  const admitted = data(start(root, 'BASELINE-REQUIRED'));
  assert.equal(admitted.readiness.ready, true);
  assert.ok(admitted.readiness.warnings.some(row => row.code === 'STORY_TEST_CONFIGURATION_PENDING'));
  const originalPolicy = JSON.parse(await readFile(path.join(admitted.repositoryPath,
    'singularity/work-items/BASELINE-REQUIRED/context/test-policy.json'), 'utf8'));
  assert.equal(originalPolicy.capability.status, 'not-checked');
  assert.deepEqual(originalPolicy.capability.modules, []);
  assert.equal(originalPolicy.baselineObservation, 'pending-not-verified');
  for (const directory of [root, admitted.repositoryPath]) {
    assert.ok(!(await readdir(directory)).includes('unexpected-install.txt'));
    assert.ok(!(await readdir(directory)).includes('node_modules'));
  }
  definition.repositoryReadiness.baselinePolicy = 'choice';
  await writeFile(file, YAML.stringify(definition));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Allow deferred test observation');
  git(root, 'push', '-q', 'origin', 'main', 'main:refs/heads/sflow/config');
  const started = data(start(root, 'BASELINE-DEFERRED', ['--readiness-baseline', 'defer', '--test-execution-mode', 'all-configured']));
  const item = path.join(started.repositoryPath, 'singularity/work-items/BASELINE-DEFERRED');
  const readiness = JSON.parse(await readFile(path.join(item, 'context/repository-test-readiness.json'), 'utf8'));
  const testPolicy = JSON.parse(await readFile(path.join(item, 'context/test-policy.json'), 'utf8'));
  assert.equal(readiness.baselineChoice, 'defer');
  assert.equal(readiness.baselineObservation, 'deferred-not-verified');
  assert.ok(readiness.repositories.every(entry => entry.status !== 'pass'));
  assert.equal(testPolicy.executionScope, 'full');
  assert.equal(testPolicy.baselineFailures, 'repair-in-story');
  assert.equal(git(root, 'branch', '--show-current'), 'main');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'worktree', 'list', '--porcelain').includes('BASELINE-REQUIRED'), true);
});

test('nested Angular with no root test detection starts without a receipt or implicit test execution', posix, async t => {
  const { root } = await repository(t);
  git(root, 'fetch', '-q', 'origin');
  git(root, 'merge', '--ff-only', 'origin/sflow/config');
  const file = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.repositoryReadiness.requiredBeforeStory = true;
  delete definition.repositoryReadiness.baselinePolicy;
  await writeFile(file, YAML.stringify(definition));
  await mkdir(path.join(root, 'apps/client'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }));
  await writeFile(path.join(root, 'apps/client/package.json'), JSON.stringify({ private: true,
    scripts: { test: 'ng test' }, devDependencies: { karma: '^6.0.0' } }));
  await writeFile(path.join(root, 'apps/client/angular.json'), '{"projects":{}}\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Nested Angular without an intake test runner');
  git(root, 'push', '-q', 'origin', 'main', 'main:refs/heads/sflow/config');
  const receipt = preflight(root, 'ANGULAR-LATER', ['--gate-mode', 'soft']);
  const started = data(start(root, 'ANGULAR-LATER', ['--intake-receipt', receipt.id, '--gate-mode', 'soft']));
  const item = path.join(started.repositoryPath, 'singularity/work-items/ANGULAR-LATER');
  const readiness = JSON.parse(await readFile(path.join(item, 'context/repository-test-readiness.json'), 'utf8'));
  const policy = JSON.parse(await readFile(path.join(item, 'context/test-policy.json'), 'utf8'));
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflow.resolution.qualityGateMode, 'soft', 'the selected pilot mode is sealed at creation');
  assert.equal(readiness.baselineObservation, 'pending-not-verified');
  assert.equal(policy.baselineObservation, 'pending-not-verified');
  assert.ok(readiness.repositories.every(row => row.status !== 'pass' && !row.testResults.length));
  assert.equal(git(root, 'status', '--porcelain'), '', 'metadata-only detection leaves the checkout untouched');
});

function run(command, args, cwd, { allowFailure = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Story Publisher', ...env }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}
const git = (root, ...args) => run('git', args, root).stdout.trim();
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);

async function repository(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-intake-start-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'checkout');
  await mkdir(root);
  git(base, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Story Publisher');
  git(root, 'config', 'user.email', EMAIL);
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'README.md'), '# Intake receipts\n');
  flow(root, ['init']);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.worldModel.grounding = 'off';
  // Intake receipt tests isolate fetch/preview behavior; pre-Story execution has its own suite.
  workflow.repositoryReadiness.requiredBeforeStory = false;
  for (const authority of Object.values(workflow.approvalAuthorities ?? {})) {
    authority.members = [{ name: 'Story Publisher', email: EMAIL }];
  }
  await writeFile(workflowFile, YAML.stringify(workflow));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Initialize governed repository');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'push', '-q', 'origin', 'main:refs/heads/sflow/config');
  // The first Story a machine starts also enrolls its identity; keep that out of every comparison.
  start(root, 'WARM-UP');
  return { base, root, remote };
}

function preflight(root, id, extra = []) {
  const listed = JSON.parse(flow(root, [
    'workspace', 'branches', '--json', '--intake', '--preflight-story', id, '--from-branch', 'main',
    '--work-type', 'feature', '--selected-base-only', '--mint-intake-receipt', ...extra
  ]).stdout);
  assert.equal(listed.preflight.passed, true, JSON.stringify(listed.preflight.readiness));
  return listed.preflight.intakeReceipt;
}

function start(root, id, extra = [], options = {}) {
  return flow(root, [
    'start', id, '--json', '--isolated-worktree', '--from-branch', 'main', '--work-type', 'feature',
    '--title', `Receipt ${id}`, '--description', 'Start from a verified intake preview.', '--timings', ...extra
  ], options);
}

const data = (result) => {
  const parsed = JSON.parse(result.stdout);
  return parsed.data ?? parsed;
};
const counter = (stderr, name) =>
  Number(new RegExp(`(?:^|\\s)${name.replaceAll('.', '\\.')}=(\\d+)(?:\\s|$)`).exec(stderr)?.[1] ?? 0);

test('a passing preview\'s receipt lets start verify every input in one wave, once', posix, async (t) => {
  const { root } = await repository(t);
  const receipt = preflight(root, 'STORY-FAST');
  assert.equal(receipt.issued, true);
  assert.match(receipt.id, /^sir_[0-9a-f]{32}$/);

  const started = start(root, 'STORY-FAST', ['--intake-receipt', receipt.id]);
  const result = data(started);
  assert.equal(result.intakeReceipt.status, 'verified', JSON.stringify(result.intakeReceipt));
  assert.deepEqual([...result.intakeReceipt.reused].sort(),
    ['authority-check', 'base-probe', 'destination', 'dry-run', 'launch-fetch']);
  assert.equal(counter(started.stderr, 'git.remote.command.fetch'), 0, 'the base the preview fetched is used');
  assert.equal(counter(started.stderr, 'git.remote.command.ls-remote'), 1,
    'configuration, base, destination and state are observed together once');
  assert.equal(counter(started.stderr, 'git.remote.command.push'), 2, 'one fresh dry run, then the publication');
  assert.match(git(root, 'ls-remote', 'origin', 'refs/heads/STORY-FAST'), /refs\/heads\/STORY-FAST$/);

  const reused = data(start(root, 'STORY-AGAIN', ['--intake-receipt', receipt.id]));
  assert.deepEqual([reused.intakeReceipt.status, reused.intakeReceipt.reason], ['rejected', 'missing'],
    'a receipt serves one start only');
});

test('pre-worktree refusals release the exact intake receipt for a corrected retry', posix, async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, '.git', 'singularity-flow', 'intake-receipts');
  for (const [id, extra, code] of [
    ['STORY-RETRY-SELECTION', ['--selection-receipt', 'not-a-receipt'], 'SINGULARITY_FLOW_ERROR'],
    ['STORY-RETRY-BASELINE', ['--test-baseline-record', `sha256:${'0'.repeat(64)}`], 'TRP_INTAKE_BASELINE_INVALID'],
    ['STORY-RETRY-WORKTREE', [], 'STORY_WORKTREE_RECOVERY_REQUIRED']
  ]) {
    const receipt = preflight(root, id);
    assert.equal(receipt.issued, true);
    const file = path.join(directory, `${receipt.id}.json`);
    const original = await readFile(file, 'utf8');
    const before = {
      head: git(root, 'rev-parse', 'HEAD'),
      worktrees: git(root, 'worktree', 'list', '--porcelain'),
      status: git(root, 'status', '--porcelain')
    };
    const target = id === 'STORY-RETRY-WORKTREE' ? await storyWorktreePath(root, id) : null;
    if (target) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'Preserve this occupied unregistered path.\n');
    }
    const failed = start(root, id, [...extra, '--intake-receipt', receipt.id], { allowFailure: true });
    assert.notEqual(failed.status, 0);
    assert.equal(JSON.parse(failed.stdout).error.code, code, failed.stdout);
    assert.equal(counter(failed.stderr, 'story.intake-receipt-wave'), 1,
      'the refusal occurs after the receipt has been claimed and verified');
    assert.equal(await readFile(file, 'utf8'), original, 'the original sealed receipt is restored unchanged');
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith(`${receipt.id}.claim-`)), []);
    assert.equal(git(root, 'rev-parse', 'HEAD'), before.head);
    assert.equal(git(root, 'worktree', 'list', '--porcelain'), before.worktrees);
    assert.equal(git(root, 'status', '--porcelain'), before.status);
    assert.equal(git(root, 'branch', '--list', id), '');
    if (target) {
      assert.equal(await readFile(target, 'utf8'), 'Preserve this occupied unregistered path.\n');
      await rm(target);
    }
    const retried = start(root, id, ['--intake-receipt', receipt.id]);
    assert.equal(data(retried).intakeReceipt.status, 'verified');
    assert.equal(counter(retried.stderr, 'git.remote.command.fetch'), 0,
      'a corrected retry keeps the fast path without refetching the selected base');
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith(receipt.id)), [],
      'the successful Story consumes the receipt, rather than making it reusable');
  }
});

test('an exact sealed onboarding pin permits receipt reuse without repinning configuration', posix, async (t) => {
  const { root } = await repository(t);
  const attached = await onboardRepository(root, { remote: 'origin' });
  const receipt = preflight(root, 'STORY-FOS-FAST');
  assert.equal(receipt.issued, true);
  const started = start(root, 'STORY-FOS-FAST', ['--intake-receipt', receipt.id]);
  const result = data(started);
  assert.equal(result.intakeReceipt.status, 'verified', JSON.stringify(result.intakeReceipt));
  assert.deepEqual([...result.intakeReceipt.reused].sort(),
    ['authority-check', 'base-probe', 'destination', 'dry-run', 'launch-fetch']);
  assert.equal(counter(started.stderr, 'git.remote.command.fetch'), 0);
  const workflow = JSON.parse(await readFile(path.join(result.repositoryPath,
    'singularity/work-items/STORY-FOS-FAST/workflow.json'), 'utf8'));
  assert.equal(workflow.resolution.configurationSource.commit, attached.descriptor.authority.commit);
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('a start without a receipt fetches only its chosen base and preserves the launch checkout', posix, async (t) => {
  const { root, remote, base } = await repository(t);
  const producer = path.join(base, 'producer');
  git(base, 'clone', '-q', remote, producer);
  git(producer, 'config', 'user.name', 'Story Publisher');
  git(producer, 'config', 'user.email', EMAIL);
  git(producer, 'switch', '-q', '-c', 'selected-base');
  await writeFile(path.join(producer, 'selected.txt'), 'exact selected base\n');
  git(producer, 'add', '.');
  git(producer, 'commit', '-qm', 'selected base advances');
  const selectedCommit = git(producer, 'rev-parse', 'HEAD');
  git(producer, 'push', '-q', 'origin', 'selected-base');
  git(producer, 'switch', '-q', '--orphan', 'unrelated-large-branch');
  await writeFile(path.join(producer, 'unrelated.txt'), 'not required for this Story\n');
  git(producer, 'add', '.');
  git(producer, 'commit', '-qm', 'unrelated history');
  const unrelatedCommit = git(producer, 'rev-parse', 'HEAD');
  git(producer, 'push', '-q', 'origin', 'unrelated-large-branch');
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'local-work.txt'), 'preserve unsaved application work\n');
  const beforeStatus = git(root, 'status', '--porcelain');
  const started = start(root, 'STORY-SELECTED-BASE', ['--from-branch', 'selected-base']);
  const result = data(started);
  assert.equal(git(result.repositoryPath, 'rev-parse', 'HEAD^'), selectedCommit);
  assert.equal(git(result.repositoryPath, 'branch', '--show-current'), 'STORY-SELECTED-BASE');
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  assert.notEqual(run('git', ['cat-file', '-e', `${unrelatedCommit}^{commit}`], root,
    { allowFailure: true }).status, 0, 'unrelated remote history is not transferred');
  assert.notEqual(run('git', ['show-ref', '--verify', '--quiet',
    'refs/remotes/origin/unrelated-large-branch'], root, { allowFailure: true }).status, 0);
  const timings = (await readFile(path.join(root,
    '.git/singularity-flow/dx/timings.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  const timing = timings.findLast((item) => item.event === 'dx.command-timing' && item.command === 'start');
  assert.ok(timing.spans['start.publication.workflow'] >= 0);
  assert.ok(timing.spans['start.publication.commit'] >= 0);
});

test('a stale deleted Story tracking ref retains the ordinary prune and collision validation path', posix, async (t) => {
  const { root } = await repository(t);
  git(root, 'update-ref', 'refs/remotes/origin/STORY-DELETED-TRACKING', git(root, 'rev-parse', 'HEAD'));
  const started = start(root, 'STORY-DELETED-TRACKING');
  const result = data(started);
  assert.equal(git(result.repositoryPath, 'branch', '--show-current'), 'STORY-DELETED-TRACKING');
  assert.equal(git(result.repositoryPath, 'rev-parse', 'HEAD^'), git(root, 'rev-parse', 'origin/main'));
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('a Story started with a receipt is the Story started without one', posix, async (t) => {
  const { root } = await repository(t);
  start(root, 'STORY-PLAIN');
  const receipt = preflight(root, 'STORY-RECEIPT');
  assert.equal(data(start(root, 'STORY-RECEIPT', ['--intake-receipt', receipt.id])).intakeReceipt.status, 'verified');
  git(root, 'fetch', '-q', 'origin');
  // Content-addressed blobs that embed the Story's own ID or title are named by their digest, so only
  // their number is compared; every other path must match exactly.
  const files = (id) => git(root, 'ls-tree', '-r', '--name-only', `origin/${id}`)
    .split('\n').map((name) => name.replaceAll(id, '<ID>')
      .replace(/\/blobs\/sha256\/[0-9a-f]{64}$/u, '/blobs/sha256/<digest>')).sort();
  assert.deepEqual(files('STORY-RECEIPT'), files('STORY-PLAIN'));
  assert.equal(git(root, 'rev-parse', 'origin/STORY-RECEIPT^'), git(root, 'rev-parse', 'origin/main'));
  assert.equal(git(root, 'rev-parse', 'origin/STORY-PLAIN^'), git(root, 'rev-parse', 'origin/main'));
  const state = (id) => {
    const listed = git(root, 'ls-tree', '-r', '--name-only', `origin/${id}`)
      .split('\n').find((name) => name.endsWith(`${id}/workflow.json`) || name.endsWith(`${id}/state.json`));
    assert.ok(listed, `${id} has lifecycle state`);
    const parsed = JSON.parse(git(root, 'show', `origin/${id}:${listed}`));
    return {
      workType: parsed.workItem?.workType, baseBranch: parsed.workItem?.baseBranch,
      baseCommit: parsed.workItem?.baseCommit, phase: parsed.currentPhase ?? parsed.workItem?.currentPhase
    };
  };
  assert.deepEqual(state('STORY-RECEIPT'), state('STORY-PLAIN'));
});

test('whatever the wave cannot confirm runs the ordinary start, which still succeeds', posix, async (t) => {
  const { base, root } = await repository(t);
  const receiptsDirectory = path.join(root, '.git', 'singularity-flow', 'intake-receipts');
  const outcome = (result) => [result.intakeReceipt.status, result.intakeReceipt.reason];

  const baseMoved = preflight(root, 'STORY-BASE');
  const other = path.join(base, 'other');
  git(base, 'clone', '-q', path.join(base, 'origin.git'), other);
  git(other, 'config', 'user.name', 'Story Publisher');
  git(other, 'config', 'user.email', EMAIL);
  await writeFile(path.join(other, 'moved.txt'), 'the base moved\n');
  git(other, 'add', 'moved.txt');
  git(other, 'commit', '-q', '-m', 'Move the base');
  git(other, 'push', '-q', 'origin', 'main');
  const moved = data(start(root, 'STORY-BASE', ['--intake-receipt', baseMoved.id]));
  assert.deepEqual(outcome(moved), ['fallback', 'base-moved']);
  assert.equal(git(root, 'rev-parse', 'refs/remotes/origin/STORY-BASE^'), git(other, 'rev-parse', 'HEAD'),
    'the ordinary start cut the Story from the new base');

  const configurationMoved = preflight(root, 'STORY-CONFIG');
  git(other, 'fetch', '-q', 'origin');
  git(other, 'switch', '-q', '-c', 'config-edit', 'origin/sflow/config');
  await writeFile(path.join(other, 'CONFIGURATION-NOTE.md'), 'approved elsewhere\n');
  git(other, 'add', 'CONFIGURATION-NOTE.md');
  git(other, 'commit', '-q', '-m', 'Advance approved configuration');
  git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/sflow/config');
  assert.deepEqual(outcome(data(start(root, 'STORY-CONFIG', ['--intake-receipt', configurationMoved.id]))),
    ['fallback', 'configuration-moved']);

  const edited = preflight(root, 'STORY-EDIT');
  const file = path.join(receiptsDirectory, `${edited.id}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.repositories[0].destinationRef = 'refs/heads/STORY-ELSEWHERE';
  await writeFile(file, JSON.stringify(record));
  assert.deepEqual(outcome(data(start(root, 'STORY-EDIT', ['--intake-receipt', edited.id]))),
    ['rejected', 'integrity']);

  const otherRequest = preflight(root, 'STORY-TYPE');
  const bugfix = flow(root, [
    'start', 'STORY-TYPE', '--json', '--isolated-worktree', '--from-branch', 'main', '--work-type', 'bugfix',
    '--title', 'Another workflow', '--description', 'A different request.', '--intake-receipt', otherRequest.id
  ]);
  assert.deepEqual(outcome(data(bugfix)), ['rejected', 'inputs']);

  const switchedOff = preflight(root, 'STORY-OFF');
  assert.deepEqual(outcome(data(start(root, 'STORY-OFF', ['--intake-receipt', switchedOff.id], {
    env: { SINGULARITY_FLOW_STORY_INTAKE_RECEIPTS: 'off' }
  }))), ['rejected', 'disabled']);
  const off = JSON.parse(flow(root, [
    'workspace', 'branches', '--json', '--intake', '--preflight-story', 'STORY-NONE', '--from-branch', 'main',
    '--work-type', 'feature', '--selected-base-only', '--mint-intake-receipt'
  ], { env: { SINGULARITY_FLOW_STORY_INTAKE_RECEIPTS: 'off' } }).stdout);
  assert.deepEqual(off.preflight.intakeReceipt, { issued: false, reason: 'disabled' });

  assert.deepEqual((await readdir(receiptsDirectory)).filter((name) => !/^sir_[0-9a-f]{32}\.json$/.test(name)), [],
    'no claimed receipt is left behind');
});

test('a state tip that moved on is brought up to date by fetching that ref alone', posix, async (t) => {
  const { base, root } = await repository(t);
  const stateRef = 'refs/remotes/origin/state';
  git(root, 'push', '-q', 'origin', 'main:refs/heads/state');
  const receipt = preflight(root, 'STORY-STATE');
  const seen = git(root, 'rev-parse', stateRef);
  // Another machine publishes to the state branch after the preview; this tracking ref is behind.
  const other = path.join(base, 'other');
  git(base, 'clone', '-q', path.join(base, 'origin.git'), other);
  git(other, 'config', 'user.name', 'Story Publisher');
  git(other, 'config', 'user.email', EMAIL);
  git(other, 'switch', '-q', '-c', 'state-edit', 'origin/state');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'State published elsewhere');
  git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/state');
  const moved = git(other, 'rev-parse', 'HEAD');
  assert.equal(git(root, 'rev-parse', stateRef), seen);
  const started = start(root, 'STORY-STATE', ['--intake-receipt', receipt.id]);
  assert.equal(data(started).intakeReceipt.status, 'verified', JSON.stringify(data(started).intakeReceipt));
  assert.equal(counter(started.stderr, 'story.intake-receipt-state-fetch'), 1);
  assert.equal(counter(started.stderr, 'git.remote.command.fetch'), 1, 'one ref, not the whole remote');
  assert.equal(git(root, 'rev-parse', stateRef), moved);
});

test('a receipt is issued only for a request start can verify, and says why not otherwise', posix, async (t) => {
  const { root } = await repository(t);
  const listed = (extra) => JSON.parse(flow(root, [
    'workspace', 'branches', '--json', '--intake', '--preflight-story', 'STORY-WHY', '--from-branch', 'main',
    '--selected-base-only', ...extra
  ]).stdout).preflight;
  assert.equal(listed(['--work-type', 'feature']).intakeReceipt, undefined, 'none unless asked for');
  assert.deepEqual(listed(['--mint-intake-receipt']).intakeReceipt, { issued: false, reason: 'work-type' });
});

test('a reference fetched during intake is copied at start, which then transfers nothing', posix, async (t) => {
  const { base, root } = await repository(t);
  const source = path.join(base, 'reference-source');
  const referenceRemote = path.join(base, 'reference.git');
  await mkdir(source);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'Reference Author');
  git(source, 'config', 'user.email', 'reference@example.test');
  await writeFile(path.join(source, 'Rules.java'), 'final class Rules {}\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'reference');
  git(base, 'clone', '-q', '--bare', source, referenceRemote);
  const references = ['--reference-repository', `rules=${referenceRemote}`, '--reference-branch', 'rules=main'];

  const inspected = JSON.parse(flow(root, ['story', 'references', 'inspect', ...references, '--prefetch', '--json']).stdout);
  assert.deepEqual(inspected.prefetched, [{ id: 'rules', status: 'prefetched' }]);
  const receipt = preflight(root, 'STORY-REFERENCE', references);
  const started = start(root, 'STORY-REFERENCE', [...references, '--intake-receipt', receipt.id]);
  assert.equal(data(started).intakeReceipt.status, 'verified', JSON.stringify(data(started).intakeReceipt));
  assert.equal(counter(started.stderr, 'reference.prefetch-used'), 1);
  assert.equal(counter(started.stderr, 'git.remote.command.fetch'), 0,
    'neither the base nor the reference is transferred again');
});

test('a readiness preview lists its own origin once and fetches only when a tip moved', posix, async (t) => {
  const { base, root } = await repository(t);
  const previewArgs = [
    'workspace', 'branches', '--json', '--intake', '--preflight-story', 'STORY-UNION', '--from-branch', 'main',
    '--work-type', 'feature', '--selected-base-only', '--timings'
  ];
  flow(root, previewArgs);
  const warm = flow(root, previewArgs);
  assert.equal(JSON.parse(warm.stdout).preflight.passed, true);
  assert.equal(counter(warm.stderr, 'git.remote.command.ls-remote'), 1,
    'authority, base, destination and state come from one listing');
  assert.equal(counter(warm.stderr, 'git.story-preflight-fetch-verified'), 1);
  assert.equal(counter(warm.stderr, 'git.remote.command.fetch'), 0, 'the tracking refs were already current');

  const other = path.join(base, 'other');
  git(base, 'clone', '-q', path.join(base, 'origin.git'), other);
  git(other, 'config', 'user.name', 'Story Publisher');
  git(other, 'config', 'user.email', EMAIL);
  await writeFile(path.join(other, 'moved.txt'), 'moved\n');
  git(other, 'add', 'moved.txt');
  git(other, 'commit', '-q', '-m', 'Move the base');
  git(other, 'push', '-q', 'origin', 'main');
  const moved = flow(root, previewArgs);
  assert.equal(counter(moved.stderr, 'git.remote.command.fetch'), 1, 'a moved tip is fetched');
  assert.equal(JSON.parse(moved.stdout).preflight.repositories[0].baseCommit, git(other, 'rev-parse', 'HEAD'));
});

test('a reference branch that disappeared after the preview sends start down its ordinary path', posix, async (t) => {
  const { base, root } = await repository(t);
  const source = path.join(base, 'reference-source');
  const referenceRemote = path.join(base, 'reference.git');
  await mkdir(source);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'Reference Author');
  git(source, 'config', 'user.email', 'reference@example.test');
  await writeFile(path.join(source, 'Rules.java'), 'final class Rules {}\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'reference');
  git(base, 'clone', '-q', '--bare', source, referenceRemote);
  git(referenceRemote, 'branch', 'release', 'main');
  const references = ['--reference-repository', `rules=${referenceRemote}`, '--reference-branch', 'rules=release'];
  const receipt = preflight(root, 'STORY-GONE-REF', references);
  git(referenceRemote, 'branch', '-D', 'release');
  const refused = start(root, 'STORY-GONE-REF', [...references, '--intake-receipt', receipt.id], { allowFailure: true });
  assert.notEqual(refused.status, 0, 'the ordinary start refuses a missing reference branch');
  assert.match(`${refused.stdout}${refused.stderr}`, /REFERENCE_REPOSITORY_BRANCH_NOT_FOUND|no advertised branch 'release'/);
});
