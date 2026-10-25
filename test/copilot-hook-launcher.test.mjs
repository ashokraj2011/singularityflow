import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { copilotHookCommand } from '../src/copilot-hook-commands.mjs';
import { hookCliLine, setHookCli } from '../src/copilot-mode.mjs';
import { RUNTIME_UNAVAILABLE_MARKER } from '../src/copilot-repository-boundary.mjs';
import { renderPlatformCommand } from '../src/safe-command-guidance.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = path.join(packageRoot, 'plugin');
const bootstrap = path.join(pluginRoot, 'hook-launcher.mjs');
const cli = path.join(packageRoot, 'bin/singularity-flow.mjs');
const actions = ['boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start'];
const events = ['userPromptSubmitted', 'preToolUse', 'postToolUse', 'sessionEnd', 'subagentStart'];
// Restrict execution-policy bypass to these disposable test processes, not the machine policy.
const powershellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const powershell = ['pwsh', ...(process.platform === 'win32' ? ['powershell'] : [])].find(command =>
  spawnSync(command, [...powershellArgs, '$PSVersionTable.PSVersion.ToString()'],
    { encoding: 'utf8', timeout: childTimeout(10_000) }).status === 0);

function rootEnvironment(env, roots) {
  const next = { ...env };
  delete next.PLUGIN_ROOT;
  delete next.COPILOT_PLUGIN_ROOT;
  return { ...next, ...roots };
}

async function manifestCommands(shell) {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'hooks.json'), 'utf8'));
  return events.map((event, index) => [actions[index], manifest.hooks[event][0][shell]]);
}

function assertRootUnavailable(result, action) {
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  if (action === 'boundary-guard') {
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /SFLOW_HOOK_PLUGIN_ROOT_UNAVAILABLE/);
    assert.match(output.permissionDecisionReason, /plugin install/);
  } else assert.deepEqual(output, {});
  assert.match(result.stderr, /SFLOW_HOOK_PLUGIN_ROOT_UNAVAILABLE/);
  assert.doesNotMatch(result.stderr, /No such file or directory|CommandNotFoundException/);
}

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
    [bootstrap, action, ...candidates], { cwd, env, input, encoding: 'utf8', timeout: childTimeout(10_000) });
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

test('a dedicated installed runtime is preferred, with a closed legacy diagnostic fallback', async t => {
  const item = await fixture(t);
  const runtime = path.join(item.directory, 'dedicated runtime');
  await mkdir(path.join(runtime, 'bin'), { recursive: true });
  await mkdir(path.join(runtime, 'src'));
  await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'singularity-flow', type: 'module',
    bin: { 'singularity-flow': 'bin/singularity-flow.mjs' } }));
  const entry = path.join(runtime, 'bin/singularity-flow.mjs');
  await writeFile(entry, '// installed runtime fixture\n');
  await writeFile(path.join(runtime, 'src/copilot-hook-runtime.mjs'),
    'export async function runCopilotHook(action) { let input=""; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({runtime:"dedicated",action,input})); }\n');
  await writeFile(path.join(runtime, 'src/cli-entry.mjs'),
    'export async function main(argv) { console.log(JSON.stringify({runtime:"legacy",argv})); }\n');
  assert.deepEqual(JSON.parse(item.invoke('boundary-guard', [entry], '{"sessionId":"exact"}').stdout),
    { runtime: 'dedicated', action: 'boundary-guard', input: '{"sessionId":"exact"}' });
  item.env.SINGULARITY_FLOW_HOOK_RUNTIME = 'legacy';
  assert.deepEqual(JSON.parse(item.invoke('boundary-guard', [entry]).stdout),
    { runtime: 'legacy', argv: ['hook', 'boundary-guard'] });
  item.env.SINGULARITY_FLOW_HOOK_RUNTIME = 'off';
  assert.equal(JSON.parse(item.invoke('boundary-guard', [entry]).stdout).runtime, 'dedicated', 'off cannot disable the hook');
  await writeFile(path.join(runtime, 'src/copilot-hook-runtime.mjs'), 'throw new Error("broken dedicated runtime");\n');
  assert.match(JSON.parse(item.invoke('boundary-guard', [entry]).stdout).permissionDecisionReason,
    /SFLOW_HOOK_RUNTIME_UNAVAILABLE/, 'do not silently downgrade a broken installed policy runtime');
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

