import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import { gitDir } from '../src/git.mjs';
import {
  clearPromptAudits, listPromptAudits, promptAuditStatus, readPromptAudit, recordPromptAudit,
  renderPromptAudit, repairPromptAudits, setPromptAudit, setPromptAuditRetention, scrubPrompt
} from '../src/prompt-audit.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');
const promptAuditMachineState = await mkdtemp(path.join(os.tmpdir(), 'sflow-prompt-audit-machine-'));
const originalMachineEnvironment = Object.fromEntries([
  'SINGULARITY_FLOW_WORKSPACE_REGISTRY',
  'SINGULARITY_FLOW_ACTIVE_WORKSPACE',
  'SINGULARITY_FLOW_LEAD_REGISTRY'
].map((key) => [key, process.env[key]]));
process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = path.join(promptAuditMachineState, 'workspaces.json');
process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = path.join(promptAuditMachineState, 'active-workspace.json');
process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(promptAuditMachineState, 'lead-registry.json');
after(async () => {
  for (const [key, value] of Object.entries(originalMachineEnvironment)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(promptAuditMachineState, { recursive: true, force: true });
});

function promptCli(root, args, options = {}) {
  const machineState = path.join(root, '.isolated-machine-state');
  return run(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machineState, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machineState, 'active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machineState, 'lead-registry.json')
    },
    ...options
  });
}

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
  assert.equal(record.handoffBytes, record.bytes);
  assert.equal(record.handoffSha256, record.promptSha256);

  const listed = await listPromptAudits(root, { agent: 'developer', includePrompt: true });
  assert.equal(listed.count, 1);
  assert.equal(listed.records[0].prompt, record.prompt);
  assert.equal(listed.records[0].execution.status, 'not-observed');
  assert.equal(listed.records[0].execution.tokens.promptEstimate.assurance, 'sflow-estimated');
  const viewed = await readPromptAudit(root, record.id);
  assert.equal(viewed.record.task, 'Implement the approved design');
});

test('a composition-cache hit reuses the consecutive prompt record without hiding invocations', async () => {
  const root = await repository();
  await setPromptAudit(root, true);
  const input = {
    agent: 'developer', phase: 'implementation', workId: 'STORY-CACHE', generation: 1,
    prompt: '# Same governed prompt\n', source: 'wm-compose',
    compositionCache: { key: 'a'.repeat(64), hit: false }
  };
  const first = await recordPromptAudit(root, input);
  const repeated = await recordPromptAudit(root, {
    ...input, compositionCache: { ...input.compositionCache, hit: true }
  });
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.deduplicated, true);
  assert.equal((await promptAuditStatus(root)).count, 1);

  await recordPromptAudit(root, {
    ...input, source: 'model-invocation', compositionCache: { ...input.compositionCache, hit: true }
  });
  assert.equal((await promptAuditStatus(root)).count, 2);
});

