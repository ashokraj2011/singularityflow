import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import {
  listPromptAudits, promptAuditStatus, readPromptAudit, recordPromptAudit, setPromptAudit
} from '../src/prompt-audit.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-prompt-audit-'));
  run('git', ['init', '-q'], { cwd: root });
  return root;
}

test('prompt auditing is off by default and records nothing until explicitly enabled', async () => {
  const root = await repository();
  const before = await promptAuditStatus(root);
  assert.equal(before.enabled, false);
  assert.equal(before.count, 0);
  assert.equal(before.scope, 'repository');
  assert.equal(await recordPromptAudit(root, { agent: 'developer', phase: 'design', prompt: 'not written' }), null);
  assert.equal((await promptAuditStatus(root)).count, 0);
});

test('enabled audit records agent, Story, phase, generation, hash, and prompt text', async () => {
  const root = await repository();
  await setPromptAudit(root, true);
  const record = await recordPromptAudit(root, {
    agent: 'developer', phase: 'implementation', workId: 'STORY-123', workType: 'feature',
    generation: 2, task: 'Implement the approved design', prompt: '# Governed prompt\nBuild only the approved scope.\n'
  });
  assert.equal(record.agent, 'developer');
  assert.equal(record.workId, 'STORY-123');
  assert.equal(record.phase, 'implementation');
  assert.equal(record.generation, 2);
  assert.match(record.promptSha256, /^[a-f0-9]{64}$/);

  const listed = await listPromptAudits(root, { agent: 'developer', includePrompt: true });
  assert.equal(listed.count, 1);
  assert.equal(listed.records[0].prompt, record.prompt);
  const viewed = await readPromptAudit(root, record.id);
  assert.equal(viewed.record.task, 'Implement the approved design');
});

test('recognized credentials are removed before a prompt reaches the workspace log', async () => {
  const root = await repository();
  const status = await setPromptAudit(root, true);
  const secret = 'Bearer abcdefghijklmnopqrstuvwxyz';
  const record = await recordPromptAudit(root, {
    agent: 'architect', phase: 'design', prompt: `Use context, not ${secret}`
  });
  assert.equal(record.redactions, 1);
  assert.equal(record.prompt.includes(secret), false);
  const raw = await readFile(status.logFile, 'utf8');
  assert.equal(raw.includes(secret), false);
  assert.match(raw, /\[redacted-secret\]/);
});

test('turning prompt auditing off preserves existing records and stops future capture', async () => {
  const root = await repository();
  await setPromptAudit(root, true);
  await recordPromptAudit(root, { agent: 'qa', phase: 'verification', prompt: 'first' });
  await setPromptAudit(root, false);
  await recordPromptAudit(root, { agent: 'qa', phase: 'verification', prompt: 'second' });
  const result = await listPromptAudits(root, { includePrompt: true });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.records.map((record) => record.prompt), ['first']);
});

test('an active Flow workspace owns the prompt log instead of the repository clone', async () => {
  const root = await repository();
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'sflow-prompt-audit-workspace-'));
  const selectionFile = path.join(workspacePath, 'active-workspace.json');
  const registryFile = path.join(workspacePath, 'workspaces.json');
  await writeFile(selectionFile, JSON.stringify({
    schemaVersion: 1,
    workspaceId: 'payments',
    workspaceName: 'Payments',
    workspacePath,
    repositoryId: 'api',
    repositoryPath: root,
    selectedAt: new Date().toISOString()
  }));
  await writeFile(registryFile, '[]\n');
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selectionFile;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;
  try {
    const status = await setPromptAudit(root, true);
    assert.equal(status.scope, 'workspace');
    assert.equal(status.workspaceName, 'Payments');
    assert.equal(status.logFile, path.join(workspacePath, '.singularity-flow', 'prompt-audit', 'prompts.jsonl'));
    await recordPromptAudit(root, { agent: 'architect', phase: 'design', prompt: 'workspace prompt' });
    assert.match(await readFile(status.logFile, 'utf8'), /workspace prompt/);
  } finally {
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
  }
});
