import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyGitHost } from '../src/git-host.mjs';
import { repositoryCheckEvidence, storyCheckRemote } from '../src/github-evidence.mjs';
import { createPullRequest, storyPullRequestPlan } from '../src/pull-request.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { run } from '../src/util.mjs';

const COMMIT = 'c'.repeat(40);

test('remote hosts are classified from the URL alone; an unrecognised host may be GitHub Enterprise', () => {
  const provider = (url) => classifyGitHost(url).provider;
  assert.equal(provider('https://github.com/acme/app.git'), 'github');
  assert.equal(provider('git@github.example.invalid:acme/app.git'), 'github');
  assert.equal(provider('https://gitlab.com/acme/group/app.git'), 'gitlab');
  assert.equal(provider('ssh://git@gitlab.example.invalid:2222/acme/app.git'), 'gitlab');
  assert.equal(provider('git@bitbucket.org:acme/app.git'), 'bitbucket');
  assert.equal(provider('https://dev.azure.com/acme/project/_git/app'), 'azure-devops');
  assert.equal(provider('git@ssh.dev.azure.com:v3/acme/project/app'), 'azure-devops');
  assert.equal(provider('/srv/git/app.git'), 'local');
  assert.equal(provider('file:///srv/git/app.git'), 'local');
  assert.equal(provider('https://git.example.invalid/acme/app.git'), 'unknown');
  assert.equal(classifyGitHost('https://gitlab.example.invalid/acme/app.git').host, 'gitlab.example.invalid');
});

test('story checks with no required checks record ready evidence without asking any provider', () => {
  for (const url of ['https://gitlab.example.invalid/acme/app.git', 'https://github.com/acme/app.git']) {
    const evidence = repositoryCheckEvidence('/fixture', {
      workId: 'HOST-1', remote: { name: 'origin', url }, commit: COMMIT, requiredChecks: [],
      runCommand: () => assert.fail('no provider is asked when nothing is required')
    });
    assert.equal(evidence.ready, true);
    assert.equal(evidence.provider, 'not-required');
    assert.deepEqual(evidence.required, []);
  }
});

test('required checks on a non-GitHub host refuse with a manual route instead of gh auth login', () => {
  assert.throws(() => repositoryCheckEvidence('/fixture', {
    workId: 'HOST-2', remote: { name: 'upstream', url: 'git@gitlab.example.invalid:acme/group/app.git' },
    commit: COMMIT, requiredChecks: ['build'],
    runCommand: () => assert.fail('the GitHub CLI is never asked about another host')
  }), (error) => {
    assert.equal(error.code, 'STORY_CHECKS_HOST_UNSUPPORTED');
    assert.doesNotMatch(error.message, /gh auth login/u);
    assert.match(error.message, /remote 'upstream' is GitLab \(gitlab\.example\.invalid\)/u);
    assert.match(error.message, /build still count as not passed/u);
    assert.equal(error.details.provider, 'gitlab');
    assert.deepEqual(error.details.recoveryCommands.map((entry) => entry.command), ['singularity-flow pr describe HOST-2 --clipboard']);
    assert.ok(safeCommandGuidance(error.details.recoveryCommands[0]));
    assert.match(error.details.actions[0].label, /GitLab's own pipeline view/u);
    return true;
  });
  // GitHub (and an unrecognised host that may be GitHub Enterprise) still reads the checks.
  const calls = [];
  const evidence = repositoryCheckEvidence('/fixture', {
    workId: 'HOST-3', remote: { name: 'origin', url: 'git@git.example.invalid:acme/app.git' },
    commit: COMMIT, requiredChecks: ['build'],
    runCommand: (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'auth') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: JSON.stringify({ check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] }), stderr: '' };
    }
  });
  assert.equal(evidence.ready, true);
  assert.ok(calls.some((entry) => entry.join(' ').includes(`commits/${COMMIT}/check-runs`)));
});

test('story checks read the configured remote and fall back to a review checkout origin', () => {
  const remotes = (names) => (command, args) => names[args[2]]
    ? { status: 0, stdout: `${names[args[2]]}\n`, stderr: '' } : { status: 2, stdout: '', stderr: 'No such remote' };
  assert.deepEqual(storyCheckRemote('/fixture', { git: { remote: 'upstream' } }, remotes({
    upstream: 'https://gitlab.example.invalid/acme/app.git', origin: 'https://git.example.invalid/other.git'
  })), { name: 'upstream', url: 'https://gitlab.example.invalid/acme/app.git' });
  assert.deepEqual(storyCheckRemote('/fixture', { git: { remote: 'upstream' } }, remotes({
    origin: 'https://git.example.invalid/review.git'
  })), { name: 'origin', url: 'https://git.example.invalid/review.git' });
  assert.throws(() => storyCheckRemote('/fixture', { git: { remote: 'upstream' } }, remotes({})),
    (error) => error.code === 'STORY_CHECKS_REMOTE_MISSING' && /no remote 'upstream'/u.test(error.message));
});

