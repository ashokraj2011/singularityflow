/**
 * The toolchain a test run ran with [TCE:REQ-033]: the versions of its runner family (Node and
 * package manager, JDK and Maven or Gradle, Python and pytest, Go, .NET, Playwright).
 *
 * Probes are cheap and asked once per process: a version is read from a file beside the executable
 * the run's PATH finds (a package.json, a JDK's `release`, Go's `VERSION`, a wrapper's properties,
 * Maven's or Gradle's own jars) or, when there is none, from one bounded `--version` call; Gradle
 * is never started, since that starts its daemon. The probes run beside the test run, in its
 * working folder and with its environment, so a version manager picks what the run picked. A
 * version that cannot be read is null; a probe never fails or delays a run past its own deadline.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { runQualityCommand } from './quality-command-runner.mjs';

const PROBE_TIMEOUT_MS = 5_000;
const probes = new Map();
const NODE_RUNNERS = /^(?:node|npm|npx|pnpm|pnpx|yarn|corepack|jest|vitest|mocha|playwright|cypress|ng|react-scripts|karma|tsx|ts-node)$/u;
const NODE_ADAPTERS = new Set(['node-tap', 'jest-json', 'vitest-json', 'playwright-json', 'karma-text']);
const PACKAGE_MANAGERS = { npm: 'npm', npx: 'npm', pnpm: 'pnpm', pnpx: 'pnpm', yarn: 'yarn' };

const baseName = value => path.basename(String(value ?? '')).toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/u, '');
const valueOf = (environment, name) => environment[Object.keys(environment).find(key => key.toUpperCase() === name) ?? name];

/** The runner family of a test command, from its executable and result adapter; null when unknown. */
export function runnerFamily(command) {
  const executable = baseName(command?.argv?.[0]);
  const adapter = command?.result?.adapter;
  if (/^mvnw?$/u.test(executable)) return 'maven';
  if (/^gradlew?$/u.test(executable)) return 'gradle';
  if (/^(?:python[\d.]*|py|pytest|tox|nox|uv|poetry|pipenv|hatch)$/u.test(executable)) return 'python';
  if (executable === 'go' || adapter === 'go-test-json') return 'go';
  if (executable === 'dotnet' || adapter === 'dotnet-trx') return 'dotnet';
  if (NODE_RUNNERS.test(executable) || NODE_ADAPTERS.has(adapter)) return 'node';
  if (executable === 'java') return 'java';
  return null;
}

function once(key, probe) {
  const id = JSON.stringify(key);
  if (!probes.has(id)) probes.set(id, probe().then(value => value ?? null, () => null));
  return probes.get(id);
}

export async function onPath(name, environment, cwd) {
  if (/[\\/]/u.test(name)) return path.resolve(cwd, name);
  const extensions = process.platform === 'win32' ? ['', ...String(valueOf(environment, 'PATHEXT') ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const directory of String(valueOf(environment, 'PATH') ?? '').split(path.delimiter)) {
    for (const extension of directory ? extensions : []) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (await stat(candidate).then(entry => entry.isFile(), () => false)) return candidate;
    }
  }
  return null;
}

const real = async file => (file ? realpath(file).catch(() => null) : null);
const text = file => readFile(file, 'utf8').catch(() => null);

async function asked(executable, args, pattern, { cwd, environment }) {
  const result = await runQualityCommand(executable, args, { cwd, env: environment, timeoutMs: PROBE_TIMEOUT_MS, captureBytes: 4096 });
  return result.status === 0 ? pattern.exec(`${result.stdout}\n${result.stderr}`)?.[1] ?? null : null;
}

async function packageVersion(start, names, levels = 4) {
  for (let directory = start, level = 0; level < levels && directory; level += 1) {
    const manifest = await text(path.join(directory, 'package.json'));
    try { const parsed = JSON.parse(manifest); if (names.includes(parsed.name)) return String(parsed.version); } catch { /* not a manifest */ }
    if (path.dirname(directory) === directory) break;
    directory = path.dirname(directory);
  }
  return null;
}

export function nodeVersion(executable, context) {
  return once(['node', executable, context.cwd, valueOf(context.environment, 'PATH')], async () => {
    const found = await real(await onPath(executable, context.environment, context.cwd));
    if (found && found === await real(process.execPath)) return process.versions.node;
    return asked(executable, ['--version'], /v?(\d+\.\d+\.\d+)/u, context);
  });
}

function packageManagerVersion(name, context) {
  return once([name, context.cwd, valueOf(context.environment, 'PATH')], async () => {
    const found = await real(await onPath(name, context.environment, context.cwd));
    const names = name === 'yarn' ? ['yarn', '@yarnpkg/cli-dist'] : [name];
    return (found && await packageVersion(path.dirname(found), names))
      ?? asked(name, ['--version'], /(\d+\.\d+\.\d+\S*)/u, context);
  });
}

function playwrightVersion(context) {
  return once(['playwright', context.cwd], async () => {
    for (let directory = context.cwd, level = 0; level < 12; level += 1) {
      for (const name of ['@playwright/test', 'playwright']) {
        const version = await packageVersion(path.join(directory, 'node_modules', name), [name], 1);
        if (version) return version;
      }
      if (path.dirname(directory) === directory) break;
      directory = path.dirname(directory);
    }
    return null;
  });
}

