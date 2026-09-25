import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

import { ensureConfigurationBranch } from '../src/configuration-branch.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Story Publisher',
      ...env
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const git = (root, ...args) => run('git', args, root);
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);

async function repository() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-publication-'));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'checkout');
  await mkdir(root);
  git(base, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Story Publisher');
  git(root, 'config', 'user.email', 'story.publisher@example.com');
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'README.md'), '# Story publication\n');
  flow(root, ['init']);
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.worldModel.grounding = 'off';
  await writeFile(definitionFile, YAML.stringify(definition));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initialize governed repository');
  git(root, 'push', '-u', 'origin', 'main');

  git(root, 'switch', '-c', 'release/24.3');
  await writeFile(path.join(root, 'release.txt'), 'release-only base\n');
  git(root, 'add', 'release.txt');
  git(root, 'commit', '-m', 'Prepare release base');
  git(root, 'push', '-u', 'origin', 'release/24.3');
  git(root, 'switch', 'main');
  return { base, root, remote };
}

function start(root, id, extra = []) {
  return flow(root, [
    'start', id, '--json', '--from-branch', 'release/24.3',
    '--work-type', 'feature', '--title', 'Explicit Story branch',
    '--description', 'Prove exact base and publication refs.', ...extra
  ]);
}

async function seedRaceGitEnvironment({ base, remote, storyBranch, seedCommit, replacementCommit }) {
  const realGit = run('which', ['git'], base).stdout.trim();
  const wrappers = path.join(base, `seed-race-${storyBranch}`);
  const wrapper = path.join(wrappers, 'git');
  const initialFetchSeen = path.join(wrappers, 'initial-fetch-seen');
  const raceApplied = path.join(wrappers, 'race-applied');
  await mkdir(wrappers, { recursive: true });
  await writeFile(wrapper, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
const initialFetchSeen = ${JSON.stringify(initialFetchSeen)};
const raceApplied = ${JSON.stringify(raceApplied)};
const broadRefspec = '+refs/heads/*:refs/remotes/origin/*';
const storyFetch = args[0] === 'fetch' && args.includes(broadRefspec);
// The transport is an invocation-local frozen alias, never the mutable name 'origin'.
const initialStoryFetch = storyFetch && !fs.existsSync(initialFetchSeen);
const postFreezeRefresh = storyFetch && !initialStoryFetch && fs.existsSync(initialFetchSeen)
  && !fs.existsSync(raceApplied);
if (initialStoryFetch) fs.writeFileSync(initialFetchSeen, 'yes');
if (postFreezeRefresh) {
  const moved = spawnSync(realGit, [
    '--git-dir', ${JSON.stringify(remote)}, 'update-ref',
    ${JSON.stringify(`refs/heads/${storyBranch}`)},
    ${JSON.stringify(replacementCommit)}, ${JSON.stringify(seedCommit)}
  ], { encoding: 'utf8' });
  if (moved.status !== 0) {
    if (moved.stdout) process.stdout.write(moved.stdout);
    if (moved.stderr) process.stderr.write(moved.stderr);
    process.exit(moved.status || 1);
  }
  fs.writeFileSync(raceApplied, 'yes');
}
const result = spawnSync(realGit, args, {
  cwd: process.cwd(), env: process.env, stdio: 'inherit'
});
process.exit(result.status == null ? 1 : result.status);
`);
  await chmod(wrapper, 0o755);
  return {
    env: { PATH: `${wrappers}${path.delimiter}${process.env.PATH}` },
    raceApplied
  };
}

test('Story start cuts from the selected remote base and publishes only its own branch', async () => {
  const { root } = await repository();
  const baseBefore = git(root, 'ls-remote', 'origin', 'refs/heads/release/24.3').stdout.split(/\s+/)[0];

  const result = JSON.parse(start(root, 'STORY-42').stdout);

  const localHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const remoteStory = git(root, 'ls-remote', 'origin', 'refs/heads/STORY-42').stdout.split(/\s+/)[0];
  const baseAfter = git(root, 'ls-remote', 'origin', 'refs/heads/release/24.3').stdout.split(/\s+/)[0];
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'STORY-42');
  assert.equal(remoteStory, localHead, 'the governed Story commit is the published Story ref');
  assert.equal(baseAfter, baseBefore, 'the selected base ref was not moved');
  assert.equal(git(root, 'merge-base', '--is-ancestor', baseBefore, localHead).status, 0);
  assert.equal(result.data.base.branch, 'release/24.3');
  assert.equal(result.data.base.commit, baseBefore);
  assert.equal(result.data.readiness.resultType, 'story-start-readiness');
  assert.equal(result.data.readiness.ready, true);
  assert.equal(result.data.readiness.base.branch, 'release/24.3');
  assert.deepEqual(Object.values(result.data.readiness.receipt.baseCommits), [baseBefore]);
  assert.ok(result.data.readiness.checks.some((entry) =>
    entry.code === 'STORY_OPTIONAL_INTELLIGENCE_NON_BLOCKING' && entry.status === 'pass'));
  assert.deepEqual(result.data.publication, {
    remote: 'origin', branch: 'STORY-42', ref: 'refs/heads/STORY-42',
    pushed: true, commit: localHead
  });
  const workflow = JSON.parse(await readFile(
    path.join(root, 'singularity/work-items/STORY-42/workflow.json'), 'utf8'
  ));
  assert.equal(workflow.workItem.baseBranch, 'release/24.3');
  assert.equal(workflow.workItem.baseCommit, baseBefore);
  assert.equal(workflow.workItem.baseRemote, 'origin');
});

test('starting an existing durable Story routes to Resume without asking for another base', async () => {
  const { root } = await repository();
  start(root, 'STORY-RESUME');
  git(root, 'switch', 'main');
  git(root, 'branch', '-D', 'STORY-RESUME');

  const resumed = flow(root, ['start', 'STORY-RESUME']);

  assert.equal(resumed.status, 0);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'STORY-RESUME');
  assert.match(resumed.stdout, /STORY-RESUME/);
  assert.doesNotMatch(resumed.stderr, /--from-branch/);
});

test('Story start refuses a remote retarget between destination inspection and fetch', async () => {
  const { base, root } = await repository();
  const id = 'STORY-DESTINATION-RACE';
  start(root, id);
  git(root, 'switch', 'main');
  git(root, 'branch', '-D', id);
  const priorTrackingCommit = git(root, 'rev-parse', `refs/remotes/origin/${id}`).stdout.trim();
  const alternate = path.join(base, 'alternate.git');
  git(base, 'init', '--bare', '--initial-branch=main', alternate);
  const realGit = run('which', ['git'], base).stdout.trim();
  const wrapperDirectory = path.join(base, 'retarget-wrapper');
  const wrapper = path.join(wrapperDirectory, 'git');
  const retargeted = path.join(wrapperDirectory, 'retargeted');
  await mkdir(wrapperDirectory);
  await writeFile(wrapper, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  cwd: process.cwd(), env: process.env, encoding: 'utf8'
});
if (args[0] === 'ls-remote' && args.includes(${JSON.stringify(`refs/heads/${id}`)})
    && !fs.existsSync(${JSON.stringify(retargeted)})) {
  const changed = spawnSync(${JSON.stringify(realGit)}, [
    'remote', 'set-url', 'origin', ${JSON.stringify(alternate)}
  ], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  if (changed.status !== 0) {
    process.stderr.write(changed.stderr || 'Could not set test remote');
    process.exit(changed.status || 1);
  }
  fs.writeFileSync(${JSON.stringify(retargeted)}, 'yes');
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status == null ? 1 : result.status);
`);
  await chmod(wrapper, 0o755);

  const refused = flow(root, ['start', id, '--json'], {
    allowFailure: true,
    env: { PATH: `${wrapperDirectory}${path.delimiter}${process.env.PATH}` }
  });
  assert.equal(refused.status, 1);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /GIT_REMOTE_AUTHORITY_CHANGED/u);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'rev-parse', `refs/remotes/origin/${id}`).stdout.trim(), priorTrackingCommit);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${id}`], root, {
    allowFailure: true
  }).status, 1);
});

test('noninteractive start resumes a cached Story on the configured named remote', async () => {
  const { root } = await repository();
  git(root, 'remote', 'rename', 'origin', 'company');
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.git.remote = 'company';
  await writeFile(definitionFile, YAML.stringify(definition));
  git(root, 'add', 'singularity/workflow.yml');
  git(root, 'commit', '-m', 'Use the named repository remote');
  git(root, 'push', 'company', 'main');
  const id = 'STORY-NAMED-RESUME';
  flow(root, [
    'start', id, '--json', '--from-branch', 'main', '--work-type', 'feature',
    '--title', 'Resume from named remote', '--description', 'Prove cached Story detection.'
  ]);
  git(root, 'switch', 'main');
  git(root, 'branch', '-D', id);
  assert.equal(git(root, 'show-ref', '--verify', '--quiet', `refs/remotes/company/${id}`).status, 0);

  const resumed = JSON.parse(flow(root, ['start', id, '--json']).stdout);
  assert.equal(resumed.outcome.status, 'succeeded');
  assert.equal(resumed.subject.id, id);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), id);
});

test('resume fetches once and fast-forwards from the exact refreshed remote ref without pulling', async () => {
  const { base, root, remote } = await repository();
  start(root, 'STORY-RESUME-FETCH');
  git(root, 'switch', 'main');

  const publisher = path.join(base, 'publisher');
  git(base, 'clone', '--quiet', remote, publisher);
  git(publisher, 'config', 'user.name', 'Remote Publisher');
  git(publisher, 'config', 'user.email', 'remote.publisher@example.com');
  git(publisher, 'switch', '--quiet', 'STORY-RESUME-FETCH');
  await writeFile(path.join(publisher, 'remote-update.txt'), 'published after the first session\n');
  git(publisher, 'add', 'remote-update.txt');
  git(publisher, 'commit', '--quiet', '-m', 'advance Story remotely');
  git(publisher, 'push', '--quiet', 'origin', 'STORY-RESUME-FETCH');
  const expected = git(publisher, 'rev-parse', 'HEAD').stdout.trim();

  const resumed = flow(root, ['resume', 'STORY-RESUME-FETCH', '--fetch', '--json'], {
    env: { SINGULARITY_FLOW_SUBPROCESS_PROBE: '1' }
  });
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), expected);
  assert.match(resumed.stderr, /\b1x\s+\d+ ms\s+git fetch --prune\b/,
    'resume should perform exactly one explicit remote refresh');
  assert.doesNotMatch(resumed.stderr, /git pull --ff-only/,
    'the refreshed remote-tracking ref is sufficient for the fast-forward');
});

test('a materialized Epic Story uses its pinned parent branch and commit as read-only base evidence', async () => {
  const { root, remote } = await repository();
  await ensureConfigurationBranch(remote);
  const baseCommit = git(root, 'rev-parse', 'origin/release/24.3').stdout.trim();
  git(root, 'switch', '-c', 'STORY-SEEDED', 'origin/release/24.3');
  const seedDirectory = path.join(root, 'singularity/seeds');
  await mkdir(seedDirectory, { recursive: true });
  await writeFile(path.join(seedDirectory, 'STORY-SEEDED.yml'), YAML.stringify({
    version: 1,
    initiative: { id: 'EPIC-42' },
    story: {
      id: 'STORY-SEEDED',
      workId: 'STORY-SEEDED',
      title: 'Materialized Story',
      description: 'Use the exact parent selected during Epic materialization.',
      acceptanceCriteria: ['The pinned base is preserved.'],
      suggestedWorkType: 'feature',
      parentBranch: 'release/24.3',
      baseCommit
    }
  }));
  git(root, 'add', 'singularity/seeds/STORY-SEEDED.yml');
  git(root, 'commit', '-m', '[EPIC-42][story:STORY-SEEDED][seed] Link initiative');
  git(root, 'push', '-u', 'origin', 'HEAD:refs/heads/STORY-SEEDED');
  git(root, 'switch', 'main');
  git(root, 'branch', '-D', 'STORY-SEEDED');
  git(root, 'config', 'user.name', 'Seed Consumer');
  git(root, 'config', 'user.email', 'seed.consumer@example.com');

  const result = JSON.parse(flow(root, ['start', 'STORY-SEEDED', '--json'], {
    env: { SINGULARITY_FLOW_TEST_IDENTITY: 'Seed Consumer' }
  }).stdout);
  const workflow = JSON.parse(await readFile(
    path.join(root, 'singularity/work-items/STORY-SEEDED/workflow.json'), 'utf8'
  ));

  assert.equal(result.data.base.branch, 'release/24.3');
  assert.equal(result.data.base.commit, baseCommit);
  assert.equal(workflow.workItem.baseBranch, 'release/24.3');
  assert.equal(workflow.workItem.baseCommit, baseCommit);
  assert.equal(result.data.publication.ref, 'refs/heads/STORY-SEEDED');
  assert.equal(result.data.publication.pushed, true);
  assert.equal(result.data.approvalEnrollment?.automatic, true,
    'a new user adopting an Epic seed is enrolled before the Story starts');
  const approved = YAML.parse(git(
    root, 'show', 'origin/sflow/config:singularity/workflow.yml'
  ).stdout);
  assert.ok(Object.values(approved.approvalAuthorities).every((authority) =>
    authority.members.some((member) => member.email === 'seed.consumer@example.com')),
  'the seeded Story user is enrolled in every configured Story approval authority');
});

test('approved configuration refuses a materialized Epic seed that moves before enrollment or checkout', {
  skip: process.platform === 'win32'
}, async () => {
  const { base, root, remote } = await repository();
  await ensureConfigurationBranch(remote);
  const configBefore = git(base, '--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config').stdout.trim();
  const mainBefore = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const baseCommit = git(root, 'rev-parse', 'origin/release/24.3').stdout.trim();
  const storyBranch = 'STORY-SEED-APPROVED-RACE';
  git(root, 'switch', '-c', storyBranch, 'origin/release/24.3');
  const seedDirectory = path.join(root, 'singularity/seeds');
  await mkdir(seedDirectory, { recursive: true });
  await writeFile(path.join(seedDirectory, `${storyBranch}.yml`), YAML.stringify({
    version: 1,
    initiative: { id: 'EPIC-SEED-RACE' },
    story: {
      id: storyBranch,
      workId: storyBranch,
      title: 'Approved seed race',
      description: 'Refuse a concurrently replaced materialized seed.',
      acceptanceCriteria: ['Enrollment and checkout wait for an immutable seed.'],
      suggestedWorkType: 'feature',
      parentBranch: 'release/24.3',
      baseCommit
    }
  }));
  git(root, 'add', `singularity/seeds/${storyBranch}.yml`);
  git(root, 'commit', '--quiet', '-m', `[EPIC-SEED-RACE][story:${storyBranch}][seed] Link initiative`);
  const seedCommit = git(root, 'rev-parse', 'HEAD').stdout.trim();
  git(root, 'push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${storyBranch}`);
  await writeFile(path.join(root, 'replacement.txt'), 'concurrent replacement\n');
  git(root, 'add', 'replacement.txt');
  git(root, 'commit', '--quiet', '-m', 'Concurrent seed replacement');
  const replacementCommit = git(root, 'rev-parse', 'HEAD').stdout.trim();
  git(root, 'push', '--quiet', 'origin', `HEAD:refs/heads/race-${storyBranch}`);
  git(root, 'switch', 'main');
  git(root, 'branch', '-D', storyBranch);
  git(root, 'config', 'user.name', 'Seed Race Consumer');
  git(root, 'config', 'user.email', 'seed.race.consumer@example.com');
  const race = await seedRaceGitEnvironment({
    base, remote, storyBranch, seedCommit, replacementCommit
  });

  const refused = flow(root, ['start', storyBranch, '--json'], {
    allowFailure: true,
    env: {
      ...race.env,
      SINGULARITY_FLOW_TEST_IDENTITY: 'Seed Race Consumer'
    }
  });

  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /"code": "STORY_SEED_CHANGED"/);
  assert.equal(await readFile(race.raceApplied, 'utf8'), 'yes');
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), mainBefore);
  assert.equal(git(base, '--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config').stdout.trim(), configBefore,
    'automatic identity enrollment must not advance approved configuration after a seed race');
  assert.equal(run('git', [
    'show-ref', '--verify', '--quiet', `refs/heads/${storyBranch}`
  ], root, { allowFailure: true }).status, 1,
  'the materialized Story must not be checked out locally');
  await assert.rejects(readFile(
    path.join(root, `singularity/work-items/${storyBranch}/workflow.json`)
  ), /ENOENT/);
});

