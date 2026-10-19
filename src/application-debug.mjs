/**
 * How `app start --debug` adds a debugger to a declared start entry [RUN amendment §2].
 *
 * The listener always binds 127.0.0.1. The launcher is read from the resolved argv (argv plus the
 * environment's arguments) and the runtime's own injection is applied, unless the entry gives an
 * explicit debug.argv, debug.arguments or debug.environment, which replace it:
 *
 * - java: `java …` gains the JDWP agent after `java`; Maven `spring-boot:run` gets it merged into
 *   `-Dspring-boot.run.jvmArguments`; Gradle `bootRun`/`run` gets a private init script that adds it to
 *   that JavaExec task only (JAVA_TOOL_OPTIONS would reach the Gradle client and daemon JVMs first).
 * - python: `-m debugpy --listen 127.0.0.1:PORT` before the script or `-m module`; known console
 *   scripts (uvicorn, flask, …) run as their module; Django's runserver gets `--noreload`.
 * - node: `node …` gains `--inspect=127.0.0.1:PORT`; npm, npx and pnpm get it through npm's own
 *   `node-options` setting, which reaches the scripts and not the package manager's own Node
 *   (NODE_OPTIONS would give the debugger to npm). yarn is refused: it runs on Node itself.
 * - go: `go run PKG ARGS` becomes `dlv debug PKG --headless --listen=127.0.0.1:PORT …  -- ARGS`.
 * - dotnet: nothing is added; the person attaches to the pid `app status` reports.
 *
 * Everything here is a pure transform of argv and environment except the tool checks, which look
 * for dlv on PATH and ask the interpreter whether it can import debugpy, through the process launcher
 * the caller passes (application-run.mjs holds the one reviewed launch site).
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { debuggerListeners } from './capabilities.mjs';
import { resolvePlatformProcess } from './platform-process.mjs';
import { SingularityFlowError } from './util.mjs';

export const DEBUG_HOST = '127.0.0.1';
const PYTHON_INTERPRETER = /^(?:python(?:[23](?:\.\d+)?)?|pypy3?)$/u;
const PYTHON_WRAPPERS = Object.freeze(['poetry', 'pipenv', 'pdm', 'uv', 'hatch']);
/** Console scripts whose module runs the same application under `python -m`. */
const PYTHON_CONSOLE_MODULES = Object.freeze({
  uvicorn: 'uvicorn', flask: 'flask', fastapi: 'fastapi', hypercorn: 'hypercorn', 'django-admin': 'django', streamlit: 'streamlit'
});
const PYTHON_OPTIONS_WITH_VALUE = new Set(['-X', '-W', '--check-hash-based-pycs']);
const GO_FLAGS_WITH_VALUE = new Set(['-tags', '-ldflags', '-gcflags', '-asmflags', '-gccgoflags', '-mod', '-modfile', '-o', '-p', '-pkgdir',
  '-overlay', '-pgo', '-toolexec', '-buildmode', '-compiler', '-installsuffix', '-coverpkg', '-covermode', '-C', '-buildvcs']);

function refusal(code, message, details = {}) {
  return new SingularityFlowError(message, { code, details });
}

export function launcherName(command) {
  return String(command).split(/[\\/]/u).pop().replace(/\.(?:exe|cmd|bat|ps1)$/iu, '').toLowerCase();
}

function unsupported(runtime, argv, why) {
  return refusal('APP_DEBUG_LAUNCHER_UNSUPPORTED',
    `app start --debug cannot add a ${runtime} debugger to '${argv.slice(0, 3).join(' ')}': ${why}`
    + ' Give the entry an explicit debug.argv (or debug.arguments) that starts the debugger on 127.0.0.1. Nothing ran.',
    { runtime, launcher: launcherName(argv[0]) });
}

/** The private files a debug start may need, beside the run record. */
export function appDebugPaths(recordPath) {
  const directory = path.dirname(recordPath);
  const id = path.basename(recordPath, '.json');
  return { directory, gradleInitScript: path.join(directory, `${id}.debug.init.gradle`), goBinary: path.join(directory, `${id}.debug-bin`) };
}

function jdwpAgent(port, suspend) {
  return `-agentlib:jdwp=transport=dt_socket,server=y,suspend=${suspend ? 'y' : 'n'},address=${DEBUG_HOST}:${port}`;
}

export function gradleDebugInitScript(tasks, agent) {
  return [
    '// Written by singularity-flow app start --debug for one run and kept below the Git common directory.',
    '// It adds a loopback-only debugger to the JavaExec task(s) the start entry runs, and to nothing else.',
    'gradle.allprojects { project ->',
    `  project.tasks.withType(JavaExec).matching { it.name in [${tasks.map((task) => `'${task}'`).join(', ')}] }.configureEach { task ->`,
    `    task.jvmArgs('${agent}')`,
    '  }',
    '}',
    ''
  ].join('\n');
}

