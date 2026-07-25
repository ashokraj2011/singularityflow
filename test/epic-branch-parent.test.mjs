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
