/**
 * A Copilot chat SFlow's hooks never saw says so, with the one fix (src/copilot-chat-hooks.mjs).
 *
 * VS Code's agent host runs no command hook in a folder it opened through a link (/tmp/x is /private/tmp/x on macOS), so
 * SFlow's guard was off without a word (2026-11-25). The hooks now leave a file per chat they see; a command a chat runs
 * (COPILOT_AGENT_SESSION_ID) in a chat with none says what is off and the command that fixes it, in the agent view, in
 * the first command of every skill, on stderr, in doctor, and in VS Code itself.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, utimesSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  copilotChatClient, copilotChatHookGap, hookGapAct, hookGapAgentInstruction, hookSessionsDirectory, linkedFolderNotice,
  linkedTerminalFolder, noteHookSession, shellPath, vscodeLinkedOpenings
} from '../src/copilot-chat-hooks.mjs';
import { setCopilotPaused } from '../src/copilot-mode.mjs';
import { runRepositoryBoundaryHook } from '../src/copilot-repository-boundary.mjs';
import { linkedFolderPrompt, linkedFolders, usesSflowFolder } from '../src/linked-folder-notice.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const DAY = 24 * 60 * 60 * 1000;
/** The shell's own folder variable, as a terminal sets it. */
const shellIn = (folder) => Object.fromEntries([['PWD', folder]]);

/**
 * A machine of its own: SFlow's state, Copilot's session records and VS Code's storage under one folder, a repository
 * that carries SFlow's hooks, and a link to it as VS Code would have opened it.
 */
async function machine(t, { client = 'vscode-agent-host', openedThroughLink = true, repositoryHooks = true } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-chat-hooks-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = {
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'state', 'copilot-mode.json'),
    SINGULARITY_FLOW_COPILOT_SESSION_STATE: path.join(base, 'session-state'),
    SINGULARITY_FLOW_VSCODE_USER_DATA: path.join(base, 'vscode'),
    COPILOT_AGENT_SESSION_ID: 'chat-1'
  };
  const repository = path.join(base, 'repo');
  await mkdir(path.join(repository, '.github', 'hooks'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', repository]);
  if (repositoryHooks) await writeFile(path.join(repository, '.github', 'hooks', 'sflow.json'), '{"version":1,"hooks":{}}\n');
  await writeFile(path.join(repository, 'README.md'), 'fixture\n');
  spawnSync('git', ['-C', repository, 'add', '-A']);
  spawnSync('git', ['-C', repository, 'commit', '-q', '-m', 'fixture']);
  const link = path.join(base, 'link');
  await symlink(repository, link);
  if (openedThroughLink) {
    const storage = path.join(env.SINGULARITY_FLOW_VSCODE_USER_DATA, 'User', 'workspaceStorage', 'w1');
    await mkdir(storage, { recursive: true });
    await writeFile(path.join(storage, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(link).href }));
  }
  if (client) {
    await mkdir(path.join(env.SINGULARITY_FLOW_COPILOT_SESSION_STATE, 'chat-1'), { recursive: true });
    await writeFile(path.join(env.SINGULARITY_FLOW_COPILOT_SESSION_STATE, 'chat-1', 'workspace.yaml'), `id: chat-1\nclient_name: ${client}\n`);
  }
  return { base, env, repository, link };
}

test('a chat SFlow\'s hooks never saw, in a folder VS Code opened through a link, names the link and the command that fixes it', async (t) => {
  const { env, repository, link } = await machine(t);
  const gap = copilotChatHookGap({ env, cwd: repository });
  assert.equal(gap.code, 'SFLOW_HOOKS_OFF');
  assert.equal(gap.client, 'vscode-agent-host');
  assert.equal(gap.cause, 'linked-folder');
  assert.equal(gap.opened, link);
  assert.equal(gap.real, repository);
  assert.equal(gap.command, `code ${shellPath(repository)}`);
  assert.match(gap.message, /^SFlow's guard is off in this chat: Copilot ran none of SFlow's hooks here/u);
  assert.ok(gap.message.includes(`VS Code opened this folder as ${link}, a link to ${repository}`), gap.message);
  assert.ok(gap.fix.endsWith(gap.command), gap.fix);
  // A Story's worktree inside the linked folder is the same window's chat.
  const worktree = path.join(repository, '.singularity-flow', 'story-worktrees', '.w-1');
  await mkdir(worktree, { recursive: true });
  assert.equal(copilotChatHookGap({ env, cwd: worktree })?.cause, 'linked-folder');
  // The agent is told to say it and stop; every --for-agent result leads with that.
  assert.match(hookGapAgentInstruction(gap), /^SFLOW_HOOKS_OFF: .* Fix: Open the folder at its real path.*then stop: run no other SFlow command/u);
  assert.deepEqual(hookGapAct(gap), { state: 'end-turn', said: hookGapAgentInstruction(gap), do: null });
});

