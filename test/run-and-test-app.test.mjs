import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { buildRepositoryReadinessPlan } from '../src/initialization/runtime-readiness.mjs';

const CLI = path.resolve('bin/singularity-flow.mjs');
const SECRET = 'fixture-secret-value-7f3a';

const SERVER = `import http from 'node:http';
import { writeFileSync } from 'node:fs';
const [port, mode] = process.argv.slice(2);
writeFileSync('pid.txt', String(process.pid));
if (process.env.API_TOKEN) console.log('token is ' + process.env.API_TOKEN + ' and endpoint ' + process.env.API_BASE_URL);
if (mode === 'never') setInterval(() => {}, 1000);
else setTimeout(() => {
  http.createServer((request, response) => { response.statusCode = request.url === '/health' ? 204 : 404; response.end(); })
    .listen(Number(port), '127.0.0.1', () => console.log('server ready in 3 ms'));
}, 200);
`;

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const ENVIRONMENTS = `schemaVersion: 1
environments:
  dev:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://dev.example.test" }
  qa:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://qa.example.test" }
      - { name: API_TOKEN, kind: secret }
    localFiles: [resources/qa/**]
`;

async function fixture({ ready, mode = 'listen', environments = null, policy = null, port = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-app-'));
  git(root, ['init', '-q']);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await mkdir(path.join(root, 'server'), { recursive: true });
  await writeFile(path.join(root, 'server', 'server.mjs'), SERVER);
  const chosen = port ?? await freePort();
  const entry = {
    id: 'web', argv: ['node', 'server.mjs', String(chosen), mode], workingDirectory: 'server',
    url: `http://127.0.0.1:${chosen}/`, ready: ready ?? { http: '/health', timeoutMs: 15_000 },
    ...(environments ? { environments } : {})
  };
  const capability = { kind: 'delivery', repository: 'web', application: { start: [entry] }, ...(policy ? { policy } : {}) };
  await writeFile(path.join(root, 'singularity', 'capabilities.yml'), JSON.stringify({ version: 1, capabilities: { web: capability } }, null, 2));
  await writeFile(path.join(root, 'singularity', 'environments.yml'), ENVIRONMENTS);
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=App Tester', '-c', 'user.email=app-tester@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, port: chosen, url: entry.url };
}

function cli(root, args, input = null) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', input, timeout: 60_000 });
}

const started = new Set();
after(async () => {
  // A failed assertion must not leave a foreground start or its server holding this test open.
  for (const { child, root } of started) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { process.kill(Number(await readFile(path.join(root, 'server', 'pid.txt'), 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
  }
});

function startInBackground(root, args = []) {
  const child = spawn(process.execPath, [CLI, 'app', 'start', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  started.add({ child, root });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return {
    child, exited, output: () => output,
    async waitFor(pattern, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(output)) return output;
        const done = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))]);
        if (done && !pattern.test(output)) break;
      }
      assert.match(output, pattern);
      return output;
    }
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }))).flat();
}

test('app plan lists each declared start entry with its environments and command identity', async () => {
  const { root, url } = await fixture({ environments: ['dev', 'qa'] });
  const result = cli(root, ['app', 'plan', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.resultType, 'sflow-app-plan');
  assert.equal(plan.capability, 'web');
  assert.deepEqual(Object.keys(plan.entries[0]), ['capability', 'repository', 'id', 'argv', 'workingDirectory', 'url', 'ready', 'environments', 'commandSha256']);
  assert.deepEqual(plan.entries[0].environments, [
    { name: 'dev', status: 'bound', default: true },
    { name: 'qa', status: 'unbound', default: false }
  ]);
  assert.equal(plan.entries[0].url, url);
  assert.match(plan.entries[0].commandSha256, /^sha256:[a-f0-9]{64}$/u);
  const human = cli(root, ['app', 'plan']);
  assert.match(human.stdout, /Start: singularity-flow app start web \[--environment dev\|qa\]/u);
  assert.match(human.stdout, /qa is not bound: .*env bind qa --stdin/u);
});

test('app start waits for http readiness, records the process privately, and app stop ends its tree', async () => {
  const { root, url } = await fixture();
  const started = startInBackground(root);
  await started.waitFor(new RegExp(`Ready at ${url.replaceAll('.', '\\.')}`, 'u'));
  const status = JSON.parse(cli(root, ['app', 'status', '--json']).stdout);
  assert.equal(status.resultType, 'sflow-app-status');
  assert.equal(status.entries[0].started, true);
  assert.equal(status.entries[0].ready, true);
  assert.equal(status.entries[0].url, url);
  const pid = Number(await readFile(path.join(root, 'server', 'pid.txt'), 'utf8'));
  assert.equal(status.entries[0].pid, pid);
  const recordPath = path.join(root, '.git', 'singularity-flow', 'app', 'web', 'web.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(record.format, 'sflow-app-run/v1');
  assert.equal(record.pid, pid);
  assert.equal(record.url, url);
  assert.ok(record.readyAt);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(recordPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(recordPath))).mode & 0o777, 0o700);
  }
  // A second start of the same entry is refused while the first runs.
  const again = cli(root, ['app', 'start', '--json']);
  assert.notEqual(again.status, 0);
  const second = cli(root, ['app', 'start']);
  assert.match(second.stderr + second.stdout, /already running/u);
  const stop = JSON.parse(cli(root, ['app', 'stop', '--json']).stdout);
  assert.equal(stop.stopped, true);
  assert.equal(stop.pid, pid);
  const ended = await started.exited;
  assert.equal(ended.code, 0, started.output());
  assert.equal(alive(pid), false);
  const after = JSON.parse(cli(root, ['app', 'status', '--json']).stdout);
  assert.equal(after.entries[0].started, false);
  assert.equal(after.entries[0].ready, false);
  await assert.rejects(lstat(recordPath), { code: 'ENOENT' });
  // Stopping again stops nothing and says so.
  assert.equal(JSON.parse(cli(root, ['app', 'stop', '--json']).stdout).reason, 'not-recorded');
});