test('every packaged bash hook accepts VS Code and CLI roots, preferring the current host root', {
  skip: process.platform === 'win32'
}, async t => {
  const item = await fixture(t);
  const bin = path.join(item.directory, 'host-bin');
  await mkdir(bin);
  const mountedPlugin = path.join(item.directory, "loaded plugin ' & with spaces");
  await symlink(pluginRoot, mountedPlugin, 'dir');
  await symlink(process.execPath, path.join(bin, 'node'));
  await symlink(cli, path.join(bin, 'singularity-flow'));
  for (const roots of [
    { PLUGIN_ROOT: mountedPlugin }, { COPILOT_PLUGIN_ROOT: mountedPlugin },
    { PLUGIN_ROOT: mountedPlugin, COPILOT_PLUGIN_ROOT: '/stale/plugin' },
    { PLUGIN_ROOT: '', COPILOT_PLUGIN_ROOT: mountedPlugin }
  ]) for (const [action, command] of await manifestCommands('bash')) {
    const result = spawnSync('/bin/bash', ['-c', command], {
      cwd: item.cwd, env: { ...rootEnvironment(item.env, roots), PATH: `${bin}:/usr/bin:/bin` },
      input: '{}', encoding: 'utf8', timeout: childTimeout(10_000)
    });
    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    assert.equal(result.stderr, '', action);
    assert.deepEqual(JSON.parse(result.stdout), {}, action);
  }
});

test('the packaged preToolUse hook judges a batched toolCalls payload call by call', {
  skip: process.platform === 'win32'
}, async t => {
  const item = await fixture(t);
  const bin = path.join(item.directory, 'host-bin');
  await mkdir(bin);
  await symlink(process.execPath, path.join(bin, 'node'));
  await symlink(cli, path.join(bin, 'singularity-flow'));
  const commands = Object.fromEntries(await manifestCommands('bash'));
  const hook = (action, payload) => {
    const result = spawnSync('/bin/bash', ['-c', commands[action]], {
      cwd: item.cwd, env: { ...rootEnvironment(item.env, { PLUGIN_ROOT: pluginRoot }), PATH: `${bin}:/usr/bin:/bin` },
      input: JSON.stringify(payload), encoding: 'utf8', timeout: childTimeout(30_000)
    });
    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  // The batch shape Copilot 1.0.9x records, { sessionId, cwd, toolCalls: [{ id, name, args }] }; a
  // command hook has so far received one call as toolName/toolArgs. Either way it gives one decision.
  const binding = { sessionId: 'batched-session', cwd: item.cwd };
  const workspace = { id: 'call_1', name: 'bash', args: { command: 'singularity-flow workspace current --json' } };
  const view = { id: 'call_2', name: 'view', args: { path: path.join(item.cwd, 'notes.md') } };
  const edit = { id: 'call_3', name: 'edit', args: { path: 'src/App.jsx' } };
  const search = { id: 'call_4', name: 'glob', args: { pattern: '**/*.jsx', paths: '/' } };
  assert.deepEqual(hook('boundary-turn', { ...binding, prompt: '/sf-code' }), {});

  assert.deepEqual(hook('boundary-guard', { ...binding, toolCalls: [workspace, view] }), {},
    'a read beside the permitted bootstrap command is judged as it is alone');
  const denied = hook('boundary-guard', { ...binding, toolCalls: [edit] });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /PHASE_MUTATION_CONTRACT_REQUIRED/);
  assert.deepEqual(hook('boundary-guard', { ...binding, toolCalls: [workspace, view, edit] }), denied,
    'one denied call denies the batch with its reason');
  assert.deepEqual(hook('boundary-guard', { ...binding, toolName: 'edit', toolArgs: edit.args }), denied,
    'the single-call shape gets the same answer');
  const discovery = hook('boundary-guard', { ...binding, toolCalls: [view, search] });
  assert.equal(discovery.permissionDecision, 'deny');
  assert.match(discovery.permissionDecisionReason, /must not discover a repository/);

  assert.deepEqual(hook('boundary-end', binding), {});
  assert.deepEqual(hook('boundary-guard', { ...binding, toolCalls: [workspace, view, edit, search] }), {},
    'outside an explicit SFlow turn no batch is gated');
});

