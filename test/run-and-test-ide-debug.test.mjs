import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  assertDebugToolsAvailable, debugPortAccepts, executableOnPath, gradleDebugInitScript, jdwpListeningLine, resolveDebugLaunch
} from '../src/application-debug.mjs';
import { normalizeCapabilityApplication, validateCapabilities } from '../src/capabilities.mjs';

const CLI = path.resolve('bin/singularity-flow.mjs');
const PATHS = { gradleInitScript: '/private/app/web.debug.init.gradle', goBinary: '/private/app/web.debug-bin' };
const entry = (argv, debug, extra = {}) => normalizeCapabilityApplication('web', {
  kind: 'delivery', repository: 'web',
  application: { start: [{ id: 'web', argv, url: 'http://127.0.0.1:8080/', ready: { http: '/' }, debug, ...extra }] }
}).start[0];
const launch = (argv, debug, options = {}) => {
  const declared = entry(argv, debug, options.extra);
  return resolveDebugLaunch(declared, { argv: declared.argv, paths: PATHS, environment: options.environment ?? {}, platform: options.platform ?? 'darwin' });
};
const refusedLaunch = (argv, debug, code, pattern, options) => assert.throws(() => launch(argv, debug, options),
  (error) => error.code === code && pattern.test(error.message), `${argv.join(' ')} → ${code}`);
const JDWP = (port, suspend = 'n') => `-agentlib:jdwp=transport=dt_socket,server=y,suspend=${suspend},address=127.0.0.1:${port}`;