test('a legacy materialized Epic Story uses workflow policy from its exact seed tip', async () => {
  const { root } = await repository();
  const baseCommit = git(root, 'rev-parse', 'origin/release/24.3').stdout.trim();
  git(root, 'switch', '-c', 'STORY-SEED-POLICY', 'origin/release/24.3');
  const seedWorkflowFile = path.join(root, 'singularity/workflow.yml');
  const seedWorkflow = YAML.parse(await readFile(seedWorkflowFile, 'utf8'));
  seedWorkflow.git.publish = 'required';
  seedWorkflow.workTypes.feature.label = 'Seed-tip governed feature';
  await writeFile(seedWorkflowFile, YAML.stringify(seedWorkflow));
  const seedDirectory = path.join(root, 'singularity/seeds');
  await mkdir(seedDirectory, { recursive: true });
  await writeFile(path.join(seedDirectory, 'STORY-SEED-POLICY.yml'), YAML.stringify({
    version: 1,
    initiative: { id: 'EPIC-SEED-POLICY' },
    story: {
      id: 'STORY-SEED-POLICY',
      workId: 'STORY-SEED-POLICY',
      title: 'Use seed-tip policy',
      description: 'The materialized branch carries newer workflow policy than main.',
      acceptanceCriteria: ['The exact seed tip governs Story creation.'],
      suggestedWorkType: 'feature',
      parentBranch: 'release/24.3',
      baseCommit
    }
  }));
  git(root, 'add', 'singularity/workflow.yml', 'singularity/seeds/STORY-SEED-POLICY.yml');
  git(root, 'commit', '--quiet', '-m', '[EPIC-SEED-POLICY][story:STORY-SEED-POLICY][seed] Link initiative');
  git(root, 'push', '--quiet', '-u', 'origin', 'HEAD:refs/heads/STORY-SEED-POLICY');
  const seedTip = git(root, 'rev-parse', 'HEAD').stdout.trim();

  git(root, 'switch', 'main');
  git(root, 'branch', '-D', 'STORY-SEED-POLICY');
  const launchWorkflowFile = path.join(root, 'singularity/workflow.yml');
  const launchWorkflow = YAML.parse(await readFile(launchWorkflowFile, 'utf8'));
  launchWorkflow.git.publish = 'off';
  launchWorkflow.workTypes.feature.label = 'Divergent launch-checkout feature';
  await writeFile(launchWorkflowFile, YAML.stringify(launchWorkflow));
  git(root, 'add', 'singularity/workflow.yml');
  git(root, 'commit', '--quiet', '-m', 'Diverge launch checkout from materialized seed');

  const result = JSON.parse(flow(root, ['start', 'STORY-SEED-POLICY', '--json']).stdout);
  const workflow = JSON.parse(await readFile(
    path.join(root, 'singularity/work-items/STORY-SEED-POLICY/workflow.json'), 'utf8'
  ));

  assert.equal(result.data.readiness.base.repositories[0].publishRequired, true);
  assert.equal(result.data.publication.pushed, true);
  assert.equal(workflow.workItem.workTypeLabel, 'Seed-tip governed feature');
  assert.equal(workflow.workItem.baseBranch, 'release/24.3');
  assert.equal(workflow.workItem.baseCommit, baseCommit);
  assert.notEqual(result.data.publication.commit, seedTip,
    'the opening governed commit advances the exact materialized seed tip');
  assert.equal(git(root, 'ls-remote', 'origin', 'refs/heads/STORY-SEED-POLICY')
    .stdout.split(/\s+/)[0], result.data.publication.commit);
});

