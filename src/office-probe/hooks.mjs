/**
 * Probe C: do SFlow's Copilot hooks run here (Bet 1 guardrails)?
 *
 * - VS Code, at no cost: VS Code's own bundled Copilot runtime, started with its own SDK, runs one chat in a
 *   temporary repository with SFlow's installed plugin. The chat's model is a stand-in on 127.0.0.1 (fake-model.mjs),
 *   so nothing is sent and no premium request is used. SFlow's prompt hook leaves a stamp per chat
 *   (copilot-hook-sessions.mjs); a stamp in the run's own machine folder means the hooks ran. Where this VS Code has
 *   no bundled runtime, or it cannot start, the person may send one real chat message instead, after a Yes that says
 *   it uses one premium request; the probe then waits for SFlow's stamp on this machine.
 * - Copilot CLI, at no cost: the same stand-in through Copilot CLI's own bring-your-own-model variables.
 * - IntelliJ: guided only, after one Yes (two premium requests: Copilot agent and Local agent).
 * - Whether the folder SFlow was run from is reached through a link, the known cause of VS Code running no hooks.
 *
 * Every run uses its own home, Copilot home and SFlow machine folders under the probe's temporary folder, so the
 * person's Copilot settings, sessions and SFlow state are read (the plugin record) and never written.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ISOLATED_RUN_SWITCHES, MACHINE_STATE_LOCATIONS } from '../machine-state-locations.mjs';
import { HOOK_SESSIONS_DIRECTORY, hookSessionsDirectory } from '../copilot-hook-sessions.mjs';
import { parseJsonc, jetBrainsInstalls, vscodeInstalls } from './editors.mjs';
import { startFakeModel } from './fake-model.mjs';
import { check, PASS } from './report.mjs';

const PROMPT = 'SFlow office check';
// What the stand-in model is given as its access value: a plain word, not shaped like any credential.
const STAND_IN = 'probe-not-a-key';
export const GUIDED_MESSAGE = 'sflow office check';
const SIGN_IN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_TYPE', 'COPILOT_MODEL', 'COPILOT_AGENT_SESSION_ID'];

const list = (directory) => { try { return readdirSync(directory); } catch { return []; } };

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); })]);
  } finally { clearTimeout(timer); }
}

/** SFlow's plugin as Copilot recorded it on this machine: read only, never changed. */
export function copilotPluginRecord(ctx) {
  const copilotHome = ctx.env.COPILOT_HOME || path.join(ctx.home, '.copilot');
  let config = null;
  try { config = parseJsonc(readFileSync(path.join(copilotHome, 'config.json'), 'utf8')); } catch { /* not installed */ }
  const record = (Array.isArray(config?.installedPlugins) ? config.installedPlugins : [])
    .find((entry) => entry?.name === 'singularity-flow' && entry.enabled !== false);
  const root = record?.cache_path ?? record?.installed_source?.path ?? record?.source?.path ?? null;
  const hooks = root ? existsSync(path.join(root, 'hooks.json')) : false;
  return { record: record ?? null, root, hooks, version: typeof record?.version === 'string' ? record.version : null };
}

/** A home, Copilot home, SFlow machine folder and Git repository of the run's own. */
function isolatedMachine(ctx, label, plugin) {
  const base = path.join(ctx.tempReal, `hooks-${label}`);
  const machine = path.join(base, 'machine');
  const home = path.join(base, 'home');
  const copilotHome = path.join(base, 'copilot-home');
  const folder = path.join(base, 'repository');
  for (const directory of [machine, home, copilotHome, folder]) mkdirSync(directory, { recursive: true });
  ctx.run.gitIn(folder, ['init', '-q'], { env: ctx.env, timeoutMs: 20_000 });
  writeFileSync(path.join(copilotHome, 'config.json'), `${JSON.stringify({ trustedFolders: [base, folder], installedPlugins: [plugin.record] }, null, 2)}\n`);
  const env = { ...ctx.env };
  for (const name of SIGN_IN_VARIABLES) delete env[name];
  for (const [name, value] of Object.entries(env)) {
    if (/^(?:XDG_[A-Z_]+|npm_config_[a-z0-9_]+)$/iu.test(name) && typeof value === 'string' && path.resolve(value).startsWith(path.resolve(ctx.home))) delete env[name];
  }
  for (const [name, relative] of Object.entries(MACHINE_STATE_LOCATIONS)) env[name] = path.join(machine, relative);
  Object.assign(env, ISOLATED_RUN_SWITCHES, { HOME: home, USERPROFILE: home, COPILOT_HOME: copilotHome });
  const engine = ctx.env.SINGULARITY_FLOW_ENGINE_HOME || path.join(ctx.home, '.singularity-flow', 'engine');
  if (existsSync(engine)) env.SINGULARITY_FLOW_ENGINE_HOME = engine;
  const local = '127.0.0.1,localhost';
  env.NO_PROXY = [ctx.env.NO_PROXY, local].filter(Boolean).join(',');
  env.no_proxy = [ctx.env.no_proxy, local].filter(Boolean).join(',');
  const stamps = path.join(path.dirname(env.SINGULARITY_FLOW_COPILOT_MODE_FILE), HOOK_SESSIONS_DIRECTORY);
  return { base, env, copilotHome, folder, stamps: () => list(stamps).filter((name) => name !== '.latest').length };
}

