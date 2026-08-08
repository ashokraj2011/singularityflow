import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { materializeInitiative } from '../src/initiative-repositories.mjs';
import { createInitiative, initiativeDir, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

process.env.NODE_ENV = 'test';
process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Initiative Owner';
const ACTOR_EMAIL = 'initiative.owner@example.com';
const EPIC = 'INIT-SOLO';

function git(args, cwd) { return run('git', args, { cwd }).stdout.trim(); }

// One repository that is both the initiative lead and the only story repository —
// the single-repo, one-epic, many-stories case.
async function soloRepository(stories) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-parent-'));
  const remote = path.join(base, 'app.git');
  const root = path.join(base, 'app');
  run('git', ['init', '--bare', '-b', 'main', remote], { cwd: base });
  await mkdir(root);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', ACTOR_EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# App\n');
  await initializeDefinition(root);

  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Initiative Owner', email: ACTOR_EMAIL }];
  }
  // The single repository IS this repository.
  portfolio.repositories = { app: { url: remote, defaultBranch: 'main', required: true } };
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize lead'], { cwd: root });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: root });

  // Epic branch, named after the epic, carrying the governance artifacts.
  run('git', ['switch', '-c', EPIC], { cwd: root });
  const created = await createInitiative(root, { id: EPIC, profile: 'initiative-lite' });
  created.initiative.phases.define.status = 'approved';
  created.initiative.phases.plan.status = 'approved';
  created.initiative.phases.build.status = 'in_progress';
  created.initiative.currentPhase = 'build';

  // Approve one real artifact so the seed carries a verifiable approvedArtifacts entry.
  const directory = initiativeDir(root, created.portfolio, EPIC);
  const output = Object.values(created.initiative.phases.define.outputs)[0];
  const body = `# Approved business case for ${EPIC}\n\nThe governed decision record.\n`;
  const absolute = path.join(directory, output.path);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, body);
  output.status = 'approved';
  output.sha256 = createHash('sha256').update(body).digest('hex');
  output.generation = 1;
  await saveInitiative(root, created.portfolio, created.initiative);

  const breakdown = {
    version: 1,
    initiativeId: EPIC,
    epics: [{
      id: 'EPIC-1',
      title: 'Single repository feature',
      stories: stories.map((id) => ({ id, title: `Story ${id}`, repository: 'app', blocking: true }))
    }]
  };
  await writeFile(path.join(directory, 'breakdown.yml'), YAML.stringify(breakdown));

  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', `[${EPIC}][epic:init] governance artifacts`], { cwd: root });
  run('git', ['push', '-u', 'origin', `HEAD:${EPIC}`], { cwd: root });

  return { root, base, remote, directory, approvedPath: output.path, approvedSha: output.sha256 };
}

test('single repo: story branches descend from the epic branch and can verify the approved artifacts', async () => {
  const stories = ['APP-1', 'APP-2', 'APP-3'];
  const { root, base, remote, approvedPath, approvedSha } = await soloRepository(stories);

  const result = await materializeInitiative(root, EPIC, { confirmation: EPIC });
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));

  const epicHead = git(['rev-parse', `refs/heads/${EPIC}`], remote);

  for (const story of stories) {
    const check = path.join(base, `verify-${story}`);
    run('git', ['clone', '--branch', story, remote, check], { cwd: base });

    // 1. Real git ancestry: the epic branch head is an ancestor of the story branch.
    const ancestor = run('git', ['merge-base', '--is-ancestor', epicHead, 'HEAD'], { cwd: check, allowFailure: true });
    assert.equal(ancestor.status, 0, `${story} must descend from the epic branch ${EPIC}`);

    // 2. The seed's approved artifacts resolve on the story branch and hash-match.
    const seed = YAML.parse(await readFile(path.join(check, 'singularity/seeds', `${story}.yml`), 'utf8'));
    assert.ok(seed.approvedArtifacts.length > 0, 'seed must carry approved artifacts');
    for (const artifact of seed.approvedArtifacts) {
      const repoPath = path.join('singularity/initiatives', EPIC, artifact.path);
      const absolute = path.join(check, repoPath);
      const content = await readFile(absolute, 'utf8').catch(() => null);
      assert.ok(content !== null, `${story}: approved artifact ${repoPath} must exist on the story branch`);
      assert.equal(createHash('sha256').update(content).digest('hex'), artifact.sha256, `${story}: ${repoPath} must match its approved hash`);
    }
    assert.ok(seed.approvedArtifacts.some((item) => item.path === approvedPath && item.sha256 === approvedSha));

    // 3. Lineage records the parent branch.
    assert.equal(seed.story.parentBranch, EPIC);
    assert.equal(seed.initiative.branch, EPIC);
  }
});