test('nothing is said outside a chat, once a hook saw it, while a hook just ran, while paused, or where no SFlow hook is meant to run', async (t) => {
  const { env, repository } = await machine(t);
  const now = Date.now();
  assert.equal(copilotChatHookGap({ env: { ...env, COPILOT_AGENT_SESSION_ID: undefined }, cwd: repository }), null, 'not a chat');
  assert.equal(copilotChatHookGap({ env: { ...env, SINGULARITY_FLOW_COPILOT_HOOK_CHECK: 'off' }, cwd: repository }), null, 'turned off');
  // A sub-agent's call can carry another id than its hooks name: any SFlow hook a moment ago is enough.
  assert.ok(noteHookSession('chat-other', { env, now }));
  assert.equal(copilotChatHookGap({ env, cwd: repository, now: now + 1_000 }), null, 'a hook ran just now');
  assert.ok(copilotChatHookGap({ env, cwd: repository, now: now + 60_000 }), 'a minute later the chat is reported again');
  assert.ok(noteHookSession('chat-1', { env, now }));
  assert.equal(copilotChatHookGap({ env, cwd: repository, now: now + DAY }), null, 'the hooks saw this chat');
  const paused = await machine(t);
  await setCopilotPaused(true, paused.env.SINGULARITY_FLOW_COPILOT_MODE_FILE);
  assert.equal(copilotChatHookGap({ env: paused.env, cwd: paused.repository }), null, 'paused: SFlow stands aside on purpose');
  const bare = await machine(t, { repositoryHooks: false });
  assert.equal(copilotChatHookGap({ env: bare.env, cwd: bare.repository }), null, 'no plugin and no repository hooks: none were meant to run');
  // The plugin's recorded launcher is enough on its own.
  const plugin = path.join(bare.base, 'plugin');
  await mkdir(plugin, { recursive: true });
  await writeFile(path.join(plugin, 'hook-launcher.sh'), '#!/bin/bash\n');
  await mkdir(path.dirname(bare.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), { recursive: true });
  await writeFile(path.join(path.dirname(bare.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-plugin'), `${plugin}\n`);
  assert.equal(copilotChatHookGap({ env: bare.env, cwd: bare.repository })?.cause, 'linked-folder');
});

test('another host, or a VS Code window not opened through a link, is told its hooks did not run and what to do', async (t) => {
  const cli = await machine(t, { client: 'copilot-cli' });
  const other = copilotChatHookGap({ env: cli.env, cwd: cli.repository });
  assert.equal(other.cause, 'hooks-not-run');
  assert.match(other.message, /This Copilot host \(copilot-cli\) did not run them\.$/u);
  assert.match(other.fix, /^Start a new chat; if it happens again, run singularity-flow doctor\.$/u);
  const plain = await machine(t, { openedThroughLink: false });
  const vscode = copilotChatHookGap({ env: plain.env, cwd: plain.repository });
  assert.equal(vscode.cause, 'hooks-not-run');
  assert.match(vscode.fix, /^Reload VS Code \(Developer: Reload Window\)/u);
  const unknown = await machine(t, { client: null });
  assert.equal(copilotChatClient('chat-1', unknown.env), null);
  assert.match(copilotChatHookGap({ env: unknown.env, cwd: unknown.repository }).message, /This Copilot host did not run them\.$/u);
  assert.equal(copilotChatClient('../chat-1', plain.env), null, 'a session id is never a path');
});

test('VS Code\'s linked openings: only folders reached through a link, the most recent first, and none older than asked', async (t) => {
  const { env, repository, link, base } = await machine(t);
  const storage = path.join(env.SINGULARITY_FLOW_VSCODE_USER_DATA, 'User', 'workspaceStorage');
  // The real folder opened as itself, a multi-root workspace and a broken entry are not links.
  for (const [name, body] of [['w2', JSON.stringify({ folder: pathToFileURL(repository).href })],
    ['w3', JSON.stringify({ workspace: pathToFileURL(path.join(base, 'x.code-workspace')).href })], ['w4', '{not json']]) {
    await mkdir(path.join(storage, name), { recursive: true });
    await writeFile(path.join(storage, name, 'workspace.json'), body);
  }
  const second = path.join(base, 'second-link');
  await symlink(repository, second);
  await mkdir(path.join(storage, 'w5'), { recursive: true });
  await writeFile(path.join(storage, 'w5', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(second).href }));
  const old = (Date.now() - 60 * DAY) / 1000;
  utimesSync(path.join(storage, 'w1'), old, old);
  const found = vscodeLinkedOpenings(repository, { env });
  assert.deepEqual(found.map((entry) => entry.opened), [second, link]);
  assert.ok(found.every((entry) => entry.real === repository));
  assert.deepEqual(vscodeLinkedOpenings(repository, { env, since: Date.now() - 30 * DAY }).map((entry) => entry.opened), [second]);
  assert.deepEqual(vscodeLinkedOpenings(path.join(base, 'missing'), { env }), []);
});

test('a terminal that reached its folder through a link is told so; one standing in it by its real path is not', async (t) => {
  const { repository, link } = await machine(t);
  assert.deepEqual(linkedTerminalFolder({ env: shellIn(link), cwd: repository }), { opened: link, real: repository });
  assert.equal(linkedTerminalFolder({ env: shellIn(repository), cwd: repository }), null);
  assert.equal(linkedTerminalFolder({ env: {}, cwd: repository }), null);
  const notice = linkedFolderNotice({ opened: '/tmp/my repo', real: '/private/tmp/my repo' }, 'darwin');
  assert.equal(notice.command, "code '/private/tmp/my repo'");
  assert.equal(linkedFolderNotice({ opened: 'C:\\l', real: 'D:\\my repo' }, 'win32').command, 'code "D:\\my repo"');
});

test('the hooks leave one file per chat they see, and old ones go once there are many', async (t) => {
  const { env } = await machine(t);
  const directory = hookSessionsDirectory(env);
  const now = Date.now();
  for (let index = 0; index < 260; index += 1) assert.ok(noteHookSession(`old-${index}`, { env, now: now - 30 * DAY }));
  assert.ok(noteHookSession('new-chat', { env, now }));
  const left = readdirSync(directory).filter((name) => name !== '.latest');
  assert.equal(left.length, 1, 'chats not seen for two weeks are tidied once a new one arrives');
  assert.equal(noteHookSession('', { env }), false);
  assert.equal(noteHookSession('bad\nid', { env }), false);
});

test('the prompt hook and the guard stamp the chat they run for', async (t) => {
  const { env, repository } = await machine(t);
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const hook = async (event, payload) => {
    const log = console.log;
    console.log = () => {};
    try { await runRepositoryBoundaryHook(event, Readable.from([Buffer.from(JSON.stringify(payload))])); } finally { console.log = log; }
  };
  assert.ok(copilotChatHookGap({ env, cwd: repository }), 'before any hook');
  await hook('boundary-guard', { sessionId: 'chat-1', cwd: repository, toolName: 'bash', toolArgs: { command: 'singularity-flow pause status --json' } });
  assert.equal(copilotChatHookGap({ env, cwd: repository, now: Date.now() + DAY }), null, 'the guard saw the chat');
  await hook('boundary-turn', { sessionId: 'chat-2', cwd: repository, prompt: 'hello' });
  assert.equal(copilotChatHookGap({ env: { ...env, COPILOT_AGENT_SESSION_ID: 'chat-2' }, cwd: repository, now: Date.now() + DAY }), null,
    'the prompt hook saw the chat');
});

/** The CLI as a chat's tool call runs it, from the repository's real folder. */
function sflow(env, cwd, args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: childTimeout(60_000) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('in such a chat a skill\'s first command, every --for-agent result and every command say it; a chat the hooks saw is unchanged', async (t) => {
  const { env, repository, link } = await machine(t);
  const pause = sflow(env, repository, ['pause', 'status', '--json']);
  assert.equal(pause.status, 0, pause.stderr);
  const data = JSON.parse(pause.stdout).data;
  assert.equal(data.paused, false);
  assert.equal(data.copilotHooks.ran, false);
  assert.equal(data.copilotHooks.cause, 'linked-folder');
  assert.match(data.agentInstruction, /^SFLOW_HOOKS_OFF: .*then stop/u);
  assert.ok(data.agentInstruction.includes(link));
  assert.equal(pause.stderr, '', 'the skill reads it from the result');
  const read = sflow(env, repository, ['nextsteps', '--for-agent', '--json']);
  assert.ok(read.stderr.startsWith('SFLOW_HOOKS_OFF: '), read.stderr);
  assert.ok(read.stderr.includes(`code ${shellPath(repository)}`), read.stderr);
  const view = JSON.parse(read.stdout);
  assert.equal(view.act.state, 'end-turn');
  assert.match(view.act.said, /^SFLOW_HOOKS_OFF: /u);
  const doctor = sflow(env, repository, ['doctor', '--json']);
  const check = JSON.parse(doctor.stdout).checks.find((entry) => entry.id === 'copilot-chat-hooks');
  assert.equal(check.status, 'fail');
  assert.ok(check.fix.endsWith(`code ${shellPath(repository)}`), check.fix);
  // The same chat once SFlow's hooks saw it.
  assert.ok(noteHookSession('chat-1', { env }));
  const later = { ...env };
  const fine = sflow(later, repository, ['pause', 'status', '--json']);
  assert.equal(JSON.parse(fine.stdout).data.copilotHooks, undefined);
  assert.doesNotMatch(sflow(later, repository, ['nextsteps', '--for-agent', '--json']).stderr, /SFLOW_HOOKS_OFF/u);
});

test('doctor in a VS Code terminal of a window opened through a link fails, and warns about such a window otherwise', async (t) => {
  const { env, repository, link } = await machine(t);
  const outside = { ...env, COPILOT_AGENT_SESSION_ID: '' };
  const terminal = sflow({ ...outside, TERM_PROGRAM: 'vscode', ...shellIn(link) }, repository, ['doctor', '--json']);
  const failed = JSON.parse(terminal.stdout).checks.find((entry) => entry.id === 'copilot-chat-hooks');
  assert.equal(failed.status, 'fail');
  assert.match(failed.message, /^SFlow's guard is off in Copilot chats in that window: VS Code opened this folder as /u);
  const elsewhere = sflow({ ...outside, TERM_PROGRAM: 'Apple_Terminal', ...shellIn(repository) }, repository, ['doctor', '--json']);
  assert.equal(JSON.parse(elsewhere.stdout).checks.find((entry) => entry.id === 'copilot-chat-hooks')?.status, 'warn');
  const clean = await machine(t, { openedThroughLink: false });
  const none = sflow({ ...clean.env, COPILOT_AGENT_SESSION_ID: '', ...shellIn(clean.repository) }, clean.repository, ['doctor', '--json']);
  assert.equal(JSON.parse(none.stdout).checks.find((entry) => entry.id === 'copilot-chat-hooks'), undefined);
});

test('VS Code warns in a window whose SFlow folder it opened through a link, with one button that reopens it at its real path', async (t) => {
  const { repository, link, base } = await machine(t);
  const resolve = (target) => realpath(target);
  assert.deepEqual(await linkedFolders([link, repository], resolve, false), [{ opened: link, real: repository }]);
  assert.deepEqual(await linkedFolders([path.join(base, 'missing')], resolve, false), []);
  // A difference of letter case alone is not a link where the file system ignores case.
  assert.deepEqual(await linkedFolders(['/Work/Repo'], async () => '/work/repo', true), []);
  assert.deepEqual(await linkedFolders(['/Work/Repo'], async () => '/work/repo', false), [{ opened: '/Work/Repo', real: '/work/repo' }]);
  const exists = async (target) => existsSync(target);
  assert.equal(await usesSflowFolder(repository, exists), true);
  assert.equal(await usesSflowFolder(base, exists), false);
  const one = linkedFolderPrompt({ opened: link, real: repository });
  assert.equal(one.action, 'Reopen at real path');
  assert.equal(one.newWindow, false);
  assert.equal(one.status, '$(warning) SFlow guard off');
  assert.ok(one.message.startsWith(`SFlow's guard is off in this window's Copilot chats: VS Code opened this folder as ${link}, a link to ${repository}`), one.message);
  assert.ok(one.tooltip.includes(`code ${shellPath(repository)}`), one.tooltip);
  const many = linkedFolderPrompt({ opened: link, real: repository }, { multiRoot: true });
  assert.equal(many.action, 'Open real folder');
  assert.equal(many.newWindow, true);
});
