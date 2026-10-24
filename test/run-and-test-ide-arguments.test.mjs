import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  applicationStartArgv, applicationStartCommandSha256, debuggerListeners, normalizeCapabilityApplication, validateCapabilities
} from '../src/capabilities.mjs';
import { recordSha256 } from '../src/records.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const CLI = path.resolve('bin/singularity-flow.mjs');
const start = (overrides = {}) => ({
  id: 'api', argv: ['./mvnw', '-q', 'spring-boot:run'], workingDirectory: 'services/api', url: 'http://127.0.0.1:8080/',
  ready: { http: '/actuator/health', timeoutMs: 180_000 }, environments: ['dev', 'qa'], ...overrides
});
const capability = (entry) => ({ kind: 'delivery', repository: 'api', application: { start: [entry] } });
const normalized = (entry) => normalizeCapabilityApplication('api', capability(entry)).start[0];
const refused = (entry, pattern) => assert.throws(() => validateCapabilities({ version: 1, capabilities: { api: capability(entry) } }),
  (error) => error.code === 'CAPABILITY_APPLICATION_INVALID' && pattern.test(error.message), `expected ${pattern}`);

test('arguments per environment are appended to argv for the chosen environment only', () => {
  const entry = normalized(start({ arguments: {
    dev: ['-Dspring-boot.run.profiles=dev'],
    qa: ['-Dspring-boot.run.profiles=qa', '-Dspring-boot.run.jvmArguments=-Xmx2g']
  } }));
  assert.deepEqual(entry.arguments, { dev: ['-Dspring-boot.run.profiles=dev'], qa: ['-Dspring-boot.run.profiles=qa', '-Dspring-boot.run.jvmArguments=-Xmx2g'] });
  assert.deepEqual(applicationStartArgv(entry, 'dev'), ['./mvnw', '-q', 'spring-boot:run', '-Dspring-boot.run.profiles=dev']);
  assert.deepEqual(applicationStartArgv(entry, 'qa'), ['./mvnw', '-q', 'spring-boot:run', '-Dspring-boot.run.profiles=qa', '-Dspring-boot.run.jvmArguments=-Xmx2g']);
  assert.deepEqual(applicationStartArgv(entry, null), ['./mvnw', '-q', 'spring-boot:run']);
  // An environment the map does not name runs the plain argv.
  const partial = normalized(start({ arguments: { qa: ['--qa'] } }));
  assert.deepEqual(applicationStartArgv(partial, 'dev'), partial.argv);
});

test('arguments name only the entry\'s environments, as lists of 1 to 64 shell-free strings', () => {
  refused(start({ arguments: { uat: ['-x'] } }), /arguments\.uat names an environment the entry does not list \(environments: dev, qa\)/u);
  refused(start({ environments: undefined, arguments: { dev: ['-x'] } }), /arguments\.dev names an environment the entry does not list \(environments: none\)/u);
  refused(start({ arguments: { dev: '-Dspring-boot.run.profiles=dev' } }), /arguments\.dev must be a list of arguments, not a shell string/u);
  refused(start({ arguments: { dev: [] } }), /arguments\.dev must be a list of 1 to 64 non-empty strings/u);
  refused(start({ arguments: { dev: Array.from({ length: 65 }, (_, index) => `-D${index}`) } }), /1 to 64/u);
  refused(start({ arguments: { dev: ['ok', 'bad\nline'] } }), /without control characters/u);
  refused(start({ arguments: { dev: [''] } }), /non-empty strings/u);
  refused(start({ arguments: ['-x'] }), /arguments must map an environment/u);
});