test('stories in other repositories still branch from that repository default branch', async () => {
  // Reuse the multi-repo fixture shape: the lead repo has no shared remote with mobile/api,
  // so those stories must keep branching from their own default branch.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-parent-multi-'));
  const childRemote = path.join(base, 'api.git');
  const childSeed = path.join(base, 'api-seed');
  run('git', ['init', '--bare', '-b', 'main', childRemote], { cwd: base });
  await mkdir(childSeed);
  run('git', ['init', '-b', 'main'], { cwd: childSeed });
  run('git', ['config', 'user.name', 'Fixture'], { cwd: childSeed });
  run('git', ['config', 'user.email', 'fixture@example.com'], { cwd: childSeed });
  await writeFile(path.join(childSeed, 'README.md'), '# api\n');
  run('git', ['add', '.'], { cwd: childSeed });
  run('git', ['commit', '-m', 'Initial'], { cwd: childSeed });
  run('git', ['remote', 'add', 'origin', childRemote], { cwd: childSeed });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: childSeed });

  const root = path.join(base, 'lead');
  await mkdir(root);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', ACTOR_EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Lead\n');
  await initializeDefinition(root);
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Initiative Owner', email: ACTOR_EMAIL }];
  }
  portfolio.repositories = { api: { url: childRemote, defaultBranch: 'main', required: true } };
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize lead'], { cwd: root });
  run('git', ['switch', '-c', EPIC], { cwd: root });

  const created = await createInitiative(root, { id: EPIC, profile: 'initiative-lite' });
  created.initiative.phases.define.status = 'approved';
  created.initiative.phases.plan.status = 'approved';
  created.initiative.phases.build.status = 'in_progress';
  created.initiative.currentPhase = 'build';
  await saveInitiative(root, created.portfolio, created.initiative);
  const directory = initiativeDir(root, created.portfolio, EPIC);
  await writeFile(path.join(directory, 'breakdown.yml'), YAML.stringify({
    version: 1,
    initiativeId: EPIC,
    epics: [{ id: 'EPIC-1', title: 'Cross repo', stories: [{ id: 'API-9', title: 'API work', repository: 'api', blocking: true }] }]
  }));

  const result = await materializeInitiative(root, EPIC, { confirmation: EPIC });
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));

  // No epic branch is fabricated in the child repository.
  const branches = run('git', ['ls-remote', '--heads', childRemote], { cwd: base }).stdout;
  assert.ok(branches.includes('refs/heads/API-9'));
  assert.ok(!branches.includes(`refs/heads/${EPIC}`), 'no epic branch should be created in another repository');

  // The story is based on that repository's default branch, and records it as its parent.
  const check = path.join(base, 'verify-api');
  run('git', ['clone', '--branch', 'API-9', childRemote, check], { cwd: base });
  const mainHead = git(['rev-parse', 'refs/heads/main'], childRemote);
  assert.equal(run('git', ['merge-base', '--is-ancestor', mainHead, 'HEAD'], { cwd: check, allowFailure: true }).status, 0);
  const seed = YAML.parse(await readFile(path.join(check, 'singularity/seeds/API-9.yml'), 'utf8'));
  assert.equal(seed.story.parentBranch, 'main');
  assert.equal(seed.story.baseCommit, mainHead);
});