test('a direct completion policy refuses a pull request with a coded route', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-direct-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main', root], { cwd: os.tmpdir() });
  run('git', ['config', 'user.name', 'Direct Policy'], { cwd: root });
  run('git', ['config', 'user.email', 'direct-policy@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# direct\n');
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', 'initial'], { cwd: root });
  run('git', ['switch', '-q', '-c', 'feature/DIRECT-1'], { cwd: root });
  const workflow = {
    workItem: { id: 'DIRECT-1', title: 'Direct', branch: 'DIRECT-1', baseBranch: 'main', workType: 'feature' },
    source: {}, phaseOrder: [], phases: {}, history: [],
    lineage: { canonicalBranch: 'DIRECT-1', branchCompletionPolicy: 'direct', childBranches: [{ name: 'feature/DIRECT-1' }], finalizations: [] }
  };
  await assert.rejects(storyPullRequestPlan(root, {}, workflow), (error) => {
    assert.equal(error.code, 'PULL_REQUEST_POLICY_DIRECT');
    assert.match(error.message, /it does not use pull requests/u);
    assert.deepEqual(error.details.recoveryCommands.map((entry) => entry.command), [
      'singularity-flow finalize --parent DIRECT-1',
      'singularity-flow story branch promote --parent DIRECT-1 --mode direct',
      'singularity-flow nextsteps DIRECT-1'
    ]);
    assert.equal(error.details.nextAction.command, 'singularity-flow finalize --parent DIRECT-1');
    for (const entry of error.details.recoveryCommands) assert.ok(safeCommandGuidance(entry), entry.command);
    return true;
  });
});

test('pull request creation refuses another host before needing the GitHub CLI', () => {
  const plan = { workId: 'HOST-4', base: 'main', head: 'HOST-4', title: 't', body: 'b', requiredChecks: [], blockedBy: [] };
  assert.throws(() => createPullRequest('/fixture', plan, {
    runCommand: (command) => command === 'git'
      ? { status: 0, stdout: 'https://bitbucket.org/acme/app.git\n', stderr: '' }
      : assert.fail('the GitHub CLI is never asked to open another host\'s pull request')
  }), (error) => {
    assert.equal(error.code, 'PULL_REQUEST_HOST_UNSUPPORTED');
    assert.match(error.message, /Bitbucket \(bitbucket\.org\)/u);
    assert.equal(error.details.recoveryCommands[0].command, 'singularity-flow pr describe HOST-4 --clipboard');
    return true;
  });
});

test('completion next steps follow the branch policy and the host', () => {
  const closed = (lineage) => ({
    workItem: { id: 'LAND-1', branch: 'LAND-1' }, status: 'closed', currentPhase: null,
    phaseOrder: ['delivery'], phases: { delivery: { id: 'delivery', status: 'approved', generation: 1 } },
    history: [], ...(lineage ? { lineage } : {})
  });
  const commands = (workflow, options) => workflowNextSteps(workflow, options).map((entry) => entry.command);
  assert.deepEqual(commands(closed()), [
    'singularity-flow gate --terminal', 'singularity-flow pr LAND-1', 'singularity-flow pr LAND-1 --create',
    'singularity-flow progress LAND-1', 'singularity-flow report LAND-1'
  ]);
  const gitlab = commands(closed(), { repositoryHost: classifyGitHost('git@gitlab.example.invalid:acme/app.git') });
  assert.ok(gitlab.includes('singularity-flow pr describe LAND-1 --clipboard'));
  assert.ok(!gitlab.some((command) => /--create/u.test(command)));
  const direct = commands(closed({ branchCompletionPolicy: 'direct', childBranches: [{ name: 'feature/LAND-1' }] }));
  assert.ok(!direct.some((command) => /singularity-flow pr /u.test(command)), direct.join('\n'));
  assert.ok(direct.includes('singularity-flow finalize --parent LAND-1'));
  assert.ok(direct.includes('singularity-flow story branch promote --parent LAND-1 --mode direct'));
});