/**
 * One chat through VS Code's own Copilot SDK. Two generations exist: VS Code 1.147 and before (`forStdio`, flat
 * session options, `provider`) and 1.148 on (`forSpawnedStdio`, grouped options, named `inference.providers`).
 */
async function runtimeChat(sdk, runtime, machine, folder, fake, pluginRoot) {
  const args = ['--no-auto-update', '--no-auto-login'];
  const handlers = { onPreToolUse: async () => undefined, onPostToolUse: async () => undefined, onUserPromptSubmitted: async () => undefined };
  const modern = typeof sdk.RuntimeConnection?.forStdio !== 'function' && typeof sdk.RuntimeConnection?.forSpawnedStdio === 'function';
  const client = modern
    ? new sdk.CopilotClient({ mode: 'coding-agent', runtime: sdk.RuntimeConnection.forSpawnedStdio({ path: runtime, args, env: machine.env, workingDirectory: folder, baseDirectory: machine.copilotHome }) })
    : typeof sdk.RuntimeConnection?.forStdio === 'function'
      ? new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forStdio({ path: runtime, args, env: machine.env }), baseDirectory: machine.copilotHome, workingDirectory: folder, logLevel: 'error' })
      : null;
  if (!client) throw new Error('this VS Code\'s Copilot runtime has an interface the check does not know');
  const options = modern ? {
    clientName: 'vscode-agent-host', workingDirectory: folder, filesystem: { trustWorkingDirectory: 'session' }, enableConfigDiscovery: true,
    permissions: { onRequest: sdk.approveAll }, hooks: { handlers, enableRepositoryHooks: true }, plugins: { directories: [pluginRoot] },
    github: { capi: { enabled: false } }, model: 'office-check/probe-model',
    inference: { providers: [{ name: 'office-check', type: 'openai', baseUrl: fake.url, apiKey: STAND_IN }], models: [{ id: 'probe-model', provider: 'office-check' }], defaultProvider: 'office-check' }
  } : {
    clientName: 'vscode-agent-host', workingDirectory: folder, trustWorkingDirectory: 'session', onPermissionRequest: sdk.approveAll,
    enableFileHooks: true, enableConfigDiscovery: true, requestExtensions: false, hooks: handlers,
    model: 'probe-model', provider: { type: 'openai', baseUrl: fake.url, apiKey: STAND_IN }
  };
  try {
    await withTimeout(client.start(), 45_000, 'Starting VS Code\'s Copilot runtime');
    const session = await withTimeout(client.createSession(options), 45_000, 'Opening a chat in VS Code\'s Copilot runtime');
    await withTimeout(modern ? session.sendAndWait(PROMPT, 60_000) : session.sendAndWait({ prompt: PROMPT }, 60_000), 75_000, 'The chat').catch(() => {});
    await session.disconnect?.().catch?.(() => {});
  } finally {
    await withTimeout(Promise.resolve(client.stop()), 20_000, 'Stopping the runtime').catch(() => {});
  }
}

