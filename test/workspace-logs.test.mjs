import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitCommonDir, gitDir } from '../src/git.mjs';
import { prepareTelemetryLaunch, recordTelemetryLaunch, setTelemetryCapture } from '../src/telemetry-provision.mjs';
import { collectWorkspaceLogs, compareWorkspaceLogEntries } from '../src/workspace-logs.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function repository(root, id) {
  const directory = path.join(root, 'repos', id);
  await mkdir(directory, { recursive: true });
  git(directory, ['init', '-b', 'main']);
  git(directory, ['config', 'user.name', 'Workspace Logs']);
  git(directory, ['config', 'user.email', 'logs@example.invalid']);
  await writeFile(path.join(directory, 'README.md'), `# ${id}\n`);
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-m', 'initial']);
  return directory;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-logs-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(workspace, 'repos'), { recursive: true });
  const first = await repository(workspace, 'repo-a');
  const second = await repository(workspace, 'repo-b');
  const outsider = await repository(root, 'outside');
  await writeFile(path.join(workspace, 'workspace.json'), `${JSON.stringify({
    version: 1,
    id: 'logs-demo',
    name: 'Logs demo',
    anchor: { provider: 'workspace', key: 'logs-demo', title: 'Logs demo' },
    leadRepository: 'repo-a',
    repositories: {
      'repo-a': { url: 'https://example.invalid/repo-a.git', path: 'repos/repo-a', defaultBranch: 'main' },
      'repo-b': { url: 'https://example.invalid/repo-b.git', path: 'repos/repo-b', defaultBranch: 'main' }
    }
  }, null, 2)}\n`);
  const active = path.join(root, 'active-workspace.json');
  await writeFile(active, `${JSON.stringify({
    schemaVersion: 1,
    workspaceId: 'logs-demo',
    workspaceName: 'Logs demo',
    workspacePath: workspace,
    repositoryId: 'repo-a',
    repositoryPath: first,
    selectedAt: '2026-08-11T12:00:00.000Z'
  }, null, 2)}\n`);
  const env = {
    ...process.env,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: active,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'unused-registry.json')
  };
  return { root, workspace, first, second, outsider, env };
}

async function writeActivity(repository, lines) {
  const file = path.join(gitDir(repository), 'singularity-flow', 'logs', 'activity.log');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

test('workspace logs combine only active-workspace repositories in deterministic newest-first order', async () => {
  const { workspace, first, second, outsider, env } = await fixture();
  await writeActivity(first, [JSON.stringify({
    ts: '2026-08-11T12:04:00.000Z', level: 'error', event: 'command.failed',
    msg: 'Requirements publication failed', workId: 'WRK-1978', phase: 'requirements', agent: 'product-owner'
  }), 'not-json']);
  await writeActivity(second, [JSON.stringify({
    ts: '2026-08-11T12:04:00.000Z', level: 'warn', event: 'hook.warn', msg: 'Second repository warning'
  })]);
  await writeActivity(outsider, [JSON.stringify({
    ts: '2026-08-11T13:00:00.000Z', level: 'error', event: 'outside.machine.scan', msg: 'Must not appear'
  })]);

  const telemetryFile = path.join(gitDir(first), 'singularity-flow', 'copilot-otel.jsonl');
  await mkdir(path.dirname(telemetryFile), { recursive: true });
  await writeFile(telemetryFile, `${JSON.stringify({
    name: 'chat enterprise-model', startTime: '2026-08-11T12:02:58.000Z', endTime: '2026-08-11T12:03:00.000Z',
    attributes: {
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github',
      'gen_ai.response.model': 'enterprise-model', 'gen_ai.usage.input_tokens': 120,
      'gen_ai.usage.output_tokens': 30, 'gen_ai.usage.cache_read.input_tokens': 20,
      'gen_ai.conversation.id': 'private-conversation-id'
    }
  })}\n`);

  const promptFile = path.join(workspace, '.singularity-flow', 'prompt-audit', 'prompts.jsonl');
  await mkdir(path.dirname(promptFile), { recursive: true });
  await writeFile(promptFile, `${JSON.stringify({
    id: 'prompt-1', recordedAt: '2026-08-11T12:02:00.000Z', repositoryPath: first,
    workId: 'WRK-1978', phase: 'requirements', agent: 'product-owner', task: 'Formalize requirements',
    promptSha256: 'abc123', bytes: 400, prompt: 'SECRET PROMPT BODY'
  })}\n`);

  await mkdir(path.join(workspace, 'logs'), { recursive: true });
  await writeFile(path.join(workspace, 'logs', 'workspace-materialization.json'), `${JSON.stringify({
    version: 1, workspaceId: 'logs-demo', startedAt: '2026-08-11T12:00:00.000Z',
    operations: [{ id: 'clone-a', action: 'clone', repository: 'repo-a', status: 'complete', completedAt: '2026-08-11T12:01:00.000Z' }]
  }, null, 2)}\n`);

  const report = await collectWorkspaceLogs({ env, limit: 500 });
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.workspace, { id: 'logs-demo', path: await realpath(workspace) });
  assert.deepEqual(report.entries.map((item) => item.source),
    ['activity', 'activity', 'telemetry', 'prompt', 'workspace', 'activity']);
  assert.equal(report.entries.at(-1).timestamp, null);
  assert.match(report.warnings.join('\n'), /missing or invalid timestamp/);
  assert.match(report.warnings.join('\n'), /unreadable record/);
  assert.doesNotMatch(JSON.stringify(report), /SECRET PROMPT BODY|private-conversation-id|outside\.machine\.scan/);
  const telemetry = report.entries.find((item) => item.source === 'telemetry');
  assert.deepEqual(telemetry.details, {
    provider: 'github', model: 'enterprise-model', startedAt: '2026-08-11T12:02:58.000Z',
    completedAt: '2026-08-11T12:03:00.000Z', inputTokens: 120, outputTokens: 30,
    cachedInputTokens: 20, cacheWriteInputTokens: null, providerCost: null, costAvailable: false
  });
  assert.equal(report.sources.some((item) => item.path.includes('outside')), false);
});