test('merge sequence orders stories by dependency and gates the epic until all blocking stories merge', async () => {
  const { initiativeMergeSequence, validateInitiativeBreakdown } = await import('../src/initiative-repositories.mjs');
  const portfolio = { repositories: { app: { url: 'x', defaultBranch: 'main' } } };
  // Diamond: A -> B, A -> C, then D depends on both B and C.
  const breakdown = validateInitiativeBreakdown({
    version: 1,
    initiativeId: EPIC,
    epics: [{
      id: 'EPIC-1',
      title: 'Diamond',
      stories: [
        { id: 'D', title: 'D', repository: 'app', dependsOn: [{ story: 'B' }, { story: 'C' }] },
        { id: 'B', title: 'B', repository: 'app', dependsOn: [{ story: 'A' }] },
        { id: 'C', title: 'C', repository: 'app', dependsOn: [{ story: 'A' }] },
        { id: 'A', title: 'A', repository: 'app' }
      ]
    }]
  }, portfolio);

  const nothingDone = initiativeMergeSequence(breakdown);
  assert.deepEqual(nothingDone.stories.map((story) => story.id), ['A', 'B', 'C', 'D']);
  assert.equal(nothingDone.epicReady, false);
  // A has no dependencies but its own work is unfinished.
  assert.equal(nothingDone.stories[0].status, 'in-progress');
  assert.equal(nothingDone.nextToMerge, null);
  // D is blocked by both B and C.
  assert.deepEqual(nothingDone.stories[3].blockedBy, ['B', 'C']);

  // A is finished and mergeable; everything downstream is still blocked.
  const aReady = initiativeMergeSequence(breakdown, { complete: ['A', 'D'] });
  assert.equal(aReady.nextToMerge.id, 'A');
  assert.equal(aReady.stories[3].status, 'blocked');

  // With A merged, B and C unblock; D still waits on C.
  const aMerged = initiativeMergeSequence(breakdown, { merged: ['A'], complete: ['B', 'C', 'D'] });
  assert.equal(aMerged.stories[0].status, 'merged');
  assert.equal(aMerged.nextToMerge.id, 'B');
  assert.deepEqual(aMerged.stories[3].blockedBy, ['B', 'C']);

  // Everything merged: the epic may land.
  const allMerged = initiativeMergeSequence(breakdown, { merged: ['A', 'B', 'C', 'D'] });
  assert.equal(allMerged.epicReady, true);
  assert.deepEqual(allMerged.outstanding, []);
  assert.equal(allMerged.nextToMerge, null);
});

test('epic merge-plan reports the live sequence from Git', async () => {
  const stories = ['APP-1', 'APP-2'];
  const { root } = await soloRepository(stories);
  await materializeInitiative(root, EPIC, { confirmation: EPIC });

  const { initiativeMergeState } = await import('../src/initiative-repositories.mjs');
  const plan = await initiativeMergeState(root, EPIC);
  assert.equal(plan.epicBranch, EPIC);
  assert.deepEqual(plan.unreachable, []);
  assert.deepEqual(plan.stories.map((story) => story.id), stories);
  // Freshly materialized: branches exist and are ahead of the epic branch, so nothing has merged
  // and no story has finished its own workflow yet.
  assert.ok(plan.stories.every((story) => story.status === 'in-progress'));
  assert.equal(plan.epicReady, false);
  assert.deepEqual(plan.outstanding, stories);
});

test('Epic stack sync publishes an orphan control-plane manifest to participating repositories', async () => {
  const stories = ['APP-1', 'APP-2'];
  const { root, remote } = await soloRepository(stories);
  await materializeInitiative(root, EPIC, { confirmation: EPIC });
  const { syncStoryStack, storyStackPath } = await import('../src/story-stack.mjs');
  const result = await syncStoryStack(root, EPIC);
  assert.equal(result.publications.length, 1);
  assert.equal(result.publications[0].branch, 'state');
  const text = run('git', ['show', `refs/heads/state:${storyStackPath(EPIC)}`], { cwd: remote }).stdout;
  const stored = JSON.parse(text);
  assert.equal(stored.initiativeId, EPIC);
  assert.deepEqual(stored.stories.map((story) => story.workId), stories);
  assert.notEqual(run('git', ['merge-base', 'refs/heads/main', 'refs/heads/state'], { cwd: remote, allowFailure: true }).status, 0);
});