test('the command identity covers the argv each environment resolves to and the debug block', () => {
  const plain = normalized(start());
  // An entry without arguments or debug hashes exactly as the base engine hashed it, so a
  // confirmation given before this change still holds.
  assert.equal(applicationStartCommandSha256(plain), `sha256:${recordSha256({
    repository: 'api', workingDirectory: 'services/api', argv: ['./mvnw', '-q', 'spring-boot:run'], environments: ['dev', 'qa'] })}`);
  assert.equal(Object.hasOwn(plain, 'arguments'), false);
  assert.equal(Object.hasOwn(plain, 'debug'), false);
  const dev = normalized(start({ arguments: { dev: ['-Dspring-boot.run.profiles=dev'] } }));
  const changed = normalized(start({ arguments: { dev: ['-Dspring-boot.run.profiles=local'] } }));
  const debugged = normalized(start({ arguments: { dev: ['-Dspring-boot.run.profiles=dev'] }, debug: { runtime: 'java' } }));
  const otherPort = normalized(start({ arguments: { dev: ['-Dspring-boot.run.profiles=dev'] }, debug: { runtime: 'java', port: 5006 } }));
  const hashes = [plain, dev, changed, debugged, otherPort].map(applicationStartCommandSha256);
  assert.equal(new Set(hashes).size, 5, 'a changed argument or debug setting asks for confirmation again');
  assert.equal(applicationStartCommandSha256(normalized(start({ arguments: { dev: ['-Dspring-boot.run.profiles=dev'] } }))), hashes[1]);
});

test('compatibility: start entries stay a closed shape, so an older build refuses what it cannot run', () => {
  // The base validator of this branch (before arguments and debug) refuses them by name, as this
  // one refuses any field it does not know: a map using them never runs with them silently ignored.
  // Engines older than the application block ignore the whole block.
  refused(start({ launch: [] }), /unsupported field\(s\): launch/u);
  refused(start({ debug: { runtime: 'java', profile: 'x' } }), /debug contains unsupported field\(s\): profile/u);
  refused(start({ debug: { runtime: 'ruby' } }), /debug\.runtime must be one of: java, python, node, go, dotnet/u);
});

test('debugger listeners in argv and arguments must be loopback; Gradle --debug-jvm is refused', () => {
  refused(start({ argv: ['./gradlew', 'bootRun', '--debug-jvm'] }), /argv: --debug-jvm binds every interface and suspends/u);
  refused(start({ arguments: { qa: ['--debug-jvm'] } }), /arguments\.qa: --debug-jvm/u);
  refused(start({ arguments: { qa: ['-Dspring-boot.run.jvmArguments=-Xmx2g -agentlib:jdwp=transport=dt_socket,server=y,address=*:5005'] } }),
    /listens on '\*'; a debugger listens on 127\.0\.0\.1 only/u);
  refused(start({ argv: ['java', '-agentlib:jdwp=transport=dt_socket,server=y,address=0.0.0.0:5005', '-jar', 'app.jar'] }), /'0\.0\.0\.0'/u);
  refused(start({ argv: ['java', '-agentlib:jdwp=transport=dt_socket,server=y,address=5005', '-jar', 'app.jar'] }), /names no host/u);
  refused(start({ argv: ['java', '-Xrunjdwp:transport=dt_socket,server=y,address=build-host:5005', 'Main'] }), /'build-host'/u);
  refused(start({ argv: ['node', '--inspect=0.0.0.0:9229', 'server.js'] }), /'0\.0\.0\.0'/u);
  refused(start({ argv: ['node', '--inspect-brk=[::]:9229', 'server.js'] }), /'\[::\]'/u);
  refused(start({ argv: ['python', '-m', 'debugpy', '--listen', '0.0.0.0:5678', 'app.py'] }), /'0\.0\.0\.0'/u);
  refused(start({ argv: ['dlv', 'debug', '--headless', '--listen=:2345'] }), /every interface/u);
  refused(start({ argv: ['npm', 'run', 'dev', '--node-options=--inspect=10.0.0.4:9229'] }), /'10\.0\.0\.4'/u);
  // Loopback listeners already in argv are accepted (the person runs them without --debug).
  assert.ok(normalized(start({ argv: ['node', '--inspect=127.0.0.1:9229', 'server.js'] })));
  assert.ok(normalized(start({ argv: ['node', '--inspect', 'server.js'] })));
  assert.ok(normalized(start({ argv: ['java', '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=localhost:5005', 'Main'] })));
});