test('workspace log filters are applied before pagination', async () => {
  const { first, env } = await fixture();
  await writeActivity(first, [
    JSON.stringify({ ts: '2026-08-11T12:02:00.000Z', level: 'error', event: 'one', msg: 'Target failure', workId: 'WRK-1', phase: 'design', agent: 'architect' }),
    JSON.stringify({ ts: '2026-08-11T12:01:00.000Z', level: 'info', event: 'two', msg: 'Ignore', workId: 'WRK-2', phase: 'intake', agent: 'product-owner' })
  ]);
  const report = await collectWorkspaceLogs({
    env, source: 'activity', repository: 'repo-a', workId: 'wrk-1', phase: 'DESIGN',
    agent: 'architect', level: 'error', since: '2026-08-11T12:00:00Z', text: 'target', limit: 1
  });
  assert.equal(report.total, 1);
  assert.equal(report.entries[0].event, 'one');
  await assert.rejects(() => collectWorkspaceLogs({ env, since: 'yesterday-ish' }), /ISO timestamp/);
  await assert.rejects(() => collectWorkspaceLogs({ env, source: 'raw-spans' }), /Log source must be/);
});

test('workspace logs include launch-owned telemetry with its governed attribution', async () => {
  const { root, first, env } = await fixture();
  const machineEnv = {
    PATH: process.env.PATH,
    SINGULARITY_FLOW_TELEMETRY_PREFERENCES: path.join(root, 'telemetry-preferences.json')
  };
  await setTelemetryCapture(true, { acceptDisclosure: true, env: machineEnv });
  const prepared = await prepareTelemetryLaunch({
    root: first, story: 'WRK-77', phase: 'implementation', host: 'vscode-terminal',
    surface: 'vscode.continue-with-copilot', baseEnv: machineEnv,
    startedAt: '2026-08-11T12:00:00.000Z'
  });
  await recordTelemetryLaunch(prepared, { state: 'started' });
  await writeFile(prepared.rawAbsolute, `${JSON.stringify({
    name: 'chat enterprise-model',
    startTime: '2026-08-11T12:00:01.000Z', endTime: '2026-08-11T12:00:02.000Z',
    attributes: {
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github',
      'gen_ai.response.model': 'enterprise-model', 'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 4
    }
  })}\n`);
  await recordTelemetryLaunch(prepared, { state: 'finished', exitCode: 0 });

  const report = await collectWorkspaceLogs({ env, source: 'telemetry' });
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].workId, 'WRK-77');
  assert.equal(report.entries[0].phase, 'implementation');
  assert.equal(report.entries[0].details.launchId, prepared.launch.launchId);
  assert.equal(report.entries[0].details.surface, 'vscode.continue-with-copilot');
  assert.ok(prepared.rawAbsolute.startsWith(path.join(gitCommonDir(first), 'singularity-flow', 'telemetry', 'raw')));
});

