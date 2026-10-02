import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import {
  AGENT_CLARIFICATION_GUIDANCE, REPOSITORY_AGENT_BOUNDARY, STORY_AGENT_BOUNDARY
} from '../src/agent-guidance.mjs';
import { parseAgentDependencies } from '../src/agents.mjs';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../src/workflow-studio.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storyOnly = new Set([
  'poc-lite-implementer', 'poc-lite-planner', 'poc-lite-verifier', 'sflow-source-reviewer'
]);

test('independently selectable bundled agents retain the maintained checkout and custom-root boundary', async () => {
  // This equality is the source-consistency contract for deliberately repeated standalone policy.
  // A change to Studio's canonical boundary must also reach each shipped entrypoint.
  for (const directory of ['templates/agents', 'plugin/agents']) {
    for (const filename of (await readdir(path.join(packageRoot, directory))).filter((name) => name.endsWith('.agent.md'))) {
      const source = `${directory}/${filename}`;
      const markdown = await readFile(path.join(packageRoot, source), 'utf8');
      const agent = parseAgentDependencies(markdown, { source });
      const expected = storyOnly.has(agent.id) ? STORY_AGENT_BOUNDARY : REPOSITORY_AGENT_BOUNDARY;
      const boundaries = agent.prompt.split('\n').filter((line) => line.startsWith('Resolve the active Story checkout'));
      assert.deepEqual(boundaries, [expected], source);
      assert.doesNotMatch(agent.prompt, /singularity\/work-items\/<WORK-ID>/, `${source} overrides a custom root`);
      assert.deepEqual(agent.dependencies, [], `${source} unexpectedly introduces a remote dependency`);
      assert.doesNotMatch(agent.prompt, /^## Remote (?:skills|artifact templates|generated artifacts)$/m,
        `${source} carries unused dependency declarations into the prompt`);
    }
  }
});

test('workflow delegation links resolve to the canonical skills they advertise', async () => {
  const agentPath = path.join(packageRoot, 'plugin/agents/sflow-workflow.agent.md');
  const markdown = await readFile(agentPath, 'utf8');
  const links = [...markdown.matchAll(/\[`(\/sf-[a-z-]+)`\]\((\.\.\/skills\/sflow-[a-z-]+\/SKILL\.md)\)/g)];
  assert.deepEqual(links.map((match) => match[1]).sort(), [
    '/sf-approve', '/sf-code', '/sf-converge', '/sf-home', '/sf-next', '/sf-phase', '/sf-start', '/sf-submit'
  ]);
  for (const [, route, target] of links) {
    const content = await readFile(path.resolve(path.dirname(agentPath), target), 'utf8');
    const frontmatter = YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '');
    assert.equal(frontmatter.name, route.slice(1).replace(/^sf-/, 'sflow-'), `${route} points to a different skill`);
  }
});

test('Studio-created agents preserve a custom work-item root and defer the clarification procedure to composition', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-guidance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  await initializeDefinition(root);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configPath, 'utf8'));
  configuration.workItemRoot = 'governed/team-stories';
  await writeFile(configPath, YAML.stringify(configuration));

  const result = await planStudioChangeSet(root, {
    schema: STUDIO_CHANGE_SET_SCHEMA,
    changes: [{
      op: 'agent.create', id: 'custom-root-reviewer', label: 'Custom root reviewer',
      description: 'Reviews the pinned evidence.', role: 'reviewer'
    }]
  }, { write: true });
  assert.equal(result.valid, true, JSON.stringify(result.problems));
  const definition = await loadDefinition(root);
  assert.equal(definition.workItemRoot, 'governed/team-stories');
  const reviewer = definition.agents['custom-root-reviewer'];
  assert.ok(reviewer.prompt.includes(REPOSITORY_AGENT_BOUNDARY));
  assert.ok(reviewer.prompt.includes(AGENT_CLARIFICATION_GUIDANCE));
  assert.doesNotMatch(reviewer.prompt, /singularity\/work-items|clarification record|For `(?:off|required|when-needed)`/);
  assert.deepEqual(reviewer.dependencies, []);
});
