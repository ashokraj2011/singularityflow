import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = path.join(packageRoot, 'plugin');
const bootstrap = path.join(pluginRoot, 'hook-launcher.mjs');
const cli = path.join(packageRoot, 'bin/singularity-flow.mjs');
const actions = ['boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start'];

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-hook-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'chat with spaces');
  await mkdir(cwd);
  const env = { ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(directory, 'mode.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(directory, 'workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(directory, 'registry.json') };
  const invoke = (action, candidates = [cli], input = '{}') => spawnSync(process.execPath,
    [bootstrap, action, ...candidates], { cwd, env, input, encoding: 'utf8', timeout: 10_000 });
  return { directory, cwd, env, invoke };
}

test('every installed hook runs outside Git without npm CLI on PATH or a shell profile', async t => {
  const item = await fixture(t);
  item.env.PATH = '';
  for (const action of actions) {
    const result = item.invoke(action);
    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), {}, action);
  }
});

test('runtime resolution failure is an actionable JSON refusal, never hook exit 127', async t => {
  const item = await fixture(t);
  const result = item.invoke('boundary-guard', ['/missing/singularity-flow.mjs', 'relative/bin/singularity-flow.mjs']);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /SFLOW_HOOK_RUNTIME_UNAVAILABLE/);
  assert.match(decision.permissionDecisionReason, /plugin install/);
  assert.match(decision.permissionDecisionReason, /Preserve the Story/);
  for (const action of actions.filter(action => action !== 'boundary-guard')) {
    assert.deepEqual(JSON.parse(item.invoke(action, []).stdout), {});
  }
});

test('the launcher forwards stdin and rejects arbitrary hook operations', async t => {
  const item = await fixture(t);
  const runtime = path.join(item.directory, 'installed runtime');
  await mkdir(path.join(runtime, 'bin'), { recursive: true });
  await mkdir(path.join(runtime, 'src'));
  await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'singularity-flow', type: 'module',
    bin: { 'singularity-flow': 'bin/singularity-flow.mjs' } }));
  const entry = path.join(runtime, 'bin/singularity-flow.mjs');
  await writeFile(entry, '// fixture entry\n');
  await writeFile(path.join(runtime, 'src/cli-entry.mjs'),
    'export async function main(argv) { let input=""; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({argv,input})); }\n');
  assert.deepEqual(JSON.parse(item.invoke('boundary-guard', [entry], '{"sessionId":"exact"}').stdout), {
    argv: ['hook', 'boundary-guard'], input: '{"sessionId":"exact"}'
  });
  assert.deepEqual(JSON.parse(item.invoke('approve', [entry]).stdout), {});
});

test('a repository-owned PATH package cannot masquerade as the installed CLI', async t => {
  const item = await fixture(t);
  const runtime = path.join(item.cwd, 'node_modules/singularity-flow');
  await mkdir(path.join(runtime, 'bin'), { recursive: true });
  await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'singularity-flow',
    bin: { 'singularity-flow': 'bin/singularity-flow.mjs' } }));
  const entry = path.join(runtime, 'bin/singularity-flow.mjs');
  await writeFile(entry, '// never execute repository code\n');
  assert.equal(JSON.parse(item.invoke('boundary-guard', [entry]).stdout).permissionDecision, 'deny');
  assert.deepEqual(JSON.parse(item.invoke('boundary-guard', [entry, cli]).stdout), {});
});

test('import failure is a structured refusal instead of a raw hook crash', async t => {
  const item = await fixture(t);
  const runtime = path.join(item.directory, 'broken-install');
  await mkdir(path.join(runtime, 'bin'), { recursive: true });
  await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'singularity-flow',
    bin: { 'singularity-flow': 'bin/singularity-flow.mjs' } }));
  const entry = path.join(runtime, 'bin/singularity-flow.mjs');
  await writeFile(entry, '// missing installed src\n');
  const result = item.invoke('boundary-guard', [entry]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).permissionDecisionReason, /SFLOW_HOOK_RUNTIME_UNAVAILABLE/);
});

test('a global user-prefix install works when the GUI starts from its non-Git parent', async t => {
  const item = await fixture(t);
  const runtime = path.join(item.cwd, '.node-prefix/lib/node_modules/singularity-flow');
  await mkdir(path.join(runtime, 'bin'), { recursive: true });
  await mkdir(path.join(runtime, 'src'));
  await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'singularity-flow', type: 'module',
    bin: { 'singularity-flow': 'bin/singularity-flow.mjs' } }));
  const entry = path.join(runtime, 'bin/singularity-flow.mjs');
  await writeFile(entry, '// global-prefix fixture\n');
  await writeFile(path.join(runtime, 'src/cli-entry.mjs'), 'export async function main() { console.log("{}"); }\n');
  assert.deepEqual(JSON.parse(item.invoke('boundary-guard', [entry]).stdout), {});
  // The same dependency location inside a checkout is not an installed-runtime fallback.
  await mkdir(path.join(item.cwd, '.git'));
  assert.equal(JSON.parse(item.invoke('boundary-guard', [entry]).stdout).permissionDecision, 'deny');
});

test('packaged bash hook resolves quoted plugin roots and forwards input through an absolute Node runtime', {
  skip: process.platform === 'win32'
}, async t => {
  const item = await fixture(t);
  const bin = path.join(item.directory, 'host-bin');
  await mkdir(bin);
  const mountedPlugin = path.join(item.directory, 'loaded plugin with spaces');
  await symlink(pluginRoot, mountedPlugin, 'dir');
  await symlink(process.execPath, path.join(bin, 'node'));
  await symlink(cli, path.join(bin, 'singularity-flow'));
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'hooks.json'), 'utf8'));
  const result = spawnSync('/bin/bash', ['-c', manifest.hooks.preToolUse[0].bash], {
    cwd: item.cwd, env: { ...item.env, COPILOT_PLUGIN_ROOT: mountedPlugin, PATH: `${bin}:/usr/bin:/bin` },
    input: '{}', encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('PowerShell hook uses applications and closed operations without profile or expression evaluation', async () => {
  const content = await readFile(path.join(pluginRoot, 'hook-launcher.ps1'), 'utf8');
  assert.match(content, /Get-Command node -CommandType Application/);
  assert.match(content, /hook-launcher\.mjs/);
  assert.match(content, /@candidates/);
  assert.doesNotMatch(content, /Invoke-Expression|Get-ChildItem|\.\s+\$PROFILE/);
  for (const action of actions) assert.ok(content.includes(`'${action}'`));
});