test('story pull request targets the epic branch and is built from committed state', async () => {
  const { pullRequestTarget, storyPullRequestBody, createStoryPullRequest, updateStoryPullRequest } = await import('../src/pull-request.mjs');
  const workflow = {
    workItem: { id: 'APP-1', title: 'Add priority', branch: 'APP-1', baseBranch: 'main', workType: 'feature' },
    source: {}
  };
  const seed = {
    initiative: { id: EPIC, branch: EPIC },
    story: {
      parentBranch: EPIC,
      baseCommit: 'a'.repeat(40),
      acceptanceCriteria: ['Priority is persisted', 'Reader sorts by priority'],
      requiredChecks: ['build'],
      branchCompletionPolicy: 'pr',
      epicJiraKey: 'KAN-8',
      jiraKey: 'KAN-12'
    },
    approvedArtifacts: [{ phase: 'define', output: 'business-case', path: 'artifacts/define/business-case.md', sha256: 'b'.repeat(64) }]
  };

  // The pull request targets the epic branch, not the repository default branch.
  assert.deepEqual(pullRequestTarget(workflow, seed), { base: EPIC, head: 'APP-1' });
  assert.deepEqual(pullRequestTarget(workflow, null), { base: 'main', head: 'APP-1' });

  const body = storyPullRequestBody(workflow, seed);
  assert.match(body, /Epic: `INIT-SOLO` \(Jira KAN-8\)/);
  assert.match(body, /Branched from: `INIT-SOLO` at `aaaaaaaa`/);
  assert.match(body, /Priority is persisted/);
  assert.match(body, /business-case\.md` — define\/business-case @ `bbbbbbbbbbbb`/);
  assert.match(body, /Editable draft generated deterministically/);
  assert.match(body, /not a governed lifecycle artifact/);

  // A story whose dependencies have not merged cannot open a pull request.
  const blocked = { workId: 'APP-2', base: EPIC, head: 'APP-2', title: 't', body: 'b', requiredChecks: [], blockedBy: ['APP-1'] };
  assert.throws(() => createStoryPullRequest('/tmp', blocked, { runCommand: () => ({ status: 0, stdout: '', stderr: '' }) }), /APP-1 must merge/);

  // An existing pull request is reported rather than duplicated.
  const calls = [];
  const stub = (command, args) => {
    calls.push(`${command} ${args[0]}`);
    if (command === 'git') return { status: 0, stdout: 'git@git.example.corp:acme/app.git', stderr: '' };
    if (args[0] === 'auth') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: 'https://git.example.corp/acme/app/pull/7', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const ready = { workId: 'APP-1', base: EPIC, head: 'APP-1', title: 't', body: 'b', requiredChecks: [], blockedBy: [] };
  const result = createStoryPullRequest('/tmp', ready, { runCommand: stub });
  assert.equal(result.status, 'existing');
  assert.equal(result.url, 'https://git.example.corp/acme/app/pull/7');
  assert.ok(!calls.includes('gh pr create'));

  const updateCalls = [];
  const updateResult = updateStoryPullRequest('/tmp', ready, { runCommand: (command, args) => {
    updateCalls.push([command, ...args]);
    if (args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: '{"number":7,"url":"https://git.example.corp/acme/app/pull/7"}', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  } });
  assert.equal(updateResult.status, 'updated');
  assert.ok(updateCalls.some((args) => args[0] === 'gh' && args[1] === 'pr' && args[2] === 'edit'));
  assert.ok(!updateCalls.some((args) => args.includes('create')), 'description updates never create a pull request');
});

test('Epic pull requests land only after the blocking Story stack has merged', async () => {
  const { root } = await soloRepository(['APP-1', 'APP-2']);
  const {
    createPullRequest, epicPullRequestBody, epicPullRequestPlan
  } = await import('../src/pull-request.mjs');
  const initiative = {
    initiative: { id: EPIC, title: 'Single repository feature', profile: 'initiative-lite', branch: EPIC },
    status: 'in_progress'
  };
  const blockedSequence = {
    initiativeId: EPIC,
    epicBranch: EPIC,
    epicReady: false,
    outstanding: ['APP-2'],
    unreachable: [],
    stories: [
      { id: 'APP-1', workId: 'APP-1', blocking: true, status: 'merged' },
      { id: 'APP-2', workId: 'APP-2', blocking: true, status: 'in-progress' }
    ]
  };
  const blocked = epicPullRequestPlan(root, {}, initiative, blockedSequence);
  assert.equal(blocked.base, 'main');
  assert.equal(blocked.head, EPIC);
  assert.deepEqual(blocked.blockedBy, ['APP-2']);
  assert.match(blocked.body, /APP-1: \*\*merged\*\*/);
  assert.match(epicPullRequestBody(initiative, blockedSequence), /Not ready: APP-2/);
  assert.throws(
    () => createPullRequest(root, blocked, { runCommand: () => ({ status: 0, stdout: '', stderr: '' }) }),
    /APP-2 must merge/
  );

  const ready = epicPullRequestPlan(root, {}, initiative, {
    ...blockedSequence,
    epicReady: true,
    outstanding: [],
    stories: blockedSequence.stories.map((story) => ({ ...story, status: 'merged' }))
  });
  const calls = [];
  const result = createPullRequest(root, ready, { runCommand: (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git') return { status: 0, stdout: 'git@git.example.corp:acme/app.git', stderr: '' };
    if (args[0] === 'auth') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'create') return { status: 0, stdout: 'https://git.example.corp/acme/app/pull/9\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  } });
  assert.equal(result.status, 'created');
  assert.equal(result.url, 'https://git.example.corp/acme/app/pull/9');
  assert.ok(calls.some((args) => args[0] === 'gh' && args[1] === 'pr' && args[2] === 'create'));
});

test('impact map validation rejects unknown repositories and undeclared world-model views', async () => {
  const { validateImpactMap } = await import('../src/initiative-repositories.mjs');
  const portfolio = { repositories: { api: { url: 'x' }, web: { url: 'y' } } };
  const manifest = { views: { architecture: { path: 'views/architecture.md' }, security: { path: 'views/security.md' } } };

  const good = { version: 1, repositories: { api: { worldModelViews: ['architecture'] } } };
  assert.deepEqual(validateImpactMap(portfolio, manifest, good, { mode: 'enforce' }), { errors: [], warnings: [] });

  const unknownRepo = { version: 1, repositories: { ghost: { worldModelViews: ['architecture'] } } };
  assert.match(validateImpactMap(portfolio, manifest, unknownRepo, { mode: 'enforce' }).errors[0], /unknown repository 'ghost'/);

  const unknownView = { version: 1, repositories: { api: { worldModelViews: ['telepathy'] } } };
  assert.match(validateImpactMap(portfolio, manifest, unknownView, { mode: 'enforce' }).errors[0], /undeclared world-model view 'telepathy'/);

  // Outside enforce the same findings surface as warnings rather than blocking.
  const warned = validateImpactMap(portfolio, manifest, unknownView, { mode: 'warn' });
  assert.equal(warned.errors.length, 0);
  assert.equal(warned.warnings.length, 1);
});

test('worldModelRebuildReason reports a missing model without throwing', async () => {
  const { worldModelRebuildReason } = await import('../src/grounding.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-reason-'));
  const reason = await worldModelRebuildReason(root, { worldModel: { outputDir: 'singularity/world-model' } });
  assert.match(reason, /has not been built/);
});

test('publishing a phase blocks an impact map naming an unknown repository under enforce', async () => {
  const { publishInitiativePhase } = await import('../src/initiative-evidence.mjs');
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-impact-publish-'));
  const root = path.join(base, 'lead');
  await mkdir(root);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', ACTOR_EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Lead\n');
  await initializeDefinition(root);

  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Initiative Owner', email: ACTOR_EMAIL }];
  }
  portfolio.repositories = { app: { url: path.join(base, 'app.git'), defaultBranch: 'main', required: true } };
  // Isolate the impact gate: keep the outputs other phases reference, but drop their upstream
  // input requirements so publication reaches the impact check.
  for (const output of portfolio.initiativePhases.plan.outputs) { delete output.consumes; output.required = false; }
  // Give the phase a repository-map output so the impact gate applies.
  portfolio.initiativePhases.plan.outputs.push({
    id: 'repository-map', label: 'Repository map', kind: 'yaml', path: 'repository-map.yml', template: 'initiatives/generic-output.yml'
  });
  await writeFile(portfolioFile, YAML.stringify(portfolio));

  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.worldModel.grounding = 'enforce';
  await writeFile(definitionFile, YAML.stringify(definition));

  // A committed world model declaring exactly one view.
  const modelDir = path.join(root, 'singularity/world-model');
  await mkdir(modelDir, { recursive: true });
  await writeFile(path.join(modelDir, 'manifest.json'), JSON.stringify({ views: { architecture: { path: 'views/architecture.md' } } }));

  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize lead'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-IMPACT'], { cwd: root });
  const created = await createInitiative(root, { id: 'INIT-IMPACT', profile: 'initiative-lite' });
  created.initiative.currentPhase = 'plan';
  created.initiative.phases.define.status = 'approved';
  created.initiative.phases.plan.status = 'in_progress';
  await saveInitiative(root, created.portfolio, created.initiative);

  const directory = initiativeDir(root, created.portfolio, 'INIT-IMPACT');
  const mapPath = path.join(directory, created.initiative.phases.plan.outputs['repository-map'].path);
  await mkdir(path.dirname(mapPath), { recursive: true });

  // An unknown repository is rejected outright.
  await writeFile(mapPath, YAML.stringify({ version: 1, repositories: { ghost: { worldModelViews: ['architecture'] } } }));
  await assert.rejects(() => publishInitiativePhase(root, 'INIT-IMPACT', 'plan'), /unknown repository 'ghost'/);

  // So is a view the committed world model does not declare.
  await writeFile(mapPath, YAML.stringify({ version: 1, repositories: { app: { worldModelViews: ['telepathy'] } } }));
  await assert.rejects(() => publishInitiativePhase(root, 'INIT-IMPACT', 'plan'), /undeclared world-model view 'telepathy'/);
});
