import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { initiativeMergeState, materializeInitiative } from '../src/initiative-repositories.mjs';
import { createInitiative, initiativeDir, loadInitiative, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

process.env.NODE_ENV = 'test';
process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Initiative Owner';
const ACTOR_EMAIL = 'initiative.owner@example.invalid';
const EPIC = 'INIT-LAND';

function git(cwd, ...args) { return run('git', args, { cwd }).stdout.trim(); }

// One repository that is both the Initiative lead and every Story's repository.
async function soloRepository(t, stories) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-landing-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'app.git');
  const root = path.join(base, 'app');
  run('git', ['init', '--bare', '-b', 'main', remote], { cwd: base });
  await mkdir(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Initiative Owner');
  git(root, 'config', 'user.email', ACTOR_EMAIL);
  await writeFile(path.join(root, 'README.md'), '# App\n');
  await initializeDefinition(root);
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Initiative Owner', email: ACTOR_EMAIL }];
  }
  portfolio.repositories = { app: { url: remote, defaultBranch: 'main', required: true } };
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initialize lead');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');

  git(root, 'switch', '-c', EPIC);
  const created = await createInitiative(root, { id: EPIC, profile: 'initiative-lite' });
  created.initiative.phases.define.status = 'approved';
  created.initiative.phases.plan.status = 'approved';
  created.initiative.phases.build.status = 'in_progress';
  created.initiative.currentPhase = 'build';
  const directory = initiativeDir(root, created.portfolio, EPIC);
  const output = Object.values(created.initiative.phases.define.outputs)[0];
  const body = `# Approved business case for ${EPIC}\n`;
  await mkdir(path.dirname(path.join(directory, output.path)), { recursive: true });
  await writeFile(path.join(directory, output.path), body);
  output.status = 'approved';
  output.sha256 = createHash('sha256').update(body).digest('hex');
  output.generation = 1;
  await saveInitiative(root, created.portfolio, created.initiative);
  await writeFile(path.join(directory, 'breakdown.yml'), YAML.stringify({
    version: 1, initiativeId: EPIC,
    epics: [{ id: 'EPIC-1', title: 'Landing', stories: stories.map((id) => ({ id, title: `Story ${id}`, repository: 'app', blocking: true })) }]
  }));
  git(root, 'add', '.');
  git(root, 'commit', '-m', `[${EPIC}][epic:init] governance artifacts`);
  git(root, 'push', '-u', 'origin', `HEAD:${EPIC}`);
  const result = await materializeInitiative(root, EPIC, { confirmation: EPIC });
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));

  const reviewer = path.join(base, 'reviewer');
  run('git', ['clone', '-q', '--branch', EPIC, remote, reviewer], { cwd: base });
  git(reviewer, 'config', 'user.name', 'Reviewer');
  git(reviewer, 'config', 'user.email', 'reviewer@example.invalid');
  return { root, reviewer };
}

test('squash merges, auto-deleted branches and pattern-named Story branches count as merged', async (t) => {
  const { root, reviewer } = await soloRepository(t, ['APP-1', 'APP-2', 'APP-3']);

  // APP-1 lands by squash and the host deletes its branch.
  git(reviewer, 'merge', '-q', '--squash', 'origin/APP-1');
  git(reviewer, 'commit', '-qm', 'APP-1 (squashed)');

  // APP-2 was delivered on a pattern-named branch, merged with history, then its seed branch removed.
  git(reviewer, 'switch', '-q', '-c', 'feature/APP-2', 'origin/APP-2');
  await writeFile(path.join(reviewer, 'APP-2.md'), 'delivered\n');
  git(reviewer, 'add', 'APP-2.md');
  git(reviewer, 'commit', '-qm', 'APP-2 delivery');
  git(reviewer, 'push', '-q', 'origin', 'feature/APP-2');
  git(reviewer, 'switch', '-q', EPIC);
  git(reviewer, 'merge', '-q', '--no-ff', '-m', 'Merge feature/APP-2', 'feature/APP-2');
  git(reviewer, 'push', '-q', 'origin', EPIC, ':APP-1', ':APP-2');

  const { portfolio, initiative } = await loadInitiative(root, EPIC);
  initiative.childStories['APP-2'] = { ...initiative.childStories['APP-2'], canonicalBranch: 'feature/APP-2' };
  await saveInitiative(root, portfolio, initiative);

  const plan = await initiativeMergeState(root, EPIC);
  assert.deepEqual(plan.unreachable, []);
  const status = Object.fromEntries(plan.stories.map((story) => [story.id, story.status]));
  assert.equal(status['APP-1'], 'merged');
  assert.equal(status['APP-2'], 'merged');
  assert.notEqual(status['APP-3'], 'merged', 'an unmerged Story stays outstanding');
  assert.deepEqual(plan.outstanding, ['APP-3']);
});