function javaLaunch(argv, { port, suspend, paths }) {
  const agent = jdwpAgent(port, suspend);
  const name = launcherName(argv[0]);
  if (name === 'java' || name === 'javaw') {
    return { launcher: 'java', argv: [argv[0], agent, ...argv.slice(1)] };
  }
  if (['mvn', 'mvnw', 'mvnd'].includes(name)) {
    if (!argv.some((token) => /^(?:[\w.-]+:)?spring-boot(?:-maven-plugin)?(?::[\w.-]+)?:run$/u.test(token))) {
      throw unsupported('java', argv, 'Maven runs the application in its own JVM except through spring-boot:run.');
    }
    const property = '-Dspring-boot.run.jvmArguments=';
    const at = argv.findLastIndex((token) => token.startsWith(property));
    if (at === -1) return { launcher: 'maven-spring-boot', argv: [...argv, `${property}${agent}`] };
    const existing = argv[at].slice(property.length).trim();
    return { launcher: 'maven-spring-boot', argv: argv.map((token, index) => (index === at ? `${property}${existing ? `${existing} ` : ''}${agent}` : token)) };
  }
  if (['gradle', 'gradlew'].includes(name)) {
    const tasks = [...new Set(argv.slice(1).filter((token) => !token.startsWith('-')).map((token) => token.split(':').pop())
      .filter((task) => task === 'bootRun' || task === 'run'))];
    if (!tasks.length) throw unsupported('java', argv, 'Gradle starts the application only through bootRun or the application plugin\'s run task.');
    if (!paths?.gradleInitScript) throw unsupported('java', argv, 'no private directory for the Gradle init script.');
    return {
      launcher: 'gradle-java-exec', argv: [argv[0], '--init-script', paths.gradleInitScript, ...argv.slice(1)],
      files: [{ path: paths.gradleInitScript, content: gradleDebugInitScript(tasks, agent) }]
    };
  }
  throw unsupported('java', argv, 'the launcher is not java, Maven spring-boot:run or Gradle bootRun.');
}

function pythonLaunch(argv, { port, platform }) {
  const listen = ['-m', 'debugpy', '--listen', `${DEBUG_HOST}:${port}`];
  let prefix = [];
  let rest = argv;
  if (PYTHON_WRAPPERS.includes(launcherName(argv[0])) && argv[1] === 'run' && argv.length > 2) {
    prefix = argv.slice(0, 2);
    rest = argv.slice(2);
  }
  const name = launcherName(rest[0]);
  const notes = [];
  const noReload = (tail, at) => {
    const runserver = tail.indexOf('runserver', at);
    if (runserver === -1 || tail.includes('--noreload')) return tail;
    notes.push('Django runserver gets --noreload under the debugger, so the code you attach to is the code that serves.');
    return [...tail.slice(0, runserver + 1), '--noreload', ...tail.slice(runserver + 1)];
  };
  if (PYTHON_INTERPRETER.test(name)) {
    let index = 1;
    while (index < rest.length) {
      const token = rest[index];
      if (token === '-m' || token === '-c' || token === '-' || !token.startsWith('-')) break;
      index += PYTHON_OPTIONS_WITH_VALUE.has(token) ? 2 : 1;
    }
    if (index >= rest.length) throw unsupported('python', argv, 'it runs no script or module.');
    let tail = rest.slice(index);
    if (/(?:^|[\\/])manage\.py$/u.test(tail[0])) tail = noReload(tail, 1);
    return {
      launcher: prefix.length ? `${launcherName(prefix[0])}-python` : 'python', notes,
      argv: [...prefix, rest[0], ...rest.slice(1, index), ...listen, ...tail],
      requires: { debugpy: [...prefix, rest[0]] }
    };
  }
  const module = PYTHON_CONSOLE_MODULES[name];
  if (!module) throw unsupported('python', argv, 'the launcher is not a Python interpreter or a known console script (uvicorn, flask, fastapi, hypercorn, django-admin, streamlit).');
  const separator = rest[0].includes('/') ? '/' : rest[0].includes('\\') ? '\\' : null;
  const interpreter = separator
    ? `${rest[0].slice(0, rest[0].lastIndexOf(separator) + 1)}${platform === 'win32' ? 'python.exe' : 'python'}`
    : prefix.length ? 'python' : platform === 'win32' ? 'python' : 'python3';
  notes.push(`${rest[0]} runs as ${interpreter} -m ${module} under the debugger.`);
  let tail = rest.slice(1);
  if (module === 'django') tail = noReload(tail, 0);
  return {
    launcher: `python-${module}`, notes,
    argv: [...prefix, interpreter, ...listen, '-m', module, ...tail],
    requires: { debugpy: [...prefix, interpreter] }
  };
}

