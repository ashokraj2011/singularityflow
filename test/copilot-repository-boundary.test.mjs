import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { explicitSflowSkill, recordRepositoryBoundaryTurn, endRepositoryBoundaryTurn,
  repositoryDiscoveryGuard, resolveCopilotHookRoot, resolveCopilotDiscoveryRoot } from '../src/copilot-repository-boundary.mjs';
import { setCopilotPaused } from '../src/copilot-mode.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-discovery-'));
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, 'repository');
  const scratch = path.join(directory, 'chats', 'session');
  await mkdir(root); await mkdir(scratch, { recursive: true });
  const payload = { sessionId: 'chat-1', cwd: scratch };
  const guard = command => repositoryDiscoveryGuard({ ...payload,
    toolCalls: [{ name: 'bash', args: { command } }] }, { resolveRoot: async () => root });
  return { directory, root, scratch, payload, guard };
}

test('only explicit slash invocations or host skill contexts opt in; ordinary mentions do not', () => {
  for (const prompt of ['/sf-phase', '/sflow-code focus', 'The user invoked a skill.\n<skill-context name="sf-phase">'])
    assert.ok(explicitSflowSkill(prompt));
  for (const prompt of ['Explain /sf-code', 'find repository', '/other', '', null]) assert.equal(explicitSflowSkill(prompt), null);
});

test('native chat short-circuits without repository resolution or restrictions', async t => {
  const item = await fixture(t);
  let probes = 0;
  assert.deepEqual(await repositoryDiscoveryGuard({ ...item.payload,
    toolCalls: [{ name: 'bash', args: { command: 'find /Users' } }] }, {
    resolveRoot: async () => { probes++; throw new Error('must not run'); }
  }), {});
  assert.equal(probes, 0);
});

test('explicit SFlow blocks the actual compacted-chat discovery commands and supplies bootstrap', async t => {
  const item = await fixture(t);
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-phase' });
  for (const command of ['find /Users -maxdepth 6',
    "pwd && ls -la && find /Users -path '*/singularity/work-items/*' | head -100",
    'find /Users/ashokraj -name .git', 'find $HOME', 'find ${HOME}', 'find ~', 'find ..',
    'find /', `find '${item.root}' /Users -name singularity`, 'rg --files /Users', 'rg --files', 'ls -la']) {
    const decision = await item.guard(command);
    assert.equal(decision.permissionDecision, 'deny', command);
    assert.match(decision.permissionDecisionReason, /phase enter --for-agent --json/);
    assert.match(decision.permissionDecisionReason, /\/sf-session or \/sf-workspaces/);
  }
});

test('bound repository searches, bootstrap, tests and direct source operations remain allowed', async t => {
  const item = await fixture(t);
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-code' });
  for (const command of ['singularity-flow phase enter --for-agent --json',
    `find '${item.root}' -name '*.js'`, `cd '${item.root}' && rg --files src`,
    `cd '${item.root}' && find . -name '*.js'`, `cd '${item.root}' && cd src && rg --files`,
    'npm test', 'git diff -- src/App.jsx']) {
    assert.deepEqual(await item.guard(command), {}, command);
  }
  assert.deepEqual(await repositoryDiscoveryGuard({ ...item.payload, cwd: item.root,
    toolCalls: [{ name: 'glob', args: { pattern: '**/*.jsx', path: item.root } }] }, {
    resolveRoot: async () => item.root
  }), {});
  assert.equal((await item.guard(`cd '${item.root}' && cd .. && find .`)).permissionDecision, 'deny');
});

test('discovery uses the phase-entry selected checkout, not an unrelated launch Git root', async t => {
  const item = await fixture(t);
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-code' });
  const rootFor = () => '/unrelated/launch-repository';
  const resolveRoot = payload => resolveCopilotDiscoveryRoot(payload, { rootFor,
    resolveSelected: async () => ({ repositoryPath: item.root, selectionStatus: 'ready' }) });
  assert.equal(await resolveRoot(item.payload), item.root);
  assert.deepEqual(await repositoryDiscoveryGuard({ ...item.payload,
    toolName: 'bash', toolArgs: { command: `find '${item.root}' -name '*.js'` }
  }, { resolveRoot }), {});
  assert.equal(await resolveCopilotDiscoveryRoot(item.payload, { rootFor,
    resolveSelected: async () => ({ repositoryPath: '/stale', selectionStatus: 'stale' }) }), null);
  assert.equal(await resolveCopilotDiscoveryRoot(item.payload, { rootFor, resolveSelected: async () => null }), '/unrelated/launch-repository');
  await setCopilotPaused(true);
  assert.equal(await resolveCopilotDiscoveryRoot(item.payload, {
    rootFor: () => { throw new Error('must not inspect Git'); },
    resolveSelected: () => { throw new Error('must not resolve selection'); }
  }), null);
});

test('structured search tools and batched calls cannot bypass the directory boundary', async t => {
  const item = await fixture(t);
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-next' });
  for (const call of [{ name: 'glob', args: { pattern: '/Users/**/work-items/**' } },
    { name: 'rg', args: { paths: '/Users', pattern: 'workflow' } },
    { name: 'grep', args: JSON.stringify({ path: '..', pattern: 'work-items' }) }]) {
    const decision = await repositoryDiscoveryGuard({ ...item.payload, toolCalls: [
      { name: 'bash', args: { command: 'singularity-flow nextsteps --for-agent --json' } }, call
    ] }, { resolveRoot: async () => item.root });
    assert.equal(decision.permissionDecision, 'deny');
    assert.match(decision.permissionDecisionReason, /nextsteps --for-agent --json/);
  }
});