test('every bash hook diagnoses missing, empty or stale plugin roots before launching', {
  skip: process.platform === 'win32'
}, async t => {
  const item = await fixture(t);
  await mkdir(path.join(item.cwd, 'relative-plugin'));
  await writeFile(path.join(item.cwd, 'relative-plugin/hook-launcher.sh'), 'printf NOT_INSTALLED\n');
  for (const roots of [{}, { PLUGIN_ROOT: '', COPILOT_PLUGIN_ROOT: '' },
    { PLUGIN_ROOT: item.directory },
    { PLUGIN_ROOT: 'relative-plugin', COPILOT_PLUGIN_ROOT: pluginRoot },
    { PLUGIN_ROOT: path.join(item.directory, 'missing plugin'), COPILOT_PLUGIN_ROOT: pluginRoot }
  ]) for (const [action, command] of await manifestCommands('bash')) {
    assertRootUnavailable(spawnSync('/bin/bash', ['-c', command], {
      cwd: item.cwd, env: rootEnvironment(item.env, roots), input: '{}', encoding: 'utf8', timeout: childTimeout(10_000)
    }), action);
  }
});

test('every PowerShell hook invokes the literal host root and forwards the action and stdin', {
  skip: !powershell && 'PowerShell host unavailable'
}, async t => {
  const item = await fixture(t);
  const mountedPlugin = path.join(item.directory, "loaded plugin ' & with spaces");
  await mkdir(mountedPlugin);
  await writeFile(path.join(mountedPlugin, 'hook-launcher.ps1'),
    'param([string]$Action)\n@{ action = $Action; input = [Console]::In.ReadToEnd() } | ConvertTo-Json -Compress\n');
  for (const roots of [
    { PLUGIN_ROOT: mountedPlugin }, { COPILOT_PLUGIN_ROOT: mountedPlugin },
    { PLUGIN_ROOT: mountedPlugin, COPILOT_PLUGIN_ROOT: path.join(item.directory, 'stale') },
    { PLUGIN_ROOT: '', COPILOT_PLUGIN_ROOT: mountedPlugin }
  ]) for (const [action, command] of await manifestCommands('powershell')) {
    const result = spawnSync(powershell, [...powershellArgs, command], {
      cwd: item.cwd, env: rootEnvironment(item.env, roots), input: '{"sessionId":"exact"}', encoding: 'utf8', timeout: childTimeout(10_000)
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { action, input: '{"sessionId":"exact"}' });
  }
});

test('every PowerShell hook returns structured diagnostics for missing, empty or stale roots', {
  skip: !powershell && 'PowerShell host unavailable'
}, async t => {
  const item = await fixture(t);
  await mkdir(path.join(item.cwd, 'relative-plugin'));
  await writeFile(path.join(item.cwd, 'relative-plugin/hook-launcher.ps1'), "Write-Output 'NOT_INSTALLED'\n");
  for (const roots of [{}, { PLUGIN_ROOT: '', COPILOT_PLUGIN_ROOT: '' },
    { PLUGIN_ROOT: item.directory },
    { PLUGIN_ROOT: 'relative-plugin', COPILOT_PLUGIN_ROOT: pluginRoot },
    { PLUGIN_ROOT: path.join(item.directory, 'missing plugin'), COPILOT_PLUGIN_ROOT: pluginRoot }
  ]) for (const [action, command] of await manifestCommands('powershell')) {
    assertRootUnavailable(spawnSync(powershell, [...powershellArgs, command], {
      cwd: item.cwd, env: rootEnvironment(item.env, roots), input: '{}', encoding: 'utf8', timeout: childTimeout(10_000)
    }), action);
  }
});

test('packaged PowerShell launcher finds the Windows-style APPDATA runtime and forwards stdin', {
  skip: !powershell && 'PowerShell host unavailable'
}, async t => {
  const item = await fixture(t);
  const appData = path.join(item.directory, 'Windows app data');
  const hostBin = path.join(item.directory, 'host-bin');
  await mkdir(hostBin);
  // Shadow any real installed CLI without executing it. Its missing adjacent package forces the
  // launcher to use this test's APPDATA package, even on a fully configured Windows host.
  await writeFile(path.join(hostBin, process.platform === 'win32' ? 'singularity-flow.cmd' : 'singularity-flow'),
    process.platform === 'win32' ? '@exit /b 99\r\n' : '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const runtime = path.join(appData, 'npm/node_modules/singularity-flow');
  await mkdir(path.join(runtime, 'bin'), { recursive: true });
  await mkdir(path.join(runtime, 'src'));
  await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'singularity-flow', type: 'module',
    bin: { 'singularity-flow': 'bin/singularity-flow.mjs' } }));
  await writeFile(path.join(runtime, 'bin/singularity-flow.mjs'), '// installed runtime fixture\n');
  await writeFile(path.join(runtime, 'src/cli-entry.mjs'),
    'export async function main(argv) { let input=""; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({argv,input})); }\n');
  // A recorded turn: without one the guard, after-tool and end hooks answer without Node (tested below).
  await mkdir(path.join(item.directory, 'copilot-boundaries'));
  await writeFile(path.join(item.directory, 'copilot-boundaries', 'session.json'), '{}');
  for (const [action, command] of await manifestCommands('powershell')) {
    const result = spawnSync(powershell, [...powershellArgs, command], {
      cwd: item.cwd, env: { ...rootEnvironment(item.env, { PLUGIN_ROOT: pluginRoot }), APPDATA: appData,
        PATH: `${hostBin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${item.env.PATH ?? ''}` },
      input: '{"sessionId":"exact"}', encoding: 'utf8', timeout: childTimeout(10_000)
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { argv: ['hook', action], input: '{"sessionId":"exact"}' });
  }
});

