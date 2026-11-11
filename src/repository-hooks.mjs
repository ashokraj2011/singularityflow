/**
 * The repository carries the guard (docs/SPEC-PCR-PLAIN-CHAT-ROUTING-v1.md, P3): `.github/hooks/sflow.json` with the
 * seven events the plugin uses, and two launchers, `sflow-hook.sh` and `sflow-hook.ps1`, committed with the
 * repository, so the guard applies to anyone who opens it with Copilot [PCR:REQ-030].
 *
 *   repositoryHookFiles      what SFlow writes, for the repository's own policy.plainChatEdits [PCR:REQ-033]
 *   writeRepositoryHooks     onboarding writes them, and `doctor --repair-hooks` writes them again: into the
 *                            working tree, so they are reviewed and committed like any other change
 *   setRepositoryHookSetting the setting changed: the file's arguments change in the same change
 *   repositoryHookStatus     whether this repository's hooks would run [PCR:REQ-034]
 *
 * The launchers answer {} where SFlow's plugin is installed, so each event is handled once [PCR:REQ-031]; the
 * plugin's own launcher leaves the marker they read (`copilot-plugin` beside the Copilot mode file).
 */
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copilotModeFile } from './copilot-mode.mjs';
// The package root through the host-safe boundary: the VS Code build has no import.meta.
import { PACKAGE_ROOT } from './package-root.mjs';

export const REPOSITORY_HOOK_DIRECTORY = '.github/hooks';
export const REPOSITORY_HOOK_FILE = '.github/hooks/sflow.json';
export const REPOSITORY_HOOK_LAUNCHERS = Object.freeze(['.github/hooks/sflow-hook.sh', '.github/hooks/sflow-hook.ps1']);
export const REPOSITORY_HOOK_README = '.github/hooks/README.md';
export const REPOSITORY_HOOK_SETTINGS = Object.freeze(['refuse', 'record', 'allow']);
// The plugin's seven events and the action each runs (plugin/hooks.json); scripts/check.mjs keeps both maps closed.
export const REPOSITORY_HOOK_EVENTS = Object.freeze({ userPromptSubmitted: 'boundary-turn', preToolUse: 'boundary-guard',
  postToolUse: 'boundary-after', sessionEnd: 'boundary-end', subagentStart: 'agent-start', agentStop: 'boundary-stop',
  postToolUseFailure: 'boundary-failure' });
const DEFAULT_SETTING = 'record';

/**
 * The folder every SFlow hook starts in (`cwd` in plugin/hooks.json and the repository's .github/hooks/sflow.json):
 * the chat's project root. Without it Copilot CLI starts a plugin's hooks in the plugin's own folder, so a plugin
 * copy removed under a running chat (a reinstall, an uninstall, a retired copy cleaned up) made the host fail every
 * later hook with "spawn /bin/bash ENOENT" and deny every tool "(hook errored)" before any SFlow code ran (session
 * mining N6). Live probes, Copilot CLI 1.0.107 to 1.0.109 (2026-11-12): a relative `cwd` resolves against the
 * project root, also from a subfolder; `~`, `${HOME}` and `${COPILOT_PROJECT_DIR}` are not expanded; an absolute
 * folder is used as it is, and a missing one fails the hook the same way; with the project root itself removed
 * the host runs no hook at all. VS Code's own chat (1.146) joins a relative `cwd` to the workspace folder it uses
 * anyway and hands the hook's folder on as the payload's `cwd`, which SFlow reads as the chat's folder: so the
 * folder must stay the project root, never an absolute one such as the home folder.
 */
export const COPILOT_HOOK_CWD = '.';

/** The marker SFlow's plugin leaves when its launcher runs, beside the Copilot mode file. */
export const pluginMarkerFile = (env = process.env) => path.join(path.dirname(copilotModeFile(env)), 'copilot-plugin');

const setting = (value) => (REPOSITORY_HOOK_SETTINGS.includes(value) ? value : DEFAULT_SETTING);

/** The command a host runs for one event, in each shell, with the repository's own setting as an argument. */
export function repositoryHookCommand(action, value, shell) {
  const chosen = setting(value);
  if (shell === 'bash') return `/bin/bash ./.github/hooks/sflow-hook.sh ${action} ${chosen}`;
  // A host's execution policy can refuse a script: run it again with this process's own PowerShell, as plugin/hooks.json does.
  return `$sflowHook = './.github/hooks/sflow-hook.ps1'; try { & $sflowHook ${action} ${chosen} } catch [System.Management.Automation.PSSecurityException] { & (Get-Process -Id $PID).Path -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $sflowHook ${action} ${chosen} }`;
}

/**
 * sflow.json for a setting: each event's matcher and timeout as the plugin's own hooks.json has them, started in the
 * project root (COPILOT_HOOK_CWD), where the launchers it names live. `cwd: null` gives the file as SFlow wrote it
 * before it named that folder.
 */
