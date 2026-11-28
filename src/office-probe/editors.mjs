/**
 * Probe B: editors and Copilot. VS Code (version, channel, its Copilot extensions, whether its Copilot agent
 * host has run, its hook and plugin settings and any organisation policy), Copilot CLI, and IntelliJ IDEA or
 * Android Studio with their Copilot plugin. Everything is read from install, settings and plugin folders; no
 * editor is started and nothing is written.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { check, PASS } from './report.mjs';

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const list = (directory) => { try { return readdirSync(directory); } catch { return []; } };
const compareVersions = (a, b) => {
  const left = String(a).split(/[.-]/u).map(Number); const right = String(b).split(/[.-]/u).map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
};

/** settings.json allows comments and trailing commas. */
export function parseJsonc(text) {
  let out = ''; let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) { out += char; if (char === '\\') { out += text[index + 1] ?? ''; index += 1; } else if (char === '"') inString = false; continue; }
    if (char === '"') { inString = true; out += char; continue; }
    if (char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index += 1; out += '\n'; continue; }
    if (char === '/' && text[index + 1] === '*') { index += 2; while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1; index += 1; continue; }
    out += char;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/gu, '$1')); } catch { return null; }
}

function installRoots(ctx) {
  const env = ctx.env;
  if (ctx.platform === 'darwin') {
    return ['/Applications', path.join(ctx.home, 'Applications')].flatMap((parent) =>
      ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'].map((name) => path.join(parent, name, 'Contents', 'Resources', 'app')));
  }
  if (ctx.platform === 'win32') {
    const parents = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    return parents.flatMap((parent) => ['Microsoft VS Code', 'Microsoft VS Code Insiders'].flatMap((name) => {
      const base = path.join(parent, name);
      // Newer Windows installs keep each version in a folder named by its commit.
      const versioned = list(base).filter((entry) => /^[0-9a-f]{8,40}$/u.test(entry)).map((entry) => path.join(base, entry, 'resources', 'app'));
      return [path.join(base, 'resources', 'app'), ...versioned];
    }));
  }
  return ['/usr/share/code', '/usr/share/code-insiders', '/opt/visual-studio-code', '/snap/code/current/usr/share/code']
    .map((root) => path.join(root, 'resources', 'app'));
}

/** Copilot's SDK and runtime that this VS Code bundles, if it bundles them. */
function bundledRuntime(appDirectory, ctx) {
  const platform = ctx.platform; const arch = ctx.arch;
  for (const modules of ['node_modules.asar.unpacked', 'node_modules']) {
    for (const scope of ['@microsoft', '@github']) {
      const base = path.join(appDirectory, modules, scope, `copilot-sdk-${platform}-${arch}`);
      const index = path.join(base, 'copilot-sdk', 'index.js');
      const runtime = path.join(base, 'prebuilds', `${platform}-${arch}`, platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime');
      if (existsSync(index) && existsSync(runtime)) {
        return { index, runtime, version: readJson(path.join(base, 'package.json'))?.version ?? null };
      }
    }
  }
  return null;
}

export function vscodeInstalls(ctx) {
  if (ctx.vscode) return ctx.vscode;
  const found = [];
  for (const appDirectory of ctx.vscodeRoots ?? installRoots(ctx)) {
    const product = readJson(path.join(appDirectory, 'product.json'));
    const pkg = readJson(path.join(appDirectory, 'package.json'));
    if (!product || !pkg?.version) continue;
    const nameShort = typeof product.nameShort === 'string' ? product.nameShort : 'Code';
    const userData = ctx.platform === 'darwin' ? path.join(ctx.home, 'Library', 'Application Support', nameShort)
      : ctx.platform === 'win32' ? path.join(ctx.env.APPDATA ?? path.join(ctx.home, 'AppData', 'Roaming'), nameShort)
        : path.join(ctx.env.XDG_CONFIG_HOME ?? path.join(ctx.home, '.config'), nameShort);
    const dataFolder = typeof product.dataFolderName === 'string' ? product.dataFolderName : '.vscode';
    found.push({
      channel: product.quality === 'insider' ? 'Insiders' : product.quality === 'stable' ? 'Stable' : String(product.quality ?? 'unknown'),
      version: pkg.version, appDirectory, userData, extensions: path.join(ctx.home, dataFolder, 'extensions'),
      builtInCopilot: readJson(path.join(appDirectory, 'extensions', 'copilot', 'package.json'))?.version ?? null,
      runtime: bundledRuntime(appDirectory, ctx)
    });
  }
  const unique = new Map();
  for (const entry of found.sort((a, b) => compareVersions(b.version, a.version))) if (!unique.has(entry.channel)) unique.set(entry.channel, entry);
  ctx.vscode = [...unique.values()];
  return ctx.vscode;
}

function extensionVersions(directory) {
  const versions = {};
  const record = readJson(path.join(directory, 'extensions.json'));
  const entries = Array.isArray(record) ? record.map((entry) => [entry?.identifier?.id, entry?.version])
    : list(directory).map((name) => { const match = /^(.+?)-(\d+\.\d+\.\d+.*)$/u.exec(name); return match ? [match[1], match[2]] : [null, null]; });
  for (const [id, value] of entries) {
    const key = String(id ?? '').toLowerCase();
    if (['github.copilot', 'github.copilot-chat'].includes(key) && value && (!versions[key] || compareVersions(value, versions[key]) > 0)) versions[key] = value;
  }
  return versions;
}

function agentHostSeen(userData) {
  const logs = path.join(userData, 'logs');
  const sessions = list(logs).filter((name) => /^\d{8}T\d{6}$/u.test(name)).sort().slice(-8);
  const used = sessions.filter((name) => existsSync(path.join(logs, name, 'agenthost.log')));
  return used.length ? `${used.at(-1).slice(0, 4)}-${used.at(-1).slice(4, 6)}-${used.at(-1).slice(6, 8)}` : null;
}

const SETTINGS = [
  ['chat.useHooks', 'Hooks in chat'],
  ['chat.hooks.allowManagedOnly', 'Only hooks the organisation manages'],
  ['chat.plugins.enabled', 'Agent plugins']
];

function vscodePolicies(ctx) {
  const named = [];
  if (ctx.platform === 'darwin') {
    if (existsSync('/Library/Managed Preferences/com.microsoft.VSCode.plist')) named.push('a managed VS Code profile is installed');
  } else if (ctx.platform === 'linux') {
    const policy = readJson('/etc/vscode/policy.json');
    if (policy) named.push(...Object.keys(policy).filter((name) => /hook|plugin|agent|chat|copilot|extension/iu.test(name)).slice(0, 10));
  } else if (ctx.platform === 'win32') {
    for (const hive of ['HKLM', 'HKCU']) {
      const result = ctx.run.tool('reg', ['query', `${hive}\\SOFTWARE\\Policies\\Microsoft\\VSCode`, '/s'], { env: ctx.env, timeoutMs: 10_000 });
      if (!result.ok) continue;
      for (const match of result.stdout.matchAll(/^\s+(\w+)\s+REG_(?:DWORD|SZ|MULTI_SZ)\s+(\S*)/gmu)) {
        if (/hook|plugin|agent|chat|copilot|extension/iu.test(match[1])) named.push(`${match[1]}${/^0x[01]$/u.test(match[2]) ? ` = ${match[2] === '0x1' ? 'on' : 'off'}` : ''}`);
      }
    }
  }
  return named;
}

function vscodeCheck(ctx) {
  const installs = vscodeInstalls(ctx);
  if (!installs.length) {
    return [check('editor-vscode', 'B', 'VS Code and its Copilot extensions', 'not available', ['VS Code is not installed in a usual place.'],
      'The VS Code checks below cannot run here.')];
  }
  const checks = [];
  for (const install of installs) {
    const extensions = extensionVersions(install.extensions);
    const chat = extensions['github.copilot-chat'] ?? (install.builtInCopilot ? `${install.builtInCopilot} (built in)` : null);
    const evidence = [`VS Code ${install.version} (${install.channel}).`,
      `Copilot Chat: ${chat ?? 'not installed'}.`, `Copilot (completions): ${extensions['github.copilot'] ?? 'not installed'}.`,
      `Copilot runtime bundled with VS Code: ${install.runtime ? `yes${install.runtime.version ? `, ${install.runtime.version}` : ''}` : 'no'}.`];
    const host = agentHostSeen(install.userData);
    evidence.push(host ? `VS Code's Copilot agent host has run here (last on ${host}).` : 'VS Code\'s Copilot agent host has not run here recently.');
    const settings = parseJsonc((() => { try { return readFileSync(path.join(install.userData, 'User', 'settings.json'), 'utf8'); } catch { return ''; } })()) ?? {};
    for (const [key, words] of SETTINGS) {
      if (typeof settings[key] === 'boolean') evidence.push(`${words}: ${settings[key] ? 'on' : 'off'} in the person's settings.`);
    }
    const policies = vscodePolicies(ctx);
    evidence.push(policies.length ? `Organisation policies: ${policies.join('; ')}.` : 'No organisation policy for VS Code hooks, plugins or chat was found.');
    const hooksOff = settings['chat.useHooks'] === false || settings['chat.hooks.allowManagedOnly'] === true;
    checks.push(check(`editor-vscode-${install.channel.toLowerCase()}`, 'B', `VS Code ${install.channel} and its Copilot extensions`, chat ? (hooksOff ? 'fail' : 'pass') : 'fail', evidence,
      !chat ? 'Copilot Chat is not installed, so SFlow\'s chat skills and hooks cannot run in this VS Code.'
        : hooksOff ? 'A setting here turns SFlow\'s chat hooks off: the guard and turn records would not run in VS Code.'
          : host ? 'VS Code runs Copilot chats through its agent host here; SFlow\'s hooks must run there (see C).'
            : 'Copilot Chat is installed; whether SFlow\'s hooks run in it is checked in C.'));
  }
  return checks;
}

function copilotCliCheck(ctx) {
  const result = ctx.run.tool('copilot', ['--version'], { env: ctx.env, timeoutMs: 15_000 });
  const value = /(\d+\.\d+\.\d+)/u.exec(result.stdout)?.[1] ?? null;
  return check('editor-copilot-cli', 'B', 'Copilot CLI', result.ok && value ? PASS : 'not available',
    [result.ok && value ? `Copilot CLI ${value}.` : 'Copilot CLI is not on PATH.'],
    result.ok && value ? 'People here can run SFlow\'s skills from Copilot CLI too.' : 'SFlow runs from VS Code here; Copilot CLI checks are skipped.');
}

/** IntelliJ IDEA and Android Studio found from their settings folders, newest of each, with the Copilot plugin. */
export function jetBrainsInstalls(ctx) {
  if (ctx.jetbrains) return ctx.jetbrains;
  const roots = ctx.platform === 'darwin' ? [path.join(ctx.home, 'Library', 'Application Support')]
    : ctx.platform === 'win32' ? [ctx.env.APPDATA ?? path.join(ctx.home, 'AppData', 'Roaming')]
      : [ctx.env.XDG_CONFIG_HOME ?? path.join(ctx.home, '.config'), path.join(ctx.home, '.local', 'share')];
  const products = new Map();
  const names = { IntelliJIdea: 'IntelliJ IDEA Ultimate', IdeaIC: 'IntelliJ IDEA Community', AndroidStudio: 'Android Studio' };
  for (const root of roots) {
    for (const vendor of ['JetBrains', 'Google']) {
      for (const folder of list(path.join(root, vendor))) {
        const match = /^(IntelliJIdea|IdeaIC|AndroidStudio)(\d{4}\.\d+)$/u.exec(folder);
        if (!match) continue;
        const directory = path.join(root, vendor, folder);
        try { if (!statSync(directory).isDirectory()) continue; } catch { continue; }
        const jar = list(path.join(directory, 'plugins', 'github-copilot-intellij', 'lib')).map((name) => /^github-copilot-intellij-(.+)\.jar$/u.exec(name)?.[1]).find(Boolean) ?? null;
        const key = match[1];
        const current = products.get(key);
        if (!current || compareVersions(match[2], current.version) > 0 || (match[2] === current.version && jar && !current.copilot)) {
          products.set(key, { product: names[key], version: match[2], copilot: jar ?? current?.copilot ?? null });
        }
      }
    }
  }
  ctx.jetbrains = [...products.values()];
  return ctx.jetbrains;
}

function jetBrainsCheck(ctx) {
  const found = jetBrainsInstalls(ctx);
  if (!found.length) {
    return check('editor-jetbrains', 'B', 'IntelliJ IDEA and Android Studio', 'not available', ['Neither IntelliJ IDEA nor Android Studio has been used here.'],
      'The IntelliJ checks are skipped.');
  }
  return check('editor-jetbrains', 'B', 'IntelliJ IDEA and Android Studio', found.some((entry) => entry.copilot) ? PASS : 'fail',
    found.map((entry) => `${entry.product} ${entry.version}: Copilot plugin ${entry.copilot ?? 'not installed'}.`),
    found.some((entry) => entry.copilot) ? 'SFlow\'s IntelliJ guard work must support this Copilot plugin version.'
      : 'Copilot is not installed in IntelliJ here, so SFlow cannot run there.');
}

export function editorChecks(ctx) {
  const checks = [];
  for (const probe of [vscodeCheck, copilotCliCheck, jetBrainsCheck]) {
    ctx.note(`Editors: ${probe.name}`);
    try { checks.push(...[probe(ctx)].flat()); } catch (error) { checks.push(check(`editor-${probe.name}`, 'B', probe.name, 'not available', [`The check stopped: ${error.message}`], 'Nothing was learned here.')); }
  }
  return checks;
}
