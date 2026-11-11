/**
 * The repository carries the guard (docs/SPEC-PCR-PLAIN-CHAT-ROUTING-v1.md, P3): `.github/hooks/sflow.json` and its two
 * launchers, which step aside for SFlow's plugin, hand an event to SFlow where it is installed, and on a machine without
 * SFlow refuse a change with the line to install it; and the checks that say when the hooks would not run.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { REPOSITORY_HOOK_EVENTS, REPOSITORY_HOOK_FILE, repositoryHookFiles, repositoryHookJson, repositoryHookProblems, repositoryHookSetting,
  repositoryHookStatus, setRepositoryHookSetting, writeRepositoryHooks } from '../src/repository-hooks.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { repository as envRepository } from './helpers/environment-files-fixture.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const pwsh = (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, 'pwsh')).find((file) => existsSync(file));
const pwshSkip = (process.platform === 'win32' || !pwsh) && 'PowerShell host unavailable';

async function temporary(t, name) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `sflow-${name}-`)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// ---------------------------------------------------------------------------------------------------
// [PCR:REQ-030, REQ-033] The hook file and its setting.

test('PCR REQ-030, REQ-033: the hook file names the plugin\'s seven events, each running the launcher with the repository\'s setting', async () => {
  const plugin = JSON.parse(readFileSync(path.join(packageRoot, 'plugin/hooks.json'), 'utf8'));
  for (const setting of ['refuse', 'record', 'allow']) {
    const file = JSON.parse(await repositoryHookJson(setting));
    assert.equal(file.version, 1);
    assert.deepEqual(Object.keys(file.hooks).sort(), Object.keys(plugin.hooks).sort());
    assert.equal(file.hooks.sessionStart, undefined);
    for (const [event, action] of Object.entries(REPOSITORY_HOOK_EVENTS)) {
      const [entry] = file.hooks[event];
      assert.equal(entry.bash, `/bin/bash ./.github/hooks/sflow-hook.sh ${action} ${setting}`);
      assert.match(entry.powershell, new RegExp(`& \\$sflowHook ${action} ${setting} \\}`, 'u'));
      assert.equal(entry.matcher, plugin.hooks[event][0].matcher);
      // The launchers it names live in the project root, where every host starts a hook whose folder is "." (N6).
      assert.equal(entry.cwd, '.');
    }
    assert.equal(repositoryHookSetting(JSON.stringify(file)), setting);
  }
  assert.equal(repositoryHookSetting('{"hooks":{}}'), null, 'a file that is not SFlow\'s carries no setting');
});

test('PCR REQ-030: init writes the hook files into an application checkout, the shell launcher runnable, and keeps a person\'s own edits', async (t) => {
  const root = await temporary(t, 'pcr-init');
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  const wrote = await initializeDefinition(root, { repositoryHooks: true });
  for (const file of Object.keys(await repositoryHookFiles('record'))) assert.ok(wrote.includes(file), file);
  assert.equal(repositoryHookSetting(await readFile(path.join(root, REPOSITORY_HOOK_FILE), 'utf8')), 'record');
  assert.ok(statSync(path.join(root, '.github/hooks/sflow-hook.sh')).mode & 0o100);
  assert.match(await readFile(path.join(root, '.github/hooks/README.md'), 'utf8'), /Your prompts are kept/u);
  await writeFile(path.join(root, '.github/hooks/README.md'), 'Our own words.\n');
  assert.deepEqual((await initializeDefinition(root, { repositoryHooks: true })).filter((file) => file.startsWith('.github/hooks/')), []);
  // A configuration branch's tree is no application checkout: it never gets them.
  const authority = await temporary(t, 'pcr-authority');
  assert.equal((await initializeDefinition(authority)).some((file) => file.startsWith('.github/hooks/')), false);
  assert.equal(await readFile(path.join(root, '.github/hooks/README.md'), 'utf8'), 'Our own words.\n');
  // The setting changed: the file and its README take it, and nothing else.
  assert.deepEqual(await setRepositoryHookSetting(root, 'refuse'), [REPOSITORY_HOOK_FILE, '.github/hooks/README.md']);
  assert.equal(repositoryHookSetting(await readFile(path.join(root, REPOSITORY_HOOK_FILE), 'utf8')), 'refuse');
  assert.deepEqual(await setRepositoryHookSetting(root, 'refuse'), []);
  const bare = await temporary(t, 'pcr-bare');
  assert.deepEqual(await setRepositoryHookSetting(bare, 'refuse'), [], 'a repository without SFlow\'s hook file is left as it is');
});

// ---------------------------------------------------------------------------------------------------
// [PCR:REQ-031, REQ-032] The launchers, on bash and pwsh.

async function launcherHost(t) {
  const directory = await temporary(t, 'pcr-repo-hook');
  const repo = path.join(directory, 'shop');
  await writeRepositoryHooks(repo, { setting: 'record' });
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  const started = path.join(directory, 'node-started');
  // A stand-in Node: it says it started and with what, and answers {}.
  await writeFile(path.join(bin, 'node'), `#!/bin/sh\necho "$*" >> '${started}'\ncat >/dev/null\necho '{}'\n`, { mode: 0o755 });
  const machine = path.join(directory, 'machine');
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: path.join(directory, 'home'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(machine, 'mode.json'),
    SINGULARITY_FLOW_ENGINE_HOME: path.join(directory, 'no-engine'), SINGULARITY_FLOW_INSTALL_PREFIXES: '', COPILOT_HOME: path.join(directory, 'copilot') };
  const starts = () => (existsSync(started) ? readFileSync(started, 'utf8').split('\n').filter(Boolean) : []);
  return { directory, repo, bin, machine, env, starts };
}

const guardCall = (cwd, toolName, toolArgs) => JSON.stringify({ sessionId: 's', timestamp: 1, cwd, toolName, toolArgs });
const reason = (output) => { try { return JSON.parse(output).permissionDecisionReason ?? null; } catch { return `unreadable: ${output}`; } };

async function assertRepositoryLauncher(host, launch) {
  const guard = (setting, payload) => launch('boundary-guard', setting, payload);
  // Without SFlow on the machine [PCR:REQ-032].
  const edit = guardCall(host.repo, 'apply_patch', '*** Begin Patch\n*** Update File: src/retry.js\n@@\n-5\n+10\n*** End Patch\n');
  assert.match(reason(guard('refuse', edit)), /^SFLOW_NOT_INSTALLED: .*\(policy\.plainChatEdits: refuse\).*so this edit did not run\..*singularity-flow plugin install\. Do not retry it$/u);
  assert.match(reason(guard('record', edit)), /policy\.plainChatEdits: record/u, 'record refuses too: without SFlow nothing can be recorded');
  assert.equal(reason(guard('allow', edit)), null, 'allow lets it through');
  const vsCodeWrite = JSON.stringify({ session_id: 's', cwd: host.repo, tool_name: 'Write', tool_input: { file_path: 'src/retry.js' } });
  const answer = JSON.parse(guard('refuse', vsCodeWrite));
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny', 'VS Code reads the refusal under hookSpecificOutput');
  assert.match(reason(guard('refuse', guardCall(host.repo, 'bash', { command: 'npm test' }))), /so this command did not run/u);
  assert.match(reason(guard('refuse', guardCall(host.repo, 'bash', { command: 'git diff > patch.txt' }))), /^SFLOW_NOT_INSTALLED/u);
  for (const [toolName, toolArgs] of [['view', { path: 'src/retry.js' }], ['grep', { pattern: 'timeout' }], ['bash', { command: 'git diff --stat && git status --short' }],
    ['bash', { command: 'git log --oneline -5' }], ['bash', { command: 'ls -la src' }], ['write_stdin', { chars: '\u0003' }], ['view', { path: '.env.example' }]]) {
    assert.equal(reason(guard('refuse', guardCall(host.repo, toolName, toolArgs))), null, `${toolName} ${JSON.stringify(toolArgs)}`);
  }
  for (const setting of ['refuse', 'allow']) {
    assert.match(reason(guard(setting, guardCall(host.repo, 'view', { path: 'apps/web/.env' }))), /^ENVIRONMENT_FILE_PRIVATE: \.env is named to stay on a laptop/u, setting);
    assert.match(reason(guard(setting, guardCall(host.repo, 'view', { path: 'certs/server.pem' }))), /^ENVIRONMENT_FILE_PRIVATE: server\.pem/u);
  }
  // Never a crash: anything unexpected answers {}.
  for (const payload of ['not json {{{', '', '{"toolName":', JSON.stringify({ sessionId: 's', cwd: '/nowhere', toolName: 'view' })]) {
    assert.equal(reason(guard('refuse', payload)), null, payload);
  }
  assert.equal(launch('boundary-turn', 'refuse', JSON.stringify({ sessionId: 's', cwd: host.repo, prompt: 'make it 10s' })), '{}');
  assert.equal(launch('anything-else', 'refuse', edit), '{}');
  assert.match(reason(launch('boundary-guard', 'nonsense', edit)), /policy\.plainChatEdits: record/u, 'an unknown setting reads as the default');
  assert.deepEqual(host.starts(), [], 'no Node: SFlow is not on this machine');
  // SFlow's plugin is installed: it guards, so the repository's launcher steps aside [PCR:REQ-031].
  const plugin = path.join(host.directory, 'plugin-copy');
  await mkdir(plugin);
  await writeFile(path.join(plugin, 'hook-launcher.sh'), '');
  await writeFile(path.join(plugin, 'hook-launcher.ps1'), '');
  await mkdir(host.machine, { recursive: true });
  await writeFile(path.join(host.machine, 'copilot-plugin'), `${plugin}\n`);
  assert.equal(guard('refuse', edit), '{}');
  await rm(plugin, { recursive: true });
  assert.match(reason(guard('refuse', edit)), /^SFLOW_NOT_INSTALLED/u, 'a marker whose plugin is gone is no plugin');
  const installed = path.join(host.env.COPILOT_HOME, 'installed-plugins', '_direct', 'plugin-1');
  await mkdir(installed, { recursive: true });
  await writeFile(path.join(installed, 'plugin.json'), JSON.stringify({ name: 'singularity-flow' }, null, 2));
  await writeFile(path.join(installed, 'hook-launcher.sh'), '');
  await writeFile(path.join(installed, 'hook-launcher.ps1'), '');
  assert.equal(guard('refuse', edit), '{}', 'a Copilot CLI install of the plugin, found by its files');
  await rm(host.env.COPILOT_HOME, { recursive: true });
  // SFlow is installed without its plugin: each event goes to SFlow's own launcher, which starts Node.
  await symlink(path.join(packageRoot, 'bin/singularity-flow.mjs'), path.join(host.bin, 'singularity-flow'));
  assert.equal(launch('boundary-turn', 'refuse', JSON.stringify({ sessionId: 's', cwd: host.repo, prompt: 'make it 10s' })), '{}');
  assert.equal(host.starts().length, 1);
  assert.match(host.starts()[0], /hook-launcher\.mjs boundary-turn /u);
  await rm(path.join(host.bin, 'singularity-flow'));
}

test('PCR REQ-031, REQ-032: the bash repository launcher steps aside for the plugin, hands over to SFlow, and refuses without it', { skip: process.platform === 'win32' }, async (t) => {
  const host = await launcherHost(t);
  await assertRepositoryLauncher(host, (action, setting, input) => {
    const result = spawnSync('/bin/bash', [path.join(host.repo, '.github/hooks/sflow-hook.sh'), action, setting],
      { cwd: host.repo, env: host.env, input, encoding: 'utf8', timeout: childTimeout(30_000) });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').at(-1);
  });
});

test('PCR REQ-031, REQ-032: the PowerShell repository launcher agrees', { skip: pwshSkip }, async (t) => {
  const host = await launcherHost(t);
  await assertRepositoryLauncher(host, (action, setting, input) => {
    const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(host.repo, '.github/hooks/sflow-hook.ps1'), action, setting],
      { cwd: host.repo, env: host.env, input, encoding: 'utf8', timeout: childTimeout(60_000) });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split(/\r?\n/u).at(-1);
  });
});

test('PCR REQ-031: SFlow\'s plugin launcher leaves its marker only when Copilot runs it as the plugin', async (t) => {
  const directory = await temporary(t, 'pcr-plugin-marker');
  const machine = path.join(directory, 'machine');
  const marker = path.join(machine, 'copilot-plugin');
  const env = { PATH: '/usr/bin:/bin', HOME: directory, SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(machine, 'mode.json'), SINGULARITY_FLOW_ENGINE_HOME: path.join(directory, 'none') };
  const launchers = [['/bin/bash', [path.join(packageRoot, 'plugin/hook-launcher.sh'), 'boundary-guard']],
    ...(pwshSkip ? [] : [[pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(packageRoot, 'plugin/hook-launcher.ps1'), 'boundary-guard']]])];
  for (const [command, args] of launchers) {
    await rm(machine, { recursive: true, force: true });
    const input = guardCall(directory, 'view', { path: 'README.md' });
    spawnSync(command, args, { cwd: directory, env, input, encoding: 'utf8', timeout: childTimeout(60_000) });
    assert.equal(existsSync(marker), false, `${command}: a repository hook's hand-over names no plugin folder`);
    spawnSync(command, args, { cwd: directory, env: { ...env, PLUGIN_ROOT: path.join(packageRoot, 'plugin') }, input, encoding: 'utf8', timeout: childTimeout(60_000) });
    assert.equal(readFileSync(marker, 'utf8').trim(), await realpath(path.join(packageRoot, 'plugin')), command);
  }
});

// ---------------------------------------------------------------------------------------------------
// [PCR:REQ-034] Hooks turned off are visible.

test('PCR REQ-034: the status names a missing or changed hook file, disableAllHooks, an untrusted folder, and the plugin without the repository hook', async (t) => {
  const directory = await temporary(t, 'pcr-status');
  const root = path.join(directory, 'shop');
  await mkdir(root);
  const env = { HOME: directory, SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(directory, 'machine', 'mode.json'), COPILOT_HOME: path.join(directory, 'copilot') };
  let status = await repositoryHookStatus(root, { setting: 'refuse', env });
  assert.equal(status.files[REPOSITORY_HOOK_FILE], 'missing');
  assert.equal(status.trusted, null, 'Copilot CLI\'s own config cannot be read: unknown, never a guess');
  assert.match(repositoryHookProblems(status).join(' '), /carries no guard of its own/u);
  await writeRepositoryHooks(root, { setting: 'record' });
  status = await repositoryHookStatus(root, { setting: 'refuse', env });
  assert.equal(status.files[REPOSITORY_HOOK_FILE], 'changed', 'the file carries record while the map says refuse');
  assert.match(repositoryHookProblems(status).join(' '), /sflow\.json, \.github\/hooks\/README\.md differ from what SFlow writes for policy\.plainChatEdits: refuse/u);
  await writeRepositoryHooks(root, { setting: 'refuse' });
  assert.equal(repositoryHookProblems(await repositoryHookStatus(root, { setting: 'refuse', env })), null);
  // A file written before it named the project root as its hooks' folder runs the same way, so it is no problem to repair.
  const named = await readFile(path.join(root, REPOSITORY_HOOK_FILE), 'utf8');
  const earlier = await repositoryHookJson('refuse', { cwd: null });
  assert.doesNotMatch(earlier, /"cwd"/u);
  await writeFile(path.join(root, REPOSITORY_HOOK_FILE), earlier);
  assert.equal((await repositoryHookStatus(root, { setting: 'refuse', env })).files[REPOSITORY_HOOK_FILE], 'current');
  await writeFile(path.join(root, REPOSITORY_HOOK_FILE), named);
  await mkdir(path.join(root, '.github/copilot'), { recursive: true });
  await writeFile(path.join(root, '.github/copilot/settings.local.json'), '{ "disableAllHooks": true }\n');
  await mkdir(env.COPILOT_HOME, { recursive: true });
  await writeFile(path.join(env.COPILOT_HOME, 'config.json'), `// Managed by the host.\n${JSON.stringify({ trustedFolders: [path.join(directory, 'elsewhere')] })}\n`);
  status = await repositoryHookStatus(root, { setting: 'refuse', env });
  assert.deepEqual(status.disabled, ['.github/copilot/settings.local.json']);
  assert.equal(status.trusted, false);
  const problems = repositoryHookProblems(status).join(' ');
  assert.match(problems, /disableAllHooks in \.github\/copilot\/settings\.local\.json turns every hook off/u);
  assert.match(problems, /Copilot CLI does not trust this folder/u);
  await writeFile(path.join(env.COPILOT_HOME, 'config.json'), JSON.stringify({ trustedFolders: [directory] }));
  assert.equal((await repositoryHookStatus(root, { setting: 'refuse', env })).trusted, true, 'a trusted parent folder trusts the repository');
  // The plugin installed and no repository hook file.
  await rm(path.join(root, '.github'), { recursive: true });
  await mkdir(path.join(directory, 'machine'), { recursive: true });
  await mkdir(path.join(directory, 'plugin'));
  await writeFile(path.join(directory, 'plugin', 'hook-launcher.sh'), '');
  await writeFile(path.join(directory, 'machine', 'copilot-plugin'), `${path.join(directory, 'plugin')}\n`);
  status = await repositoryHookStatus(root, { setting: 'refuse', env });
  assert.equal(status.plugin, true);
  assert.match(repositoryHookProblems(status).join(' '), /SFlow's plugin guards chats on this machine, but nothing guards a chat on a machine without it/u);
});

test('PCR REQ-030, REQ-033, REQ-034: doctor --repair-hooks writes the files for the setting, and capability set rewrites the file with the map', async (t) => {
  const repo = await envRepository(t, { declaration: null, files: { 'singularity/workflow.yml': 'version: 2\n',
    'singularity/capabilities.yml': 'version: 1\ncapabilities:\n  shop: { kind: delivery, repository: shop, parent: null }\n' } });
  const environment = { ...repo.env, HOME: repo.base, SINGULARITY_FLOW_HOME: path.join(repo.base, 'home'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(repo.base, 'machine', 'mode.json'),
    COPILOT_HOME: path.join(repo.base, 'copilot') };
  const doctor = repo.json(['doctor'], { env: environment });
  const hooks = (doctor.value.checks ?? doctor.value.data?.checks ?? []).find((entry) => entry.id === 'repository-hooks');
  assert.equal(hooks?.status, 'warn', JSON.stringify(hooks));
  assert.match(hooks.fix, /singularity-flow doctor --repair-hooks/u);
  const repaired = repo.json(['doctor', '--repair-hooks'], { env: environment });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.deepEqual(repaired.value.wrote.sort(), Object.keys(await repositoryHookFiles('record')).sort());
  assert.equal(repositoryHookSetting(await readFile(path.join(repo.root, REPOSITORY_HOOK_FILE), 'utf8')), 'record');
  assert.equal(spawnSync('git', ['status', '--porcelain', '.github/hooks'], { cwd: repo.root, encoding: 'utf8' }).stdout.trim().split('\n').every((line) => line.startsWith('??')), true,
    'written into the working tree, never committed');
  const set = repo.json(['capability', 'set', 'shop', '--plain-chat-edits', 'refuse'], { env: environment });
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(set.value.hooksRewritten, [REPOSITORY_HOOK_FILE, '.github/hooks/README.md']);
  assert.equal(YAML.parse(await readFile(path.join(repo.root, 'singularity/capabilities.yml'), 'utf8')).capabilities.shop.policy.plainChatEdits, 'refuse');
  assert.equal(repositoryHookSetting(await readFile(path.join(repo.root, REPOSITORY_HOOK_FILE), 'utf8')), 'refuse');
  const after = (repo.json(['doctor'], { env: environment }).value.checks ?? []).find((entry) => entry.id === 'repository-hooks');
  assert.equal(after.status, 'pass', JSON.stringify(after));
});