function javaVersion(context) {
  const home = valueOf(context.environment, 'JAVA_HOME');
  return once(['java', home, context.cwd, valueOf(context.environment, 'PATH')], async () => {
    const fromRelease = async directory => /JAVA_VERSION="([^"]+)"/u.exec(await text(path.join(directory, 'release')) ?? '')?.[1] ?? null;
    const declared = home ? await fromRelease(home) : null;
    if (declared) return declared;
    const found = await real(await onPath('java', context.environment, context.cwd));
    return (found && await fromRelease(path.dirname(path.dirname(found))))
      ?? asked(found ?? 'java', ['-version'], /version "([^"]+)"/u, context);
  });
}

// A wrapper names its distribution; an installed tool is named by its own jars.
async function wrapperVersion(executable, context, properties, pattern) {
  const folder = path.dirname(path.resolve(context.cwd, executable));
  return pattern.exec(await text(path.join(folder, ...properties)) ?? '')?.[1] ?? null;
}

async function installedJarVersion(name, context, pattern) {
  const found = await real(await onPath(name, context.environment, context.cwd));
  const jars = found ? await readdir(path.join(path.dirname(path.dirname(found)), 'lib')).catch(() => []) : [];
  return jars.map(jar => pattern.exec(jar)?.[1]).find(Boolean) ?? null;
}

function mavenVersion(executable, context) {
  return once(['maven', executable, context.cwd, valueOf(context.environment, 'PATH')], async () => (baseName(executable) === 'mvnw'
    ? wrapperVersion(executable, context, ['.mvn', 'wrapper', 'maven-wrapper.properties'], /apache-maven-(\d[^/]*?)-bin/u)
    : (await installedJarVersion('mvn', context, /^maven-core-(\d.*)\.jar$/u)) ?? asked('mvn', ['--version'], /Apache Maven (\S+)/u, context)));
}

function gradleVersion(executable, context) {
  return once(['gradle', executable, context.cwd, valueOf(context.environment, 'PATH')], () => (baseName(executable) === 'gradlew'
    ? wrapperVersion(executable, context, ['gradle', 'wrapper', 'gradle-wrapper.properties'], /gradle-(\d[^/]*?)-(?:bin|all)\.zip/u)
    : installedJarVersion('gradle', context, /^gradle-(?:launcher|core-api)-(\d.*)\.jar$/u)));
}

const PYTHON_PROBE = 'import sys\ntry:\n import importlib.metadata as m; v = m.version("pytest")\nexcept Exception: v = ""\nprint(sys.version.split()[0]); print(v)';

function pythonVersions(executable, context) {
  return once(['python', executable, context.cwd, valueOf(context.environment, 'PATH')], async () => {
    let interpreter = /^(?:python[\d.]*|py)$/u.test(baseName(executable)) ? executable : process.platform === 'win32' ? 'python' : 'python3';
    if (baseName(executable) === 'pytest') {
      // A pytest script names the interpreter it runs under on its first line.
      const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/u.exec(await text(await onPath(executable, context.environment, context.cwd) ?? '') ?? '');
      if (shebang) interpreter = baseName(shebang[1]) === 'env' && shebang[2] ? shebang[2] : shebang[1];
    }
    const result = await runQualityCommand(interpreter, ['-c', PYTHON_PROBE], {
      cwd: context.cwd, env: context.environment, timeoutMs: PROBE_TIMEOUT_MS, captureBytes: 4096 });
    const [python, pytest] = result.status === 0 ? result.stdout.split(/\r?\n/u) : [];
    return { python: python || null, pytest: pytest || null };
  });
}

function goVersion(context) {
  return once(['go', context.cwd, valueOf(context.environment, 'PATH')], async () => {
    const found = await real(await onPath('go', context.environment, context.cwd));
    return (found && /^go(\S+)/u.exec(await text(path.join(path.dirname(path.dirname(found)), 'VERSION')) ?? '')?.[1])
      || asked('go', ['version'], /\bgo(\d+\.\d+\S*)/u, context);
  });
}

function dotnetVersion(context) {
  return once(['dotnet', context.cwd, valueOf(context.environment, 'PATH')], () => asked('dotnet', ['--version'], /(\d+\.\d+\.\d+\S*)/u,
    { ...context, environment: { ...context.environment, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } }));
}

/** `{ tool: version | null }` for the runner family of one test command; {} for an unknown family. */
export async function runnerToolchain(command, { cwd = process.cwd(), environment = process.env } = {}) {
  const executable = String(command?.argv?.[0] ?? '');
  const context = { cwd, environment };
  const wanted = {};
  switch (runnerFamily(command)) {
    case 'node': {
      wanted.node = nodeVersion(baseName(executable) === 'node' ? executable : 'node', context);
      const manager = PACKAGE_MANAGERS[baseName(executable)];
      if (manager) wanted[manager] = packageManagerVersion(manager, context);
      if (command.result?.adapter === 'playwright-json' || (command.argv ?? []).some(argument => /playwright/u.test(argument))) {
        wanted.playwright = playwrightVersion(context);
      }
      break;
    }
    case 'maven': Object.assign(wanted, { java: javaVersion(context), maven: mavenVersion(executable, context) }); break;
    case 'gradle': Object.assign(wanted, { java: javaVersion(context), gradle: gradleVersion(executable, context) }); break;
    case 'java': wanted.java = javaVersion(context); break;
    case 'python': {
      const versions = await pythonVersions(executable, context);
      return { pytest: versions?.pytest ?? null, python: versions?.python ?? null };
    }
    case 'go': wanted.go = goVersion(context); break;
    case 'dotnet': wanted.dotnet = dotnetVersion(context); break;
    default: return {};
  }
  const entries = await Promise.all(Object.entries(wanted).map(async ([tool, version]) => [tool, await version]));
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}