async function vscodeRuntimeCheck(ctx, plugin) {
  const install = vscodeInstalls(ctx).find((entry) => entry.runtime);
  if (!install) return { ran: false, check: check('hooks-vscode', 'C', 'SFlow\'s hooks in VS Code chat (no premium request)', 'not available', ['This VS Code bundles no Copilot runtime the check can start.'], 'The guided check below can tell instead.') };
  if (!plugin.record) return { ran: false, check: check('hooks-vscode', 'C', 'SFlow\'s hooks in VS Code chat (no premium request)', 'fail', ['SFlow\'s Copilot plugin is not installed for Copilot on this machine.'], 'No SFlow hook can run in any Copilot chat here: install SFlow\'s plugin (singularity-flow plugin install).') };
  let sdk;
  try { sdk = await import(pathToFileURL(install.runtime.index).href); } catch (error) {
    return { ran: false, check: check('hooks-vscode', 'C', 'SFlow\'s hooks in VS Code chat (no premium request)', 'not available', [`VS Code's Copilot SDK could not be loaded (${error.code ?? 'error'}).`], 'The guided check below can tell instead.') };
  }
  const machine = isolatedMachine(ctx, 'vscode', plugin);
  const fake = await startFakeModel();
  const evidence = [`VS Code ${install.version} (${install.channel}), its Copilot runtime ${install.runtime.version ?? ''}`.trim() + '.'];
  try {
    await runtimeChat(sdk, install.runtime.runtime, machine, machine.folder, fake, plugin.root);
    const real = machine.stamps();
    evidence.push(fake.requests ? 'The chat reached the stand-in model on this machine (nothing was sent out).' : 'The chat never reached the stand-in model.');
    evidence.push(real ? 'SFlow\'s prompt hook ran for the chat in a folder at its real place.' : 'No SFlow hook ran for the chat in a folder at its real place.');
    // The known VS Code failure: the same chat in a folder reached through a link.
    let linked = null;
    try {
      const link = path.join(machine.base, 'linked-repository');
      symlinkSync(machine.folder, link, ctx.platform === 'win32' ? 'junction' : 'dir');
      await runtimeChat(sdk, install.runtime.runtime, machine, link, fake, plugin.root);
      linked = machine.stamps() > real;
      evidence.push(linked ? 'Through a link to the same folder, SFlow\'s hook ran too.' : 'Through a link to the same folder, no SFlow hook ran.');
    } catch { evidence.push('The same chat through a link could not be tried.'); }
    if (!fake.requests) return { ran: false, check: check('hooks-vscode', 'C', 'SFlow\'s hooks in VS Code chat (no premium request)', 'not available', evidence, 'The runtime did not run the chat, so nothing was learned; the guided check below can tell instead.') };
    return { ran: true, check: check('hooks-vscode', 'C', 'SFlow\'s hooks in VS Code chat (no premium request)', real ? PASS : 'fail', evidence,
      (real ? 'VS Code\'s Copilot runtime runs SFlow\'s hooks here: the guard and turn records work in VS Code chats.'
        : 'VS Code\'s Copilot runtime runs no SFlow hook here: VS Code chats would run without SFlow\'s guard.')
      + (linked === false ? ' Folders opened through a link run none: open the repository at its real place.' : '')
      + ' This check ran without a GitHub sign-in, so the organisation\'s Copilot policies were not applied.') };
  } catch (error) {
    evidence.push(`The runtime stopped: ${String(error.message).slice(0, 200)}`);
    return { ran: false, check: check('hooks-vscode', 'C', 'SFlow\'s hooks in VS Code chat (no premium request)', 'not available', evidence, 'The guided check below can tell instead.') };
  } finally { await fake.close(); }
}