test('legacy configuration refuses a materialized Epic seed that moves before checkout', {
  skip: process.platform === 'win32'
}, async () => {
  const { base, root, remote } = await repository();
  const mainBefore = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const remoteMainBefore = git(base, '--git-dir', remote, 'rev-parse', 'refs/heads/main').stdout.trim();
  const baseCommit = git(root, 'rev-parse', 'origin/release/24.3').stdout.trim();
  const storyBranch = 'STORY-SEED-LEGACY-RACE';
  git(root, 'switch', '-c', storyBranch, 'origin/release/24.3');
  const seedDirectory = path.join(root, 'singularity/seeds');
  await mkdir(seedDirectory, { recursive: true });
  await writeFile(path.join(seedDirectory, `${storyBranch}.yml`), YAML.stringify({
    version: 1,
    initiative: { id: 'EPIC-SEED-LEGACY-RACE' },
    story: {
      id: storyBranch,
      workId: storyBranch,
      title: 'Legacy seed race',
      description: 'Refuse a concurrently replaced branch-local seed.',
      acceptanceCriteria: ['Checkout waits for an immutable legacy seed.'],
      suggestedWorkType: 'feature',
      parentBranch: 'release/24.3',
      baseCommit
    }
  }));
  git(root, 'add', `singularity/seeds/${storyBranch}.yml`);
  git(root, 'commit', '--quiet', '-m', `[EPIC-SEED-LEGACY-RACE][story:${storyBranch}][seed] Link initiative`);
  const seedCommit = git(root, 'rev-parse', 'HEAD').stdout.trim();
  git(root, 'push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${storyBranch}`);
  await writeFile(path.join(root, 'replacement.txt'), 'concurrent replacement\n');
  git(root, 'add', 'replacement.txt');
  git(root, 'commit', '--quiet', '-m', 'Concurrent legacy seed replacement');
  const replacementCommit = git(root, 'rev-parse', 'HEAD').stdout.trim();
  git(root, 'push', '--quiet', 'origin', `HEAD:refs/heads/race-${storyBranch}`);
  git(root, 'switch', 'main');
  git(root, 'branch', '-D', storyBranch);
  const race = await seedRaceGitEnvironment({
    base, remote, storyBranch, seedCommit, replacementCommit
  });

  const refused = flow(root, ['start', storyBranch, '--json'], {
    allowFailure: true,
    env: race.env
  });

  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /"code": "STORY_SEED_CHANGED"/);
  assert.equal(await readFile(race.raceApplied, 'utf8'), 'yes');
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), mainBefore);
  assert.equal(git(base, '--git-dir', remote, 'rev-parse', 'refs/heads/main').stdout.trim(), remoteMainBefore);
  assert.equal(run('git', [
    '--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'
  ], base, { allowFailure: true }).status, 1,
  'legacy refusal must not create a shared configuration branch');
  assert.equal(run('git', [
    'show-ref', '--verify', '--quiet', `refs/heads/${storyBranch}`
  ], root, { allowFailure: true }).status, 1,
  'the materialized Story must not be checked out locally');
  await assert.rejects(readFile(
    path.join(root, `singularity/work-items/${storyBranch}/workflow.json`)
  ), /ENOENT/);
});