test('wm-compose dedup never collapses different raw handoffs that redact identically', async () => {
  const root = await repository();
  await setPromptAudit(root, true);
  const common = {
    agent: 'developer', phase: 'implementation', workId: 'STORY-REDACTION', generation: 1,
    source: 'wm-compose', compositionCache: { key: 'b'.repeat(64), hit: false }
  };
  const first = await recordPromptAudit(root, {
    ...common, prompt: `Use Bearer ${'a'.repeat(32)} for this synthetic request.`
  });
  const second = await recordPromptAudit(root, {
    ...common, prompt: `Use Bearer ${'b'.repeat(32)} for this synthetic request.`
  });
  assert.equal(first.promptSha256, second.promptSha256,
    'the fixture must produce the same scrubbed prompt');
  assert.notEqual(first.handoffSha256, second.handoffSha256);
  assert.notEqual(first.id, second.id);
  const repeated = await recordPromptAudit(root, {
    ...common, prompt: `Use Bearer ${'b'.repeat(32)} for this synthetic request.`
  });
  assert.equal(repeated.id, second.id);
  assert.equal((await promptAuditStatus(root)).count, 2);
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
  assert.match(rendered, /Prompt protocol version: unavailable/);
  assert.match(rendered, /--- BEGIN CAPTURED GOVERNED PROMPT ---/);
  const cliView = promptCli(root, ['prompt-log', 'view', record.id]).stdout;
  assert.match(cliView, /## Tokens and cost/);
  assert.match(cliView, /Total provider tokens: 150/);
  const raw = promptCli(root, ['prompt-log', 'view', record.id, '--raw']).stdout;
  assert.equal(raw, prompt);
  const json = JSON.parse(promptCli(root, ['prompt-log', 'view', record.id, '--json']).stdout);
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
  assert.notEqual(record.handoffSha256, record.promptSha256, 'the exact handoff hash survives content redaction');
  assert.equal(record.handoffBytes, Buffer.byteLength(`Use context, not ${secret}`));
  const raw = await readFile(status.logFile, 'utf8');
  assert.equal(raw.includes(secret), false);
  assert.match(raw, /\[redacted-secret\]/);
});

test('common provider, cloud, URL, assignment, and private-key credentials are scrubbed', () => {
  const values = [
    `OPENAI_API_KEY=sk-${'a'.repeat(48)}`,
    `AWS_ACCESS_KEY_ID=AKIA${'A'.repeat(16)}`,
    'https://user:synthetic-password@example.invalid/path',
    'client_secret=synthetic-client-secret-value',
    '"apiKey": "synthetic json secret"',
    '--password short-secret',
    '<password>xml-secret</password>',
    '-----BEGIN PRIVATE KEY-----\nSYNTHETIC-CONTENT\n-----END PRIVATE KEY-----'
  ];
  for (const secret of values) {
    const result = scrubPrompt(`before ${secret} after`);
    assert.equal(result.prompt.includes(secret), false, `secret survived: ${secret.slice(0, 12)}`);
    assert.ok(result.redactions >= 1);
  }
});

test('a truncated JSONL tail remains readable and is quarantined before the next append', async () => {
  const root = await repository();
  const enabled = await setPromptAudit(root, true);
  await recordPromptAudit(root, { agent: 'developer', phase: 'intake', prompt: 'first valid prompt' });
  await appendFile(enabled.logFile, '{"interrupted":');
  const degraded = await promptAuditStatus(root);
  assert.equal(degraded.count, 1);
  assert.equal(degraded.integrity.status, 'failed');
  assert.equal(degraded.integrity.malformed, 1);
  await recordPromptAudit(root, { agent: 'developer', phase: 'intake', prompt: 'after recovery' });
  const recovered = await listPromptAudits(root, { includePrompt: true });
  assert.equal(recovered.count, 2);
  assert.equal(recovered.integrity.status, 'verified');
  assert.equal(recovered.recoveryFiles, 1);
  assert.deepEqual(recovered.records.map((record) => record.prompt), ['after recovery', 'first valid prompt']);
});

test('sealed prompt records detect edits and explicit repair preserves the original recovery bytes', async () => {
  const root = await repository();
  const enabled = await setPromptAudit(root, true);
  await recordPromptAudit(root, { agent: 'developer', phase: 'design', prompt: 'trusted prompt' });
  const [stored] = (await readFile(enabled.logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  stored.prompt = 'locally edited prompt';
  await writeFile(enabled.logFile, `${JSON.stringify(stored)}\n`);
  const failed = await promptAuditStatus(root);
  assert.equal(failed.integrity.status, 'failed');
  await assert.rejects(
    () => recordPromptAudit(root, { agent: 'developer', phase: 'design', prompt: 'must not append' }),
    (error) => error.code === 'PROMPT_AUDIT_INTEGRITY_FAILED'
  );
  const repaired = await repairPromptAudits(root);
  assert.equal(repaired.repaired, 1);
  assert.equal(repaired.count, 0);
  assert.equal(repaired.recoveryFiles, 1);
  await recordPromptAudit(root, { agent: 'developer', phase: 'design', prompt: 'clean restart' });
  assert.equal((await promptAuditStatus(root)).integrity.status, 'verified');
});

test('chain anchors detect deletion of the newest record', async () => {
  const root = await repository();
  const enabled = await setPromptAudit(root, true);
  await recordPromptAudit(root, { agent: 'developer', phase: 'design', prompt: 'first' });
  await recordPromptAudit(root, { agent: 'developer', phase: 'design', prompt: 'second' });
  const lines = (await readFile(enabled.logFile, 'utf8')).trim().split('\n');
  await writeFile(enabled.logFile, `${lines[0]}\n`);
  const missingTail = await promptAuditStatus(root);
  assert.equal(missingTail.integrity.status, 'failed');
  assert.match(missingTail.warnings.join('\n'), /anchored last record is missing or changed/);
  const repaired = await repairPromptAudits(root);
  assert.equal(repaired.count, 1);
  assert.equal(repaired.integrity.status, 'verified');
});

test('explicit repair rotates a lost integrity key and reseals readable records', async () => {
  const root = await repository();
  const enabled = await setPromptAudit(root, true);
  await recordPromptAudit(root, { agent: 'developer', phase: 'design', prompt: 'retain me' });
  await writeFile(path.join(enabled.directory, 'integrity.key'), 'broken');
  assert.equal((await promptAuditStatus(root)).integrity.status, 'failed');
  const repaired = await repairPromptAudits(root);
  assert.equal(repaired.count, 1);
  assert.equal(repaired.resealed, 1);
  assert.equal(repaired.integrity.status, 'verified');
});

test('prompt capture is append-locked under concurrency', async () => {
  const root = await repository();
  await setPromptAudit(root, true);
  await Promise.all(Array.from({ length: 40 }, (_, index) => recordPromptAudit(root, {
    agent: 'developer', phase: 'implementation', prompt: `concurrent prompt ${index}`
  })));
  const result = await listPromptAudits(root, { includePrompt: true, limit: 100 });
  assert.equal(result.count, 40);
  assert.equal(result.integrity.status, 'verified');
  assert.equal(new Set(result.records.map((record) => record.id)).size, 40);
});

test('retention prunes expired legacy records and clear removes history plus recovery copies', async () => {
  const root = await repository();
  const enabled = await setPromptAudit(root, true);
  await writeFile(enabled.logFile, `${JSON.stringify({
    schemaVersion: 1, id: 'old', recordedAt: '2020-01-01T00:00:00.000Z',
    repositoryPath: root, phase: 'intake', agent: 'product-owner', prompt: 'old',
    promptSha256: 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4',
    bytes: 3, redactions: 0
  })}\n`);
  const retained = await setPromptAuditRetention(root, 7);
  assert.equal(retained.retentionDays, 7);
  assert.equal(retained.count, 0);
  await recordPromptAudit(root, { agent: 'developer', phase: 'intake', prompt: 'new' });
  const cleared = await clearPromptAudits(root);
  assert.equal(cleared.removed, 1);
  assert.equal(cleared.count, 0);
  assert.equal(cleared.enabled, true);
});

test('the CLI requires explicit deletion confirmation and applies retention and clear controls', async () => {
  const root = await repository();
  const enabled = JSON.parse(promptCli(root, ['prompt-log', 'on', '--json']).stdout);
  assert.equal(enabled.enabled, true);
  const retained = JSON.parse(promptCli(root, [
    'prompt-log', 'retention', '--retention-days', '14', '--json'
  ]).stdout);
  assert.equal(retained.retentionDays, 14);
  await recordPromptAudit(root, { agent: 'developer', phase: 'intake', prompt: 'delete through the CLI' });
  const refused = promptCli(root, ['prompt-log', 'clear', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires --confirm "DELETE PROMPT AUDIT"/);
  const cleared = JSON.parse(promptCli(root, [
    'prompt-log', 'clear', '--confirm', 'DELETE PROMPT AUDIT', '--json'
  ]).stdout);
  assert.equal(cleared.removed, 1);
  assert.equal(cleared.count, 0);
});

test('the configured byte ceiling retains the newest complete record without breaking integrity', async () => {
  const root = await repository();
  const enabled = await setPromptAudit(root, true);
  const stored = JSON.parse(await readFile(enabled.settingsFile, 'utf8'));
  await writeFile(enabled.settingsFile, `${JSON.stringify({
    ...stored, maximumBytes: 1024, lastPrunedAt: null
  }, null, 2)}\n`);
  for (let index = 0; index < 3; index += 1) {
    await recordPromptAudit(root, {
      agent: 'developer', phase: 'implementation', prompt: `${index}:${'x'.repeat(1400)}`
    });
  }
  const result = await listPromptAudits(root, { includePrompt: true });
  assert.equal(result.count, 1);
  assert.equal(result.integrity.status, 'verified');
  assert.match(result.records[0].prompt, /^2:/);
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
  run('git', ['remote', 'add', 'origin', 'https://example.invalid/api.git'], { cwd: root });
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'sflow-prompt-audit-workspace-'));
  const selectionFile = path.join(workspacePath, 'active-workspace.json');
  const registryFile = path.join(workspacePath, 'workspaces.json');
  await writeFile(path.join(workspacePath, 'workspace.json'), `${JSON.stringify({
    version: 1, id: 'payments', name: 'Payments',
    anchor: { provider: 'workspace', key: 'payments', title: 'Payments' },
    leadRepository: 'api',
    repositories: {
      api: {
        url: 'https://example.invalid/api.git', path: 'repos/api', defaultBranch: 'main',
        adoption: {
          mode: 'existing-clone', canonicalPath: root,
          proofHash: `sha256:${'a'.repeat(64)}`, reviewedAt: '2026-08-31T00:00:00.000Z'
        }
      }
    }
  }, null, 2)}\n`);
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

test('an invalid active workspace selection is surfaced instead of redirecting prompts to repository storage', async () => {
  const root = await repository();
  const selectionFile = path.join(root, 'invalid-active-workspace.json');
  const registryFile = path.join(root, 'unused-workspaces.json');
  await writeFile(selectionFile, '{invalid-json');
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selectionFile;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;
  try {
    await assert.rejects(() => promptAuditStatus(root), /Unable to read active workspace selection/);
  } finally {
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
  }
});

test('workspace prompt audit resolves invocation evidence from the repository that created each record', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-prompt-audit-multi-'));
  const workspacePath = path.join(base, 'workspace');
  const first = path.join(workspacePath, 'repos', 'first');
  const second = path.join(workspacePath, 'repos', 'second');
  for (const repositoryPath of [first, second]) {
    await mkdir(repositoryPath, { recursive: true });
    run('git', ['init', '-q'], { cwd: repositoryPath });
  }
  run('git', ['remote', 'add', 'origin', 'https://example.invalid/first.git'], { cwd: first });
  run('git', ['remote', 'add', 'origin', 'https://example.invalid/second.git'], { cwd: second });
  await writeFile(path.join(workspacePath, 'workspace.json'), `${JSON.stringify({
    version: 1, id: 'multi', name: 'Multi repository',
    anchor: { provider: 'workspace', key: 'multi', title: 'Multi repository' },
    leadRepository: 'first',
    repositories: {
      first: { url: 'https://example.invalid/first.git', path: 'repos/first', defaultBranch: 'main' },
      second: { url: 'https://example.invalid/second.git', path: 'repos/second', defaultBranch: 'main' }
    }
  }, null, 2)}\n`);
  const selectionFile = path.join(base, 'active-workspace.json');
  const registryFile = path.join(base, 'workspaces.json');
  const select = async (repositoryId, repositoryPath) => writeFile(selectionFile, `${JSON.stringify({
    schemaVersion: 1, workspaceId: 'multi', workspaceName: 'Multi repository', workspacePath,
    repositoryId, repositoryPath, selectedAt: new Date().toISOString()
  })}\n`);
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selectionFile;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;
  try {
    await select('second', second);
    await setPromptAudit(second, true);
    const prompt = 'prompt from the second repository';
    const record = await recordPromptAudit(second, {
      agent: 'developer', phase: 'implementation', workId: 'MULTI-1', prompt,
      source: 'model-invocation', supportingEvidence: [{ kind: 'model-invocation-audit', id: 'second-invocation' }]
    });
    const invocationDirectory = path.join(second, '.git', 'singularity-flow', 'model-invocations');
    await mkdir(invocationDirectory, { recursive: true });
    await writeFile(path.join(invocationDirectory, 'second-invocation.json'), `${JSON.stringify({
      schemaVersion: 3, id: 'second-invocation', operationId: 'phase.implement', policy: 'required',
      modelMode: 'enabled', rootOperationId: 'phase.implement', provider: 'copilot-cli', model: 'gpt-5.4',
      routing: null, promptSha256: record.promptSha256, promptBytes: record.bytes,
      promptTransport: 'attachment', promptEncoding: 'utf-8', promptLayout: null,
      tokenAdmission: null, economics: null, cwdSha256: '0'.repeat(64), channel: 'copilot-host',
      subject: { kind: 'story', id: 'MULTI-1', phase: 'implementation' }, generationNonce: null,
      toolPolicy: { mode: 'allowlist', names: ['read_file'] },
      limits: { timeoutMs: 1000, outputBytes: 1024, promptBytes: 4096 }, status: 'completed',
      startedAt: '2026-08-25T00:00:00.000Z', completedAt: '2026-08-25T00:00:01.000Z',
      outputBytes: 4, outputSha256: '1'.repeat(64),
      usage: { status: 'exact', assurance: 'provider-reported', inputTokens: 25, outputTokens: 5, totalTokens: 30 },
      attestation: null
    })}\n`);
    await select('first', first);
    const viewedFromFirst = await listPromptAudits(first, { includePrompt: true });
    assert.equal(viewedFromFirst.records[0].repositoryPath, path.resolve(second));
    assert.equal(viewedFromFirst.records[0].execution.invocationId, 'second-invocation');
    assert.equal(viewedFromFirst.records[0].execution.tokens.total, 30);
    assert.deepEqual(viewedFromFirst.records[0].execution.tools.allowed, ['read_file']);
  } finally {
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
  }
});

test('workspace prompt audit resolves receipts written by a managed Story worktree', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-prompt-audit-worktree-'));
  const workspacePath = path.join(base, 'workspace');
  const canonical = path.join(workspacePath, 'repos', 'app');
  const managed = path.join(workspacePath, '.singularity-flow', 'story-worktrees', 'WORK-1', 'repos', 'app');
  await mkdir(canonical, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], { cwd: canonical });
  run('git', ['config', 'user.name', 'Prompt Worktree'], { cwd: canonical });
  run('git', ['config', 'user.email', 'prompt-worktree@example.com'], { cwd: canonical });
  await writeFile(path.join(canonical, 'README.md'), '# App\n');
  run('git', ['add', 'README.md'], { cwd: canonical });
  run('git', ['commit', '-m', 'initialize'], { cwd: canonical });
  run('git', ['remote', 'add', 'origin', 'https://example.invalid/app.git'], { cwd: canonical });
  await mkdir(path.dirname(managed), { recursive: true });
  run('git', ['worktree', 'add', '-q', '-b', 'WORK-1', managed], { cwd: canonical });
  await writeFile(path.join(workspacePath, 'workspace.json'), `${JSON.stringify({
    version: 1, id: 'worktree', name: 'Managed worktree',
    anchor: { provider: 'workspace', key: 'worktree', title: 'Managed worktree' },
    leadRepository: 'app',
    repositories: { app: { url: 'https://example.invalid/app.git', path: 'repos/app', defaultBranch: 'main' } }
  }, null, 2)}\n`);
  const selectionFile = path.join(base, 'active-workspace.json');
  const registryFile = path.join(base, 'workspaces.json');
  await writeFile(selectionFile, `${JSON.stringify({
    schemaVersion: 1, workspaceId: 'worktree', workspaceName: 'Managed worktree', workspacePath,
    repositoryId: 'app', repositoryPath: canonical, selectedAt: new Date().toISOString()
  })}\n`);
  await writeFile(registryFile, '[]\n');
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selectionFile;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;
  try {
    await setPromptAudit(canonical, true);
    const prompt = 'managed Story implementation prompt';
    const record = await recordPromptAudit(managed, {
      agent: 'developer', phase: 'implementation', workId: 'WORK-1', prompt,
      source: 'model-invocation', supportingEvidence: [{ kind: 'model-invocation-audit', id: 'managed-invocation' }]
    });
    const directory = path.join(gitDir(managed), 'singularity-flow', 'model-invocations');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'managed-invocation.json'), `${JSON.stringify({
      schemaVersion: 3, id: 'managed-invocation', operationId: 'phase.implement', policy: 'required',
      modelMode: 'enabled', rootOperationId: 'phase.implement', provider: 'copilot-cli', model: 'gpt-5.4',
      routing: null, promptSha256: record.promptSha256, promptBytes: record.bytes,
      promptTransport: 'attachment', promptEncoding: 'utf-8', promptLayout: null,
      tokenAdmission: null, economics: null, cwdSha256: '0'.repeat(64), channel: 'copilot-host',
      subject: { kind: 'story', id: 'WORK-1', phase: 'implementation' }, generationNonce: null,
      toolPolicy: { mode: 'allowlist', names: ['read_file', 'edit_file'] },
      limits: { timeoutMs: 1000, outputBytes: 1024, promptBytes: 4096 }, status: 'completed',
      startedAt: '2026-08-25T00:00:00.000Z', completedAt: '2026-08-25T00:00:01.000Z',
      outputBytes: 4, outputSha256: '1'.repeat(64),
      usage: { status: 'exact', assurance: 'provider-reported', inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      attestation: null
    })}\n`);
    const listed = await listPromptAudits(canonical, { includePrompt: true });
    assert.equal(listed.records[0].repositoryPath, path.resolve(managed));
    assert.equal(listed.records[0].execution.invocationId, 'managed-invocation');
    assert.equal(listed.records[0].execution.tokens.total, 50);
    assert.deepEqual(listed.records[0].execution.tools.allowed, ['read_file', 'edit_file']);
  } finally {
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
  }
});
