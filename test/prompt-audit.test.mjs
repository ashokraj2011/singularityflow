import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import {
  listPromptAudits, promptAuditStatus, readPromptAudit, recordPromptAudit, renderPromptAudit,
  setPromptAudit
} from '../src/prompt-audit.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

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
  assert.equal(listed.records[0].execution.status, 'not-observed');
  assert.equal(listed.records[0].execution.tokens.promptEstimate.assurance, 'sflow-estimated');
  const viewed = await readPromptAudit(root, record.id);
  assert.equal(viewed.record.task, 'Implement the approved design');
});

test('structured prompt view joins exact invocation tools, tokens, timing, and output without inventing tool calls', async () => {
  const root = await repository();
  await setPromptAudit(root, true);
  const prompt = '# Governed prompt\nImplement the bounded change.\n';
  const record = await recordPromptAudit(root, {
    agent: 'developer', phase: 'implementation', workId: 'STORY-TOOLS', workType: 'feature',
    generation: 3, task: 'code', prompt, source: 'model-invocation',
    composition: {
      policy: { mode: 'enforce', profile: 'standard', maximumEstimatedPromptTokens: 18000 },
      originalBytes: 96, finalBytes: Buffer.byteLength(prompt), omitted: [{ id: 'optional-ast-context' }],
      inputLinearization: { managedBytesExcluded: 2048 },
      structuralContext: { status: 'complete', factsReturned: 12, structuralFactsReturned: 12 },
      deduplicatedReferences: [{ path: 'artifacts/intake.md', previewBytes: 1024 }],
      sections: [{
        id: 'phase-contract', included: true, bytes: 48, estimatedTokens: 12,
        mandatory: true
      }]
    },
    supportingEvidence: [{ kind: 'model-invocation-audit', id: 'invocation-1' }]
  });
  const invocationDirectory = path.join(root, '.git/singularity-flow/model-invocations');
  await mkdir(invocationDirectory, { recursive: true });
  await writeFile(path.join(invocationDirectory, 'invocation-1.json'), `${JSON.stringify({
    schemaVersion: 2,
    id: 'invocation-1',
    operationId: 'phase.implement',
    policy: 'required',
    modelMode: 'enabled',
    rootOperationId: 'phase.implement',
    provider: 'copilot-cli',
    model: 'gpt-5.4',
    routing: { task: 'code', resolvedModel: 'gpt-5.4' },
    promptSha256: record.promptSha256,
    promptBytes: record.bytes,
    promptTransport: 'attachment',
    promptEncoding: 'utf-8',
    cwdSha256: '0'.repeat(64),
    channel: 'copilot-host',
    subject: { kind: 'story', id: 'STORY-TOOLS', phase: 'implementation', generation: 3 },
    toolPolicy: { mode: 'allowlist', names: ['read_file', 'edit_file'] },
    limits: { timeoutMs: 120000, outputBytes: 4096, promptBytes: 65536 },
    status: 'completed',
    startedAt: '2026-08-24T10:00:00.000Z',
    completedAt: '2026-08-24T10:00:01.250Z',
    outputBytes: 512,
    outputSha256: '1'.repeat(64),
    usage: {
      status: 'exact', assurance: 'provider-reported', inputTokens: 120,
      outputTokens: 30, cachedInputTokens: 20, totalTokens: 150, providerCost: 0.001
    }
  }, null, 2)}\n`);

  const viewed = await readPromptAudit(root, record.id);
  assert.equal(viewed.record.execution.observation, 'exact-invocation-audit');
  assert.deepEqual(viewed.record.execution.tools.allowed, ['read_file', 'edit_file']);
  assert.equal(viewed.record.execution.tools.observedCalls, null);
  assert.equal(viewed.record.execution.tokens.total, 150);
  assert.equal(viewed.record.execution.durationMs, 1250);
  const rendered = renderPromptAudit(viewed.record);
  for (const heading of [
    '## Context', '## Model and execution', '## Tools', '## Tokens and cost',
    '## Request and output', '## Grounding and references', '## Prompt composition',
    '## Context efficiency', '## Prompt'
  ]) assert.match(rendered, new RegExp(heading.replaceAll('#', '\\#')));
  assert.match(rendered, /Allowed tools: `read_file`, `edit_file`/);
  assert.match(rendered, /Observed tool calls: unavailable/);
  assert.match(rendered, /Total provider tokens: 150/);
  assert.match(rendered, /Provider cost: \$0\.001000/);
  assert.match(rendered, /Prompt-only estimate: .*sflow-estimated/);
  assert.match(rendered, /Policy: enforce\/standard/);
  assert.match(rendered, /Optional sections omitted: 1/);
  assert.match(rendered, /duplicates removed: 1/);
  assert.match(rendered, /Managed source bytes excluded before prompt composition: 2,048/);
  assert.match(rendered, /Duplicate approved-reference preview bytes excluded from prompt: 1,024/);
  assert.match(rendered, /Provider uncached input tokens: 100/);
  assert.match(rendered, /AST structural facts selected: 12/);
  assert.match(rendered, /Sent prompt bytes: 48/);
  assert.match(rendered, /Prompt transport: attachment/);
  assert.match(rendered, /--- BEGIN CAPTURED GOVERNED PROMPT ---/);
  const cliView = run(process.execPath, [cli, 'prompt-log', 'view', record.id], { cwd: root }).stdout;
  assert.match(cliView, /## Tokens and cost/);
  assert.match(cliView, /Total provider tokens: 150/);
  const raw = run(process.execPath, [cli, 'prompt-log', 'view', record.id, '--raw'], { cwd: root }).stdout;
  assert.equal(raw, prompt);
  const json = JSON.parse(run(process.execPath, [cli, 'prompt-log', 'view', record.id, '--json'], { cwd: root }).stdout);
  assert.equal(json.record.execution.tokens.total, 150);
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