test('non-interactive Story start requires an explicit base before mutation', async () => {
  const { root } = await repository();
  const originalHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const refused = flow(root, [
    'start', 'STORY-NO-BASE', '--json', '--work-type', 'feature',
    '--title', 'Missing base', '--description', 'Must refuse.', '--timings'
  ], {
    allowFailure: true,
    env: { SINGULARITY_FLOW_SUBPROCESS_PROBE: '1' }
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--from-branch/);
  assert.match(refused.stderr,
    /singularity-flow workspace branches --preflight-story STORY-NO-BASE --json/);
  assert.match(refused.stderr, /singularity-flow resume STORY-NO-BASE --fetch/);
  assert.doesNotMatch(refused.stderr, /git ls-remote|git fetch/,
    'a missing required base must refuse before remote or configuration discovery');
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), originalHead);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/STORY-NO-BASE'], root,
    { allowFailure: true }).status, 1);
});

test('workspace branch preflight proves the exact destination without creating it', async () => {
  const { root } = await repository();
  const originalHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const preflight = flow(root, [
    'workspace', 'branches', '--json', '--preflight-story', 'STORY-PREVIEW',
    '--from-branch', 'release/24.3', '--work-type', 'feature', '--timings'
  ]);
  const result = JSON.parse(preflight.stdout);

  assert.equal(result.preflight.passed, true);
  assert.equal(result.preflight.storyBranch, 'STORY-PREVIEW');
  assert.equal(result.preflight.remote, 'origin');
  assert.equal(result.preflight.destinationRef, 'refs/heads/STORY-PREVIEW');
  assert.equal(result.preflight.repositories[0].baseBranch, 'release/24.3');
  assert.equal(result.preflight.readiness.resultType, 'story-start-readiness');
  assert.equal(result.preflight.readiness.ready, true);
  assert.equal(result.preflight.readiness.workType, 'feature');
  assert.equal(result.preflight.readiness.upgrade.safeToApply, false);
  assert.equal(result.preflight.readiness.upgrade.shell,
    'singularity-flow workspace reinitialize --dry-run --json');
  assert.equal(result.preflight.readiness.upgrade.copilot, '/sf-admin');
  assert.deepEqual(Object.values(result.preflight.readiness.receipt.baseCommits),
    [result.preflight.repositories[0].baseCommit]);
  assert.match(preflight.stderr, /git\.remote-inventory=1(?:\s|$)/,
    'choice rendering and same-command preflight must reuse one remote inventory');
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), originalHead);
  assert.equal(git(root, 'ls-remote', 'origin', 'refs/heads/STORY-PREVIEW').stdout.trim(), '');
});

