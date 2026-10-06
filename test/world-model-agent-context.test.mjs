import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { run } from '../src/util.mjs';
import { loadWorldModelConfig, worldModelCommand } from '../src/worldmodel.mjs';

function git(root, ...argv) {
  return run('git', argv, { cwd: root }).stdout.trim();
}

async function captureOutput(operation) {
  const prior = { log: console.log, warn: console.warn, error: console.error };
  const write = process.stdout.write;
  let output = '';
  console.log = (...values) => { output += `${values.join(' ')}\n`; };
  console.warn = console.error = () => {};
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try { await operation(); return output; }
  finally {
    Object.assign(console, prior);
    process.stdout.write = write;
  }
}

test('wm context lists and concatenates the requested phase’s pinned agent without live files', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-agent-context-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Agent Context Test');
  git(root, 'config', 'user.email', 'agent-context@example.invalid');
  await writeFile(path.join(root, 'application.mjs'), 'export const value = 1;\n');
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.worldModel.grounding = 'off';
  definition.worldModel.promptSource = 'builtin';
  await writeFile(definitionPath, YAML.stringify(definition));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base application and configuration');
  const workId = 'WM-AGENT-1';
  git(root, 'switch', '-qc', workId);
  const config = await loadConfig(root);
  await setAgentSession(root, config, {
    name: 'Agent Context Test', email: 'agent-context@example.invalid', login: null
  }, 'product-owner', workId, { phaseId: 'specification', source: 'test' });
  await createWorkflow(root, config, {
    id: workId, title: 'Read pinned phase agents', baseBranch: 'main',
    workType: 'spec-driven-standard', agent: 'product-owner',
    resolved: resolveWorkType(config, 'spec-driven-standard'),
    source: {
      type: 'manual', key: workId, title: 'Read pinned phase agents',
      description: 'Verify read-only phase context uses exact accepted agent bytes.',
      acceptanceCriteria: ['The requested phase agent is rendered from its accepted snapshot.']
    }
  });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'accept Story closure');
  await captureOutput(() => worldModelCommand(root, ['wm', 'light'], {
    repositoryCatalog: true
  }));
  const loaded = await loadWorldModelConfig(root, { phase: 'implementation' });
  assert.equal(loaded.agentPrompt, 'agent:developer');
  const developerText = loaded.executionContext.agent.text;
  await rm(path.join(root, '.github/agents'), { recursive: true });
  // Even a same-named live replacement must not shadow the accepted agent.
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/developer.agent.md'), 'UNTRUSTED LIVE PROMPT\n');
  const before = git(root, 'status', '--porcelain=v1');
  const workflowPath = path.join(root, 'singularity/work-items', workId, 'workflow.json');
  const beforeWorkflow = await readFile(workflowPath);
  const listed = await captureOutput(() => worldModelCommand(root,
    ['wm', 'context', 'implementation'], {}));
  assert.match(listed, /L0  agent:developer  # active agent prompt/);
  assert.doesNotMatch(listed, /world-model\/agent:developer|agent:product-owner/);
  const rendered = await captureOutput(() => worldModelCommand(root,
    ['wm', 'context', 'implementation'], { concat: true }));
  assert.equal(rendered.split(developerText).length, 2, 'the pinned prompt is rendered once');
  assert.doesNotMatch(rendered, /UNTRUSTED LIVE PROMPT/);
  const withoutAgent = await captureOutput(() => worldModelCommand(root,
    ['wm', 'context', 'implementation'], { concat: true, agent: false }));
  assert.doesNotMatch(withoutAgent, /active agent prompt|UNTRUSTED LIVE PROMPT/);
  for (const phase of loaded.workflow.resolution.phases) {
    const output = await captureOutput(() => worldModelCommand(root,
      ['wm', 'context', phase.id], {}));
    assert.ok(output.includes(`L0  agent:${phase.defaultAgent}  # active agent prompt`),
      `${phase.id} must select its own accepted phase agent`);
  }
  assert.equal(git(root, 'status', '--porcelain=v1'), before);
  assert.deepEqual(await readFile(workflowPath), beforeWorkflow,
    'read-only context does not repair or rewrite Story state');
});