test('app start accepts literal log readiness', async () => {
  const { root } = await fixture({ ready: { log: 'server ready in', timeoutMs: 15_000 } });
  const started = startInBackground(root);
  await started.waitFor(/Ready at/u);
  assert.equal(JSON.parse(cli(root, ['app', 'stop', '--json']).stdout).stopped, true);
  assert.equal((await started.exited).code, 0);
});

test('a readiness timeout is a coded refusal that stops the process tree', async () => {
  const { root } = await fixture({ mode: 'never', ready: { http: '/health', timeoutMs: 1_000 } });
  const started = startInBackground(root);
  const ended = await started.exited;
  assert.notEqual(ended.code, 0);
  assert.match(started.output(), /was not ready within 1000 ms.*Its process tree was stopped/su);
  const pid = Number(await readFile(path.join(root, 'server', 'pid.txt'), 'utf8'));
  assert.equal(alive(pid), false);
  assert.deepEqual(await filesBelow(path.join(root, '.git', 'singularity-flow', 'app')), []);
});

test('environment values reach the started process only when the policy allows and the binding is complete', async () => {
  const off = await fixture({ environments: ['qa'] });
  // app start streams the application's output, so its refusals are words; the codes are pinned
  // on the library boundary in run-and-test-environment.test.mjs.
  const refusedOff = cli(off.root, ['app', 'start']);
  assert.notEqual(refusedOff.status, 0);
  assert.match(refusedOff.stderr, /policy\.localIntegrationEvidence to allowed\. It is off\. Change it through a capability proposal/u);

  const allowed = await fixture({ environments: ['qa', 'dev'], policy: { localIntegrationEvidence: 'allowed' } });
  const unbound = cli(allowed.root, ['app', 'start']);
  assert.match(unbound.stderr, /environment 'qa', which is unbound on this machine \(missing API_TOKEN\).*env bind qa --stdin/su);
  const notAllowed = cli(allowed.root, ['app', 'start', '--environment', 'uat']);
  assert.match(notAllowed.stderr, /may run only in 'qa', 'dev', not 'uat'/u);

  const bind = cli(allowed.root, ['env', 'bind', 'qa', '--stdin'], JSON.stringify({ bindings: { API_TOKEN: { source: 'local', value: SECRET } } }));
  assert.equal(bind.status, 0, bind.stderr);
  const started = startInBackground(allowed.root);
  const output = await started.waitFor(/Ready at/u);
  assert.match(output, /token is \[redacted:API_TOKEN\] and endpoint https:\/\/qa\.example\.test/u);
  assert.doesNotMatch(output, new RegExp(SECRET, 'u'));
  const status = cli(allowed.root, ['app', 'status', '--json']);
  assert.equal(JSON.parse(status.stdout).entries[0].environment, 'qa');
  const record = await readFile(path.join(allowed.root, '.git', 'singularity-flow', 'app', 'web', 'web.json'), 'utf8');
  assert.doesNotMatch(record + status.stdout, new RegExp(SECRET, 'u'));
  assert.equal(JSON.parse(cli(allowed.root, ['app', 'stop', '--json']).stdout).stopped, true);
  assert.equal((await started.exited).code, 0);
  // Nothing the run wrote into the checkout carries the value.
  for (const file of (await filesBelow(allowed.root)).filter((file) => !file.includes(`${path.sep}.git${path.sep}objects`))) {
    if (file.includes(`${path.sep}environments${path.sep}v1${path.sep}`)) continue;
    assert.doesNotMatch(await readFile(file, 'latin1'), new RegExp(SECRET, 'u'), file);
  }
  // The dev environment has no secret and runs too.
  const dev = startInBackground(allowed.root, ['--environment', 'dev']);
  assert.match(await dev.waitFor(/Ready at/u), /Ready at/u);
  assert.equal(JSON.parse(cli(allowed.root, ['app', 'stop', '--json']).stdout).stopped, true);
  await dev.exited;
});

test('an environment a start entry lists must be declared in environments.yml', async () => {
  const { root } = await fixture({ environments: ['uat'], policy: { localIntegrationEvidence: 'allowed' } });
  const result = cli(root, ['app', 'start']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not declared in singularity\/environments\.yml: uat/u);
  const plan = JSON.parse(cli(root, ['app', 'plan', '--json']).stdout);
  assert.deepEqual(plan.entries[0].environments, [{ name: 'uat', status: 'undeclared', default: true }]);
});

test('the readiness smoke check starts a declared entry instead of a detected start command', async () => {
  const { root } = await fixture();
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'web', scripts: { start: 'node index.js' } }));
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=App Tester', '-c', 'user.email=app-tester@example.invalid', 'commit', '-qm', 'package']);
  const plan = await buildRepositoryReadinessPlan(root, { scope: 'full', inferTestCommands: async () => [] });
  const starts = plan.commands.filter((command) => command.purpose === 'start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].source, 'capability-application');
  assert.deepEqual(starts[0].argv, ['node', 'server.mjs', starts[0].argv[2], 'listen']);
  assert.equal(starts[0].workingDirectory, 'server');
  const detected = await buildRepositoryReadinessPlan(root, { scope: 'full', inferTestCommands: async () => [], declaredStartCommands: null });
  assert.ok(detected.commands.filter((command) => command.purpose === 'start').every((command) => command.source !== 'capability-application'));
});