test('selected-base Story preflight reuses the earlier UI choice without another remote inventory', async () => {
  const { root } = await repository();
  const originalHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const preview = flow(root, [
    'workspace', 'branches', '--json', '--intake', '--preflight-story', 'STORY-FAST-PREVIEW',
    '--from-branch', 'release/24.3', '--selected-base-only', '--work-type', 'feature', '--timings'
  ]);
  const result = JSON.parse(preview.stdout);

  assert.equal(result.choicesComplete, false);
  assert.deepEqual(result.choices.map((choice) => choice.branch), ['release/24.3']);
  assert.equal(result.preflight.passed, true);
  assert.equal(result.preflight.repositories[0].baseBranch, 'release/24.3');
  assert.equal(result.preflight.readiness.ready, true);
  assert.doesNotMatch(preview.stderr, /git\.remote-inventory=/,
    'the selected base is proven by the fresh preflight fetch, without a second all-heads probe');
  assert.match(preview.stderr, /git\.remote-fetch=1(?:\s|$)/);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), originalHead);
});

test('workspace preflight derives publication policy from the exact selected legacy base', async () => {
  const { root } = await repository();
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const launchWorkflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  launchWorkflow.git.publish = 'off';
  launchWorkflow.workTypes.feature.label = 'Divergent launch-checkout feature';
  await writeFile(workflowFile, YAML.stringify(launchWorkflow));
  git(root, 'add', 'singularity/workflow.yml');
  git(root, 'commit', '--quiet', '-m', 'Diverge launch checkout policy');

  const result = JSON.parse(flow(root, [
    'workspace', 'branches', '--json', '--intake',
    '--preflight-story', 'STORY-BASE-POLICY',
    '--from-branch', 'release/24.3', '--work-type', 'feature'
  ]).stdout);

  assert.equal(result.preflight.passed, true);
  assert.equal(result.preflight.repositories[0].publishRequired, true,
    'the selected base requires publication even though the launch checkout disables it');
  assert.equal(result.preflight.readiness.base.repositories[0].publishRequired, true);
  assert.equal(result.intake.storyWorkflows.find((workflow) => workflow.id === 'feature')?.label,
    'Feature', 'the workflow selector reflects the exact selected base');
});

