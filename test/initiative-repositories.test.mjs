import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
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
import { deriveInitiativeReport } from '../src/initiative-report.mjs';
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
    mobile: { url: mobile, defaultBranch: 'main', required: true, metadata: { appId: 'APP-MOBILE', name: 'Mobile application' } },
    api: { url: api, defaultBranch: 'main', required: true, metadata: { appId: 'APP-API', owner: 'Integration' } }
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
  const report = await deriveInitiativeReport(root, 'INIT-MULTI');
  assert.equal(report.children.total, 2);
  assert.equal(report.children.materialized, 0);
  assert.equal(report.children.epics[0].percentage, 0);
  const cyclic = structuredClone(valid);
  cyclic.epics[0].stories[0].dependsOn = [{ story: 'MOB-1' }];
  assert.throws(() => validateInitiativeBreakdown(cyclic, portfolio), /dependency cycle/);
  const unknown = structuredClone(valid);
  unknown.epics[0].stories[0].repository = 'unknown';
  assert.throws(() => validateInitiativeBreakdown(unknown, portfolio), /unknown repository/);
});

test('initiative breakdown loading rejects a symbolic-link replacement', async () => {
  const { root } = await repository();
  const { portfolio } = await loadInitiative(root, 'INIT-MULTI');
  const breakdown = path.join(root, 'singularity/initiatives/INIT-MULTI/breakdown.yml');
  const original = `${breakdown}.original`;
  await rename(breakdown, original);
  await symlink(original, breakdown);
  await assert.rejects(
    () => loadInitiativeBreakdown(root, portfolio, 'INIT-MULTI'),
    /breakdown cannot be a symbolic link/i
  );
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
  const report = await deriveInitiativeReport(root, 'INIT-MULTI');
  assert.equal(report.children.epics[0].id, 'EPIC-1');
  assert.equal(report.children.epics[0].stories[0].workId, 'API-1');
  assert.equal(report.children.materialized, 2);

  const check = path.join(root, 'check-api');
  run('git', ['clone', '--branch', 'API-1', api, check], { cwd: root });
  const seed = YAML.parse(await readFile(path.join(check, 'singularity/seeds/API-1.yml'), 'utf8'));
  assert.equal(seed.initiative.id, 'INIT-MULTI');
  assert.equal(seed.story.workId, 'API-1');
  assert.equal(seed.story.repository, 'api');
  assert.deepEqual(seed.story.repositoryMetadata, { appId: 'APP-API', owner: 'Integration' });

  const retry = await materializeInitiative(root, 'INIT-MULTI', { confirmation: 'INIT-MULTI' });
  assert.deepEqual(retry.attempt.stories.map((story) => story.status), ['attached', 'attached']);
});

test('materialization rejects a symbolic-link managed-clone cache', async () => {
  const { root } = await repository();
  const cache = path.join(root, '.git/singularity-flow/initiatives/INIT-MULTI/repositories');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-managed-clone-outside-'));
  await mkdir(cache, { recursive: true });
  await symlink(outside, path.join(cache, 'api'));
  const result = await materializeInitiative(root, 'INIT-MULTI', { confirmation: 'INIT-MULTI' });
  const api = result.attempt.stories.find((story) => story.repository === 'api');
  assert.equal(api.status, 'failed');
  assert.match(api.error, /managed clone.*cannot be a symbolic link/i);
  assert.deepEqual(await readdir(outside), []);
});

test('Jira materialization persists separate epic and story Jira IDs into breakdown and seeds', async () => {
  const { root, api } = await repository();
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.jira = { write: true, projectKey: 'PORT', epicIssueType: 'Epic', storyIssueType: 'Story' };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  let created = 100;
  const fetchImpl = async (_url, init) => {
    const payload = init.method === 'POST' && String(init.body).includes('"jql"')
      ? { issues: [] }
      : { id: String(created), key: `PORT-${created++}` };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const result = await materializeInitiative(root, 'INIT-MULTI', {
    confirmation: 'INIT-MULTI',
    env: { JIRA_BASE_URL: 'https://jira.example.com', JIRA_EMAIL: 'owner@example.com', JIRA_API_TOKEN: 'test' },
    fetchImpl
  });
  assert.equal(result.attempt.jira.epics['EPIC-1'].key, 'PORT-100');
  assert.equal(result.attempt.jira.stories['API-1'].key, 'PORT-101');
  const breakdown = YAML.parse(await readFile(path.join(root, 'singularity/initiatives/INIT-MULTI/breakdown.yml'), 'utf8'));
  assert.equal(breakdown.epics[0].jiraKey, 'PORT-100');
  assert.equal(breakdown.epics[0].stories[0].jiraKey, 'PORT-101');
  assert.equal(breakdown.epics[0].stories[1].jiraKey, 'PORT-102');

  const check = path.join(root, 'check-jira-api');
  run('git', ['clone', '--branch', 'API-1', api, check], { cwd: root });
  const seed = YAML.parse(await readFile(path.join(check, 'singularity/seeds/API-1.yml'), 'utf8'));
  assert.equal(seed.story.epicId, 'EPIC-1');
  assert.equal(seed.story.epicJiraKey, 'PORT-100');
  assert.equal(seed.story.jiraKey, 'PORT-101');
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
  assert.equal(initiative.childStories['API-1'].progress.percentage, 33);
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