test('a launcher this machine\'s execution policy refuses runs again in its own PowerShell, stdin and all', {
  skip: !powershell && 'PowerShell host unavailable'
}, async t => {
  const item = await fixture(t);
  // A stand-in launcher: its first run is refused as a script file is under Restricted or AllSigned;
  // the run in its own PowerShell (policy bypassed for that process only) answers with what it read.
  const root = path.join(item.directory, 'plugin root');
  await mkdir(root);
  const marker = path.join(item.directory, 'refused-once');
  await writeFile(path.join(root, 'hook-launcher.ps1'), [
    'param([string]$Action)',
    `if (-not (Test-Path -LiteralPath '${marker}')) { New-Item -ItemType File -Path '${marker}' | Out-Null; throw [System.Management.Automation.PSSecurityException]::new('running scripts is disabled on this system') }`,
    "$read = [Console]::In.ReadToEnd(); Write-Output (ConvertTo-Json -Compress @{ action = $Action; input = $read })"
  ].join('\n'));
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', copilotHookCommand('boundary-guard', 'powershell')], {
    cwd: item.cwd, env: rootEnvironment(item.env, { PLUGIN_ROOT: root }), input: '{"sessionId":"refused"}',
    encoding: 'utf8', timeout: childTimeout(20_000)
  });
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(answer.action, 'boundary-guard');
  assert.equal(answer.input.trim(), '{"sessionId":"refused"}', 'the payload reaches the second run');
});

test('all shipped hook commands use the closed host-neutral command composer', async () => {
  for (const shell of ['bash', 'powershell']) for (const [action, command] of await manifestCommands(shell)) {
    assert.equal(command, copilotHookCommand(action, shell));
    assert.match(command, /PLUGIN_ROOT/);
    assert.match(command, /COPILOT_PLUGIN_ROOT/);
    assert.match(command, /SFLOW_HOOK_PLUGIN_ROOT_UNAVAILABLE/);
    assert.doesNotMatch(command, /Invoke-Expression|eval |\$HOME|Get-ChildItem/);
  }
  assert.throws(() => copilotHookCommand('approve', 'bash'), /Unsupported Copilot hook action/);
  assert.throws(() => copilotHookCommand('boundary-guard', 'cmd'), /Unsupported Copilot hook shell/);
});