async function copilotCliCheck(ctx, plugin) {
  const title = 'SFlow\'s hooks in Copilot CLI (no premium request)';
  const version = ctx.run.tool('copilot', ['--version'], { env: ctx.env, timeoutMs: 15_000 });
  if (!version.ok) return check('hooks-copilot-cli', 'C', title, 'not available', ['Copilot CLI is not on PATH.'], 'Skipped.');
  if (!plugin.record) return check('hooks-copilot-cli', 'C', title, 'fail', ['SFlow\'s Copilot plugin is not installed for Copilot on this machine.'], 'No SFlow hook can run in Copilot CLI here.');
  const machine = isolatedMachine(ctx, 'cli', plugin);
  const fake = await startFakeModel();
  try {
    const env = { ...machine.env, COPILOT_PROVIDER_BASE_URL: fake.url, COPILOT_PROVIDER_API_KEY: STAND_IN, COPILOT_MODEL: 'probe-model' };
    const result = await ctx.run.launch('copilot', ['-p', PROMPT, '--no-color'], { cwd: machine.folder, env, timeoutMs: 120_000 });
    const ran = machine.stamps() > 0;
    const evidence = [`Copilot CLI ${/(\d+\.\d+\.\d+)/u.exec(version.stdout)?.[1] ?? ''}`.trim() + '.',
      fake.requests ? 'The prompt reached the stand-in model on this machine (nothing was sent out).' : `The prompt never reached the stand-in model${result.timedOut ? ' (Copilot CLI took longer than 2 minutes)' : ''}.`,
      ran ? 'SFlow\'s prompt hook ran.' : 'No SFlow hook ran.'];
    if (!fake.requests && !ran) {
      return check('hooks-copilot-cli', 'C', title, 'not available', evidence, 'Copilot CLI did not run the prompt with the stand-in model (it may need a sign-in first), so nothing was learned.');
    }
    return check('hooks-copilot-cli', 'C', title, ran ? PASS : 'fail', evidence,
      ran ? 'Copilot CLI runs SFlow\'s hooks here.' : 'Copilot CLI runs no SFlow hook here: CLI chats would run without SFlow\'s guard.');
  } finally { await fake.close(); }
}

function stampSnapshot(ctx) {
  const directory = hookSessionsDirectory(ctx.env, ctx.home);
  let latest = 0;
  try { latest = lstatSync(path.join(directory, '.latest')).mtimeMs; } catch { /* none yet */ }
  return { directory, names: new Set(list(directory)), latest };
}

/** Wait for SFlow's prompt hook to leave a stamp after `before`, or give up. */
async function waitForHook(ctx, before, seconds) {
  const deadline = ctx.clock() + seconds * 1000;
  let lastNote = 0;
  while (ctx.clock() < deadline && !ctx.cancelled()) {
    const now = stampSnapshot(ctx);
    if ([...now.names].some((name) => name !== '.latest' && !before.names.has(name)) || now.latest > before.latest) return true;
    const left = Math.ceil((deadline - ctx.clock()) / 1000);
    if (ctx.clock() - lastNote >= 30_000) { ctx.note(`Waiting for SFlow's hook (up to ${left} s more)`); lastNote = ctx.clock(); }
    await ctx.sleep(2000);
  }
  return false;
}

async function vscodeGuidedCheck(ctx) {
  const title = 'SFlow\'s hooks in VS Code chat (one real message)';
  const yes = await ctx.ask({
    id: 'vscode-chat',
    question: 'Send one real message in VS Code\'s Copilot chat to check SFlow\'s hooks?',
    why: 'The free check could not run here, and this tells whether VS Code chats run SFlow\'s guard.',
    yes: `Yes: you send "${GUIDED_MESSAGE}" in Copilot chat in this folder, which uses ONE premium request; SFlow waits up to 3 minutes for its hook.`,
    no: 'No: skip this check.'
  });
  if (!yes) return check('hooks-vscode-guided', 'C', title, 'not available', ['You chose No, so this was not checked.'], 'Whether VS Code chats run SFlow\'s hooks here is still unknown.');
  const before = stampSnapshot(ctx);
  ctx.note(`Now send this message in VS Code's Copilot chat, in a window open on this folder: ${GUIDED_MESSAGE}`, { action: 'send-chat', message: GUIDED_MESSAGE });
  const ran = await waitForHook(ctx, before, 180);
  return check('hooks-vscode-guided', 'C', title, ran ? PASS : 'fail', [ran ? 'SFlow\'s prompt hook ran for the message.' : 'No SFlow hook ran within 3 minutes of the request.'],
    ran ? 'VS Code chats run SFlow\'s hooks here.' : 'VS Code chats here run without SFlow\'s guard (or the message was not sent in this folder).');
}