export async function repositoryHookJson(value, { cwd = COPILOT_HOOK_CWD } = {}) {
  const plugin = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'plugin', 'hooks.json'), 'utf8'));
  const hooks = {};
  for (const [event, action] of Object.entries(REPOSITORY_HOOK_EVENTS)) {
    const own = plugin.hooks?.[event]?.[0] ?? {};
    hooks[event] = [{ type: 'command', ...(own.matcher ? { matcher: own.matcher } : {}), ...(cwd ? { cwd } : {}),
      bash: repositoryHookCommand(action, value, 'bash'), powershell: repositoryHookCommand(action, value, 'powershell'), timeoutSec: own.timeoutSec ?? 10 }];
  }
  return `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
}

/**
 * What the hook folder's README says to anyone who opens the repository [PCR:REQ-004]: prompts are kept, what a plain
 * chat's change does, and what happens on a machine without SFlow.
 */
export function repositoryHookReadme(value) {
  const chosen = setting(value);
  const changes = { refuse: 'is refused, with the `/sf-` line to type instead', record: 'goes ahead and is recorded; a code step\'s approval waits until it is accounted for',
    allow: 'goes ahead' }[chosen];
  return [
    '# Singularity Flow hooks',
    '',
    'This repository uses Singularity Flow. Copilot (Copilot CLI and VS Code) runs these hooks for every chat opened in it.',
    '',
    '- **Your prompts are kept.** Each prompt, with `/sf-` or without, is kept with secrets taken out: in the Story\'s',
    '  "Asked for" while a Story is checked out (shared when the Story is pushed), otherwise in this clone\'s own log,',
    '  which never leaves it (`singularity-flow prompts`).',
    '- **A secret in a prompt is refused.** Copilot CLI never sends it; in VS Code nothing in that turn runs.',
    `- **A change in a chat with no \`/sf-\` command** (\`policy.plainChatEdits: ${chosen}\`) ${changes}. Reading,`,
    '  searching and questions stay free.',
    '- **Without Singularity Flow on your machine** these hooks refuse an edit or a writing command, with the line to',
    `  install it${chosen === 'allow' ? ' (not under `allow`, which lets them through)' : ''}, and a file named to stay on a laptop such as \`.env\`.`,
    '- **`/sf-pause`** turns all of this off on your own machine.',
    '',
    'A chat opened outside this repository is not guarded when it changes files here: Copilot loads these hooks only from',
    'the folder a chat was opened in. Copilot CLI skips them in a folder it does not trust, and `disableAllHooks` in',
    '`.github/copilot/settings.json` or `settings.local.json` turns them off; `singularity-flow doctor` says when.',
    '',
    'These files are written by `singularity-flow init` and again by `singularity-flow doctor --repair-hooks`. Changing the',
    'setting with `singularity-flow capability set <ID> --plain-chat-edits ...` rewrites `sflow.json` in the same change;',
    'after a reviewed `capability plain-chat` proposal, `doctor --repair-hooks` does. Review and commit them like any other change.',
    ''
  ].join('\n');
}

/** Every file of the repository's hooks, as SFlow writes them for a setting. */
export async function repositoryHookFiles(value) {
  const template = (name) => readFile(path.join(PACKAGE_ROOT, 'templates', 'github-hooks', name), 'utf8');
  return { [REPOSITORY_HOOK_FILE]: await repositoryHookJson(value), [REPOSITORY_HOOK_LAUNCHERS[0]]: await template('sflow-hook.sh'),
    [REPOSITORY_HOOK_LAUNCHERS[1]]: await template('sflow-hook.ps1'), [REPOSITORY_HOOK_README]: repositoryHookReadme(value) };
}

/** The setting a hook file carries, or null when it is not SFlow's. */
export function repositoryHookSetting(text) {
  try {
    const command = JSON.parse(text)?.hooks?.preToolUse?.[0]?.bash;
    return typeof command === 'string' ? command.match(/sflow-hook\.sh boundary-guard (refuse|record|allow)$/u)?.[1] ?? null : null;
  } catch { return null; }
}

/**
 * Writes the repository's hook files into its working tree, never committing: they are reviewed like any other change.
 * `onlyMissing` leaves every file that exists as it is. Returns the paths it wrote.
 */
export async function writeRepositoryHooks(root, { setting: value = DEFAULT_SETTING, onlyMissing = false } = {}) {
  const wrote = [];
  for (const [relative, content] of Object.entries(await repositoryHookFiles(value))) {
    const file = path.join(root, ...relative.split('/'));
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current === content || (onlyMissing && current !== null)) continue;
    await mkdir(path.dirname(file), { recursive: true });
    if ((await lstat(path.dirname(file))).isSymbolicLink()) throw new Error(`${REPOSITORY_HOOK_DIRECTORY} is a link; its hooks were not written.`);
    await writeFile(file, content);
    if (relative.endsWith('.sh')) await chmod(file, 0o755);
    wrote.push(relative);
  }
  return wrote;
}

/**
 * The setting changed [PCR:REQ-033]: sflow.json and the README take it in the same working-tree change. A repository
 * without SFlow's hook file is left as it is. Returns the paths it rewrote.
 */
