import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { listEpicReviewInbox } from '../src/epic-review.mjs';
import { gitDir } from '../src/git.mjs';
import { createInitiative, initiativeDir, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

function git(root, args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

test('Epic review clone keeps the approved raw origin and refuses a changed cached origin', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-review-transport-'));
  const source = path.join(parent, 'source');
  const remote = path.join(parent, 'delivery.git');
  const lead = path.join(parent, 'lead');
  await mkdir(source);
  await mkdir(lead);
  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Review Tester']);
  git(source, ['config', 'user.email', 'review@example.com']);
  await writeFile(path.join(source, 'README.md'), '# Delivery\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Delivery']);
  git(parent, ['init', '--bare', remote]);
  git(source, ['push', remote, 'main']);

  git(lead, ['init', '-b', 'main']);
  git(lead, ['config', 'user.name', 'Review Tester']);
  git(lead, ['config', 'user.email', 'review@example.com']);
  await initializeDefinition(lead);
  const portfolioPath = path.join(lead, 'singularity/portfolio.yml');
  const configured = YAML.parse(await readFile(portfolioPath, 'utf8'));
  configured.repositories = { delivery: { url: remote, defaultBranch: 'main', required: true } };
  configured.git.publish = 'off';
  for (const authority of Object.values(configured.approvalAuthorities ?? {})) {
    authority.members = [{ name: 'Review Tester', email: 'review@example.com' }];
  }
  await writeFile(portfolioPath, YAML.stringify(configured));
  git(lead, ['add', '.']);
  git(lead, ['commit', '-m', 'Initialize']);
  git(lead, ['switch', '-c', 'EPIC-REVIEW']);
  const { portfolio, initiative } = await createInitiative(lead, {
    id: 'EPIC-REVIEW', title: 'Review clone test', profile: 'epic-planning', agent: 'product-owner'
  });
  await writeFile(path.join(initiativeDir(lead, portfolio, 'EPIC-REVIEW'), 'breakdown.yml'), YAML.stringify({
    version: 2,
    initiativeId: 'EPIC-REVIEW',
    epics: [{
      planId: 'EPIC-001', title: 'Delivery', stories: [{
        planId: 'STORY-001', workId: 'WRK-REVIEW', title: 'Inspect delivery', repository: 'delivery',
        requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], dependsOn: []
      }]
    }]
  }));
  await saveInitiative(lead, portfolio, initiative);
  git(lead, ['add', '.']);
  git(lead, ['commit', '-m', 'Plan story']);

  assert.deepEqual(await listEpicReviewInbox(lead, 'EPIC-REVIEW'), []);
  const clone = path.join(gitDir(lead), 'singularity-flow', 'reviews', 'EPIC-REVIEW', 'delivery');
  assert.equal(git(clone, ['config', '--local', '--get', 'remote.origin.url']), remote);

  git(clone, ['remote', 'set-url', 'origin', path.join(parent, 'different.git')]);
  await assert.rejects(listEpicReviewInbox(lead, 'EPIC-REVIEW'), /origin differs from the approved repository URL/);
});