test('debuggerListeners finds each kind of listener and its address', () => {
  const { listeners, refusals } = debuggerListeners([
    '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005', '--inspect', '--inspect-brk=9230',
    '--listen', '127.0.0.1:5678', '--listen=localhost:2345', 'JAVA_TOOL_OPTIONS=-Xrunjdwp:server=y,address=[::1]:5006'
  ]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(listeners.map((listener) => [listener.kind, listener.host, listener.port]), [
    ['jdwp', '127.0.0.1', 5005], ['inspector', '127.0.0.1', 9229], ['inspector', '127.0.0.1', 9230],
    ['listen', '127.0.0.1', 5678], ['listen', 'localhost', 2345], ['jdwp', '[::1]', 5006]
  ]);
});

// ---------------------------------------------------------------------------------------------

const SERVER = `import http from 'node:http';
import { writeFileSync } from 'node:fs';
const [port, ...rest] = process.argv.slice(2);
writeFileSync('argv.json', JSON.stringify(rest));
http.createServer((request, response) => { response.statusCode = 204; response.end(); }).listen(Number(port), '127.0.0.1');
`;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const children = new Set();
after(() => { for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } } });

async function fixture(t, entry) {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-ide-arguments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root }).status, 0, args.join(' '));
  git('init', '-q');
  await mkdir(path.join(root, 'singularity'));
  await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, 'server', 'server.mjs'), SERVER);
  await writeFile(path.join(root, 'singularity', 'capabilities.yml'), JSON.stringify({ version: 1, capabilities: { web: {
    kind: 'delivery', repository: 'web', policy: { localIntegrationEvidence: 'allowed' }, application: { start: [entry] } } } }, null, 2));
  await writeFile(path.join(root, 'singularity', 'environments.yml'),
    'schemaVersion: 1\nenvironments:\n  dev:\n    requires:\n      - { name: APP_MODE, kind: flag, default: dev }\n  qa:\n    requires:\n      - { name: APP_MODE, kind: flag, default: qa }\n');
  git('add', '-A');
  git('-c', 'user.name=Arguments Tester', '-c', 'user.email=arguments-tester@example.invalid', 'commit', '-qm', 'fixture');
  return root;
}

const cli = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000) });

test('app plan shows the resolved argv per environment and app start runs the chosen one', async (t) => {
  const port = await freePort();
  const root = await fixture(t, {
    id: 'web', argv: ['node', 'server.mjs', String(port)], workingDirectory: 'server', url: `http://127.0.0.1:${port}/`,
    ready: { http: '/', timeoutMs: 15_000 }, environments: ['dev', 'qa'], arguments: { qa: ['--mode', 'qa', '--seed=7'] }
  });
  const plan = JSON.parse(cli(root, ['app', 'plan', '--json']).stdout).entries[0];
  assert.deepEqual(plan.arguments, { qa: ['--mode', 'qa', '--seed=7'] });
  assert.deepEqual(plan.environments.map((environment) => [environment.name, environment.argv]), [
    ['dev', ['node', 'server.mjs', String(port)]], ['qa', ['node', 'server.mjs', String(port), '--mode', 'qa', '--seed=7']]]);
  assert.equal(Object.hasOwn(plan, 'debug'), false);
  const human = cli(root, ['app', 'plan']).stdout;
  assert.match(human, new RegExp(`qa: node server\\.mjs ${port} --mode qa --seed=7`, 'u'));

  const child = spawn(process.execPath, [CLI, 'app', 'start', '--environment', 'qa', '--expect-command', plan.commandSha256], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('close', resolve));
  for (let index = 0; index < 150 && !/Ready at/u.test(output); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(output, /Starting web: node server\.mjs \d+ --mode qa --seed=7/u);
  assert.match(output, /Ready at/u);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'server', 'argv.json'), 'utf8')), ['--mode', 'qa', '--seed=7']);
  assert.equal(JSON.parse(cli(root, ['app', 'stop', '--json']).stdout).stopped, true);
  assert.equal(await exited, 0);
  // A confirmation of the old arguments no longer starts anything.
  const stale = cli(root, ['app', 'start', '--environment', 'qa', '--expect-command', `sha256:${'1'.repeat(64)}`]);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /changed since it was confirmed; nothing ran/u);
});