export async function setRepositoryHookSetting(root, value) {
  const file = path.join(root, ...REPOSITORY_HOOK_FILE.split('/'));
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current === null || repositoryHookSetting(current) === null) return [];
  const wrote = [];
  for (const [relative, content] of [[REPOSITORY_HOOK_FILE, await repositoryHookJson(value)], [REPOSITORY_HOOK_README, repositoryHookReadme(value)]]) {
    const target = path.join(root, ...relative.split('/'));
    if (await readFile(target, 'utf8').catch(() => null) === content) continue;
    await writeFile(target, content);
    wrote.push(relative);
  }
  return wrote;
}

/** Whether SFlow's plugin is installed: the marker its launcher left, or a Copilot CLI install of it. */
export async function pluginInstalled(env = process.env) {
  const marker = await readFile(pluginMarkerFile(env), 'utf8').catch(() => null);
  const root = marker?.split('\n')[0]?.trim();
  if (root && path.isAbsolute(root) && existsSync(path.join(root, 'hook-launcher.sh'))) return true;
  const copilotHome = env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  for (const source of await readdir(path.join(copilotHome, 'installed-plugins')).catch(() => [])) {
    for (const plugin of await readdir(path.join(copilotHome, 'installed-plugins', source)).catch(() => [])) {
      const directory = path.join(copilotHome, 'installed-plugins', source, plugin);
      const manifest = await readFile(path.join(directory, 'plugin.json'), 'utf8').catch(() => '');
      if (manifest.includes('"name": "singularity-flow"') && existsSync(path.join(directory, 'hook-launcher.sh'))) return true;
    }
  }
  return false;
}

/** Removes the plugin's marker, as `plugin uninstall` does. */
export async function forgetPluginMarker(env = process.env) { await rm(pluginMarkerFile(env), { force: true }); }

async function jsonFile(file) {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  try { return JSON.parse(text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')); } catch { return null; }
}

const within = (folder, target) => {
  const relative = path.relative(path.resolve(folder), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Whether this repository's hooks would run [PCR:REQ-034], each reason a person can act on:
 *   files      each hook file: current, missing, or changed from what SFlow writes for the repository's setting
 *   disabled   the Copilot settings files that say disableAllHooks
 *   trusted    whether Copilot CLI trusts this folder (its own config), null when that cannot be read
 *   plugin     whether SFlow's plugin is installed, which guards even where the repository's hooks do not run
 */
export async function repositoryHookStatus(root, { setting: value = DEFAULT_SETTING, env = process.env } = {}) {
  const expected = await repositoryHookFiles(value);
  // A hook file written before it named its folder runs the same way: every host starts a repository's hooks in its
  // project root unless told otherwise (COPILOT_HOOK_CWD). Only `doctor --repair-hooks` rewrites it.
  const earlier = { [REPOSITORY_HOOK_FILE]: await repositoryHookJson(value, { cwd: null }) };
  const files = {};
  for (const [relative, content] of Object.entries(expected)) {
    const current = await readFile(path.join(root, ...relative.split('/')), 'utf8').catch(() => null);
    files[relative] = current === null ? 'missing' : current === content || current === earlier[relative] ? 'current' : 'changed';
  }
  const disabled = [];
  for (const relative of ['.github/copilot/settings.json', '.github/copilot/settings.local.json']) {
    if ((await jsonFile(path.join(root, ...relative.split('/'))))?.disableAllHooks === true) disabled.push(relative);
  }
  const config = await jsonFile(path.join(env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'config.json'));
  const folders = Array.isArray(config?.trustedFolders) ? config.trustedFolders.filter((entry) => typeof entry === 'string') : null;
  const trusted = folders === null ? null : folders.some((folder) => within(folder, root));
  return { files, disabled, trusted, plugin: await pluginInstalled(env), setting: setting(value) };
}

/** The status in a person's words: null when the hooks run as they should. */
export function repositoryHookProblems(status) {
  const problems = [];
  const missing = Object.entries(status.files).filter(([, state]) => state === 'missing').map(([file]) => file);
  const changed = Object.entries(status.files).filter(([, state]) => state === 'changed').map(([file]) => file);
  if (missing.includes(REPOSITORY_HOOK_FILE)) {
    problems.push(status.plugin
      ? `${REPOSITORY_HOOK_FILE} is missing: SFlow's plugin guards chats on this machine, but nothing guards a chat on a machine without it.`
      : `${REPOSITORY_HOOK_FILE} is missing, so this repository carries no guard of its own.`);
  } else if (missing.length) problems.push(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`);
  if (changed.length) problems.push(`${changed.join(', ')} ${changed.length === 1 ? 'differs' : 'differ'} from what SFlow writes for policy.plainChatEdits: ${status.setting}.`);
  if (status.disabled.length) problems.push(`disableAllHooks in ${status.disabled.join(' and ')} turns every hook off for this repository, SFlow's plugin's too.`);
  if (status.trusted === false && !status.plugin) problems.push('Copilot CLI does not trust this folder, so it skips the repository\'s hooks here, and SFlow\'s plugin, which needs no trust, is not installed.');
  return problems.length ? problems : null;
}