test('workspace logs resolve a linked Git worktree rather than assuming dot-git is a directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worktree-logs-'));
  const source = await repository(root, 'source');
  const worktree = path.join(root, 'linked');
  git(source, ['worktree', 'add', '-b', 'linked-logs', worktree]);
  await writeActivity(worktree, [JSON.stringify({
    ts: '2026-08-11T12:00:00.000Z', level: 'info', event: 'worktree.visible', msg: 'Resolved real git dir'
  })]);
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'workspace.json'), `${JSON.stringify({
    version: 1, id: 'worktree-demo', name: 'Worktree demo',
    anchor: { provider: 'workspace', key: 'worktree-demo' }, leadRepository: 'linked',
    repositories: { linked: { url: 'https://example.invalid/linked.git', path: 'repos/linked' } }
  })}\n`);
  // Workspace manifests intentionally require repository paths below repos/. Use a symlink-free
  // nested worktree in the real test fixture so the path contract and worktree contract both hold.
  const nested = path.join(workspace, 'repos', 'linked');
  await mkdir(path.dirname(nested), { recursive: true });
  git(source, ['worktree', 'remove', '--force', worktree]);
  git(source, ['worktree', 'add', '-b', 'nested-logs', nested]);
  await writeActivity(nested, [JSON.stringify({
    ts: '2026-08-11T12:00:00.000Z', level: 'info', event: 'worktree.visible', msg: 'Resolved real git dir'
  })]);
  const active = path.join(root, 'active.json');
  await writeFile(active, JSON.stringify({
    schemaVersion: 1, workspaceId: 'worktree-demo', workspaceName: 'Worktree demo',
    workspacePath: workspace, repositoryId: 'linked', repositoryPath: nested
  }));
  const report = await collectWorkspaceLogs({ env: {
    ...process.env, SINGULARITY_FLOW_ACTIVE_WORKSPACE: active,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'registry.json')
  }, source: 'activity' });
  assert.equal(report.entries[0].event, 'worktree.visible');
  assert.match(report.sources[0].path, /\.git\/worktrees\/[^/]+\/singularity-flow\/logs\/activity\.log$/);
});

test('identical timestamps use source, repository, and sequence tie-breakers', () => {
  const input = [
    { timestamp: '2026-08-11T12:00:00Z', source: 'prompt', repositoryId: null, _sequence: 4 },
    { timestamp: '2026-08-11T12:00:00Z', source: 'activity', repositoryId: 'repo-b', _sequence: 2 },
    { timestamp: '2026-08-11T12:00:00Z', source: 'activity', repositoryId: 'repo-a', _sequence: 3 },
    { timestamp: '2026-08-11T12:00:00Z', source: 'activity', repositoryId: 'repo-a', _sequence: 1 }
  ];
  input.sort(compareWorkspaceLogEntries);
  assert.deepEqual(input.map((item) => `${item.source}:${item.repositoryId}:${item._sequence}`), [
    'activity:repo-a:1', 'activity:repo-a:3', 'activity:repo-b:2', 'prompt:null:4'
  ]);
});

test('the VS Code logs surface is top-level and legacy log commands route to source tabs', async () => {
  const sidebar = await readFile(new URL('../apps/vscode/src/views/sidebar.ts', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../apps/vscode/src/views/workspace-logs.ts', import.meta.url), 'utf8');
  /**
   * Logs is its own top-level section rather than a drawer inside another one. Its position moved:
   * the sections now read inbox, workspaces, lifecycle, configuration, help, logs — what you owe
   * someone, where you are, what you are doing, how it is set up, how to ask, and what happened.
   * Logs is last because it is the one you go looking for, not the one you are handed.
   */
  const order = ['inbox', 'workspaces', 'lifecycle', 'configuration', 'help', 'logs']
    .map((section) => sidebar.indexOf(`  ${section}: {`));
  assert.ok(order.every((at) => at > 0), 'every section is declared');
  assert.deepEqual([...order].sort((left, right) => left - right), order, 'sections are declared in render order');
  assert.match(extension, /WorkspaceLogsPanel\.show\(context, client, 'prompt'\)/);
  assert.match(extension, /WorkspaceLogsPanel\.show\(context, client, 'activity'\)/);
  assert.match(panel, /Prompt bodies stay hidden from the combined timeline/);
  assert.match(panel, /watchFile\(source\.path/);
  assert.doesNotMatch(panel, /acquireVsCodeApi\(/);
});
