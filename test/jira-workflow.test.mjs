import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { initializeDefinition } from '../src/config.mjs';

function exec(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-jira-workflow-'));
  exec('git', ['init', '-b', 'main'], root);
  exec('git', ['config', 'user.name', 'Singularity Flow Test'], root);
  exec('git', ['config', 'user.email', 'singularity-flow@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Test\n');
  await initializeDefinition(root);
  exec('git', ['add', 'README.md', '.singularity'], root);
  exec('git', ['commit', '-m', 'initial'], root);
  exec('git', ['checkout', '-b', 'PAY-142'], root);
  return root;
}

test('Jira-backed workflow writes a readable user-story snapshot', async () => {
  const root = await repository();
  const config = await loadConfig(root);
  const source = {
    type: 'jira',
    id: '10042',
    key: 'PAY-142',
    title: 'Add payment retry policy',
    issueType: 'Story',
    project: { key: 'PAY', name: 'Payments' },
    status: 'In Progress',
    statusCategory: 'In Progress',
    priority: 'High',
    assignee: 'Developer One',
    reporter: 'Product Owner',
    description: 'Retry transient failures without retrying validation failures.',
    acceptanceCriteria: '- Retry at most three times\n- Emit retry metrics',
    storyPoints: 5,
    sprints: [{ id: 7, name: 'Sprint 12', state: 'active' }],
    labels: ['backend'],
    components: ['Payments'],
    subtasks: [{ key: 'PAY-143', title: 'Add unit tests', status: 'To Do' }],
    issueLinks: [],
    attachments: [],
    url: 'https://example.atlassian.net/browse/PAY-142',
    fetchedAt: '2026-07-21T00:00:00.000Z'
  };

  await createWorkflow(root, config, {
    id: 'PAY-142',
    title: source.title,
    source,
    baseBranch: 'main'
  });

  const story = await readFile(path.join(root, '.singularity', 'work-items', 'PAY-142', 'USER-STORY.md'), 'utf8');
  assert.match(story, /# PAY-142 — Add payment retry policy/);
  assert.match(story, /## Acceptance criteria/);
  assert.match(story, /Retry at most three times/);
  assert.match(story, /Story points: 5/);
  assert.match(story, /PAY-143/);

  const readme = await readFile(path.join(root, '.singularity', 'work-items', 'PAY-142', 'README.md'), 'utf8');
  assert.match(readme, /USER-STORY\.md/);
});