test('ordinary next turn, another session and session end never inherit SFlow restrictions', async t => {
  const item = await fixture(t);
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-phase' });
  assert.deepEqual(await repositoryDiscoveryGuard({ ...item.payload, sessionId: 'other',
    toolCalls: [{ name: 'bash', args: { command: 'find /Users' } }] }), {});
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: 'Help me find another project' });
  assert.deepEqual(await item.guard('find /Users'), {});
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-phase' });
  await endRepositoryBoundaryTurn(item.payload);
  assert.deepEqual(await item.guard('find /Users'), {});
});

test('pause and resume invalidate the old scope; expired or corrupt records stay nonintrusive', async t => {
  const item = await fixture(t);
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-phase' });
  await setCopilotPaused(true);
  assert.deepEqual(await item.guard('find /Users'), {});
  await setCopilotPaused(false);
  assert.deepEqual(await item.guard('find /Users'), {});
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-phase' }, { now: 1 });
  assert.deepEqual(await item.guard('find /Users'), {});
  const file = path.join(item.directory, 'copilot-boundaries', (await readdir(path.join(item.directory, 'copilot-boundaries')))[0]);
  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['modeChangedAt', 'recordedAt', 'schemaVersion', 'sessionId', 'skill']);
  await writeFile(file, '{bad');
  assert.deepEqual(await item.guard('find /Users'), {});
});

test('exact external tool-output files are readable without allowing external directory discovery', async t => {
  const item = await fixture(t);
  const output = path.join(item.directory, 'tool-output.json'); await writeFile(output, '{}');
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-phase' });
  assert.deepEqual(await repositoryDiscoveryGuard({ ...item.payload,
    toolCalls: [{ name: 'rg', args: { paths: output, pattern: 'ready' } }] }, { resolveRoot: async () => item.root }), {});
  assert.deepEqual(await item.guard(`rg -n 'ready' '${output}'`), {});
  assert.deepEqual(await item.guard(`grep -e 'ready' '${output}'`), {});
  assert.equal((await repositoryDiscoveryGuard({ ...item.payload, cwd: item.root,
    toolName: 'bash', toolArgs: JSON.stringify({ command: `rg --files '${item.directory}'` })
  }, { resolveRoot: async () => item.root })).permissionDecision, 'deny');
});

test('native host payload forms deny only directory searches and ignore malformed input', async t => {
  const item = await fixture(t);
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-inputs' });
  for (const fields of [{ toolName: 'bash', toolArgs: JSON.stringify({ command: 'find /Users' }) },
    { tool_name: 'glob', tool_input: { path: '/Users', pattern: '**/*.mjs' } }]) {
    const result = await repositoryDiscoveryGuard({ ...item.payload, ...fields }, { resolveRoot: async () => item.root });
    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /inputs --dry-run --for-agent --json/);
  }
  assert.deepEqual(await repositoryDiscoveryGuard({ ...item.payload, toolName: 'bash', toolArgs: '{bad' }), {});
});

test('agent hook fallback is explicit-only, preserves caller roots and never selects a stale checkout', async t => {
  const item = await fixture(t);
  const rootFor = () => { throw new Error('outside Git'); };
  let probes = 0;
  const resolveSelected = async () => { probes++; return { repositoryPath: item.root, selectionStatus: 'ready' }; };
  assert.equal(await resolveCopilotHookRoot({ ...item.payload, agentName: 'native' }, { rootFor, resolveSelected }), null);
  assert.equal(probes, 0);
  assert.equal(await resolveCopilotHookRoot({ ...item.payload, agentName: 'sflow-workflow' }, { rootFor, resolveSelected }), item.root);
  assert.equal(await resolveCopilotHookRoot(item.payload, { rootFor: () => '/exact/caller', resolveSelected }), '/exact/caller');
  await recordRepositoryBoundaryTurn({ ...item.payload, prompt: '/sf-code' });
  assert.equal(await resolveCopilotHookRoot(item.payload, { rootFor, resolveSelected }), item.root);
  assert.equal(await resolveCopilotHookRoot(item.payload, { rootFor,
    resolveSelected: async () => ({ repositoryPath: '/old', selectionStatus: 'stale' }) }), null);
  await setCopilotPaused(true);
  assert.equal(await resolveCopilotHookRoot({ ...item.payload, agentName: 'sflow-workflow' }, {
    rootFor: () => { throw new Error('must not inspect Git'); }, resolveSelected
  }), null);
});

test('CLI hooks work from a neutral SDK cwd without touching a repository or requiring a Story', async t => {
  const item = await fixture(t);
  const env = { ...process.env, PATH: '', SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.directory, 'none.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.directory, 'no-registry.json') };
  const invoke = (event, payload) => {
    const result = spawnSync(process.execPath, [path.resolve('bin/singularity-flow.mjs'), 'hook', event], {
      cwd: item.scratch, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15_000
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(invoke('boundary-turn', { ...item.payload, prompt: '/sf-phase' }), {});
  assert.equal(invoke('boundary-guard', { ...item.payload,
    toolCalls: [{ name: 'bash', args: { command: 'find /Users' } }] }).permissionDecision, 'deny');
  assert.deepEqual(invoke('boundary-guard', { ...item.payload,
    toolCalls: [{ name: 'bash', args: { command: 'singularity-flow phase enter --for-agent --json' } }] }), {});
  assert.deepEqual(invoke('boundary-end', item.payload), {});
  assert.deepEqual(invoke('boundary-guard', { ...item.payload,
    toolCalls: [{ name: 'bash', args: { command: 'find /Users' } }] }), {});
  assert.deepEqual(invoke('boundary-guard', null), {});
  assert.deepEqual(invoke('boundary-turn', []), {});
});