function nodeLaunch(argv, { port, suspend, environment }) {
  const flag = `--inspect${suspend ? '-brk' : ''}=${DEBUG_HOST}:${port}`;
  const name = launcherName(argv[0]);
  if (name === 'node' || name === 'nodejs') return { launcher: 'node', argv: [argv[0], flag, ...argv.slice(1)] };
  if (['npm', 'npx', 'pnpm'].includes(name)) {
    // npm's node-options becomes NODE_OPTIONS for the scripts it runs, never for npm's own Node.
    const existing = String(environment?.npm_config_node_options ?? environment?.NODE_OPTIONS ?? '').trim();
    return {
      launcher: `${name}-script`, argv: [...argv],
      environment: { npm_config_node_options: existing ? `${existing} ${flag}` : flag },
      notes: [`${name} passes ${flag} to the Node process its script starts, through its node-options setting.`]
    };
  }
  if (name === 'yarn') {
    throw unsupported('node', argv, 'yarn runs on Node itself, so NODE_OPTIONS would give the debugger to yarn rather than the application.');
  }
  throw unsupported('node', argv, 'the launcher is not node, npm, npx or pnpm.');
}

function goLaunch(argv, { port, paths }) {
  if (launcherName(argv[0]) !== 'go' || argv[1] !== 'run') throw unsupported('go', argv, 'only go run can be rebuilt under Delve.');
  const flags = [];
  let index = 2;
  while (index < argv.length && argv[index].startsWith('-')) {
    const token = argv[index];
    if (token === '--') { index += 1; break; }
    if (token === '-exec' || token.startsWith('-exec=')) throw unsupported('go', argv, 'go run -exec cannot run under Delve.');
    if (GO_FLAGS_WITH_VALUE.has(token)) { flags.push(token, argv[index + 1] ?? ''); index += 2; } else { flags.push(token); index += 1; }
  }
  if (index >= argv.length) throw unsupported('go', argv, 'it names no package.');
  let target = argv[index];
  index += 1;
  if (target.endsWith('.go') && index < argv.length && argv[index].endsWith('.go')) {
    throw unsupported('go', argv, 'it runs several files; name their package directory instead.');
  }
  if (flags.some((flag) => /[\s'"]/u.test(flag))) throw unsupported('go', argv, 'a build flag contains spaces or quotes.');
  const dlv = ['dlv', 'debug', target, '--headless', `--listen=${DEBUG_HOST}:${port}`, '--api-version=2', '--accept-multiclient', '--continue'];
  if (flags.length) dlv.push(`--build-flags=${flags.join(' ')}`);
  // Delve's own default writes __debug_bin into the working directory, which is the worktree.
  if (paths?.goBinary) dlv.push(`--output=${paths.goBinary}`);
  const programArguments = argv.slice(index);
  return { launcher: 'go-run', argv: programArguments.length ? [...dlv, '--', ...programArguments] : dlv, requires: { dlv: true } };
}

/**
 * The debug start of one entry in one environment: the argv and the variables added for the
 * application process only, the loopback address it listens on, and any private file it needs.
 */
export function resolveDebugLaunch(entry, { argv, environmentArguments = [], environment = {}, paths = null, platform = process.platform } = {}) {
  const debug = entry.debug;
  if (!debug) {
    throw refusal('APP_DEBUG_NOT_DECLARED',
      `Start entry '${entry.id}' declares no debug block, so app start --debug does not know its runtime. Add debug: { runtime: java|python|node|go|dotnet } to it through a capability proposal. Nothing ran.`,
      { startId: entry.id });
  }
  const { runtime, port, suspend } = debug;
  const address = port == null ? null : `${DEBUG_HOST}:${port}`;
  const base = { runtime, port, suspend, address, environment: {}, files: [], notes: [], requires: {} };
  if (debug.argv || debug.arguments || debug.environment) {
    const explicit = debug.argv ? [...debug.argv, ...environmentArguments] : [...argv, ...(debug.arguments ?? [])];
    const variables = Object.fromEntries(Object.entries(debug.environment ?? {})
      .map(([name, value]) => [name, String(environment?.[name] ?? '').trim() ? `${String(environment[name]).trim()} ${value}` : value]));
    return finish({ ...base, launcher: 'explicit', argv: explicit, environment: variables });
  }
  const existing = debuggerListeners(argv).listeners;
  if (existing.length) {
    throw refusal('APP_DEBUG_ALREADY_CONFIGURED',
      `Start entry '${entry.id}' already starts a debugger (${existing[0].token}); remove it from argv or give the entry an explicit debug.argv. Nothing ran.`,
      { startId: entry.id, listener: existing[0].token });
  }
  if (runtime === 'dotnet') {
    return finish({ ...base, launcher: 'dotnet', argv: [...argv],
      notes: ['dotnet has no debugger listener: attach a .NET debugger to the process id app status reports.'] });
  }
  const launch = runtime === 'java' ? javaLaunch(argv, { port, suspend, paths })
    : runtime === 'python' ? pythonLaunch(argv, { port, platform })
      : runtime === 'node' ? nodeLaunch(argv, { port, suspend, environment })
        : goLaunch(argv, { port, paths });
  return finish({ ...base, ...launch, environment: launch.environment ?? {}, files: launch.files ?? [], notes: launch.notes ?? [], requires: launch.requires ?? {} });

  function finish(result) {
    // Defense in depth: whatever the launcher produced must still listen on loopback only.
    const { refusals } = debuggerListeners([...result.argv, ...Object.values(result.environment)]);
    if (refusals.length) {
      throw refusal('APP_DEBUG_NOT_LOOPBACK', `Start entry '${entry.id}' debug start refused: ${refusals[0]} Nothing ran.`, { startId: entry.id, refusals });
    }
    return Object.freeze({ ...result, environmentNames: Object.keys(result.environment).sort() });
  }
}

/** The executable `name` would run from this PATH, or null. Nothing is spawned. */
export function executableOnPath(name, environment = process.env, { platform = process.platform, cwd = process.cwd() } = {}) {
  const usable = (candidate) => {
    try { accessSync(candidate, fsConstants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
  };
  if (/[\\/]/u.test(name)) return usable(path.resolve(cwd, name)) ? path.resolve(cwd, name) : null;
  const directories = String(environment.PATH ?? environment.Path ?? '').split(path.delimiter).filter((entry) => path.isAbsolute(entry));
  const extensions = platform === 'win32' ? String(environment.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Refuse a debug start whose debugger is not installed, naming the command the person runs. Delve is
 * looked up on PATH; debugpy is asked of the interpreter that will run the application.
 */
export function assertDebugToolsAvailable(launch, { cwd, environment = process.env, platform = process.platform, spawnSyncCommand } = {}) {
  if (launch.requires?.dlv && !executableOnPath('dlv', environment, { platform, cwd })) {
    throw refusal('APP_DEBUG_DLV_MISSING',
      'app start --debug runs go programs under Delve, and dlv is not on PATH. Install Delve yourself'
      + ' (brew install delve, or go install of the go-delve/delve module\'s cmd/dlv at @latest), then run app start --debug again. Nothing ran.',
      { tool: 'dlv', install: ['brew install delve', 'go install …/go-delve/delve/cmd/dlv@latest'] });
  }
  const interpreter = launch.requires?.debugpy;
  if (interpreter) {
    const command = resolvePlatformProcess(interpreter[0], [...interpreter.slice(1), '-c', 'import debugpy'], { platform, environment, cwd });
    const result = spawnSyncCommand(command.executable, command.arguments, {
      cwd, env: environment, ...command.spawnOptions, stdio: 'ignore', timeout: 20_000, windowsHide: true
    });
    if (result.status !== 0) {
      const missingInterpreter = result.error?.code === 'ENOENT';
      throw refusal('APP_DEBUG_DEBUGPY_MISSING',
        missingInterpreter
          ? `app start --debug could not run ${interpreter.join(' ')} to check for debugpy. Name the project's interpreter in argv, then run app start --debug again. Nothing ran.`
          : `debugpy is not installed for ${interpreter.join(' ')}. Install it yourself with pip install debugpy`
            + ` (for this interpreter: ${interpreter.join(' ')} -m pip install debugpy), then run app start --debug again. Nothing ran.`,
        { tool: 'debugpy', interpreter: [...interpreter], reason: missingInterpreter ? 'interpreter-missing' : 'module-missing', install: 'pip install debugpy' });
    }
  }
}

/** Whether something accepts TCP connections on the loopback debug port. */
export function debugPortAccepts(port, { timeoutMs = 750 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: DEBUG_HOST, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The JVM's own line when its debugger starts listening; probing a JDWP port would log a failed handshake. */
export function jdwpListeningLine(text, port) {
  return new RegExp(`Listening for transport dt_socket at address: (?:\\S*:)?${port}\\b`, 'u').test(text);
}
