/**
 * What a test command really runs [TCE:REQ-011]: one reading, shared by the command's pin
 * (src/test-command-pins.mjs) and the Node reporter that observes its run
 * (src/verification/node-test-observation.mjs).
 *
 * The pin read only the working directory's package.json script and the configuration files beside
 * it, and the reporter only the outer script's text. So a script edit in the workspace `npm -w a test`
 * selects, or in the `--config config/jest.config.cjs` a script names, changed which tests ran with
 * the pin unchanged, and `test → npm run unit → node --test --test-reporter=tap` got a second reporter
 * with no destination, so Node exited before any test ran (review, 2026-11-01).
 *
 * This follows the package script chain (pre and post scripts, `npm run`/`pnpm`/`yarn`/`bun`
 * references, `&&`/`;` steps, run-s/run-p/npm-run-all), the workspace and directory each step
 * selects (npm `--workspace`/`-w` by path or name, `--workspaces`, `--prefix`; pnpm `--filter`/`-F`,
 * `--dir`/`-C`, `-r`; yarn `workspace NAME`, `workspaces foreach`, `--cwd`; bun `--cwd`, `--filter`),
 * through the usual wrappers (npx, exec, cross-env, dotenv, nyc, c8) to each runner it starts, and
 * the files a runner is told to read: jest, vitest and playwright `--config`/`-c`, mocha `--config`,
 * cypress `--config-file`/`-C`, karma's configuration operand, a `node --test` run's `--import` and
 * `--require` files and a script file a step runs. Nothing runs and nothing is written; `read` and
 * `list` are the caller's, so the pin can read a base commit and the reporter the live checkout.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_SCRIPTS = 64;
const MAX_DEPTH = 8;
const MAX_WORKSPACES = 256;
export const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// Option flags of npm, pnpm, yarn and bun that take a value before the script verb.
const VALUE_FLAGS = new Set(['--prefix', '-C', '--dir', '-w', '--workspace', '--filter', '-F', '--cwd']);
// Commands that start the command after their own flags: [launcher, flags that take a value].
const WRAPPERS = new Map([
  ['npx', new Set(['-p', '--package', '-c', '--call'])], ['pnpx', new Set(['-p', '--package'])], ['bunx', new Set(['-p', '--package'])],
  ['nyc', new Set(['-r', '--reporter', '-x', '--exclude', '-n', '--include', '--temp-dir', '-t', '--report-dir', '--cwd', '--extension', '-e'])],
  ['c8', new Set(['-r', '--reporter', '-x', '--exclude', '-n', '--include', '--temp-directory', '-o', '--reports-dir', '--src'])],
  ['dotenv', new Set(['-e', '-c', '-v', '-p'])], ['env-cmd', new Set(['-f', '--file', '-e', '--environments', '-r', '--rc-file'])]
]);
// The flag naming each runner's configuration file.
const CONFIG_FLAGS = {
  jest: new Set(['--config', '-c']), vitest: new Set(['--config', '-c']), playwright: new Set(['--config', '-c']),
  mocha: new Set(['--config']), cypress: new Set(['--config-file', '-C'])
};
const NODE_IMPORT_FLAGS = new Set(['--import', '--require', '-r']);
// Node's options that take a value, so a script operand is not mistaken for one (`node --import tsx run.mjs`).
const NODE_VALUE_FLAGS = new Set([...NODE_IMPORT_FLAGS, '--loader', '--experimental-loader', '--env-file', '--test-reporter',
  '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-timeout', '--test-shard',
  '--conditions', '-C', '--input-type', '--title']);
const SCRIPT_FILE = /\.(?:sh|mjs|cjs|js|mts|cts|ts|py|ps1)$/u;

/** A launcher as one name: `.\mvnw.cmd`, `node_modules/.bin/jest` and `pnpm.exe` read as mvnw, jest, pnpm. */
export function launcherName(value) {
  return path.posix.basename(String(value ?? '').replaceAll('\\', '/')).toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/u, '');
}

