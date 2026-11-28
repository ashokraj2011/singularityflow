/**
 * Probe A: the machine. What system, shells, Node, Git and Git settings SFlow meets here, whether commits are
 * signed and a signed commit works (in a temporary repository), whether a proxy is set (yes or no, never its
 * address), whether npm and the Git host answer, and how fast the temporary folder is. Reads only, except the
 * temporary repository and files, which live under the probe's own temporary folder.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check, PASS } from './report.mjs';

const first = (text) => String(text ?? '').split(/\r?\n/u).find((line) => line.trim())?.trim() ?? '';
const version = (text) => /(\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z]+)?)/u.exec(String(text ?? ''))?.[1] ?? null;

function systemName(ctx) {
  if (ctx.platform === 'darwin') {
    const product = ctx.run.tool('sw_vers', ['-productVersion'], { env: ctx.env });
    return `macOS ${version(product.stdout) ?? 'unknown version'} (Darwin ${ctx.release})`;
  }
  if (ctx.platform === 'win32') return `Windows ${ctx.release}${ctx.osVersion ? ` (${ctx.osVersion})` : ''}`;
  let distro = '';
  try { distro = /^PRETTY_NAME="?([^"\n]+)"?/mu.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? ''; } catch { /* no release file */ }
  return `Linux ${ctx.release}${distro ? ` (${distro})` : ''}`;
}

