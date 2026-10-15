import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCopilotHook } from '../src/copilot-hook-runtime.mjs';
import { operationContext } from '../src/operation-context.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = path.join(root, 'plugin/hook-launcher.mjs');
const cli = path.join(root, 'bin/singularity-flow.mjs');

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-hook-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'chat with spaces');
  await mkdir(cwd);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_GIT_FACT_STORE: 'off', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(directory, 'mode.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(directory, 'active.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(directory, 'registry.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(directory, 'leads.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Hook Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'hook@example.invalid' };
  const invoke = (mode, action, payload = {}) => {
    const result = spawnSync(process.execPath, [launcher, action, cli], { cwd, env: { ...env, SINGULARITY_FLOW_HOOK_RUNTIME: mode },
      input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${mode} ${action}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const same = (action, payload) => {
    const before = invoke('legacy', action, payload), after = invoke('dedicated', action, payload);
    assert.deepEqual(after, before, action);
    return after;
  };
  return { directory, cwd, env, invoke, same };
}

test('dedicated entry preserves native, malformed and paused hook responses outside Git', async t => {
  const item = await fixture(t);
  const actions = ['boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start'];
  for (const action of actions) {
    assert.deepEqual(item.same(action, '{}'), {});
    assert.deepEqual(item.same(action, '{broken'), {});
    assert.deepEqual(item.same(action, 'null'), {});
  }
  await writeFile(item.env.SINGULARITY_FLOW_COPILOT_MODE_FILE, JSON.stringify({ schemaVersion: 1, paused: true }));
  item.env.PATH = '';
  await writeFile(item.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, '{broken');
  await writeFile(item.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, '{broken');
  for (const action of actions) assert.deepEqual(item.same(action, { sessionId: 'paused', prompt: '/sf-code',
    agentName: 'sflow-workflow', cwd: item.cwd }), {});
  assert.deepEqual((await readdir(item.cwd)), [], 'no repository or workspace was materialized');
});

test('active-turn denials, permitted bootstrap reads, post-tool results and reset match the CLI', async t => {
  const item = await fixture(t);
  const binding = { sessionId: 'exact-session', cwd: item.cwd };
  assert.deepEqual(item.same('boundary-turn', { ...binding, prompt: '/sf-code' }), {});
  const files = await readdir(path.join(item.directory, 'copilot-boundaries'));
  assert.ok(files.some(file => file.endsWith('.mutation.json')), 'capture still records the missing Story contract');
  const denied = item.same('boundary-guard', { ...binding, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /PHASE_MUTATION_CONTRACT_REQUIRED/);
  const search = item.same('boundary-guard', { ...binding, toolName: 'bash', toolArgs: { command: 'find /Users' } });
  assert.equal(search.permissionDecision, 'deny');
  assert.deepEqual(item.same('boundary-guard', { ...binding, toolName: 'bash',
    toolArgs: { command: 'singularity-flow workspace current --json' } }), {});
  item.same('boundary-after', { ...binding, toolName: 'bash', toolArgs: { command: 'singularity-flow workspace current --json' } });
  assert.deepEqual(item.same('boundary-turn', { ...binding, prompt: 'Ordinary native chat' }), {});
  assert.deepEqual(item.same('boundary-guard', { ...binding, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } }), {});
  item.same('boundary-turn', { ...binding, prompt: '/sf-review-source' });
  assert.deepEqual(item.same('boundary-end', binding), {});
  assert.deepEqual(item.same('boundary-guard', { ...binding, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } }), {});
});

test('governed agent selection retains the existing authority, trust and session effect', async t => {
  const item = await fixture(t);
  const repo = path.join(item.directory, 'repository');
  const git = spawnSync('git', ['init', '-q', '-b', 'main', repo], { env: item.env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const init = spawnSync(process.execPath, [cli, '--no-model', 'init'], { cwd: repo, env: item.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(init.status, 0, init.stderr);
  const selected = item.same('agent-start', { cwd: repo, sessionId: 'agent-session', agentName: 'product-owner' });
  assert.match(selected.additionalContext, /Working repository:/);
  assert.match(selected.additionalContext, /Selecting the agent alone does not run the workflow/);
  const session = JSON.parse(await readFile(path.join(repo, '.git/singularity-flow/session.json'), 'utf8'));
  assert.equal(session.nativeCopilotAgent, 'product-owner');
  assert.equal(session.agent, 'product-owner');
  assert.equal(session.workId ?? null, null, 'agent selection alone never starts or advances a Story');

  // A chunk boundary inside a multibyte native agent name must not change its identity.
  const runtime = pathToFileURL(path.join(root, 'src/copilot-hook-runtime.mjs')).href;
  const payload = { cwd: repo, sessionId: 'agent-session', agentName: 'réviewer' };
  const fragmented = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Readable } from 'node:stream';
    import { runCopilotHook } from ${JSON.stringify(runtime)};
    const bytes = Buffer.from(${JSON.stringify(JSON.stringify(payload))});
    const at = bytes.indexOf(Buffer.from('é')) + 1;
    await runCopilotHook('agent-start', Readable.from([bytes.subarray(0, at), bytes.subarray(at)]));
  `], { cwd: item.cwd, env: item.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(fragmented.status, 0, fragmented.stderr);
  assert.match(JSON.parse(fragmented.stdout).additionalContext, /réviewer/);
  const retained = JSON.parse(await readFile(path.join(repo, '.git/singularity-flow/session.json'), 'utf8'));
  assert.equal(retained.nativeCopilotAgent, 'réviewer');
  assert.equal(retained.agent, 'product-owner', 'an unmapped native name never replaces the governed author');
});

test('oversized agent input is bounded before any repository selection', async t => {
  const item = await fixture(t);
  const response = item.invoke('dedicated', 'agent-start', JSON.stringify({ agentName: 'product-owner',
    cwd: item.cwd, unused: 'x'.repeat(1024 * 1024) }));
  assert.deepEqual(response, {});
  assert.deepEqual(await readdir(item.cwd), []);
});

test('plugin runtime keeps a registered never-model context, restores signal listeners and rejects lifecycle actions', async () => {
  const before = process.listeners('SIGTERM');
  const messages = [], log = console.log;
  const previous = process.env.SINGULARITY_FLOW_GIT_FACT_STORE;
  process.env.SINGULARITY_FLOW_GIT_FACT_STORE = 'off';
  const input = async function* () {
    assert.equal(operationContext().effectivePolicy, 'never');
    assert.equal(operationContext().command, 'hook');
    assert.equal(operationContext().root, null);
    yield '{}';
  };
  console.log = value => messages.push(value);
  try { await runCopilotHook('boundary-end', Readable.from(input())); }
  finally {
    console.log = log;
    previous === undefined ? delete process.env.SINGULARITY_FLOW_GIT_FACT_STORE : process.env.SINGULARITY_FLOW_GIT_FACT_STORE = previous;
  }
  assert.deepEqual(messages, ['{}']);
  assert.equal(operationContext(), null);
  assert.deepEqual(process.listeners('SIGTERM'), before);
  for (const action of ['approve', 'phase publish', 'agent-guard', '__proto__']) {
    await assert.rejects(runCopilotHook(action, Readable.from(['{}'])), /Unsupported Copilot plugin hook action/);
  }
});