test('workspace preflight returns the exact selected-base workflow catalog before selection', async () => {
  const { root } = await repository();
  git(root, 'switch', 'release/24.3');
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowFile, 'utf8'));
  definition.workTypes['release-only'] = {
    ...definition.workTypes.feature,
    label: 'Release-only delivery'
  };
  delete definition.workTypes.feature;
  await writeFile(workflowFile, YAML.stringify(definition));
  git(root, 'add', 'singularity/workflow.yml');
  git(root, 'commit', '--quiet', '-m', 'Use a release-only Story workflow');
  git(root, 'push', '--quiet', 'origin', 'release/24.3');
  git(root, 'switch', 'main');

  const staleChoice = JSON.parse(flow(root, [
    'workspace', 'branches', '--json', '--intake',
    '--preflight-story', 'STORY-BASE-CATALOG',
    '--from-branch', 'release/24.3', '--work-type', 'feature'
  ]).stdout);
  assert.equal(staleChoice.preflight.passed, false);
  assert.equal(staleChoice.preflight.readiness.ready, false);
  assert.ok(staleChoice.intake.storyWorkflows.some((workflow) =>
    workflow.id === 'release-only' && workflow.label === 'Release-only delivery'));
  const exactBaseWorkflow = staleChoice.intake.storyWorkflows.find((workflow) =>
    workflow.id === 'release-only');
  assert.equal(exactBaseWorkflow.generatesCode, true);
  assert.deepEqual(exactBaseWorkflow.codePhases, ['implementation']);
  assert.equal(staleChoice.intake.storyWorkflows.some((workflow) => workflow.id === 'feature'),
    false, 'the launch checkout workflow is not offered for the selected base');
  assert.ok(staleChoice.intake.availableStoryWorkflows.some((workflow) =>
    workflow.id === 'feature' && workflow.installed === false),
    'a packaged workflow absent from the exact base remains visible as available');
  assert.ok(staleChoice.intake.availableStoryWorkflows.every((workflow) =>
    !staleChoice.intake.storyWorkflows.some((installed) => installed.id === workflow.id)),
    'the exact-base installed and available projections must remain disjoint');

  const selected = JSON.parse(flow(root, [
    'workspace', 'branches', '--json', '--intake',
    '--preflight-story', 'STORY-BASE-CATALOG',
    '--from-branch', 'release/24.3', '--work-type', 'release-only'
  ]).stdout);
  assert.equal(selected.preflight.passed, true);
  assert.equal(selected.preflight.readiness.workType, 'release-only');
});

test('Story intake reads the exact historical split heading from approved configuration', async () => {
  const { base, root, remote } = await repository();
  await ensureConfigurationBranch(remote);

  const authority = path.join(base, 'legacy-approved-configuration');
  git(base, 'clone', '--quiet', '--branch', 'sflow/config', remote, authority);
  git(authority, 'config', 'user.name', 'Configuration Publisher');
  git(authority, 'config', 'user.email', 'configuration.publisher@example.com');
  const workflowFile = path.join(authority, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowFile, 'utf8'));
  const verification = definition.workTypes['spec-driven-standard']
    .phaseOverrides.release.inputs.find((input) => input.phase === 'verification');
  verification.preserve = [
    'Acceptance and specification results', 'Negative', 'regression', 'security',
    'and non-functional checks'
  ];
  await writeFile(workflowFile, YAML.stringify(definition));
  git(authority, 'add', 'singularity/workflow.yml');
  git(authority, 'commit', '--quiet', '-m', 'Retain historical packaged workflow');
  git(authority, 'push', '--quiet', 'origin', 'sflow/config');

  const result = JSON.parse(flow(root, [
    'workspace', 'branches', '--json', '--intake'
  ]).stdout);
  assert.equal(result.intake.workflowReason, null);
  assert.ok(result.intake.storyWorkflows.some((workflow) =>
    workflow.id === 'spec-driven-standard'));
});

