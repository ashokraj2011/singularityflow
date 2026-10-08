import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { run } from '../src/util.mjs';
import { composePhasePrompt, loadWorldModelConfig, worldModelCommand } from '../src/worldmodel.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../src/workflow-studio.mjs';

function git(root, ...argv) {
  return run('git', argv, { cwd: root }).stdout.trim();
}

test('actual phase composition injects pinned workflow and agent skills without a local session', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-sessionless-skills-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Skill Context Test');
  git(root, 'config', 'user.email', 'skill-context@example.invalid');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.git.publish = 'off'; definition.worldModel.grounding = 'off';
  await writeFile(file, YAML.stringify(definition));
  const plan = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [
    { op: 'skill.create', id: 'agent-probe', description: 'Agent scope probe.', instructions: 'UNIQUE-AGENT-SKILL-84523' },
    { op: 'skill.create', id: 'workflow-probe', description: 'Workflow scope probe.', instructions: 'UNIQUE-WORKFLOW-SKILL-84523' },
    { op: 'skill.attach', skill: 'agent-probe', agent: 'product-owner', phases: ['specification'] },
    { op: 'skill.attach', skill: 'workflow-probe', workflow: 'spec-driven-standard', phases: ['specification'] }
  ] }, { write: true });
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'configure scoped skills');
  const id = 'SKILL-CONTEXT-1'; git(root, 'switch', '-qc', id);
  const config = await loadConfig(root);
  await setAgentSession(root, config, null, 'product-owner', id, { phaseId: 'specification', source: 'test' });
  await createWorkflow(root, config, {
    id, title: 'Verify scoped skill composition', baseBranch: 'main', workType: 'spec-driven-standard', agent: 'product-owner',
    resolved: resolveWorkType(config, 'spec-driven-standard'),
    source: { type: 'manual', key: id, title: 'Verify scoped skill composition', description: 'Verify session-independent exact skill injection.', acceptanceCriteria: ['Both scopes are composed from retained bytes.'] }
  });
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'accept Story');
  const render = () => composePhasePrompt(root, { workId: id, phase: 'specification', agent: 'product-owner' }, { renderOnly: true });
  const withSession = await render();
  await rename(path.join(root, '.git/singularity-flow/session.json'), path.join(root, '.git/singularity-flow/session.preserved.json'));
  const withoutSession = await render();
  for (const output of [withSession, withoutSession]) {
    assert.equal(output.split('UNIQUE-AGENT-SKILL-84523').length, 2);
    assert.equal(output.split('UNIQUE-WORKFLOW-SKILL-84523').length, 2);
  }
  const previousName = process.env.SINGULARITY_FLOW_REPLY_NAME;
  const statusBefore = git(root, 'status', '--porcelain=v1');
  const workflowPath = path.join(root, 'singularity/work-items', id, 'workflow.json');
  const beforeWorkflow = await readFile(workflowPath);
  try {
    process.env.SINGULARITY_FLOW_REPLY_NAME = 'Grace Hopper';
    const first = await render();
    process.env.SINGULARITY_FLOW_REPLY_NAME = 'Ada Lovelace';
    const second = await render();
    assert.match(first, /Preferred name \(literal data\): "Grace"/);
    assert.match(second, /Preferred name \(literal data\): "Ada"/);
    assert.equal(first.split('# Reply personalization')[0], second.split('# Reply personalization')[0],
      'only the ephemeral overlay changes, not the composed governed phase');
    assert.deepEqual(await readFile(workflowPath), beforeWorkflow);
    assert.equal(git(root, 'status', '--porcelain=v1'), statusBefore);
    // A saved generation is reused verbatim even when its host greeting changes.
    const compose = () => composePhasePrompt(root, { workId: id, phase: 'specification', agent: 'product-owner' });
    await compose();
    const promptFile = path.join(root, 'singularity/work-items', id, 'context/prompts/specification-gen1.md');
    const recordFile = path.join(root, 'singularity/work-items', id, 'context/specification-gen1.json');
    const retained = await readFile(promptFile, 'utf8');
    const record = await readFile(recordFile);
    const afterCompose = git(root, 'status', '--porcelain=v1');
    assert.doesNotMatch(retained, /# Reply personalization/);
    process.env.SINGULARITY_FLOW_REPLY_NAME = 'Grace Hopper';
    assert.match(await compose(), /Preferred name \(literal data\): "Grace"/);
    assert.equal(await readFile(promptFile, 'utf8'), retained);
    assert.deepEqual(await readFile(recordFile), record);
    assert.deepEqual(await readFile(workflowPath), beforeWorkflow);
    assert.equal(git(root, 'status', '--porcelain=v1'), afterCompose);
  } finally {
    if (previousName === undefined) delete process.env.SINGULARITY_FLOW_REPLY_NAME;
    else process.env.SINGULARITY_FLOW_REPLY_NAME = previousName;
  }
});

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

test('wm context and its configuration use the requested phase’s pinned agent, never live files', async (t) => {
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
  await captureOutput(() => worldModelCommand(root, ['wm', 'build'], { json: true }));
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
  assert.match(listed, /# WMB v4 context: phase=implementation/);
  assert.doesNotMatch(listed, /UNTRUSTED LIVE PROMPT/);
  const rendered = await captureOutput(() => worldModelCommand(root,
    ['wm', 'context', 'implementation'], { concat: true }));
  assert.doesNotMatch(rendered, /UNTRUSTED LIVE PROMPT/);
  const reloaded = await loadWorldModelConfig(root, { phase: 'implementation' });
  assert.equal(reloaded.executionContext.agent.text, developerText,
    'a same-named live replacement must not shadow the accepted agent');
  for (const phase of loaded.workflow.resolution.phases) {
    if (!phase.defaultAgent) continue;
    const phaseConfig = await loadWorldModelConfig(root, { phase: phase.id });
    assert.equal(phaseConfig.agentPrompt, `agent:${phase.defaultAgent}`,
      `${phase.id} must select its own accepted phase agent`);
  }
  assert.equal(git(root, 'status', '--porcelain=v1'), before);
  assert.deepEqual(await readFile(workflowPath), beforeWorkflow,
    'read-only context does not repair or rewrite Story state');
});