function shells(ctx) {
  const found = [];
  const ask = (label, command, args) => {
    const result = ctx.run.tool(command, args, { env: ctx.env, timeoutMs: 10_000 });
    if (result.ok) found.push(`${label} ${version(result.stdout) ?? 'present'}`);
    return result.ok;
  };
  if (ctx.platform !== 'win32') { ask('bash', 'bash', ['--version']); ask('zsh', 'zsh', ['--version']); }
  ask('PowerShell', 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  if (ctx.platform === 'win32') {
    ask('Windows PowerShell', 'powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    const execPath = ctx.run.gitIn(ctx.cwd, ['--exec-path'], { env: ctx.env, timeoutMs: 10_000 });
    const gitRoot = execPath.ok ? path.resolve(execPath.stdout.trim(), '..', '..', '..') : null;
    if (gitRoot && existsSync(path.join(gitRoot, 'bin', 'bash.exe'))) found.push('Git Bash present');
  }
  const hookShell = ctx.platform === 'win32' ? found.some((entry) => /PowerShell/u.test(entry)) : found.some((entry) => entry.startsWith('bash'));
  return check('machine-shells', 'A', 'Shells SFlow\'s Copilot hooks can run in', hookShell ? PASS : 'fail',
    found.length ? found : ['No shell answered.'],
    hookShell ? `SFlow's hook launcher has the shell it needs here (${ctx.platform === 'win32' ? 'PowerShell' : 'bash'}).`
      : `SFlow's hooks cannot start: ${ctx.platform === 'win32' ? 'PowerShell' : 'bash'} did not answer.`);
}

function nodes(ctx) {
  const seen = new Map();
  const add = (label, executable) => {
    const result = ctx.run.tool(executable, ['--version'], { env: ctx.env, timeoutMs: 10_000 });
    const value = result.ok ? version(result.stdout) : null;
    if (value && !seen.has(`${label} ${value}`)) seen.set(`${label} ${value}`, value);
  };
  seen.set(`running SFlow ${process.version.replace(/^v/u, '')}`, process.version.replace(/^v/u, ''));
  add('on PATH', 'node');
  const candidates = ctx.platform === 'win32' ? [] : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/opt/local/bin/node', '/usr/bin/node'];
  for (const candidate of candidates) if (existsSync(candidate)) add('system', candidate);
  const engine = path.join(ctx.env.SINGULARITY_FLOW_ENGINE_HOME || path.join(ctx.home, '.singularity-flow', 'engine'), 'runtimes');
  try {
    for (const name of readdirSync(engine).filter((entry) => /^node-v\d/u.test(entry)).slice(0, 3)) seen.set(`SFlow engine ${name.replace(/^node-v/u, '')}`, name);
  } catch { /* no managed engine */ }
  const running = Number(process.versions.node.split('.')[0]);
  return check('machine-node', 'A', 'Node.js versions SFlow finds', running >= 20 ? PASS : 'fail', [...seen.keys()],
    running >= 20 ? 'SFlow runs on the Node.js it was started with; hooks use the Node on PATH or SFlow\'s own engine.'
      : 'This Node.js is older than SFlow supports; install Node.js 22.');
}

function gitSettings(ctx) {
  const result = ctx.run.gitIn(ctx.cwd, ['--version'], { env: ctx.env, timeoutMs: 10_000 });
  if (!result.ok) {
    return check('machine-git', 'A', 'Git and its line-ending settings', 'fail', ['Git did not answer.'], 'SFlow needs Git on PATH.');
  }
  const get = (key) => {
    const value = ctx.run.gitIn(ctx.cwd, ['config', '--get', key], { env: ctx.env, timeoutMs: 10_000 });
    const text = value.ok ? value.stdout.trim().toLowerCase() : '';
    return ['true', 'false', 'input', 'yes', 'no', 'on', 'off', '1', '0'].includes(text) ? text : (text ? 'set' : 'not set');
  };
  const evidence = [first(result.stdout).replace(/^git version\s*/u, 'Git '), `core.autocrlf: ${get('core.autocrlf')}`];
  if (ctx.platform === 'win32') evidence.push(`core.longpaths: ${get('core.longpaths')}`);
  return check('machine-git', 'A', 'Git and its line-ending settings', 'pass', evidence,
    'SFlow writes records with LF endings; these settings say how this Git converts them on checkout.');
}

/** The person's Git settings a commit of theirs would use, as GIT_CONFIG_* variables (never printed). */
export function identityEnvironment(ctx) {
  if (ctx.identity) return ctx.identity;
  const read = ctx.repository?.root
    ? ctx.run.gitIn(ctx.repository.root, ['config', '--null', '--get-regexp', '^(user\\.(name|email|signingkey)|commit\\.gpgsign|gpg\\..*)$'], { env: ctx.env, timeoutMs: 10_000 })
    : ctx.run.gitIn(ctx.cwd, ['config', '--null', '--global', '--get-regexp', '^(user\\.(name|email|signingkey)|commit\\.gpgsign|gpg\\..*)$'], { env: ctx.env, timeoutMs: 10_000 });
  const settings = {};
  for (const entry of (read.ok ? read.stdout : '').split('\0').filter(Boolean)) {
    const split = entry.indexOf('\n');
    if (split > 0) settings[entry.slice(0, split).toLowerCase()] = entry.slice(split + 1);
  }
  const env = { GIT_CONFIG_COUNT: '0' };
  const set = (key, value) => {
    const index = Number(env.GIT_CONFIG_COUNT);
    env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; env.GIT_CONFIG_COUNT = String(index + 1);
  };
  for (const [key, value] of Object.entries(settings)) set(key, value);
  const hasIdentity = Boolean(settings['user.name'] && settings['user.email']);
  if (!hasIdentity) { set('user.name', 'SFlow office check'); set('user.email', 'office-check@example.invalid'); }
  for (const value of [settings['user.name'], settings['user.email'], settings['user.signingkey']]) {
    if (value) ctx.secrets.push(value, ...value.split(/\s+/u));
  }
  ctx.identity = { env, signing: ['true', 'yes', 'on', '1'].includes(String(settings['commit.gpgsign'] ?? '').toLowerCase()),
    format: ['openpgp', 'ssh', 'x509'].includes(settings['gpg.format']) ? settings['gpg.format'] : 'openpgp', hasIdentity };
  return ctx.identity;
}

/**
 * One empty commit in a temporary repository, made as the person's own commits are (their name, email and
 * signing settings), kept for the push check. Made once.
 */
export function throwawayCommit(ctx) {
  if (ctx.throwaway) return ctx.throwaway;
  const identity = identityEnvironment(ctx);
  const directory = path.join(ctx.temp, 'throwaway');
  mkdirSync(directory, { recursive: true });
  const env = { ...ctx.env, ...identity.env };
  const init = ctx.run.gitIn(directory, ['init', '-q'], { env, timeoutMs: 20_000 });
  const message = 'SFlow office check: a throwaway commit, deleted right after';
  const commit = init.ok ? ctx.run.gitIn(directory, ['commit', '-q', '--allow-empty', '-m', message], { env, timeoutMs: 90_000 }) : init;
  const head = commit.ok ? ctx.run.gitIn(directory, ['cat-file', 'commit', 'HEAD'], { env, timeoutMs: 10_000 }) : null;
  ctx.throwaway = { directory, ok: commit.ok, signed: Boolean(head?.stdout.includes('gpgsig')), error: commit.ok ? null : commit.stderr, env };
  return ctx.throwaway;
}

function signing(ctx) {
  const identity = identityEnvironment(ctx);
  if (!identity.signing) {
    return check('machine-signing', 'A', 'Commit signing', 'not available', ['Commit signing is off in this Git (commit.gpgsign is not true), so no signed commit was tried.'],
      'SFlow\'s commits here need no signature of their own, unless the Git host asks for one (see the push check).');
  }
  const made = throwawayCommit(ctx);
  return check('machine-signing', 'A', 'Commit signing', made.ok && made.signed ? PASS : 'fail',
    [`Signing is on (${identity.format}).`, made.ok ? (made.signed ? 'A signed commit worked in a temporary repository.' : 'A commit was made but carries no signature.')
      : `A signed commit failed in a temporary repository: ${first(made.error).slice(0, 200)}`],
    made.ok && made.signed ? 'SFlow\'s commits are signed here the way the person\'s own are.'
      : 'SFlow\'s commits would fail or go unsigned here: signing must work from a terminal without a prompt SFlow cannot answer.');
}

function proxy(ctx) {
  const names = Object.keys(ctx.env).filter((name) => /^(?:https?|all|no)_proxy$/iu.test(name) && String(ctx.env[name] ?? '').trim());
  const evidence = [names.length ? `Proxy variables set: ${[...new Set(names.map((name) => name.toUpperCase()))].join(', ')}.` : 'No proxy variables are set.'];
  const gitProxy = ['http.proxy', 'https.proxy'].filter((key) => ctx.run.gitIn(ctx.cwd, ['config', '--get', key], { env: ctx.env, timeoutMs: 10_000 }).ok);
  evidence.push(gitProxy.length ? `Git has a proxy set (${gitProxy.join(', ')}).` : 'Git has no proxy set.');
  try {
    const npmrc = readFileSync(path.join(ctx.home, '.npmrc'), 'utf8');
    evidence.push(/^\s*(?:https-)?proxy\s*=/mu.test(npmrc) ? 'npm has a proxy set.' : 'npm has no proxy set.');
  } catch { evidence.push('npm has no user settings file.'); }
  if (ctx.platform === 'darwin') {
    const system = ctx.run.tool('scutil', ['--proxy'], { env: ctx.env, timeoutMs: 10_000 });
    if (system.ok) evidence.push(/(?:HTTPS?Enable|ProxyAutoConfigEnable)\s*:\s*1/u.test(system.stdout) ? 'The system has a proxy or proxy script set.' : 'The system has no proxy set.');
  } else if (ctx.platform === 'win32') {
    const system = ctx.run.tool('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { env: ctx.env, timeoutMs: 10_000 });
    if (system.ok) evidence.push(/ProxyEnable\s+REG_DWORD\s+0x1\b|AutoConfigURL\s+REG_SZ/iu.test(system.stdout) ? 'Windows has a proxy or proxy script set.' : 'Windows has no proxy set.');
  }
  return check('machine-proxy', 'A', 'Proxy settings (set or not, never the address)', 'pass', evidence,
    names.length || gitProxy.length ? 'SFlow\'s network calls must go through the proxy: Git and npm use their own settings, Node.js uses none by itself.'
      : 'SFlow reaches the network directly here.');
}

function reachability(ctx) {
  const evidence = [];
  const npm = ctx.run.tool('npm', ['ping'], { env: ctx.env, timeoutMs: 25_000, cwd: ctx.cwd });
  evidence.push(npm.ok ? 'The npm registry npm uses answered.' : npm.missing ? 'npm is not on PATH.' : 'The npm registry npm uses did not answer.');
  let host = null;
  if (ctx.repository?.remote) {
    const remote = ctx.run.gitIn(ctx.repository.root, ['ls-remote', '--exit-code', ctx.repository.remote, 'HEAD'],
      { env: { ...ctx.env, GCM_INTERACTIVE: 'never' }, timeoutMs: 30_000 });
    const text = remote.stderr;
    host = remote.ok || remote.status === 2 ? 'answered'
      : /authentication|could not read username|permission denied|access denied|403|401|terminal prompts disabled/iu.test(text) ? 'answered, sign-in needed'
        : 'did not answer';
    evidence.push(`The Git host ${host}.`);
  } else evidence.push('No Git remote here, so the Git host was not tried.');
  const ok = npm.ok && (host === null || host.startsWith('answered'));
  return check('machine-network', 'A', 'npm registry and Git host reachable', ok ? PASS : 'fail', evidence,
    ok ? 'SFlow can install and update its packages and reach the Git host from here.'
      : 'Updating SFlow or pushing a Story will fail from here until the unreachable service answers.');
}

function temporaryFolder(ctx) {
  const directory = path.join(ctx.temp, 'speed');
  const started = ctx.clock();
  try {
    mkdirSync(directory, { recursive: true });
    const body = 'x'.repeat(1024);
    for (let index = 0; index < 200; index += 1) writeFileSync(path.join(directory, `f${index}.txt`), body);
    for (let index = 0; index < 200; index += 1) readFileSync(path.join(directory, `f${index}.txt`));
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    return check('machine-temp', 'A', 'Temporary folder writable and fast', 'fail', [`Writing in the temporary folder failed (${error.code ?? 'error'}).`],
      'SFlow\'s temporary work (reviews, checks, clones) cannot run here.');
  }
  const ms = Math.round(ctx.clock() - started);
  return check('machine-temp', 'A', 'Temporary folder writable and fast', 'pass', [`200 small files written, read and removed in ${ms} ms.`],
    ms > 3000 ? 'The temporary folder is slow (a scanner may be checking each file); SFlow\'s checks will feel slow here.'
      : 'SFlow\'s temporary work runs at normal speed here.');
}

export function machineChecks(ctx) {
  const checks = [
    check('machine-system', 'A', 'Operating system and processor', 'pass', [`${systemName(ctx)}, ${ctx.arch}`],
      'The SFlow build and hook launcher for this system are the ones to test.')
  ];
  for (const probe of [shells, nodes, gitSettings, signing, proxy, reachability, temporaryFolder]) {
    ctx.note(`Machine: ${probe.name}`);
    try { checks.push(probe(ctx)); } catch (error) { checks.push(check(`machine-${probe.name}`, 'A', probe.name, 'not available', [`The check stopped: ${error.message}`], 'Nothing was learned here.')); }
  }
  return checks;
}
