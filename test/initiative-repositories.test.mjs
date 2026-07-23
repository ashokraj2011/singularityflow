import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  initiativeBreakdownReview,
  initiativeMilestoneReadiness,
  loadInitiativeBreakdown,
  materializeInitiative,
  syncInitiativeRepositories,
  validateInitiativeBreakdown
} from '../src/initiative-repositories.mjs';
import {
  createInitiative, initiativeDir, loadInitiative, saveInitiative
} from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

process.env.NODE_ENV = 'test';
process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Initiative Owner';
const ACTOR_EMAIL = 'initiative.owner@example.com';

async function childRemote(base, name) {
  const remote = path.join(base, `${name}.git`);
  const seed = path.join(base, `${name}-seed`);
  run('git', ['init', '--bare', remote], { cwd: base });
  await mkdir(seed);
  run('git', ['init', '-b', 'main'], { cwd: seed });
  run('git', ['config', 'user.name', 'Fixture'], { cwd: seed });
  run('git', ['config', 'user.email', 'fixture@example.com'], { cwd: seed });
  await writeFile(path.join(seed, 'README.md'), `# ${name}\n`);
  run('git', ['add', '.'], { cwd: seed });
  run('git', ['commit', '-m', 'Initial'], { cwd: seed });
  run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: seed });
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remote });
  return remote;
}

async function repository() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-repositories-'));
  const mobile = await childRemote(base, 'mobile');
  const api = await childRemote(base, 'api');
  const root = path.join(base, 'lead');
  await mkdir(root);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', ACTOR_EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Lead\n');
  await initializeDefinition(root);
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Initiative Owner', email: ACTOR_EMAIL }];
  portfolio.repositories = {
    mobile: { url: mobile, defaultBranch: 'main', required: true },
    api: { url: api, defaultBranch: 'main', required: true }
  };
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize lead'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-MULTI'], { cwd: root });
  const created = await createInitiative(root, { id: 'INIT-MULTI', profile: 'initiative-lite' });
  created.initiative.phases.define.status = 'approved';
  created.initiative.phases.plan.status = 'approved';
  created.initiative.phases.build.status = 'in_progress';
  created.initiative.currentPhase = 'build';
  await saveInitiative(root, created.portfolio, created.initiative);
  const breakdown = {
    version: 1,
    initiativeId: 'INIT-MULTI',
    epics: [{
      id: 'EPIC-1',
      title: 'Cross repository feature',
      stories: [
        { id: 'API-1', title: 'Create API', repository: 'api', blocking: true },
        { id: 'MOB-1', title: 'Use API', repository: 'mobile', blocking: true, dependsOn: [{ story: 'API-1', requiredPhase: 'implementation-spec' }] }
      ]
    }]
  };
  await writeFile(path.join(initiativeDir(root, created.portfolio, 'INIT-MULTI'), 'breakdown.yml'), YAML.stringify(breakdown));
  return { root, base, mobile, api };
}

test('breakdown validation enforces repositories, unique stories, and an acyclic dependency graph', async () => {
  const { root } = await repository();
  const { portfolio } = await loadInitiative(root, 'INIT-MULTI');
  const valid = await loadInitiativeBreakdown(root, portfolio, 'INIT-MULTI');
  assert.deepEqual(valid.stories.map((story) => story.id), ['API-1', 'MOB-1']);
  const cyclic = structuredClone(valid);
  cyclic.epics[0].stories[0].dependsOn = [{ story: 'MOB-1' }];
  assert.throws(() => validateInitiativeBreakdown(cyclic, portfolio), /dependency cycle/);
  const unknown = structuredClone(valid);
  unknown.epics[0].stories[0].repository = 'unknown';
  assert.throws(() => validateInitiativeBreakdown(unknown, portfolio), /unknown repository/);
});

test('materialization previews then creates idempotent repository story branches and seeds', async () => {
  const { root, mobile, api } = await repository();
  const preview = await materializeInitiative(root, 'INIT-MULTI', { dryRun: true });
  assert.equal(preview.review.stories.length, 2);
  assert.equal(run('git', ['ls-remote', '--heads', api, 'refs/heads/API-1'], { cwd: root }).stdout.trim(), '');
  await assert.rejects(() => materializeInitiative(root, 'INIT-MULTI', { confirmation: 'wrong' }), /exact initiative confirmation/);

  const result = await materializeInitiative(root, 'INIT-MULTI', { confirmation: 'INIT-MULTI' });
  assert.equal(result.failures.length, 0);
  assert.equal(result.attempt.status, 'complete');
  assert.match(run('git', ['ls-remote', '--heads', api, 'refs/heads/API-1'], { cwd: root }).stdout, /refs\/heads\/API-1/);
  assert.match(run('git', ['ls-remote', '--heads', mobile, 'refs/heads/MOB-1'], { cwd: root }).stdout, /refs\/heads\/MOB-1/);

  const check = path.join(root, 'check-api');
  run('git', ['clone', '--branch', 'API-1', api, check], { cwd: root });
  const seed = YAML.parse(await readFile(path.join(check, 'singularity/seeds/API-1.yml'), 'utf8'));
  assert.equal(seed.initiative.id, 'INIT-MULTI');
  assert.equal(seed.story.repository, 'api');

  const retry = await materializeInitiative(root, 'INIT-MULTI', { confirmation: 'INIT-MULTI' });
  assert.deepEqual(retry.attempt.stories.map((story) => story.status), ['attached', 'attached']);
});

test('repository sync observes child workflow milestones and all-blocking readiness', async () => {
  const { root, api } = await repository();
  await materializeInitiative(root, 'INIT-MULTI', { confirmation: 'INIT-MULTI' });
  const author = path.join(root, 'author-api');
  run('git', ['clone', '--branch', 'API-1', api, author], { cwd: root });
  run('git', ['config', 'user.name', 'API Developer'], { cwd: author });
  run('git', ['config', 'user.email', 'api@example.com'], { cwd: author });
  await mkdir(path.join(author, 'singularity/work-items/API-1'), { recursive: true });
  await writeFile(path.join(author, 'singularity/work-items/API-1/workflow.json'), JSON.stringify({
    schemaVersion: 2,
    workItem: { id: 'API-1' },
    status: 'in_progress',
    currentPhase: 'implementation',
    phases: {
      'implementation-spec': { status: 'approved' },
      verification: { status: 'not_started' },
      conformance: { status: 'not_started' }
    }
  }, null, 2));
  run('git', ['add', '.'], { cwd: author });
  run('git', ['commit', '-m', 'Add child workflow'], { cwd: author });
  run('git', ['push'], { cwd: author });

  const synchronized = await syncInitiativeRepositories(root, 'INIT-MULTI');
  assert.equal(synchronized.results.filter((item) => item.status === 'synchronized').length, 2);
  const initiative = (await loadInitiative(root, 'INIT-MULTI')).initiative;
  assert.equal(initiative.childStories['API-1'].milestones.implementationSpec, true);
  assert.equal(initiative.childStories['MOB-1'].blocked, false);
  const readiness = initiativeMilestoneReadiness(initiative, 'construction');
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.incomplete.map((story) => story.id).sort(), ['API-1', 'MOB-1']);
});

test('breakdown review can probe participating repositories without materializing them', async () => {
  const { root } = await repository();
  const review = await initiativeBreakdownReview(root, 'INIT-MULTI', { probe: true });
  assert.equal(review.epics, 1);
  assert.equal(review.repositories.api.reachable, true);
  assert.equal(review.repositories.mobile.reachable, true);
});