test('PowerShell hook uses applications and closed operations without profile or expression evaluation', async () => {
  const content = await readFile(path.join(pluginRoot, 'hook-launcher.ps1'), 'utf8');
  assert.match(content, /Get-Command node -CommandType Application/);
  assert.match(content, /hook-launcher\.mjs/);
  assert.match(content, /@candidates/);
  assert.doesNotMatch(content, /Invoke-Expression|Get-ChildItem|\.\s+\$PROFILE/);
  for (const action of actions) assert.ok(content.includes(`'${action}'`));
});

test('with no SFlow turn recorded, bash guard, after-tool and end hooks answer without starting Node', {
  skip: process.platform === 'win32'
}, async t => {
  const item = await fixture(t);
  const bin = path.join(item.directory, 'host-bin');
  await mkdir(bin);
  const started = path.join(item.directory, 'node-started');
  // A stand-in node that records each start, then runs the real one.
  await writeFile(path.join(bin, 'node'), `#!/bin/sh\necho started >> '${started}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  await symlink(cli, path.join(bin, 'singularity-flow'));
  const launch = (action, input = '{"sessionId":"native"}') => spawnSync('/bin/bash', [path.join(pluginRoot, 'hook-launcher.sh'), action], {
    cwd: item.cwd, env: { ...item.env, PATH: `${bin}:/usr/bin:/bin` }, input, encoding: 'utf8', timeout: childTimeout(10_000)
  });
  const nodeStarts = () => (existsSync(started) ? readFileSync(started, 'utf8').split('\n').filter(Boolean).length : 0);
  for (const action of ['boundary-guard', 'boundary-after', 'boundary-end']) {
    const result = launch(action);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {}, action);
  }
  const large = JSON.stringify({ sessionId: 'native', toolArgs: { content: 'x'.repeat(256 * 1024) } });
  assert.deepEqual(JSON.parse(launch('boundary-guard', large).stdout), {}, 'a large payload is read and answered');
  assert.equal(nodeStarts(), 0, 'no hook started Node');

  // An explicit SFlow turn records a boundary; while it exists every guard goes to the runtime.
  assert.equal(launch('boundary-turn', JSON.stringify({ sessionId: 'sflow', prompt: '/sf-phase' })).status, 0);
  assert.equal(nodeStarts(), 1);
  assert.deepEqual(JSON.parse(launch('boundary-guard').stdout), {}, 'another session still gets no decision');
  assert.equal(nodeStarts(), 2, 'but from the runtime');
  assert.equal(launch('boundary-turn', JSON.stringify({ sessionId: 'sflow', prompt: 'thanks' })).status, 0);
  launch('boundary-guard');
  assert.equal(nodeStarts(), 3, 'a native prompt removed the record; the guard answers without Node again');
});

test('a runtime that cannot load keeps the shell guard failing closed until a working one takes a prompt', {
  skip: process.platform === 'win32'
}, async t => {
  const item = await fixture(t);
  const boundaries = path.join(item.directory, 'copilot-boundaries');
  const broken = item.invoke('boundary-guard', ['/missing/bin/singularity-flow.mjs']);
  assert.equal(JSON.parse(broken.stdout).permissionDecision, 'deny');
  assert.deepEqual(readdirSync(boundaries), [RUNTIME_UNAVAILABLE_MARKER], 'the shell launcher now sends hooks to Node');
  const bin = path.join(item.directory, 'host-bin');
  await mkdir(bin);
  const started = path.join(item.directory, 'node-started');
  // A stand-in node that only records being started: the marker must send the guard to Node,
  // whose bootstrap refuses for a runtime it cannot load (shown above).
  await writeFile(path.join(bin, 'node'), `#!/bin/sh\necho started >> '${started}'\necho '{}'\n`, { mode: 0o755 });
  const shellGuard = spawnSync('/bin/bash', [path.join(pluginRoot, 'hook-launcher.sh'), 'boundary-guard'], {
    cwd: item.cwd, env: { ...item.env, PATH: `${bin}:/usr/bin:/bin` }, input: '{"sessionId":"native"}', encoding: 'utf8', timeout: childTimeout(10_000)
  });
  assert.equal(shellGuard.status, 0, shellGuard.stderr);
  assert.equal(existsSync(started), true, 'not answered by the shell fast path');
  assert.deepEqual(JSON.parse(item.invoke('boundary-turn', [cli], '{"sessionId":"native","prompt":"hello"}').stdout), {});
  assert.deepEqual(readdirSync(boundaries), [], 'a working runtime cleared the marker');
});

test('with no SFlow turn recorded, PowerShell guard, after-tool and end hooks answer without starting Node', {
  skip: !powershell && 'PowerShell host unavailable'
}, async t => {
  const item = await fixture(t);
  const bin = path.join(item.directory, 'host-bin');
  await mkdir(bin);
  const started = path.join(item.directory, 'node-started');
  // A stand-in node that only records each start; no installed runtime is ever loaded.
  const standIn = process.platform === 'win32'
    ? [path.join(bin, 'node.cmd'), `@echo started>>"${started}"\r\n@echo {}\r\n`]
    : [path.join(bin, 'node'), `#!/bin/sh\necho started >> '${started}'\necho '{}'\n`];
  await writeFile(standIn[0], standIn[1], { mode: 0o755 });
  const launch = (action, input = '{"sessionId":"native"}') => spawnSync(powershell,
    [...powershellArgs, `& '${path.join(pluginRoot, 'hook-launcher.ps1')}' ${action}`], {
      cwd: item.cwd, env: { ...item.env, PATH: `${bin}${path.delimiter}${item.env.PATH}` }, input, encoding: 'utf8', timeout: childTimeout(30_000)
    });
  const nodeStarts = () => (existsSync(started) ? readFileSync(started, 'utf8').split(/\r?\n/u).filter(Boolean).length : 0);
  for (const action of ['boundary-guard', 'boundary-after', 'boundary-end']) {
    const result = launch(action);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {}, action);
  }
  const large = JSON.stringify({ sessionId: 'native', toolArgs: { content: 'x'.repeat(256 * 1024) } });
  assert.deepEqual(JSON.parse(launch('boundary-guard', large).stdout), {}, 'a large payload is read and answered');
  assert.equal(nodeStarts(), 0, 'no hook started Node');
  // Any boundary entry (a recorded turn, or the marker of a runtime that could not load) goes to Node.
  await mkdir(path.join(item.directory, 'copilot-boundaries'));
  await writeFile(path.join(item.directory, 'copilot-boundaries', RUNTIME_UNAVAILABLE_MARKER), '');
  launch('boundary-guard');
  assert.equal(nodeStarts(), 1, 'the marker sends the guard to the runtime');
});

