import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { run } from '../src/util.mjs';
import { composePhasePrompt } from '../src/worldmodel.mjs';
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
  definition.git.publish = 'off';
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