/** The package script an npm, pnpm, yarn or bun invocation runs, or null (`bun test` is bun's own runner). */
export function packageScriptName(tokens) {
  const [first, ...rest] = tokens ?? [];
  const runner = launcherName(first);
  if (!SCRIPT_RUNNERS.has(runner)) return null;
  const skipFlags = (index) => {
    let at = index;
    while (at < rest.length && rest[at].startsWith('-') && rest[at] !== '--') at += VALUE_FLAGS.has(rest[at]) ? 2 : 1;
    return at;
  };
  const at = skipFlags(0);
  const verb = rest[at];
  if (!verb || verb === '--') return null;
  if (['test', 't', 'tst'].includes(verb)) return runner === 'bun' ? null : 'test';
  if (['run', 'run-script', 'rum', 'urn'].includes(verb)) return rest[skipFlags(at + 1)] ?? null;
  if (runner === 'npm' || ['exec', 'dlx', 'x', 'install', 'add', 'ci'].includes(verb)) return null;
  return verb;
}

/** Split shell text into its commands (`&&`, `||`, `;`, `|`), each as tokens without quotes. */
export function shellSegments(text) {
  return String(text ?? '').split(/&&|\|\||[;|\n]/u)
    .map((segment) => (segment.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []).map((token) => token.replace(/^(["'])([\s\S]*)\1$/u, '$2')))
    .filter((tokens) => tokens.length);
}

/** A segment without its leading `NAME=value` assignments and `cross-env`/`dotenv` wrappers. */
export function commandTokens(tokens) {
  let at = 0;
  while (at < tokens.length) {
    const name = launcherName(tokens[at]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[at]) || ['cross-env', 'env', 'dotenv'].includes(name) || tokens[at] === '--') at += 1;
    else break;
  }
  return tokens.slice(at);
}

/** run-s, run-p and npm-run-all name scripts, globs (`test:*`) included. */
function runAllReferences(tokens, scripts) {
  const names = [];
  for (const pattern of tokens.slice(1).filter((token) => !token.startsWith('-'))) {
    const matcher = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^:]*')}$`, 'u');
    names.push(...Object.keys(scripts).filter((name) => matcher.test(name)));
  }
  return names;
}

/** The scripts one script text runs in its own package: `npm run X`, `yarn X`, `pnpm X`, and run-s/run-p names. */
function scriptReferences(text, scripts) {
  const names = [];
  for (const segment of shellSegments(text)) {
    const tokens = commandTokens(segment);
    const named = packageScriptName(tokens);
    if (named) names.push(named);
    if (['run-s', 'run-p', 'npm-run-all'].includes(launcherName(tokens[0]))) names.push(...runAllReferences(tokens, scripts));
  }
  return names;
}

/** The scripts `name` runs in one package, in order: its pre and post scripts and every script it references. */
export function packageScriptChain(scripts, name) {
  const chain = [];
  const seen = new Set();
  const visit = (script, depth) => {
    for (const candidate of [`pre${script}`, script, `post${script}`]) {
      if (seen.has(candidate) || chain.length >= MAX_SCRIPTS || typeof scripts?.[candidate] !== 'string') continue;
      seen.add(candidate);
      chain.push({ name: candidate, text: scripts[candidate] });
      if (depth < MAX_DEPTH) for (const reference of scriptReferences(scripts[candidate], scripts)) visit(reference, depth + 1);
    }
  };
  visit(name, 0);
  return chain;
}

const join = (directory, name) => (directory === '.' || !directory ? name : path.posix.join(directory, name));

/** A path a step names, inside the repository, or null: absolute, drive-letter and escaping paths are never read. */
export function repositoryRelative(directory, value) {
  const text = String(value ?? '').replaceAll('\\', '/');
  if (!text || text.includes('\0') || path.posix.isAbsolute(text) || /^[A-Za-z]:/u.test(text) || /^[a-z][a-z0-9+.-]*:/iu.test(text)) return null;
  const joined = path.posix.normalize(join(directory, text));
  return joined === '..' || joined.startsWith('../') ? null : joined.replace(/^\.\//u, '').replace(/\/+$/u, '') || '.';
}

/** A flag's value: `--config x`, `--config=x` or `-cx`-free forms; null when absent. */
function flagValues(tokens, flags) {
  const values = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') break;
    const equals = token.indexOf('=');
    const name = token.startsWith('--') && equals > 0 ? token.slice(0, equals) : token;
    if (!flags.has(name)) continue;
    if (name !== token) values.push(token.slice(equals + 1));
    else if (index + 1 < tokens.length) values.push(tokens[index += 1]);
  }
  return values;
}

/** The command a wrapper starts, and package-manager `exec`/`dlx`/`x`: `npx --no-install jest` reads as `jest`. */
export function unwrapRunner(tokens) {
  let values = commandTokens(tokens);
  for (let guard = 0; guard < 8 && values.length; guard += 1) {
    const name = launcherName(values[0]);
    const valueFlags = WRAPPERS.get(name);
    if (valueFlags) {
      let at = 1;
      while (at < values.length && values[at].startsWith('-')) at += values[at] === '--' ? 1 : valueFlags.has(values[at]) ? 2 : 1;
      values = commandTokens(values.slice(at));
      continue;
    }
    if (SCRIPT_RUNNERS.has(name)) {
      let at = 1;
      while (at < values.length && values[at].startsWith('-') && values[at] !== '--') at += VALUE_FLAGS.has(values[at]) ? 2 : 1;
      if (['exec', 'dlx', 'x'].includes(values[at])) {
        at += 1;
        while (at < values.length && values[at].startsWith('-')) at += values[at] === '--' ? 1 : ['-p', '--package'].includes(values[at]) ? 2 : 1;
        values = commandTokens(values.slice(at));
        continue;
      }
    }
    break;
  }
  return values;
}

/** Whether a runner's tokens start a `node --test` run (tsx passes Node's test flags through). */
export function nodeTestRun(tokens) {
  return ['node', 'tsx'].includes(launcherName(tokens?.[0])) && tokens.includes('--test');
}

/**
 * The files a runner's tokens tell it to read, relative to the repository: `{ path, role, flag }`. A
 * script file counts only for the command itself (`bash scripts/test.sh`): one a chain step runs
 * (`pretest: node build.mjs`) is the Story's own code, not what selects its tests.
 */
function namedFiles(tokens, directory, { command = false } = {}) {
  const runner = launcherName(tokens[0]);
  const files = [];
  const add = (value, role, flag) => {
    const relative = repositoryRelative(directory, value);
    if (relative) files.push({ path: relative, role, flag });
  };
  if (CONFIG_FLAGS[runner]) {
    // An inline JSON configuration (`--config '{...}'`) is the script's own text, pinned with it.
    for (const value of flagValues(tokens.slice(1), CONFIG_FLAGS[runner])) if (!value.trim().startsWith('{')) add(value, 'config', 'config');
  }
  if (runner === 'karma') {
    const at = tokens.findIndex((token, index) => index > 0 && ['start', 'run'].includes(token));
    const operand = tokens.slice(at > 0 ? at + 1 : 1).find((token) => !token.startsWith('-'));
    if (operand) add(operand, 'config', 'karma');
  }
  if (nodeTestRun(tokens)) {
    // A module a run preloads (`--import ./test/setup.mjs`); a package name (`--import tsx`) is not a repository file.
    for (const value of flagValues(tokens.slice(1), NODE_IMPORT_FLAGS)) {
      if (/^\.{1,2}\//u.test(value) || (!value.startsWith('@') && SCRIPT_FILE.test(value) && !value.includes(':'))) add(value, 'import', 'import');
    }
  } else if (!command) {
    return files;
  } else if (['bash', 'sh', 'zsh', 'node', 'tsx'].includes(runner)) {
    let file = null;
    for (let index = 1; index < tokens.length && !file; index += 1) {
      if (['-e', '--eval', '-p', '--print', '-c'].includes(tokens[index])) return files;
      if (tokens[index].startsWith('-')) { if (NODE_VALUE_FLAGS.has(tokens[index])) index += 1; continue; }
      file = tokens[index];
    }
    if (file && (/[/\\]/u.test(file) || SCRIPT_FILE.test(file))) add(file, 'script', 'script');
  } else if (/^\.{0,2}\//u.test(String(tokens[0]).replaceAll('\\', '/')) && SCRIPT_FILE.test(tokens[0])) {
    add(tokens[0], 'script', 'script');
  }
  return files;
}

/** A small reader for pnpm-workspace.yaml's `packages:` list. */
function pnpmWorkspacePatterns(text) {
  const patterns = [];
  let inside = false;
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (/^packages\s*:/u.test(line)) { inside = true; continue; }
    if (inside && /^\S/u.test(line)) break;
    const item = inside ? /^\s*-\s*(['"]?)(.+?)\1\s*(?:#.*)?$/u.exec(line) : null;
    if (item) patterns.push(item[2]);
  }
  return patterns;
}

/**
 * How one package-manager step selects packages: the script it runs and the directories it runs it
 * in, relative to its own. `all` is every workspace; `names` are matched against workspace names and
 * paths. Null when the tokens are not a package script run.
 */
export function packageInvocation(tokens) {
  const runner = launcherName(tokens?.[0]);
  if (!SCRIPT_RUNNERS.has(runner)) return null;
  const rest = tokens.slice(1);
  const end = rest.indexOf('--') === -1 ? rest.length : rest.indexOf('--');
  const before = rest.slice(0, end);
  const selection = { directories: [], names: [], all: false, root: false };
  // yarn workspace NAME SCRIPT, and yarn workspaces foreach|run SCRIPT.
  if (runner === 'yarn') {
    const at = before.findIndex((token) => !token.startsWith('-'));
    if (before[at] === 'workspace' && before[at + 1]) {
      const script = packageScriptName(['yarn', ...before.slice(at + 2)]);
      return script ? { script, selection: { ...selection, names: [before[at + 1]] } } : null;
    }
    if (before[at] === 'workspaces' && ['foreach', 'run'].includes(before[at + 1])) {
      const tail = before.slice(at + 2);
      const run = tail.indexOf('run');
      const script = run === -1 ? tail.find((token) => !token.startsWith('-')) : tail[run + 1];
      return script ? { script, selection: { ...selection, all: true } } : null;
    }
  }
  const script = packageScriptName(tokens);
  if (!script) return null;
  // npm reads its own options anywhere before `--`; the others only before the script name.
  const verbAt = (() => {
    let at = 0;
    while (at < before.length && before[at].startsWith('-')) at += VALUE_FLAGS.has(before[at]) ? 2 : 1;
    return at;
  })();
  // `yarn jest`, `pnpm vitest`: a script of that name, else the package's own binary.
  const bare = runner !== 'npm' && !['run', 'run-script', 'rum', 'urn', 'test', 't', 'tst'].includes(before[verbAt]) ? rest.slice(verbAt) : null;
  const options = runner === 'npm' ? before : before.slice(0, verbAt);
  const values = (flags) => flagValues(options, new Set(flags));
  if (runner === 'npm') {
    selection.names.push(...values(['--workspace', '-w']));
    if (options.includes('--workspaces') || options.includes('-ws')) selection.all = true;
    selection.directories.push(...values(['--prefix']));
  } else if (runner === 'pnpm') {
    selection.names.push(...values(['--filter', '-F']));
    if (options.includes('-r') || options.includes('--recursive')) selection.all = true;
    selection.directories.push(...values(['--dir', '-C']));
    if (options.includes('-w') || options.includes('--workspace-root')) selection.root = true;
  } else {
    selection.directories.push(...values(['--cwd']));
    if (runner === 'bun') selection.names.push(...values(['--filter']));
  }
  return { script, selection, bare };
}

/** Glob-match one workspace path segment pattern (`*`, `pkg-*`). */
const segmentMatcher = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^/]*')}$`, 'u');

/**
 * Resolve `argv`, run from `directory`, to what it runs. `read(relative)` returns a file's text or
 * null; `list(relative)` its entries as `{ name, directory }`. Returns the packages whose scripts it
 * runs (`scripts` in order, `missing` script names, `manifest` or null), the runner steps it reaches
 * (`runs`: tokens and directory), the files they name (`files`), and the workspace selectors that
 * matched nothing (`unresolved`), so a pin can say so rather than pin nothing.
 */
export async function resolveTestCommand(argv, { directory = '.', read, list }) {
  const packages = new Map();
  const runs = [];
  const files = [];
  const unresolved = [];
  const seen = new Set();
  let visited = 0;
  const manifestPath = (dir) => join(dir, 'package.json');
  const packageAt = async (dir) => {
    if (packages.has(dir)) return packages.get(dir);
    const text = await read(manifestPath(dir));
    let manifest = null;
    try { manifest = text == null ? null : JSON.parse(text); } catch { manifest = null; }
    const entry = { directory: dir, manifestPath: manifestPath(dir), manifest: manifest && typeof manifest === 'object' ? manifest : null,
      scripts: [], missing: [] };
    packages.set(dir, entry);
    return entry;
  };
  const workspaceCache = new Map();
  const workspaces = async (dir) => {
    if (workspaceCache.has(dir)) return workspaceCache.get(dir);
    const owner = await packageAt(dir);
    const declared = owner.manifest?.workspaces;
    const patterns = [...(Array.isArray(declared) ? declared : Array.isArray(declared?.packages) ? declared.packages : []),
      ...pnpmWorkspacePatterns(await read(join(dir, 'pnpm-workspace.yaml')))].filter((value) => typeof value === 'string');
    const found = new Set();
    const excluded = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1).replace(/^\.\//u, '').replace(/\/+$/u, ''));
    for (const pattern of patterns.filter((value) => !value.startsWith('!'))) {
      const segments = pattern.replace(/^\.\//u, '').replace(/\/+$/u, '').split('/').filter(Boolean);
      if (segments.some((segment) => segment === '..')) continue;
      let frontier = ['.'];
      for (const segment of segments) {
        const next = [];
        for (const base of frontier) {
          if (segment === '**') {
            // Any depth below, bounded: base itself and up to three levels of directories.
            const stack = [[base, 0]];
            while (stack.length && next.length < MAX_WORKSPACES) {
              const [at, depth] = stack.pop();
              next.push(at);
              if (depth >= 3) continue;
              for (const entry of await list(join(dir, at))) {
                if (entry.directory && entry.name !== 'node_modules' && !entry.name.startsWith('.')) stack.push([join(at, entry.name), depth + 1]);
              }
            }
          } else if (segment.includes('*')) {
            const matcher = segmentMatcher(segment);
            for (const entry of await list(join(dir, base))) if (entry.directory && entry.name !== 'node_modules' && matcher.test(entry.name)) next.push(join(base, entry.name));
          } else next.push(join(base, segment));
        }
        frontier = next.slice(0, MAX_WORKSPACES);
      }
      for (const candidate of frontier) if (candidate !== '.' && !excluded.some((skip) => candidate === skip || segmentMatcher(skip).test(candidate))) found.add(candidate);
    }
    const resolved = [];
    for (const relative of [...found].sort().slice(0, MAX_WORKSPACES)) {
      const member = await packageAt(join(dir, relative));
      if (member.manifest) resolved.push({ directory: join(dir, relative), name: typeof member.manifest.name === 'string' ? member.manifest.name : null });
    }
    workspaceCache.set(dir, resolved);
    return resolved;
  };
  // The directories one step runs its script in, relative to the repository.
  const selected = async (invocation, dir) => {
    const { selection } = invocation;
    const out = [];
    for (const value of selection.directories) {
      const relative = repositoryRelative(dir, value);
      if (relative) out.push(relative);
      else unresolved.push({ manifestPath: manifestPath(dir), selector: `directory:${value}` });
    }
    const base = out.length ? out.pop() : dir;
    const members = selection.all || selection.names.length ? await workspaces(base) : [];
    if (selection.all) {
      if (members.length) out.push(...members.map((member) => member.directory));
      else unresolved.push({ manifestPath: manifestPath(base), selector: 'workspace:*' });
    }
    for (const value of selection.names) {
      // A path (`packages/a`, `./packages/a`, pnpm `{packages/a}`) or a name (`a`, `@scope/*`); `...` and `^` are pnpm's graph markers.
      const name = value.replace(/^\{(.*)\}$/u, '$1').replace(/^\.\.\.\^?|\.\.\.$/gu, '').replace(/^\^/u, '');
      const asPath = repositoryRelative(base, name);
      const byPath = asPath ? members.filter((member) => member.directory === asPath || member.directory.startsWith(`${asPath}/`)) : [];
      const matcher = name.includes('*') ? segmentMatcher(name.replaceAll('/', '\u0000')) : null;
      const byName = members.filter((member) => member.name && (matcher ? matcher.test(member.name.replaceAll('/', '\u0000')) : member.name === name));
      const direct = !byPath.length && !byName.length && asPath && (await packageAt(asPath)).manifest ? [{ directory: asPath }] : [];
      const matched = [...byPath, ...byName, ...direct];
      if (matched.length) out.push(...matched.map((member) => member.directory));
      else unresolved.push({ manifestPath: manifestPath(base), selector: `workspace:${value}` });
    }
    // No selection runs in `base` (the step's directory, or the one --prefix/--dir/--cwd names); pnpm -w adds the root.
    if (selection.root) out.push(dir);
    if (!selection.all && !selection.names.length) out.push(base);
    return [...new Set(out)];
  };
  const visit = async (dir, name, depth) => {
    const entry = await packageAt(dir);
    const scripts = entry.manifest?.scripts && typeof entry.manifest.scripts === 'object' ? entry.manifest.scripts : {};
    for (const candidate of [`pre${name}`, name, `post${name}`]) {
      const key = `${dir}\u0000${candidate}`;
      if (seen.has(key) || visited >= MAX_SCRIPTS) continue;
      seen.add(key);
      if (typeof scripts[candidate] !== 'string') {
        if (candidate === name) entry.missing.push(name);
        continue;
      }
      visited += 1;
      entry.scripts.push({ name: candidate, text: scripts[candidate] });
      if (depth < MAX_DEPTH) for (const segment of shellSegments(scripts[candidate])) await step(segment, dir, depth + 1, scripts);
    }
  };
  const step = async (segment, dir, depth, scripts = null) => {
    const tokens = commandTokens(segment);
    if (!tokens.length) return;
    if (['run-s', 'run-p', 'npm-run-all'].includes(launcherName(tokens[0]))) {
      const own = scripts ?? (await packageAt(dir)).manifest?.scripts ?? {};
      for (const name of runAllReferences(tokens, own)) await visit(dir, name, depth);
      return;
    }
    const invocation = packageInvocation(tokens);
    if (invocation) {
      const targets = await selected(invocation, dir);
      // `yarn jest` with no `jest` script runs the binary: a runner step, not a missing script.
      const scripted = [];
      for (const target of targets) {
        const own = (await packageAt(target)).manifest?.scripts;
        if (!invocation.bare || typeof own?.[invocation.script] === 'string') scripted.push(target);
      }
      for (const target of scripted) await visit(target, invocation.script, depth);
      if (invocation.bare && !scripted.length) for (const target of targets) await runner(invocation.bare, target, depth);
      return;
    }
    const unwrapped = unwrapRunner(tokens);
    if (unwrapped.length && packageInvocation(unwrapped)) return step(unwrapped, dir, depth, scripts);
    if (unwrapped.length) await runner(unwrapped, dir, depth);
  };
  const runner = async (tokens, dir, depth) => {
    runs.push({ directory: dir, tokens });
    files.push(...namedFiles(tokens, dir, { command: depth === 0 }));
  };
  await step(argv.map(String), directory, 0);
  const unique = (values, key) => [...new Map(values.map((value) => [key(value), value])).values()];
  return {
    packages: [...packages.values()].filter((entry) => entry.scripts.length || entry.missing.length),
    runs, files: unique(files, (file) => file.path), unresolved: unique(unresolved, (entry) => `${entry.manifestPath}\u0000${entry.selector}`)
  };
}

/**
 * The `node --test` runs a command reaches from `cwd`, as their tokens, and the outer script's text for
 * a chain this cannot follow. The reporter counted only the outer script's flags, so `test → npm run
 * unit → node --test --test-reporter=tap` got a second reporter and no destination, and Node exited
 * before any test ran.
 */
export async function nodeTestRunsAt(argv, cwd) {
  if (!SCRIPT_RUNNERS.has(launcherName(argv[0])) && !nodeTestRun(argv)) return { runs: [], outer: argv.slice(1) };
  const read = async (relative) => {
    const file = path.join(cwd, relative);
    try {
      if ((await stat(file)).size > 1024 * 1024) throw new Error('Node test manifest exceeds the reporter inspection bound.');
      return await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    }
  };
  const list = async (relative) => {
    try { return (await readdir(path.join(cwd, relative), { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })); }
    catch { return []; }
  };
  const resolved = await resolveTestCommand(argv, { directory: '.', read, list });
  const outer = resolved.packages[0]?.scripts.find((script) => !/^(?:pre|post)/u.test(script.name))?.text;
  return { runs: resolved.runs.filter((run) => nodeTestRun(run.tokens)).map((run) => run.tokens), outer: outer ? [outer] : argv.slice(1) };
}