async function intellijCheck(ctx) {
  const title = 'SFlow\'s hooks in IntelliJ (Copilot agent and Local agent)';
  const installs = jetBrainsInstalls(ctx).filter((entry) => entry.copilot);
  if (!installs.length) return [check('hooks-intellij', 'C', title, 'not available', ['IntelliJ IDEA or Android Studio with Copilot is not used here.'], 'Skipped.')];
  const yes = await ctx.ask({
    id: 'intellij-chat',
    question: 'Check SFlow\'s hooks in IntelliJ by sending two real messages there?',
    why: 'This tells whether IntelliJ\'s two Copilot agents run SFlow\'s guard (the IntelliJ guard work needs it).',
    yes: `Yes: with this folder open in IntelliJ you send "${GUIDED_MESSAGE}" once with Copilot agent and once with Local agent, ONE premium request each; SFlow waits up to 2 minutes for each.`,
    no: 'No: skip this check.'
  });
  if (!yes) return [check('hooks-intellij', 'C', title, 'not available', ['You chose No, so this was not checked.'], 'Whether IntelliJ chats run SFlow\'s hooks here is still unknown.')];
  const results = [];
  for (const agent of ['Copilot agent', 'Local agent']) {
    if (ctx.cancelled()) break;
    const before = stampSnapshot(ctx);
    ctx.note(`In IntelliJ's Copilot chat, choose ${agent} and send: ${GUIDED_MESSAGE}`, { action: 'send-intellij', agent, message: GUIDED_MESSAGE });
    const ran = await waitForHook(ctx, before, 120);
    results.push(check(`hooks-intellij-${agent.split(' ')[0].toLowerCase()}`, 'C', `SFlow's hooks in IntelliJ, ${agent}`, ran ? PASS : 'fail',
      [`${installs.map((entry) => `${entry.product} ${entry.version}, Copilot plugin ${entry.copilot}`).join('; ')}.`, ran ? 'SFlow\'s prompt hook ran for the message.' : 'No SFlow hook ran within 2 minutes.'],
      ran ? `IntelliJ's ${agent} runs SFlow's hooks here.` : `IntelliJ's ${agent} runs without SFlow's guard here (or the message was not sent).`));
  }
  return results;
}

function linkedFolderCheck(ctx) {
  const folders = [...new Set([ctx.cwd, ctx.repository?.root].filter(Boolean))];
  const linked = folders.filter((folder) => {
    try {
      const real = realpathSync.native(folder);
      const same = ['win32', 'darwin'].includes(ctx.platform) ? real.toLowerCase() === path.resolve(folder).toLowerCase() : real === path.resolve(folder);
      return !same;
    } catch { return false; }
  });
  return check('hooks-linked-folder', 'C', 'Folder opened at its real place, not through a link', linked.length ? 'fail' : 'pass',
    [linked.length ? 'The folder SFlow was run from is reached through a link (its real place differs).' : 'The folder SFlow was run from is at its real place.'],
    linked.length ? 'VS Code runs no hooks in a folder opened through a link: open the repository at its real place.' : 'The known link cause of VS Code running no hooks does not apply here.');
}

export async function hookChecks(ctx) {
  const plugin = copilotPluginRecord(ctx);
  const checks = [check('hooks-plugin', 'C', 'SFlow\'s Copilot plugin installed', plugin.record && plugin.hooks ? PASS : 'fail',
    [plugin.record ? `Installed${plugin.version ? `, version ${plugin.version}` : ''}; ${plugin.hooks ? 'its hooks file is there' : 'its hooks file is missing'}.` : 'Not installed for Copilot on this machine.'],
    plugin.record && plugin.hooks ? 'Copilot can load SFlow\'s skills and hooks.' : 'No SFlow hook can run in Copilot here until the plugin is installed (singularity-flow plugin install).')];
  ctx.note('Hooks: VS Code chat (free, stand-in model)');
  const vscode = await vscodeRuntimeCheck(ctx, plugin);
  checks.push(vscode.check);
  if (!vscode.ran && !ctx.cancelled() && vscodeInstalls(ctx).length) checks.push(await vscodeGuidedCheck(ctx));
  if (!ctx.cancelled()) { ctx.note('Hooks: Copilot CLI (free, stand-in model)'); checks.push(await copilotCliCheck(ctx, plugin)); }
  if (!ctx.cancelled()) checks.push(...await intellijCheck(ctx));
  checks.push(linkedFolderCheck(ctx));
  return checks;
}