/**
 * Off PATH (VS Code started from the Dock with launchd's PATH; on Windows started before npm's global
 * bin joined PATH), Copilot's shell cannot run `singularity-flow` although every hook still runs. The
 * turn of an SFlow prompt names the launcher's verified Node and entry; the guard runs exactly that.
 */
const offPathLine = (node, entry, platform = process.platform) => `If \`singularity-flow\` is not found, run each \`singularity-flow …\` command as \`${renderPlatformCommand([node, entry], platform)} …\`.`;
const turnPayload = (item, prompt, sessionId = 'off-path') => JSON.stringify({ sessionId, cwd: item.cwd, prompt });

test('the off-PATH line quotes the exact Node and CLI entry for each shell, never a .cmd shim', t => {
  t.after(() => setHookCli(null));
  const node = path.resolve('/opt/Node runtime/bin/node');
  const entry = path.resolve("/Users/Dev O'Neil/npm/node_modules/singularity-flow/bin/singularity-flow.mjs");
  setHookCli({ node, cli: entry, onPath: false });
  assert.equal(hookCliLine('darwin'), `If \`singularity-flow\` is not found, run each \`singularity-flow …\` command as \`'${node}' '${entry.replace("'", `'"'"'`)}' …\`.`);
  assert.equal(hookCliLine('win32'), `If \`singularity-flow\` is not found, run each \`singularity-flow …\` command as \`& '${node}' '${entry.replace("'", "''")}' …\`.`);
  assert.equal(hookCliLine('linux'), offPathLine(node, entry, 'linux'), 'the same quoting as every rendered SFlow command');
  assert.doesNotMatch(hookCliLine('win32'), /\.cmd/u);
  setHookCli({ node, cli: entry, onPath: true });
  assert.equal(hookCliLine(), null, 'on PATH the turn says nothing');
  for (const value of [{ node: 'node', cli: entry }, { node, cli: path.resolve('/opt/singularity-flow.cmd') }, { node, cli: `${entry}\n` }, null]) {
    setHookCli({ onPath: false, ...value });
    assert.equal(hookCliLine(), null, JSON.stringify(value));
  }
});

test('an SFlow prompt\'s turn names the verified Node and entry only while the launcher found no CLI on PATH', async t => {
  const item = await fixture(t);
  const line = offPathLine(process.execPath, realpathSync(cli));
  const turn = (candidates, prompt) => JSON.parse(item.invoke('boundary-turn', candidates, turnPayload(item, prompt)).stdout);
  assert.deepEqual(turn(['--cli-off-path', cli], '/sf-session'), { additionalContext: line });
  assert.deepEqual(turn([cli], '/sf-session'), {}, 'on PATH: unchanged');
  assert.deepEqual(turn(['--cli-off-path', cli], 'What does this file do?'), {}, 'native chat: unchanged');
  // Paused, the skill's first command (it checks pause) still has to run.
  await writeFile(item.env.SINGULARITY_FLOW_COPILOT_MODE_FILE, JSON.stringify({ schemaVersion: 1, paused: true }));
  assert.deepEqual(turn(['--cli-off-path', cli], '/sf-pause off'), { additionalContext: line });
  // The marker is never a candidate: alone it resolves no runtime.
  assert.match(JSON.parse(item.invoke('boundary-guard', ['--cli-off-path']).stdout).permissionDecisionReason, /SFLOW_HOOK_RUNTIME_UNAVAILABLE/u);
});

/** A managed engine whose one release is this package, run by this Node (names as the launchers require). */
async function managedEngine(item, runtime) {
  const engine = path.join(item.directory, 'managed engine');
  const release = 'a'.repeat(64);
  const windowsLayout = runtime.includes('-win32-');
  const node = path.join(engine, 'runtimes', runtime, ...(windowsLayout ? ['node.exe'] : ['bin', 'node']));
  await mkdir(path.dirname(node), { recursive: true });
  if (process.platform === 'win32') await link(process.execPath, node); else await symlink(process.execPath, node);
  await mkdir(path.join(engine, 'releases', release, 'node_modules'), { recursive: true });
  await symlink(packageRoot, path.join(engine, 'releases', release, 'node_modules', 'singularity-flow'), 'junction');
  await writeFile(path.join(engine, 'active'), `1|${runtime}|${release}\n`);
  return engine;
}

test('the bash launcher, managed engine or not, marks an off-PATH CLI, and the guard runs exactly the named invocation', {
  skip: process.platform === 'win32'
}, async t => {
  const item = await fixture(t);
  const entry = realpathSync(cli);
  const bin = path.join(item.directory, 'host-bin');
  await mkdir(bin);
  await symlink(process.execPath, path.join(bin, 'node'));
  const shim = path.join(item.directory, 'npm-bin');
  await mkdir(shim);
  await symlink(cli, path.join(shim, 'singularity-flow'));
  const engine = await managedEngine(item, 'node-v26.0.0-test');
  const launch = (action, payload, { onPath = false, managed = true } = {}) => {
    const env = { ...item.env, PATH: [...(onPath ? [shim] : []), ...(managed ? [] : [bin]), '/usr/bin', '/bin'].join(':') };
    if (managed) env.SINGULARITY_FLOW_ENGINE_HOME = engine; else env.SINGULARITY_FLOW_ENGINE_HOME = path.join(item.directory, 'no engine');
    const result = spawnSync('/bin/bash', [path.join(pluginRoot, 'hook-launcher.sh'), action], {
      cwd: item.cwd, env, input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: childTimeout(30_000) });
    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const line = offPathLine(process.execPath, entry);
  assert.deepEqual(launch('boundary-turn', turnPayload(item, '/sf-session'), { onPath: true }), {});
  assert.deepEqual(launch('boundary-turn', turnPayload(item, '/sf-session'), { onPath: true, managed: false }), {});
  // The managed engine's own runtime and release, through its node and package link: the verified real paths.
  assert.deepEqual(launch('boundary-turn', turnPayload(item, '/sf-session')), { additionalContext: line });
  const binding = { sessionId: 'off-path', cwd: item.cwd };
  const guard = (command, options) => launch('boundary-guard', { ...binding, toolName: 'bash', toolArgs: { command } }, options);
  const verified = renderPlatformCommand([process.execPath, entry], 'linux');
  assert.deepEqual(guard(`${verified} session open --for-agent --json`), {});
  assert.deepEqual(guard('singularity-flow session open --for-agent --json'), {}, 'the same answer as the bare CLI');
  assert.deepEqual(launch('boundary-after', { ...binding, toolName: 'bash', toolArgs: { command: `${verified} session open --for-agent --json` } }), {});
  for (const command of [
    `'${path.join(engine, 'runtimes', 'node-v26.0.0-test', 'bin', 'node')}' '${entry}' session open --for-agent --json`,
    `'${process.execPath}' '${path.join(engine, 'releases', 'a'.repeat(64), 'node_modules', 'singularity-flow', 'bin', 'singularity-flow.mjs')}' session open --for-agent --json`,
    `node '${entry}' session open --for-agent --json`, `bash -c "${verified} session open --for-agent --json"`]) {
    assert.equal(guard(command).permissionDecision, 'deny', command);
  }
  // Without the managed engine, the same marker; its fixed install prefixes would run an installed CLI, never this one.
  const fixed = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'].map(directory => path.join(directory, 'singularity-flow'));
  if (!fixed.some(file => existsSync(file))) {
    assert.deepEqual(launch('boundary-turn', turnPayload(item, '/sf-session'), { managed: false }), {},
      'off PATH with no installed CLI the runtime is unavailable, as before');
  }
});

test('the PowerShell launcher, managed engine or not, marks an off-PATH CLI and names node.exe with the entry', {
  skip: !powershell && 'PowerShell host unavailable'
}, async t => {
  const item = await fixture(t);
  const entry = realpathSync(cli);
  const nodeDirectory = path.dirname(process.execPath);
  if (['singularity-flow', 'singularity-flow.cmd', 'singularity-flow.ps1'].some(name => existsSync(path.join(nodeDirectory, name)))) {
    return t.skip('an installed CLI sits beside this Node');
  }
  // The host by its own path: the restricted PATH below cannot find it (Homebrew's is a wrapper script).
  const host = (process.env.PATH ?? '').split(path.delimiter).flatMap(directory => [powershell, `${powershell}.exe`]
    .map(name => path.join(directory, name))).find(file => existsSync(file));
  const system = process.platform === 'win32' ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
  const shim = path.join(item.directory, 'npm-bin');
  await mkdir(shim);
  await writeFile(path.join(shim, process.platform === 'win32' ? 'singularity-flow.cmd' : 'singularity-flow'),
    process.platform === 'win32' ? '@exit /b 99\r\n' : '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const appData = path.join(item.directory, 'Windows app data');
  await mkdir(path.join(appData, 'npm', 'node_modules'), { recursive: true });
  await symlink(packageRoot, path.join(appData, 'npm', 'node_modules', 'singularity-flow'), 'junction');
  const engine = await managedEngine(item, `node-v26.0.0-win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
  const turn = ({ onPath = false, managed = false } = {}) => {
    const result = spawnSync(host, [...powershellArgs, `& '${path.join(pluginRoot, 'hook-launcher.ps1')}' boundary-turn`], {
      cwd: item.cwd, input: turnPayload(item, '/sf-session'), encoding: 'utf8', timeout: childTimeout(30_000),
      env: { ...item.env, APPDATA: appData, SINGULARITY_FLOW_ENGINE_HOME: managed ? engine : path.join(item.directory, 'no engine'),
        PATH: [...(onPath ? [shim] : []), nodeDirectory, ...system].join(path.delimiter) } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  };
  const line = offPathLine(process.execPath, entry);
  assert.deepEqual(turn(), { additionalContext: line }, 'Node on PATH, the CLI under APPDATA\\npm');
  assert.deepEqual(turn({ onPath: true }), {});
  assert.deepEqual(turn({ managed: true }), { additionalContext: line });
  assert.deepEqual(turn({ managed: true, onPath: true }), {});
});