test('java: the JDWP agent goes after java, into Maven\'s jvmArguments, or into a Gradle init script for the JavaExec task', () => {
  const table = [
    [['java', '-jar', 'target/app.jar'], { runtime: 'java' }, ['java', JDWP(5005), '-jar', 'target/app.jar'], 'java'],
    [['java', '-cp', 'build/classes', 'com.example.Main', '--port', '8080'], { runtime: 'java', port: 5006, suspend: true },
      ['java', JDWP(5006, 'y'), '-cp', 'build/classes', 'com.example.Main', '--port', '8080'], 'java'],
    [['./mvnw', '-q', 'spring-boot:run'], { runtime: 'java' }, ['./mvnw', '-q', 'spring-boot:run', `-Dspring-boot.run.jvmArguments=${JDWP(5005)}`], 'maven-spring-boot'],
    [['mvn', 'spring-boot:run', '-Dspring-boot.run.jvmArguments=-Xmx2g -Dfoo=bar', '-Dspring-boot.run.profiles=dev'], { runtime: 'java' },
      ['mvn', 'spring-boot:run', `-Dspring-boot.run.jvmArguments=-Xmx2g -Dfoo=bar ${JDWP(5005)}`, '-Dspring-boot.run.profiles=dev'], 'maven-spring-boot'],
    [['mvnw.cmd', 'org.springframework.boot:spring-boot-maven-plugin:3.3.4:run'], { runtime: 'java' },
      ['mvnw.cmd', 'org.springframework.boot:spring-boot-maven-plugin:3.3.4:run', `-Dspring-boot.run.jvmArguments=${JDWP(5005)}`], 'maven-spring-boot'],
    [['./gradlew', ':api:bootRun', '--args=--server.port=8080'], { runtime: 'java' },
      ['./gradlew', '--init-script', PATHS.gradleInitScript, ':api:bootRun', '--args=--server.port=8080'], 'gradle-java-exec'],
    [['gradle', 'run'], { runtime: 'java' }, ['gradle', '--init-script', PATHS.gradleInitScript, 'run'], 'gradle-java-exec']
  ];
  for (const [argv, debug, expected, launcher] of table) {
    const result = launch(argv, debug);
    assert.deepEqual(result.argv, expected, argv.join(' '));
    assert.equal(result.launcher, launcher);
    assert.deepEqual(result.environment, {}, 'nothing reaches JAVA_TOOL_OPTIONS, which every Gradle and Maven JVM would read');
    assert.equal(result.address, `127.0.0.1:${debug.port ?? 5005}`);
  }
  // Maven: the last jvmArguments wins, so that is the one the agent joins.
  const twice = launch(['mvn', 'spring-boot:run', '-Dspring-boot.run.jvmArguments=-Xmx1g', '-Dspring-boot.run.jvmArguments=-Xmx2g'], { runtime: 'java' });
  assert.deepEqual(twice.argv.slice(2), ['-Dspring-boot.run.jvmArguments=-Xmx1g', `-Dspring-boot.run.jvmArguments=-Xmx2g ${JDWP(5005)}`]);
  const gradle = launch(['./gradlew', 'bootRun'], { runtime: 'java', suspend: true });
  assert.deepEqual(gradle.files, [{ path: PATHS.gradleInitScript, content: gradleDebugInitScript(['bootRun'], JDWP(5005, 'y')) }]);
  assert.match(gradle.files[0].content, /withType\(JavaExec\)\.matching \{ it\.name in \['bootRun'\] \}/u);
  assert.match(gradle.files[0].content, /task\.jvmArgs\('-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127\.0\.0\.1:5005'\)/u);
  refusedLaunch(['./mvnw', 'exec:java'], { runtime: 'java' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /Maven runs the application in its own JVM except through spring-boot:run/u);
  refusedLaunch(['./gradlew', 'build'], { runtime: 'java' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /bootRun or the application plugin's run task/u);
  refusedLaunch(['./start.sh'], { runtime: 'java' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /debug\.argv/u);
});

test('python: debugpy listens on loopback before the script or module; console scripts run as their module', () => {
  const listen = ['-m', 'debugpy', '--listen', '127.0.0.1:5678'];
  const table = [
    [['python3', 'app.py', '--port', '8000'], ['python3', ...listen, 'app.py', '--port', '8000'], ['python3']],
    [['.venv/bin/python', '-u', '-X', 'dev', '-m', 'uvicorn', 'app.main:app', '--port', '8000'],
      ['.venv/bin/python', '-u', '-X', 'dev', ...listen, '-m', 'uvicorn', 'app.main:app', '--port', '8000'], ['.venv/bin/python']],
    [['python', 'manage.py', 'runserver', '127.0.0.1:8000'], ['python', ...listen, 'manage.py', 'runserver', '--noreload', '127.0.0.1:8000'], ['python']],
    [['python3', 'manage.py', 'runserver', '--noreload'], ['python3', ...listen, 'manage.py', 'runserver', '--noreload'], ['python3']],
    [['uvicorn', 'app.main:app', '--reload'], ['python3', ...listen, '-m', 'uvicorn', 'app.main:app', '--reload'], ['python3']],
    [['.venv/bin/uvicorn', 'app.main:app'], ['.venv/bin/python', ...listen, '-m', 'uvicorn', 'app.main:app'], ['.venv/bin/python']],
    [['poetry', 'run', 'uvicorn', 'app:app'], ['poetry', 'run', 'python', ...listen, '-m', 'uvicorn', 'app:app'], ['poetry', 'run', 'python']],
    [['uv', 'run', 'python', '-m', 'flask', 'run'], ['uv', 'run', 'python', ...listen, '-m', 'flask', 'run'], ['uv', 'run', 'python']],
    [['django-admin', 'runserver'], ['python3', ...listen, '-m', 'django', 'runserver', '--noreload'], ['python3']]
  ];
  for (const [argv, expected, interpreter] of table) {
    const result = launch(argv, { runtime: 'python' });
    assert.deepEqual(result.argv, expected, argv.join(' '));
    assert.deepEqual(result.requires.debugpy, interpreter, 'debugpy is checked in the interpreter that runs the application');
  }
  assert.deepEqual(launch(['uvicorn', 'app:app'], { runtime: 'python' }, { platform: 'win32' }).argv.slice(0, 1), ['python']);
  refusedLaunch(['gunicorn', 'app:app'], { runtime: 'python' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /known console script/u);
  refusedLaunch(['python3', '-u'], { runtime: 'python' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /runs no script or module/u);
});

test('node: --inspect after node; npm, npx and pnpm through npm\'s own node-options; yarn refused', () => {
  assert.deepEqual(launch(['node', '--enable-source-maps', 'server.js'], { runtime: 'node' }).argv,
    ['node', '--inspect=127.0.0.1:9229', '--enable-source-maps', 'server.js']);
  assert.deepEqual(launch(['node', 'server.js'], { runtime: 'node', port: 9333, suspend: true }).argv, ['node', '--inspect-brk=127.0.0.1:9333', 'server.js']);
  for (const manager of ['npm', 'npx', 'pnpm']) {
    const result = launch([manager, 'run', 'dev'], { runtime: 'node' });
    assert.deepEqual(result.argv, [manager, 'run', 'dev']);
    assert.deepEqual(result.environment, { npm_config_node_options: '--inspect=127.0.0.1:9229' });
    assert.deepEqual(result.environmentNames, ['npm_config_node_options']);
  }
  // Options the application already had are kept beside the debugger flag.
  assert.deepEqual(launch(['npm', 'start'], { runtime: 'node' }, { environment: { NODE_OPTIONS: '--max-old-space-size=4096' } }).environment,
    { npm_config_node_options: '--max-old-space-size=4096 --inspect=127.0.0.1:9229' });
  refusedLaunch(['yarn', 'dev'], { runtime: 'node' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /yarn runs on Node itself/u);
  refusedLaunch(['bun', 'run', 'dev'], { runtime: 'node' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /not node, npm, npx or pnpm/u);
});

test('go: go run becomes a headless, loopback dlv debug that keeps build flags and program arguments', () => {
  const dlv = (pkg, rest = []) => ['dlv', 'debug', pkg, '--headless', '--listen=127.0.0.1:2345', '--api-version=2', '--accept-multiclient', '--continue', ...rest];
  assert.deepEqual(launch(['go', 'run', './cmd/api', '--port', '8080'], { runtime: 'go' }).argv,
    dlv('./cmd/api', [`--output=${PATHS.goBinary}`, '--', '--port', '8080']));
  assert.deepEqual(launch(['go', 'run', '-race', '-tags', 'dev', '.'], { runtime: 'go', port: 2346 }).argv,
    ['dlv', 'debug', '.', '--headless', '--listen=127.0.0.1:2346', '--api-version=2', '--accept-multiclient', '--continue',
      '--build-flags=-race -tags dev', `--output=${PATHS.goBinary}`]);
  assert.deepEqual(launch(['go', 'run', 'main.go'], { runtime: 'go' }).requires, { dlv: true });
  refusedLaunch(['go', 'run', 'main.go', 'util.go'], { runtime: 'go' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /several files/u);
  refusedLaunch(['go', 'run', '-exec', 'sudo', '.'], { runtime: 'go' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /-exec/u);
  refusedLaunch(['./bin/api'], { runtime: 'go' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /only go run/u);
  refusedLaunch(['go', 'run', '-ldflags', '-X main.v=1 -s', '.'], { runtime: 'go' }, 'APP_DEBUG_LAUNCHER_UNSUPPORTED', /spaces or quotes/u);
});

test('dotnet adds nothing; explicit debug argv, arguments and environment replace the injection', () => {
  const dotnet = launch(['dotnet', 'run', '--launch-profile', 'http'], { runtime: 'dotnet' });
  assert.deepEqual(dotnet.argv, ['dotnet', 'run', '--launch-profile', 'http']);
  assert.equal(dotnet.address, null);
  assert.match(dotnet.notes[0], /attach a \.NET debugger to the process id app status reports/u);
  const explicitArgv = launch(['./run.sh'], { runtime: 'node', argv: ['node', '--inspect=127.0.0.1:9240', 'dist/main.js'] });
  assert.deepEqual(explicitArgv.argv, ['node', '--inspect=127.0.0.1:9240', 'dist/main.js']);
  assert.equal(explicitArgv.launcher, 'explicit');
  assert.equal(explicitArgv.port, 9240);
  const appended = launch(['./mvnw', 'quarkus:dev'], { runtime: 'java', arguments: [`-Dquarkus.jvm.args=${JDWP(5007)}`] });
  assert.deepEqual(appended.argv, ['./mvnw', 'quarkus:dev', `-Dquarkus.jvm.args=${JDWP(5007)}`]);
  const environment = launch(['./run.sh'], { runtime: 'java', environment: { JDK_JAVA_OPTIONS: JDWP(5008) } },
    { environment: { JDK_JAVA_OPTIONS: '-Xmx1g' } });
  assert.deepEqual(environment.environment, { JDK_JAVA_OPTIONS: `-Xmx1g ${JDWP(5008)}` });
  // Environment arguments still follow a full replacement argv.
  const declared = entry(['./run.sh'], { runtime: 'node', argv: ['node', '--inspect', 'main.js'] }, { environments: ['qa'], arguments: { qa: ['--qa'] } });
  assert.deepEqual(resolveDebugLaunch(declared, { argv: ['./run.sh', '--qa'], environmentArguments: ['--qa'] }).argv, ['node', '--inspect', 'main.js', '--qa']);
  refusedLaunch(['node', '--inspect=127.0.0.1:9229', 'server.js'], { runtime: 'node' }, 'APP_DEBUG_ALREADY_CONFIGURED', /already starts a debugger/u);
  assert.throws(() => resolveDebugLaunch(entry(['node', 'x.js'], undefined)), (error) => error.code === 'APP_DEBUG_NOT_DECLARED'
    && /debug: \{ runtime: java\|python\|node\|go\|dotnet \}/u.test(error.message));
});

test('the debug block refuses non-loopback addresses, extra flags and contradictions before anything runs', () => {
  const map = (debug, extra = {}) => ({ version: 1, capabilities: { web: { kind: 'delivery', repository: 'web', application: { start: [{
    id: 'web', argv: ['node', 'server.js'], url: 'http://127.0.0.1:8080/', ready: { http: '/' }, debug, ...extra }] } } } });
  const refused = (debug, pattern, extra) => assert.throws(() => validateCapabilities(map(debug, extra)),
    (error) => error.code === 'CAPABILITY_APPLICATION_INVALID' && pattern.test(error.message), JSON.stringify(debug));
  refused({ runtime: 'node', argv: ['node', '--inspect=0.0.0.0:9229', 'server.js'] }, /'0\.0\.0\.0'; a debugger listens on 127\.0\.0\.1 only/u);
  refused({ runtime: 'node', argv: ['node', '--inspect=*:9229', 'server.js'] }, /'\*'/u);
  refused({ runtime: 'node', argv: ['node', '--inspect=[::]:9229', 'server.js'] }, /'\[::\]'/u);
  refused({ runtime: 'node', argv: ['node', '--inspect=dev-box.example.test:9229', 'server.js'] }, /'dev-box\.example\.test'/u);
  refused({ runtime: 'python', arguments: ['--listen', '0.0.0.0:5678'] }, /'0\.0\.0\.0'/u);
  refused({ runtime: 'go', argv: ['dlv', 'debug', '--headless', '--listen=:2345'] }, /every interface/u);
  refused({ runtime: 'java', arguments: ['-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,address=*:5005'] }, /'\*'/u);
  refused({ runtime: 'java', environment: { JAVA_TOOL_OPTIONS: '-agentlib:jdwp=transport=dt_socket,server=y,address=0.0.0.0:5005' } }, /'0\.0\.0\.0'/u);
  refused({ runtime: 'java', arguments: ['--debug-jvm'] }, /--debug-jvm binds every interface/u);
  refused({ runtime: 'node', environment: { NODE_OPTIONS: '--inspect=127.0.0.1:9229 --require ./preload.js' } }, /must be the debugger flag alone/u);
  refused({ runtime: 'node', environment: { NODE_OPTIONS: '--import ./hook.mjs' } }, /must be the debugger flag alone/u);
  refused({ runtime: 'node', environment: { NODE_OPTIONS: '--loader ./loader.mjs' } }, /must be the debugger flag alone/u);
  refused({ runtime: 'java', environment: { JAVA_TOOL_OPTIONS: '-javaagent:/tmp/agent.jar' } }, /must be the debugger flag alone/u);
  refused({ runtime: 'java', environment: { JAVA_TOOL_OPTIONS: `${JDWP(5005)} -Xmx1g` } }, /must be the debugger flag alone/u);
  refused({ runtime: 'java', environment: { NODE_OPTIONS: '--inspect' } }, /may set only JAVA_TOOL_OPTIONS or JDK_JAVA_OPTIONS for runtime java/u);
  refused({ runtime: 'python', environment: { NODE_OPTIONS: '--inspect' } }, /may set only nothing for runtime python/u);
  refused({ runtime: 'java', environment: { JAVA_TOOL_OPTIONS: JDWP(5005), JDK_JAVA_OPTIONS: JDWP(5005) } }, /exactly one/u);
  refused({ runtime: 'java', environment: { PATH: '/tmp' } }, /may set only/u);
  refused({ runtime: 'python', suspend: true }, /suspend is for java and node only/u);
  refused({ runtime: 'dotnet', port: 5000 }, /dotnet has no debugger listener/u);
  refused({ runtime: 'node', argv: ['node', 'x.js'], arguments: ['--x'] }, /argv \(a full replacement\) or arguments \(appended\), never both/u);
  refused({ runtime: 'node', argv: ['node', 'x.js'] }, /must start a loopback debugger listener/u);
  refused({ runtime: 'node', argv: ['node', '--inspect=127.0.0.1:9230', 'x.js'], port: 9229 }, /listens on port 9230 but port is 9229/u);
  refused({ runtime: 'java', port: 8080 }, /8080 is the application's own port/u);
  refused({ runtime: 'java', port: 80 }, /1024 to 65535/u);
  refused({ runtime: 'java', suspend: 'yes' }, /true or false/u);
  refused('java', /must be an object with a runtime/u);
});

test('tool checks: dlv must be on PATH and debugpy importable by the application\'s interpreter, each naming the install', async (t) => {
  const bin = await mkdtemp(path.join(tmpdir(), 'sflow-debug-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const go = launch(['go', 'run', '.'], { runtime: 'go' });
  assert.throws(() => assertDebugToolsAvailable(go, { cwd: bin, environment: { PATH: bin } }),
    (error) => error.code === 'APP_DEBUG_DLV_MISSING' && /dlv is not on PATH/u.test(error.message) && /brew install delve/u.test(error.message));
  await writeFile(path.join(bin, 'dlv'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(bin, 'dlv'), 0o755);
  assert.equal(executableOnPath('dlv', { PATH: bin }), path.join(bin, 'dlv'));
  assert.doesNotThrow(() => assertDebugToolsAvailable(go, { cwd: bin, environment: { PATH: bin } }));

  const python = launch(['.venv/bin/python', 'app.py'], { runtime: 'python' });
  const calls = [];
  const probe = (status, error = null) => (command, args, options) => { calls.push([command, args, options.cwd]); return { status, error }; };
  assert.doesNotThrow(() => assertDebugToolsAvailable(python, { cwd: bin, environment: { PATH: bin }, platform: 'linux', spawnSyncCommand: probe(0) }));
  assert.deepEqual(calls[0], ['.venv/bin/python', ['-c', 'import debugpy'], bin]);
  assert.throws(() => assertDebugToolsAvailable(python, { cwd: bin, environment: {}, platform: 'linux', spawnSyncCommand: probe(1) }),
    (error) => error.code === 'APP_DEBUG_DEBUGPY_MISSING' && /pip install debugpy/u.test(error.message)
      && /\.venv\/bin\/python -m pip install debugpy/u.test(error.message) && error.details.reason === 'module-missing');
  assert.throws(() => assertDebugToolsAvailable(python, { cwd: bin, environment: {}, platform: 'linux', spawnSyncCommand: probe(null, { code: 'ENOENT' }) }),
    (error) => error.code === 'APP_DEBUG_DEBUGPY_MISSING' && error.details.reason === 'interpreter-missing');
  assert.equal(jdwpListeningLine('Listening for transport dt_socket at address: 5005\n', 5005), true);
  assert.equal(jdwpListeningLine('Listening for transport dt_socket at address: 50051\n', 5005), false);
});

// ---------------------------------------------------------------------------------------------
// Real starts.

const SERVER = `import http from 'node:http';
import inspector from 'node:inspector';
import { writeFileSync } from 'node:fs';
const port = Number(process.argv[2]);
writeFileSync('pid.txt', String(process.pid));
writeFileSync('inspector.txt', String(inspector.url() ?? 'none'));
http.createServer((request, response) => { response.statusCode = 204; response.end(); }).listen(port, '127.0.0.1', () => console.log('server ready'));
`;

/** Stands in for python3 (and debugpy) or dlv: it opens the debug port it was told to and serves HTTP. */
const FAKE_DEBUGGER = `import http from 'node:http';
import net from 'node:net';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync('debugger-argv.json', JSON.stringify(args));
const listen = args.find((arg) => arg.startsWith('--listen='))?.slice(9) ?? args[args.indexOf('--listen') + 1];
const port = Number(args[args.lastIndexOf('--port') + 1]);
const [host, debugPort] = [listen.slice(0, listen.lastIndexOf(':')), Number(listen.slice(listen.lastIndexOf(':') + 1))];
net.createServer((socket) => socket.end()).listen(debugPort, host);
http.createServer((request, response) => { response.statusCode = 204; response.end(); }).listen(port, '127.0.0.1');
`;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const running = new Set();
after(() => { for (const child of running) { try { child.kill('SIGKILL'); } catch { /* gone */ } } });

async function repository(t, start, { files = {}, policy = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-debug-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root }).status, 0, args.join(' '));
  git('init', '-q');
  await mkdir(path.join(root, 'singularity'));
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app', 'server.mjs'), SERVER);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  await writeFile(path.join(root, 'singularity', 'capabilities.yml'), JSON.stringify({ version: 1, capabilities: { web: {
    kind: 'delivery', repository: 'web', ...(policy ? { policy } : {}), application: { start: [{ id: 'web', workingDirectory: 'app', ...start }] } } } }, null, 2));
  git('add', '-A');
  git('-c', 'user.name=Debug Tester', '-c', 'user.email=debug-tester@example.invalid', 'commit', '-qm', 'fixture');
  return root;
}

const cli = (root, args, env = process.env) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, env });

function startDebug(root, env = process.env, args = []) {
  const child = spawn(process.execPath, [CLI, 'app', 'start', '--debug', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  return {
    exited, output: () => output,
    async waitFor(pattern, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      let done = false;
      exited.then(() => { done = true; });
      while (Date.now() < deadline && !pattern.test(output) && !done) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.match(output, pattern);
    }
  };
}

async function stopped(root, started) {
  assert.equal(JSON.parse(cli(root, ['app', 'stop', '--json']).stdout).stopped, true);
  assert.equal(await started.exited, 0, started.output());
}

test('app start --debug with node: Debugger listening at the loopback port, then ready; status reports it; stop ends it', async (t) => {
  const [port, debugPort] = [await freePort(), await freePort()];
  const root = await repository(t, { argv: ['node', 'server.mjs', String(port)], url: `http://127.0.0.1:${port}/`,
    ready: { http: '/', timeoutMs: 20_000 }, debug: { runtime: 'node', port: debugPort } });
  const plan = JSON.parse(cli(root, ['app', 'plan', '--json']).stdout).entries[0];
  assert.deepEqual(plan.debug, { runtime: 'node', port: debugPort, suspend: false, address: `127.0.0.1:${debugPort}`, launcher: 'node',
    argv: ['node', `--inspect=127.0.0.1:${debugPort}`, 'server.mjs', String(port)], environmentNames: [], notes: [] });
  const before = JSON.parse(cli(root, ['app', 'status', '--json']).stdout).entries[0];
  assert.deepEqual(before.debug, { runtime: 'node', port: debugPort, listening: false });

  const started = startDebug(root);
  await started.waitFor(/Ready at/u);
  const output = started.output();
  assert.match(output, new RegExp(`Debug start: node --inspect=127\\.0\\.0\\.1:${debugPort} server\\.mjs ${port}`, 'u'));
  assert.ok(output.indexOf(`Debugger listening at 127.0.0.1:${debugPort}`) !== -1, output);
  assert.ok(output.indexOf(`Debugger listening at 127.0.0.1:${debugPort}`) < output.indexOf('Ready at'), 'the debugger is announced before readiness');
  assert.equal(await debugPortAccepts(debugPort), true);
  assert.match(await readFile(path.join(root, 'app', 'inspector.txt'), 'utf8'), new RegExp(`^ws://127\\.0\\.0\\.1:${debugPort}/`, 'u'));
  const status = JSON.parse(cli(root, ['app', 'status', '--json']).stdout).entries[0];
  assert.equal(status.started, true);
  assert.deepEqual(status.debug, { runtime: 'node', port: debugPort, listening: true });
  assert.match(cli(root, ['app', 'status']).stdout, new RegExp(`debugger listening at 127\\.0\\.0\\.1:${debugPort}`, 'u'));
  const record = JSON.parse(await readFile(path.join(root, '.git', 'singularity-flow', 'app', 'web', 'web.json'), 'utf8'));
  assert.equal(record.debug.runtime, 'node');
  assert.ok(record.debug.listeningAt);
  await stopped(root, started);
  assert.equal(await debugPortAccepts(debugPort), false);
});

test('app start --debug through an npm script gives the debugger to the application, not to npm', async (t) => {
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  if (npm.status !== 0) { t.skip('npm is not available'); return; }
  const [port, debugPort] = [await freePort(), await freePort()];
  const root = await repository(t, { argv: ['npm', 'run', 'serve'], url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 30_000 },
    debug: { runtime: 'node', port: debugPort } }, { files: { 'app/package.json': JSON.stringify({ private: true, scripts: { serve: `node server.mjs ${port}` } }) } });
  const plan = JSON.parse(cli(root, ['app', 'plan', '--json']).stdout).entries[0];
  assert.deepEqual(plan.debug.environmentNames, ['npm_config_node_options']);
  const started = startDebug(root);
  await started.waitFor(/Ready at/u);
  assert.match(started.output(), /with npm_config_node_options set for the application only/u);
  assert.match(started.output(), new RegExp(`Debugger listening at 127\\.0\\.0\\.1:${debugPort}`, 'u'));
  assert.doesNotMatch(started.output(), /address already in use/u);
  assert.match(await readFile(path.join(root, 'app', 'inspector.txt'), 'utf8'), new RegExp(`^ws://127\\.0\\.0\\.1:${debugPort}/`, 'u'),
    'the server process, not npm, owns the inspector');
  await stopped(root, started);
});

test('app start --debug refuses an undeclared debugger and a port already in use, before anything runs', async (t) => {
  const [port, debugPort] = [await freePort(), await freePort()];
  const plain = await repository(t, { argv: ['node', 'server.mjs', String(port)], url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 5_000 } });
  const undeclared = cli(plain, ['app', 'start', '--debug']);
  assert.notEqual(undeclared.status, 0);
  assert.match(undeclared.stderr, /declares no debug block.*Nothing ran/su);
  await assert.rejects(readFile(path.join(plain, 'app', 'pid.txt')), { code: 'ENOENT' });

  const busy = await repository(t, { argv: ['node', 'server.mjs', String(port)], url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 5_000 },
    debug: { runtime: 'node', port: debugPort } });
  const holder = net.createServer().listen(debugPort, '127.0.0.1');
  await new Promise((resolve) => holder.once('listening', resolve));
  t.after(() => holder.close());
  const inUse = cli(busy, ['app', 'start', '--debug']);
  assert.notEqual(inUse.status, 0);
  assert.match(inUse.stderr, new RegExp(`debugs on 127\\.0\\.0\\.1:${debugPort}, and something already listens there`, 'u'));
  await assert.rejects(readFile(path.join(busy, 'app', 'pid.txt')), { code: 'ENOENT' });
  // A start that is not a debug start ignores the debug block.
  const plainStart = cli(busy, ['app', 'plan', '--json']);
  assert.equal(JSON.parse(plainStart.stdout).entries[0].debug.port, debugPort);
});

test('app start --debug with python and go launchers runs debugpy and dlv as rewritten (stand-in executables)', async (t) => {
  const bin = await mkdtemp(path.join(tmpdir(), 'sflow-debug-fake-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(bin, 'fake-debugger.mjs'), FAKE_DEBUGGER);
  // A stand-in python3: answers the debugpy check as FAKE_DEBUGPY says, else acts as debugpy.
  await writeFile(path.join(bin, 'python3'), `#!/bin/sh\nif [ "$1" = "-c" ]; then\n  [ "$FAKE_DEBUGPY" = "missing" ] && exit 1\n  exit 0\nfi\nexec "${process.execPath}" "${path.join(bin, 'fake-debugger.mjs')}" "$@"\n`);
  await writeFile(path.join(bin, 'dlv'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake-debugger.mjs')}" "$@"\n`);
  await chmod(path.join(bin, 'python3'), 0o755);
  await chmod(path.join(bin, 'dlv'), 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };

  const [port, debugPort] = [await freePort(), await freePort()];
  const python = await repository(t, { argv: ['uvicorn', 'main:app', '--port', String(port)], url: `http://127.0.0.1:${port}/`,
    ready: { http: '/', timeoutMs: 20_000 }, debug: { runtime: 'python', port: debugPort } });
  const missing = cli(python, ['app', 'start', '--debug'], { ...env, FAKE_DEBUGPY: 'missing' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /debugpy is not installed for python3\. Install it yourself with pip install debugpy/u);
  await assert.rejects(readFile(path.join(python, 'app', 'debugger-argv.json')), { code: 'ENOENT' });
  const started = startDebug(python, env);
  await started.waitFor(/Ready at/u, 30_000);
  assert.deepEqual(JSON.parse(await readFile(path.join(python, 'app', 'debugger-argv.json'), 'utf8')),
    ['-m', 'debugpy', '--listen', `127.0.0.1:${debugPort}`, '-m', 'uvicorn', 'main:app', '--port', String(port)]);
  assert.match(started.output(), new RegExp(`Debugger listening at 127\\.0\\.0\\.1:${debugPort}`, 'u'));
  assert.deepEqual(JSON.parse(cli(python, ['app', 'status', '--json'], env).stdout).entries[0].debug, { runtime: 'python', port: debugPort, listening: true });
  await stopped(python, started);

  const [goPort, goDebugPort] = [await freePort(), await freePort()];
  const go = await repository(t, { argv: ['go', 'run', './cmd/api', '--port', String(goPort)], url: `http://127.0.0.1:${goPort}/`,
    ready: { http: '/', timeoutMs: 20_000 }, debug: { runtime: 'go', port: goDebugPort } });
  const withoutDlv = String(process.env.PATH).split(path.delimiter).filter((directory) => !executableOnPath('dlv', { PATH: directory })).join(path.delimiter);
  const noDlv = cli(go, ['app', 'start', '--debug'], { ...process.env, PATH: withoutDlv });
  assert.match(noDlv.stderr, /dlv is not on PATH/u);
  const goStarted = startDebug(go, env);
  await goStarted.waitFor(/Ready at/u, 30_000);
  const dlvArgv = JSON.parse(await readFile(path.join(go, 'app', 'debugger-argv.json'), 'utf8'));
  assert.deepEqual(dlvArgv.slice(0, 7), ['debug', './cmd/api', '--headless', `--listen=127.0.0.1:${goDebugPort}`, '--api-version=2', '--accept-multiclient', '--continue']);
  assert.match(dlvArgv[7], /^--output=.*\.git\/singularity-flow\/app\/web\/web\.debug-bin$/u, 'Delve builds below the Git common directory, never in the worktree');
  assert.deepEqual(dlvArgv.slice(8), ['--', '--port', String(goPort)]);
  await stopped(go, goStarted);
});

test('app start --debug with dotnet starts normally and names the pid to attach to', async (t) => {
  const port = await freePort();
  const root = await repository(t, { argv: ['node', 'server.mjs', String(port)], url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 20_000 },
    debug: { runtime: 'dotnet' } });
  const started = startDebug(root);
  await started.waitFor(/Ready at/u);
  const pid = Number(await readFile(path.join(root, 'app', 'pid.txt'), 'utf8'));
  assert.match(started.output(), /Attach a \.NET debugger to process \d+; dotnet has no debugger listener/u);
  const status = JSON.parse(cli(root, ['app', 'status', '--json']).stdout).entries[0];
  assert.deepEqual(status.debug, { runtime: 'dotnet', port: null, listening: null });
  assert.equal(status.pid, pid);
  await stopped(root, started);
});

test('app start --debug with a real JVM: the JDWP agent listens on loopback (skipped without java)', async (t) => {
  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  const major = Number(String(java.stderr ?? '').match(/version "(\d+)/u)?.[1] ?? 0);
  if (java.status !== 0 || major < 11) { t.skip('a JDK 11 or newer is not on PATH'); return; }
  const [port, debugPort] = [await freePort(), await freePort()];
  const source = `import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
public class Server {
  public static void main(String[] args) throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", Integer.parseInt(args[0])), 0);
    server.createContext("/", exchange -> { exchange.sendResponseHeaders(204, -1); exchange.close(); });
    server.start();
    System.out.println("server ready");
  }
}
`;
  const root = await repository(t, { argv: ['java', 'Server.java', String(port)], url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 60_000 },
    debug: { runtime: 'java', port: debugPort } }, { files: { 'app/Server.java': source } });
  const started = startDebug(root);
  await started.waitFor(/Ready at/u, 90_000);
  const output = started.output();
  assert.match(output, new RegExp(`Listening for transport dt_socket at address: ${debugPort}`, 'u'));
  assert.match(output, new RegExp(`Debugger listening at 127\\.0\\.0\\.1:${debugPort}`, 'u'));
  assert.doesNotMatch(output, /handshake failed/u, 'the JDWP port is never probed');
  assert.deepEqual(JSON.parse(cli(root, ['app', 'status', '--json']).stdout).entries[0].debug, { runtime: 'java', port: debugPort, listening: true });
  await stopped(root, started);
});

test('real debugpy and dlv starts (skipped where they are not installed)', async (t) => {
  // These run only on a machine with the tools; the stand-ins above cover the rewriting here.
  const has = (command, args) => {
    if (process.env.SFLOW_TEST_NO_PYTHON === '1' && command.startsWith('python')) return false;
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000 });
    return result.status === 0;
  };
  const debugpy = has('python3', ['-c', 'import debugpy']);
  const dlv = has('dlv', ['version']) && has('go', ['version']);
  if (!debugpy && !dlv) { t.skip('neither python3 with debugpy nor go with dlv is installed'); return; }
  if (debugpy) {
    const [port, debugPort] = [await freePort(), await freePort()];
    const root = await repository(t, { argv: ['python3', 'serve.py', String(port)], url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 60_000 },
      debug: { runtime: 'python', port: debugPort } }, { files: { 'app/serve.py': 'import http.server, sys\nhttp.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), http.server.SimpleHTTPRequestHandler).serve_forever()\n' } });
    const started = startDebug(root);
    await started.waitFor(/Ready at/u, 90_000);
    assert.match(started.output(), new RegExp(`Debugger listening at 127\\.0\\.0\\.1:${debugPort}`, 'u'));
    await stopped(root, started);
  }
  if (dlv) {
    const [port, debugPort] = [await freePort(), await freePort()];
    const root = await repository(t, { argv: ['go', 'run', '.', String(port)], url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 120_000 },
      debug: { runtime: 'go', port: debugPort } }, { files: {
      'app/go.mod': 'module example.test/serve\n\ngo 1.21\n',
      'app/main.go': 'package main\n\nimport (\n\t"net/http"\n\t"os"\n)\n\nfunc main() { http.ListenAndServe("127.0.0.1:"+os.Args[1], http.NotFoundHandler()) }\n' } });
    const started = startDebug(root);
    await started.waitFor(/Ready at/u, 150_000);
    assert.match(started.output(), new RegExp(`Debugger listening at 127\\.0\\.0\\.1:${debugPort}`, 'u'));
    await stopped(root, started);
  }
});
