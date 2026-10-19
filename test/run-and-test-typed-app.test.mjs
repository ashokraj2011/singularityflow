import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import YAML from 'yaml';

import { buildRepositoryReadinessPlan } from '../src/initialization/runtime-readiness.mjs';

const CLI = path.resolve('bin/singularity-flow.mjs');
const SECRET = 'typed-fixture-secret-9c41';
const SERVER = `import http from 'node:http';
import { writeFileSync } from 'node:fs';
const [port, ...rest] = process.argv.slice(2);
writeFileSync('server-started.json', JSON.stringify({ rest, flags: process.env.FEATURE_FLAGS ?? null, region: process.env.REGION ?? null,
  execArgv: process.execArgv, pid: process.pid }));
http.createServer((request, response) => { response.statusCode = 204; response.end(); }).listen(Number(port), '127.0.0.1');
`;
const BUILD = `import { writeFileSync } from 'node:fs';
writeFileSync('built.txt', String(process.env.FEATURE_FLAGS));
console.log('build sees token ' + (process.env.API_TOKEN ?? 'none'));
process.exit(Number(process.argv[2] ?? 0));
`;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const cli = (root, args, input = null) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', input, timeout: 60_000 });
const json = (root, args) => {
  const result = cli(root, args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

const ENVIRONMENTS = `schemaVersion: 1
environments:
  dev:
    requires:
      - { name: REGION, kind: flag, default: eu-dev }
  qa:
    requires:
      - { name: API_TOKEN, kind: secret }
`;

async function fixture(t, start, { files = {}, policy = { localIntegrationEvidence: 'allowed' } } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-typed-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  for (const [relative, content] of Object.entries({
    'server/server.mjs': SERVER, 'server/build.mjs': BUILD, 'singularity/environments.yml': ENVIRONMENTS,
    'singularity/capabilities.yml': JSON.stringify({ version: 1, capabilities: { web: { kind: 'delivery', repository: 'web', policy,
      application: { start } } } }, null, 2),
    ...files
  })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Typed Tester', '-c', 'user.email=typed-tester@example.invalid', 'commit', '-qm', 'fixture');
  return root;
}

const children = new Set();
after(() => { for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } } });

function startInBackground(root, args = []) {
  const child = spawn(process.execPath, [CLI, 'app', 'start', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  return {
    exited, output: () => output,
    waitFor: async (pattern) => {
      for (let index = 0; index < 200 && !pattern.test(output); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.match(output, pattern);
    }
  };
}

const JAVA_FILES = { mvnw: '#!/bin/sh\n', 'services/api/pom.xml': '<project/>', '.venv/bin/python': '#!/bin/sh\n', 'apps/web/package.json': '{}' };

test('app plan shows a typed entry\'s type, name, fields and, per environment, what it resolves to', async (t) => {
  const root = await fixture(t, [
    { id: 'api', name: 'Api', type: 'spring-boot', launcher: 'maven', mainClass: 'com.example.api.ApiApplication', vmOptions: ['-Xmx1g', '-Dfile.encoding=UTF-8'],
      programArguments: ['--server.port=8080'], activeProfiles: ['dev'], workingDirectory: 'services/api', env: { FEATURE_FLAGS: 'a,b' },
      beforeLaunch: [{ argv: ['../../mvnw', '-q', 'compile'] }], perEnvironment: { qa: { activeProfiles: ['qa'], vmOptions: ['-Xmx2g'] } },
      environments: ['dev', 'qa'], url: 'http://127.0.0.1:8080/', ready: { http: '/actuator/health', timeoutMs: 180_000 }, debug: { port: 5005 } },
    { id: 'web', name: 'Web', type: 'npm', script: 'dev', arguments: ['--host', '127.0.0.1', '--port', '5173'], workingDirectory: 'apps/web',
      url: 'http://127.0.0.1:5173/', ready: { http: '/', timeoutMs: 90_000 }, debug: {} },
    { id: 'pricing', type: 'fastapi', app: 'app.main:app', reload: true, workingDirectory: 'services/pricing',
      url: 'http://127.0.0.1:8000/', ready: { http: '/docs' }, debug: {} }
  ], { files: { ...JAVA_FILES, 'services/pricing/app/main.py': '' } });
  const plan = json(root, ['app', 'plan', '--json']);
  const [api, web, pricing] = plan.entries;
  assert.equal(api.name, 'Api');
  assert.equal(api.type, 'spring-boot');
  assert.deepEqual(api.fields, { launcher: 'maven', mainClass: 'com.example.api.ApiApplication', vmOptions: ['-Xmx1g', '-Dfile.encoding=UTF-8'],
    programArguments: ['--server.port=8080'], activeProfiles: ['dev'] });
  assert.deepEqual(api.env, { FEATURE_FLAGS: 'a,b' });
  assert.deepEqual(api.perEnvironment, { qa: { activeProfiles: ['qa'], vmOptions: ['-Xmx2g'] } });
  const mvn = ['../../mvnw', 'spring-boot:run', '-Dspring-boot.run.main-class=com.example.api.ApiApplication'];
  assert.deepEqual(api.environments.map((environment) => [environment.name, environment.resolved]), [
    ['dev', { argv: [...mvn, '-Dspring-boot.run.jvmArguments=-Xmx1g -Dfile.encoding=UTF-8', '-Dspring-boot.run.arguments=--server.port=8080',
      '-Dspring-boot.run.profiles=dev'], envNames: ['FEATURE_FLAGS'], beforeLaunch: [{ argv: ['../../mvnw', '-q', 'compile'], workingDirectory: 'services/api', timeoutMs: 600_000 }] }],
    ['qa', { argv: [...mvn, '-Dspring-boot.run.jvmArguments=-Xmx2g', '-Dspring-boot.run.arguments=--server.port=8080', '-Dspring-boot.run.profiles=qa'],
      envNames: ['FEATURE_FLAGS'], beforeLaunch: [{ argv: ['../../mvnw', '-q', 'compile'], workingDirectory: 'services/api', timeoutMs: 600_000 }] }]
  ]);
  assert.deepEqual(api.environments.map((environment) => environment.argv), api.environments.map((environment) => environment.resolved.argv),
    'environments[].argv is the resolved argv, as VS Code reads it');
  assert.deepEqual(api.environments[1].debug.argv, [...mvn, `-Dspring-boot.run.jvmArguments=-Xmx2g -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005`,
    '-Dspring-boot.run.arguments=--server.port=8080', '-Dspring-boot.run.profiles=qa']);
  assert.deepEqual([api.debug.runtime, api.debug.port, api.debug.address, api.debug.launcher], ['java', 5005, '127.0.0.1:5005', 'maven-spring-boot']);
  assert.deepEqual(web.resolved, { argv: ['npm', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'], envNames: [], beforeLaunch: [] });
  assert.deepEqual(web.argv, web.resolved.argv);
  assert.deepEqual(web.debug.environmentNames, ['npm_config_node_options']);
  assert.deepEqual(pricing.resolved.argv, ['../../.venv/bin/python', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000', '--reload']);
  assert.deepEqual(pricing.debug.argv, ['../../.venv/bin/python', '-m', 'debugpy', '--listen', '127.0.0.1:5678', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000']);
  assert.equal(pricing.name, 'pricing', 'the name defaults to the id');
  // The human plan names the type and each environment's command line.
  const human = cli(root, ['app', 'plan']).stdout;
  assert.match(human, /api \(Api\) · spring-boot: \.\.\/\.\.\/mvnw spring-boot:run/u);
  assert.match(human, /qa: \.\.\/\.\.\/mvnw spring-boot:run .*-Dspring-boot\.run\.profiles=qa \(with FEATURE_FLAGS set\)/u);
  assert.match(human, /before launch: \.\.\/\.\.\/mvnw -q compile \(in services\/api\)/u);
  // app status is unchanged plus the name.
  const status = json(root, ['app', 'status', '--json']);
  assert.deepEqual(status.entries.map((entry) => [entry.id, entry.name, entry.started]), [['api', 'Api', false], ['web', 'Web', false], ['pricing', 'pricing', false]]);
});

test('app start runs the before-launch steps in order with the entry\'s variables and redacted output, then the typed command', async (t) => {
  const port = await freePort();
  const root = await fixture(t, [{
    id: 'web', name: 'Web', type: 'node', script: 'server/server.mjs', applicationParameters: [String(port), '--mode', 'typed'], workingDirectory: 'server',
    env: { FEATURE_FLAGS: 'a,b' }, beforeLaunch: [{ argv: ['node', 'build.mjs'] }], environments: ['dev', 'qa'],
    perEnvironment: { qa: { env: { FEATURE_FLAGS: 'qa-flags' } } }, url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 15_000 }
  }]);
  assert.equal(cli(root, ['env', 'bind', 'qa', '--stdin'], JSON.stringify({ bindings: { API_TOKEN: { source: 'local', value: SECRET } } })).status, 0);
  const plan = json(root, ['app', 'plan', '--json']).entries[0];
  const started = startInBackground(root, ['--environment', 'qa', '--expect-command', plan.commandSha256]);
  await started.waitFor(/Ready at/u);
  const output = started.output();
  assert.match(output, /Starting web: node server\.mjs \d+ --mode typed/u);
  assert.match(output, /Before launch \(1\/1\): node build\.mjs/u);
  assert.match(output, /build sees token \[redacted:API_TOKEN\]/u, 'a step\'s output is redacted like the application\'s');
  assert.doesNotMatch(output, new RegExp(SECRET, 'u'));
  assert.ok(output.indexOf('Before launch') < output.indexOf('Ready at'));
  assert.equal(await readFile(path.join(root, 'server', 'built.txt'), 'utf8'), 'qa-flags', 'the step ran with the environment\'s env first');
  const server = JSON.parse(await readFile(path.join(root, 'server', 'server-started.json'), 'utf8'));
  assert.deepEqual([server.rest, server.flags], [['--mode', 'typed'], 'qa-flags']);
  assert.equal(json(root, ['app', 'stop', '--json']).stopped, true);
  assert.equal(await started.exited, 0);
});

test('a failing or overrunning before-launch step stops the start: the application never runs', async (t) => {
  const port = await freePort();
  const entry = (steps) => ({ id: 'web', type: 'node', script: 'server/server.mjs', applicationParameters: [String(port)], workingDirectory: 'server',
    beforeLaunch: steps, url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 15_000 } });
  const failing = await fixture(t, [entry([{ argv: ['node', 'build.mjs', '0'] }, { argv: ['node', 'build.mjs', '3'] }, { argv: ['node', 'never-runs.mjs'] }])]);
  const result = cli(failing, ['app', 'start']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Before launch \(1\/3\): node build\.mjs 0\n[\s\S]*Before launch \(2\/3\): node build\.mjs 3/u);
  assert.doesNotMatch(result.stdout, /Before launch \(3\/3\)/u);
  assert.match(result.stderr, /Start entry 'web' before-launch step 2 \(node build\.mjs 3\) exited 3; the application did not start\./u);
  await assert.rejects(lstat(path.join(failing, 'server', 'server-started.json')), { code: 'ENOENT' });
  assert.equal(json(failing, ['app', 'status', '--json']).entries[0].started, false);
  const slow = await fixture(t, [entry([{ argv: ['node', '-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 1_000 }])]);
  const timedOut = cli(slow, ['app', 'start']);
  assert.notEqual(timedOut.status, 0);
  assert.match(timedOut.stderr, /before-launch step 1 \(node -e setTimeout\(\(\) => \{\}, 60000\)\) did not finish within 1000 ms; its process tree was stopped and the application did not start\./u);
  await assert.rejects(lstat(path.join(slow, 'server', 'server-started.json')), { code: 'ENOENT' });
});

test('app start --debug starts a typed node entry with the inspector after node, on loopback only', async (t) => {
  const port = await freePort();
  const debugPort = await freePort();
  const root = await fixture(t, [{
    id: 'web', type: 'node', script: 'server/server.mjs', nodeOptions: ['--enable-source-maps'], applicationParameters: [String(port)], workingDirectory: 'server',
    url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 15_000 }, debug: { port: debugPort }
  }]);
  const started = startInBackground(root, ['--debug']);
  await started.waitFor(/Ready at/u);
  assert.match(started.output(), new RegExp(`Debug start: node --inspect=127\\.0\\.0\\.1:${debugPort} --enable-source-maps server\\.mjs ${port}`, 'u'));
  assert.match(started.output(), new RegExp(`Debugger listening at 127\\.0\\.0\\.1:${debugPort}`, 'u'));
  const server = JSON.parse(await readFile(path.join(root, 'server', 'server-started.json'), 'utf8'));
  assert.deepEqual(server.execArgv, [`--inspect=127.0.0.1:${debugPort}`, '--enable-source-maps']);
  assert.deepEqual(json(root, ['app', 'status', '--json']).entries[0].debug, { runtime: 'node', port: debugPort, listening: true });
  assert.equal(json(root, ['app', 'stop', '--json']).stopped, true);
  await started.exited;
});

test('app config preview checks a whole block from a file and resolves it per environment, writing nothing', async (t) => {
  // The map's own block is broken; preview still checks the file, and app plan names the error at its field.
  const root = await fixture(t, [{ id: 'api', type: 'jar', url: 'http://127.0.0.1:8080/', ready: { http: '/' } }], { files: JAVA_FILES });
  const broken = cli(root, ['app', 'plan', '--json']);
  assert.notEqual(broken.status, 0);
  assert.equal(JSON.parse(broken.stdout).error.message, 'Capability \'web\'.application start[0].jar is required for type jar.');
  const directory = await mkdtemp(path.join(tmpdir(), 'sflow-typed-preview-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'application.yml');
  await writeFile(file, YAML.stringify({ application: { start: [
    { id: 'api', name: 'Api', type: 'spring-boot', mainClass: 'com.example.api.ApiApplication', activeProfiles: ['dev'], workingDirectory: 'services/api',
      environments: ['dev', 'qa'], perEnvironment: { qa: { activeProfiles: ['qa'] } }, url: 'http://127.0.0.1:8080/', ready: { http: '/actuator/health' } },
    { id: 'web', type: 'npm', script: 'dev', env: { DB_PASSWORD: 'hunter2' }, url: 'http://127.0.0.1:5173/', ready: { http: '/' } },
    { id: 'report', argv: ['node', 'report.mjs'], url: 'http://127.0.0.1:9000/', ready: { log: 'ready' } }
  ] } }));
  const before = git(root, 'status', '--porcelain');
  const preview = json(root, ['app', 'config', 'preview', '--application-file', file, '--json']);
  assert.equal(preview.resultType, 'sflow-app-config-preview');
  assert.equal(preview.capability, 'web');
  assert.equal(preview.valid, false);
  assert.deepEqual(preview.errors, []);
  const [api, web, report] = preview.entries;
  assert.deepEqual([api.id, api.name, api.type, api.errors], ['api', 'Api', 'spring-boot', []]);
  assert.deepEqual(api.environments.map((environment) => [environment.name, environment.resolved.argv]), [
    ['dev', ['../../mvnw', 'spring-boot:run', '-Dspring-boot.run.main-class=com.example.api.ApiApplication', '-Dspring-boot.run.profiles=dev']],
    ['qa', ['../../mvnw', 'spring-boot:run', '-Dspring-boot.run.main-class=com.example.api.ApiApplication', '-Dspring-boot.run.profiles=qa']]
  ]);
  assert.match(api.commandSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(web, { index: 1, id: 'web', name: 'web', type: 'npm', environments: [], errors: [{ field: 'env.DB_PASSWORD',
    message: 'looks like it carries a secret; capabilities.yml never holds one. Declare it as a secret in singularity/environments.yml, bind it with env bind <ENV> --stdin, and read it from the environment.' }] });
  assert.deepEqual(report.environments, [{ name: null, resolved: { argv: ['node', 'report.mjs'], envNames: [], beforeLaunch: [] } }]);
  assert.equal(git(root, 'status', '--porcelain'), before, 'nothing was written');
  // Shared-field and block errors are located too.
  await writeFile(file, YAML.stringify({ start: [{ id: 'x', type: 'npm', script: 'dev', url: 'http://10.0.0.4/', ready: { http: '/' } },
    { id: 'x', argv: ['a'], url: 'http://127.0.0.1:1/', ready: { http: '/' } }], tests: 'all', extra: true }));
  const located = json(root, ['app', 'config', 'preview', '--application-file', file, '--json']);
  assert.deepEqual(located.errors.map((error) => error.field), ['', 'tests']);
  assert.deepEqual(located.entries[0].errors.map((error) => error.field), ['url']);
  assert.match(located.entries[0].errors[0].message, /must be on the loopback host 127\.0\.0\.1, localhost or \[::1\], not '10\.0\.0\.4'/u);
  assert.deepEqual(located.entries[1].errors, [{ field: 'id', message: '\'x\' is declared more than once (also start[0]).' }]);
  const text = cli(root, ['app', 'config', 'preview', '--application-file', file]).stdout;
  assert.match(text, /x · npm: 1 error\n {4}url: must be on the loopback host/u);
  // An unreadable or oversized file is refused; preview needs a file.
  await writeFile(path.join(directory, 'huge.yml'), `start: []\n# ${'x'.repeat(300 * 1024)}\n`);
  assert.match(cli(root, ['app', 'config', 'preview', '--application-file', path.join(directory, 'huge.yml')]).stderr, /--application-file is larger than 256 KiB\./u);
  assert.match(cli(root, ['app', 'config', 'preview', '--application-file', path.join(directory, 'missing.yml')]).stderr, /names .*missing\.yml, which does not exist\./u);
  assert.match(cli(root, ['app', 'config', 'preview']).stderr, /app config preview needs --application-file <FILE>/u);
  assert.match(cli(root, ['app', 'config', 'apply', '--application-file', file]).stderr, /app config takes one action: app config preview/u);
});

test('capability set --application-file refuses a typed entry at its field before writing, and app plan reads a valid one', async (t) => {
  const root = await fixture(t, [{ id: 'web', argv: ['node', 'server.mjs'], workingDirectory: 'server', url: 'http://127.0.0.1:3000/', ready: { http: '/' } }]);
  const directory = await mkdtemp(path.join(tmpdir(), 'sflow-typed-set-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = await readFile(path.join(root, 'singularity', 'capabilities.yml'), 'utf8');
  const invalid = path.join(directory, 'invalid.yml');
  await writeFile(invalid, YAML.stringify({ start: [{ id: 'web', type: 'node', script: 'server/server.mjs', nodeOptions: ['--inspect=0.0.0.0:9229'],
    env: { PATH: '/tmp' }, url: 'http://127.0.0.1:3000/', ready: { http: '/' } }] }));
  const refused = cli(root, ['capability', 'set', 'web', '--application-file', invalid]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--application-file start\[0\]\.nodeOptions --inspect=0\.0\.0\.0:9229 listens on '0\.0\.0\.0'; a debugger listens on 127\.0\.0\.1 only\. \(1 more; app config preview --application-file .* lists each\) Nothing was written\./u);
  assert.equal(await readFile(path.join(root, 'singularity', 'capabilities.yml'), 'utf8'), before);
  const valid = path.join(directory, 'valid.yml');
  await writeFile(valid, YAML.stringify({ start: [{ id: 'web', name: 'Web', type: 'node', script: 'server/server.mjs', applicationParameters: ['3000'],
    workingDirectory: 'server', url: 'http://127.0.0.1:3000/', ready: { http: '/' } }] }));
  assert.equal(cli(root, ['capability', 'set', 'web', '--application-file', valid]).status, 0);
  const plan = json(root, ['app', 'plan', '--json']).entries[0];
  assert.deepEqual([plan.type, plan.name, plan.argv], ['node', 'Web', ['node', 'server.mjs', '3000']]);
});

test('the readiness smoke check starts a typed entry its argv runs, never one that needs variables, steps or a private file', async (t) => {
  const root = await fixture(t, [
    { id: 'plain', type: 'node', script: 'server/server.mjs', applicationParameters: ['3000'], workingDirectory: 'server', url: 'http://127.0.0.1:3000/', ready: { http: '/' } },
    { id: 'flags', type: 'node', script: 'server/server.mjs', env: { FEATURE_FLAGS: 'x' }, workingDirectory: 'server', url: 'http://127.0.0.1:3001/', ready: { http: '/' } },
    { id: 'steps', type: 'node', script: 'server/server.mjs', beforeLaunch: [{ argv: ['node', 'build.mjs'] }], workingDirectory: 'server', url: 'http://127.0.0.1:3002/', ready: { http: '/' } },
    { id: 'gradle', type: 'spring-boot', launcher: 'gradle', vmOptions: ['-Xmx1g'], url: 'http://127.0.0.1:3003/', ready: { http: '/' } }
  ]);
  const plan = await buildRepositoryReadinessPlan(root, { scope: 'full', inferTestCommands: async () => [] });
  const starts = plan.commands.filter((command) => command.purpose === 'start');
  assert.deepEqual(starts.map((command) => [command.id, command.argv]), [['start-plain', ['node', 'server.mjs', '3000']]]);
});