test('Story start derives publication policy from the exact selected legacy base', async () => {
  const { root } = await repository();
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const launchWorkflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  launchWorkflow.git.publish = 'off';
  await writeFile(workflowFile, YAML.stringify(launchWorkflow));
  git(root, 'add', 'singularity/workflow.yml');
  git(root, 'commit', '--quiet', '-m', 'Disable publication only on launch checkout');

  const result = JSON.parse(start(root, 'STORY-BASE-PUBLISH').stdout);

  assert.equal(result.data.readiness.base.repositories[0].publishRequired, true);
  assert.equal(result.data.publication.pushed, true);
  assert.match(git(root, 'ls-remote', 'origin', 'refs/heads/STORY-BASE-PUBLISH').stdout,
    /^[0-9a-f]{40}\s+refs\/heads\/STORY-BASE-PUBLISH$/m);
});

test('workspace intake aggregates profiles, installed workflows, and one remote inventory', async () => {
  const { root } = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  delete workflow.workTypes['benchmarking-a'];
  await writeFile(workflowPath, YAML.stringify(workflow));
  const listed = flow(root, ['workspace', 'branches', '--json', '--intake', '--timings']);
  const result = JSON.parse(listed.stdout);

  assert.ok(result.intake.profiles.some((profile) =>
    profile.id === 'epic-planning' && profile.phases.length > 0));
  assert.ok(result.intake.storyWorkflows.some((workflow) =>
    workflow.id === 'feature' && workflow.governs === 'story' && workflow.installed === true));
  assert.deepEqual(
    result.intake.storyWorkflows.find((workflow) => workflow.id === 'feature').codePhases,
    ['implementation']
  );
  assert.equal(
    result.intake.storyWorkflows.find((workflow) => workflow.id === 'chore').generatesCode,
    false
  );
  assert.ok(result.intake.availableStoryWorkflows.some((workflow) =>
    workflow.id === 'benchmarking-a' && workflow.governs === 'story' && workflow.installed === false));
  const availableBenchmarking = result.intake.availableStoryWorkflows.find((workflow) =>
    workflow.id === 'benchmarking-a');
  assert.equal(availableBenchmarking.generatesCode, true);
  assert.deepEqual(availableBenchmarking.codePhases, ['implementation']);
  assert.ok(result.intake.availableStoryWorkflows.every((workflow) =>
    !result.intake.storyWorkflows.some((installed) => installed.id === workflow.id)));
  assert.equal(result.intake.workflowCatalogReason, null);
  assert.equal(result.intake.profileReason, null);
  assert.equal(result.intake.workflowReason, null);
  assert.match(listed.stderr, /git\.remote-inventory=1(?:\s|$)/,
    'the aggregate must not repeat the base catalog for its additional intake fields');
});

test('workspace branch choices use approved configuration when application main has no workflow file', async () => {
  const { root } = await repository();
  git(root, 'push', 'origin', 'main:refs/heads/sflow/config');
  git(root, 'fetch', 'origin', 'refs/heads/sflow/config:refs/remotes/origin/sflow/config');
  git(root, 'rm', '-r', 'singularity', '.github/agents');
  git(root, 'commit', '-m', 'Keep application main free of configuration');
  const headBefore = git(root, 'rev-parse', 'HEAD').stdout.trim();

  const result = JSON.parse(flow(root, ['workspace', 'branches', '--json', '--intake']).stdout);

  assert.equal(result.remote, 'origin');
  assert.ok(result.choices.some((choice) => choice.branch === 'main' && choice.everywhere));
  assert.ok(result.intake.profiles.some((profile) => profile.id === 'epic-planning'));
  assert.ok(result.intake.storyWorkflows.some((workflow) =>
    workflow.id === 'feature' && workflow.installed === true));
  assert.equal(result.unreachable.length, 0);
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), headBefore);
  assert.equal(git(root, 'status', '--porcelain=v1').stdout, '');
});

test('new Story start ignores a malformed main workflow when sflow/config is approved', async () => {
  const { root } = await repository();
  git(root, 'push', 'origin', 'main:refs/heads/sflow/config');
  const localWorkflowFile = path.join(root, 'singularity/workflow.yml');
  await writeFile(localWorkflowFile, 'version: [invalid workflow\n');
  git(root, 'add', 'singularity/workflow.yml');
  git(root, 'commit', '-m', 'Application checkout carries a stale malformed workflow');
  const mainBefore = git(root, 'rev-parse', 'HEAD').stdout.trim();

  const started = JSON.parse(start(root, 'STORY-APPROVED-OVER-MAIN').stdout);

  assert.equal(started.outcome.status, 'succeeded');
  assert.equal(started.subject.id, 'STORY-APPROVED-OVER-MAIN');
  assert.equal(git(root, 'rev-parse', 'main').stdout.trim(), mainBefore);
  assert.equal(git(root, 'status', '--porcelain=v1').stdout, '');
  assert.ok(YAML.parse(await readFile(localWorkflowFile, 'utf8')).workTypes.feature,
    'the Story checkout uses the approved workflow instead of the malformed main bytes');
});

test('workspace intake and preflight prefer approved configuration over a divergent local workflow', async () => {
  const { base, root, remote } = await repository();
  git(root, 'push', 'origin', 'main:refs/heads/sflow/config');

  const publisher = path.join(base, 'configuration-publisher');
  git(base, 'clone', '--quiet', '--branch', 'sflow/config', remote, publisher);
  git(publisher, 'config', 'user.name', 'Configuration Publisher');
  git(publisher, 'config', 'user.email', 'configuration.publisher@example.com');
  const approvedWorkflowFile = path.join(publisher, 'singularity/workflow.yml');
  const approvedWorkflow = YAML.parse(await readFile(approvedWorkflowFile, 'utf8'));
  approvedWorkflow.workTypes.feature.label = 'Approved authority feature';
  await writeFile(approvedWorkflowFile, YAML.stringify(approvedWorkflow));
  git(publisher, 'add', 'singularity/workflow.yml');
  git(publisher, 'commit', '--quiet', '-m', 'Publish approved workflow label');
  git(publisher, 'push', '--quiet', 'origin', 'sflow/config');
  const approvedCommit = git(publisher, 'rev-parse', 'HEAD').stdout.trim();

  const localWorkflowFile = path.join(root, 'singularity/workflow.yml');
  const localWorkflow = YAML.parse(await readFile(localWorkflowFile, 'utf8'));
  localWorkflow.workTypes.feature.label = 'Divergent local feature';
  await writeFile(localWorkflowFile, YAML.stringify(localWorkflow));

  const result = JSON.parse(flow(root, [
    'workspace', 'branches', '--json', '--intake',
    '--preflight-story', 'STORY-AUTHORITY-PREVIEW',
    '--from-branch', 'release/24.3', '--work-type', 'feature'
  ]).stdout);

  assert.equal(result.intake.storyWorkflows.find((workflow) => workflow.id === 'feature')?.label,
    'Approved authority feature');
  assert.equal(result.preflight.passed, true);
  assert.equal(result.preflight.readiness.authority.branch, 'sflow/config');
  assert.equal(result.preflight.readiness.authority.commit, approvedCommit);
  assert.ok(result.preflight.readiness.checks.some((entry) =>
    entry.code === 'CONFIGURATION_AUTHORITY_VALID' && entry.status === 'pass'));
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(YAML.parse(await readFile(localWorkflowFile, 'utf8')).workTypes.feature.label,
    'Divergent local feature', 'the approved read must not rewrite the application checkout');
});

test('workspace preflight refuses a legacy base that does not carry the local workflow', async () => {
  const { root } = await repository();
  git(root, 'switch', 'release/24.3');
  git(root, 'rm', 'singularity/workflow.yml');
  git(root, 'commit', '--quiet', '-m', 'Remove governance from release base');
  git(root, 'push', '--quiet', 'origin', 'release/24.3');
  git(root, 'switch', 'main');
  git(root, 'branch', 'STORY-LEGACY-NO-GOVERNANCE', 'main');

  const refused = flow(root, [
    'workspace', 'branches', '--json', '--preflight-story', 'STORY-LEGACY-NO-GOVERNANCE',
    '--from-branch', 'release/24.3', '--work-type', 'feature'
  ], { allowFailure: true });

  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /"code": "STORY_CONFIGURATION_AUTHORITY_MISSING"/);
  assert.match(refused.stderr,
    /Selected base branch 'release\/24\.3' does not contain singularity\/workflow\.yml/);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'ls-remote', 'origin',
    'refs/heads/STORY-LEGACY-NO-GOVERNANCE').stdout.trim(), '');
});

test('remote publication preflight failure creates no branch, Story state, or session change', async () => {
  const { root, remote } = await repository();
  // Publication resolves and pins the exact push URL before preflight. Point that authority at a
  // missing repository rather than relying on remote.<name>.receivepack, which intentionally cannot
  // affect a literal-URL transport.
  git(root, 'config', 'remote.origin.pushurl', path.join(path.dirname(remote), 'missing.git'));
  const originalHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const result = flow(root, [
    'start', 'STORY-READ-ONLY', '--json', '--from-branch', 'release/24.3',
    '--work-type', 'feature', '--title', 'Read-only remote',
    '--description', 'Preflight must refuse before checkout.'
  ], { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot publish the new Story branch/);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), originalHead);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/STORY-READ-ONLY'], root,
    { allowFailure: true }).status, 1);
  await assert.rejects(readFile(path.join(root, 'singularity/work-items/STORY-READ-ONLY/workflow.json')), /ENOENT/);
});

test('a post-preflight push rejection retains the commit and sync publishes it later', async () => {
  const { root, remote } = await repository();
  const hook = path.join(remote, 'hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\necho rejected-after-dry-run >&2\nexit 1\n');
  await chmod(hook, 0o755);

  const failed = flow(root, [
    'start', 'STORY-RACE', '--json', '--from-branch', 'release/24.3',
    '--work-type', 'feature', '--title', 'Publication race',
    '--description', 'Retain an exact pending publication.'
  ], { allowFailure: true });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /retained locally but push failed/);
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'STORY-RACE');
  const pending = path.join(root, '.git/singularity-flow/pending-publication/story--STORY-RACE.json');
  const pendingRecord = JSON.parse(await readFile(pending, 'utf8'));
  assert.equal(pendingRecord.branch, 'STORY-RACE');
  assert.equal(pendingRecord.expectedRemoteSha, null,
    'initial Story publication records its create-only remote expectation');
  assert.equal(pendingRecord.pushOutcome, 'rejected');

  await rm(hook);
  flow(root, ['sync']);
  const localHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const remoteHead = git(root, 'ls-remote', 'origin', 'refs/heads/STORY-RACE').stdout.split(/\s+/)[0];
  assert.equal(remoteHead, localHead);
  await assert.rejects(readFile(pending), /ENOENT/);
});
