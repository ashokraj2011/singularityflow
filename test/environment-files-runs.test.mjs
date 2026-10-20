import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CLI, git, repository as envRepository, writeFiles } from './helpers/environment-files-fixture.mjs';
import { repository as testsRepository } from './helpers/run-and-test-fixture.mjs';

const WEB_SECRET = 'web-token-secret-7731';
const API_SECRET = 'api-db-pass-9142';
const SERVER = (file, label) => `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('pid.txt', String(process.pid));
console.log('${label} read: ' + readFileSync('${file}', 'utf8').trim().split('\\n').join(' | '));
console.log('${label} ready');
setInterval(() => {}, 1000);
`;
const MONOREPO = `schemaVersion: 1
environments:
  dev:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://dev.example.test" }
    localFiles: [services/api/src/main/resources/application-dev.yml, apps/web/.env.dev]
`;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const started = new Set();
after(() => { for (const child of started) { try { child.kill('SIGKILL'); } catch { /* gone */ } } });

function startInBackground(repo, args) {
  const child = spawn(process.execPath, [CLI, 'app', 'start', ...args], { cwd: repo.root, env: repo.env, stdio: ['ignore', 'pipe', 'pipe'] });
  started.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('close', resolve));
  return {
    exited, output: () => output,
    async waitFor(pattern, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !pattern.test(output)) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.match(output, pattern);
    }
  };
}

async function monorepo(t) {
  const [apiPort, webPort] = [await freePort(), await freePort()];
  const entry = (id, workingDirectory, port) => ({ id, argv: ['node', 'server.mjs'], workingDirectory, url: `http://127.0.0.1:${port}/`,
    ready: { log: `${id} ready`, timeoutMs: 20_000 }, environments: ['dev'] });
  const capabilities = { version: 1, capabilities: {
    api: { kind: 'delivery', repository: 'mono', sourceRoots: ['services/api'], policy: { localIntegrationEvidence: 'allowed' },
      application: { start: [entry('api', 'services/api', apiPort)] } },
    web: { kind: 'delivery', repository: 'mono', sourceRoots: ['apps/web'], policy: { localIntegrationEvidence: 'allowed' },
      application: { start: [entry('web', 'apps/web', webPort)] } }
  } };
  return envRepository(t, { declaration: MONOREPO, files: {
    'singularity/capabilities.yml': JSON.stringify(capabilities, null, 2),
    'services/api/server.mjs': SERVER('src/main/resources/application-dev.yml', 'api'),
    'services/api/src/main/resources/application-dev.example.yml': 'spring:\n  datasource:\n    password: CHANGE_ME\n',
    'apps/web/server.mjs': SERVER('.env.dev', 'web')
  } });
}

test('app start places only its app\'s files, refuses a missing one before anything runs, and redacts file values', { timeout: 180_000 }, async (t) => {
  const repo = await monorepo(t);
  const refused = repo.sflow(['app', 'start', 'web', '--capability', 'web']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /needs a file of this repository that is missing on this machine: apps\/web\/\.env\.dev\./u);
  assert.doesNotMatch(refused.stderr, /application-dev\.yml/u, 'the api app\'s file is not the web app\'s concern');
  assert.equal(await lstat(path.join(repo.root, 'apps/web/pid.txt')).catch(() => null), null, 'nothing started');

  const web = repo.json(['env', 'files', 'create', 'dev', 'apps/web/.env.dev']).value;
  await writeFile(web.location, `API_TOKEN=${WEB_SECRET}\nPORT=3000\n`);
  const run = startInBackground(repo, ['web', '--capability', 'web']);
  await run.waitFor(/Ready at/u);
  assert.match(run.output(), /Environment files for dev: apps\/web\/\.env\.dev/u);
  assert.match(run.output(), /web read: API_TOKEN=\[redacted:ENV_DEV-API_TOKEN\] \| PORT=3000/u);
  assert.equal(run.output().includes(WEB_SECRET), false);
  assert.equal(await lstat(path.join(repo.root, 'services/api/src/main/resources/application-dev.yml')).catch(() => null), null);
  const record = JSON.parse(await readFile(path.join(repo.root, '.git', 'singularity-flow', 'app', 'web', 'web.json'), 'utf8'));
  assert.deepEqual(record.environmentFiles, { checkout: repo.root, paths: ['apps/web/.env.dev'] });
  assert.equal(JSON.stringify(record).includes(WEB_SECRET), false);
  assert.equal(repo.sflow(['app', 'stop', 'web', '--capability', 'web']).status, 0);
  await run.exited;

  const api = repo.json(['env', 'files', 'create', 'dev', 'services/api/src/main/resources/application-dev.yml', '--from-template']).value;
  await writeFile(api.location, `spring:\n  datasource:\n    url: jdbc:postgresql://localhost/app\n    password: ${API_SECRET}\n`);
  const apiRun = startInBackground(repo, ['api', '--capability', 'api']);
  await apiRun.waitFor(/Ready at/u);
  assert.match(apiRun.output(), /password: \[redacted:APPLICATION_DEV_YML-SPRING_DATASOURCE_PASSWORD\]/u);
  assert.match(apiRun.output(), /url: jdbc:postgresql:\/\/localhost\/app/u, 'a value that does not look secret is shown');
  assert.equal(apiRun.output().includes(API_SECRET), false);
  assert.equal(repo.sflow(['app', 'stop', 'api', '--capability', 'api']).status, 0);
  await apiRun.exited;
});

const CHECK = `import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';

test('reads the placed environment file', () => {
  appendFileSync(process.env.FIXTURE_FLAG, 'ran\\n');
  const text = readFileSync('.env.qa', 'utf8');
  console.log('file holds ' + text.trim());
  assert.equal(text.trim(), 'nothing like this', 'saw ' + text.trim());
});
`;

test('tests run refuses a missing environment file before any command runs, then places it and redacts its values', { timeout: 300_000 }, async (t) => {
  const command = { id: 'integration-tests', kind: 'test', argv: ['node', '--test', 'integration/qa.check.mjs'], workingDirectory: '.',
    affectedRoots: ['integration'], modelPolicy: 'never', result: { adapter: 'node-tap', path: '.sflow/results/integration.tap' } };
  const repo = await testsRepository(t, { implementQualityCommands: [command], files: { 'integration/qa.check.mjs': CHECK } });
  repo.env.FIXTURE_FLAG = path.join(repo.base, 'integration-ran.flag');
  await writeFiles(repo.root, {
    'singularity/environments.yml': 'schemaVersion: 1\nenvironments:\n  qa:\n    requires:\n      - { name: API_BASE_URL, kind: endpoint, value: "https://qa.example.test" }\n    localFiles: [.env.qa]\n',
    'singularity/capabilities.yml': JSON.stringify({ version: 1, capabilities: { web: { kind: 'delivery', repository: 'web',
      application: { tests: [{ use: 'integration-tests', environments: ['qa'] }] }, policy: { localIntegrationEvidence: 'allowed' } } } }, null, 2)
  });
  repo.must('git', ['add', '.']);
  repo.must('git', ['commit', '-q', '-m', 'environment files']);
  const refused = repo.sflowJson('tests', 'run', '--command', 'integration-tests');
  assert.equal(refused.status, 1);
  assert.equal(refused.value.error.code, 'ENV_FILE_MISSING');
  assert.deepEqual([refused.value.error.details.environment, refused.value.error.details.path], ['qa', '.env.qa']);
  await assert.rejects(readFile(repo.env.FIXTURE_FLAG), { code: 'ENOENT' }, 'nothing ran');
  const created = repo.sflowJson('env', 'files', 'create', 'qa', '.env.qa').value;
  await writeFile(created.location, 'QA_SECRET_TOKEN=qa-file-secret-5512\n');
  const ran = repo.sflowJson('tests', 'run', '--command', 'integration-tests');
  assert.equal(ran.value.run.environment, 'qa');
  assert.equal(await readFile(repo.env.FIXTURE_FLAG, 'utf8'), 'ran\n');
  const summary = repo.sflowJson('tests', 'summary', '--capability', 'web');
  const text = JSON.stringify([ran.value, summary.value]);
  assert.equal(text.includes('qa-file-secret-5512'), false, 'the run result and its summary never hold the value');
  assert.match(text, /\[redacted:ENV_QA-QA_SECRET_TOKEN\]/u, 'the failure message shows where the value was');
  const runs = path.join(repo.root, '.git', 'singularity-flow', 'test-runs', 'web');
  for (const name of await readdir(runs)) assert.equal((await readFile(path.join(runs, name), 'utf8')).includes('qa-file-secret-5512'), false);
  assert.equal(git(repo.root, ['status', '--porcelain', '--', '.env.qa']).stdout, '');
});

test('a repository without exact localFiles and without a registry loads no environment-file module', { timeout: 120_000 }, async (t) => {
  const repo = await envRepository(t, { declaration: 'schemaVersion: 1\nenvironments:\n  qa:\n    requires:\n      - { name: API_BASE_URL, kind: endpoint, value: "https://qa.example.test" }\n    localFiles: ["config/*.local.yml"]\n' });
  const hooks = path.join(repo.base, 'hooks');
  await writeFiles(hooks, {
    'register.mjs': "import { register } from 'node:module';\nregister('./resolve.mjs', import.meta.url);\n",
    'resolve.mjs': "import { appendFileSync } from 'node:fs';\nexport async function resolve(specifier, context, next) {\n  const resolved = await next(specifier, context);\n  appendFileSync(process.env.RESOLVED_LOG, resolved.url + '\\n');\n  return resolved;\n}\n",
    'probe.mjs': `const { materializeEnvironmentBinding } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../src/environment-bindings.mjs', import.meta.url))).href)});
try {
  const result = await materializeEnvironmentBinding(process.argv[2], 'qa', { files: { checkout: process.argv[2] } });
  console.log(JSON.stringify({ status: result.status, files: result.environmentFiles }));
} catch (error) { console.log(JSON.stringify({ error: error.code })); }
`
  });
  const probe = async (label) => {
    const log = path.join(repo.base, `${label}.log`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(hooks, 'register.mjs')).href, path.join(hooks, 'probe.mjs'), repo.root],
      { cwd: repo.root, env: { ...repo.env, RESOLVED_LOG: log }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { output: JSON.parse(result.stdout), loaded: await readFile(log, 'utf8') };
  };
  const none = await probe('none');
  assert.deepEqual(none.output, { status: 'bound', files: null });
  assert.match(none.loaded, /environment-bindings\.mjs/u);
  assert.doesNotMatch(none.loaded, /environment-files/u, 'globs alone cost nothing new');
  // An exact path makes the run look, and load, the engine.
  await writeFile(path.join(repo.root, 'singularity/environments.yml'), MONOREPO.replace('dev:', 'qa:'));
  const exact = await probe('exact');
  assert.deepEqual(exact.output, { error: 'ENV_FILE_MISSING' });
  assert.match(exact.loaded, /environment-files\.mjs/u);
});

const STORY_CHECK = `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('reaches the configured service', () => {
  const text = readFileSync('.env.qa', 'utf8').trim();
  console.log('qa file: ' + text);
  assert.match(text, /^QA_SECRET_TOKEN=/u);
});
`;

test('a Story step\'s local run and its publish gate place the file, block without it, and redact it in kept reports', { timeout: 400_000 }, async (t) => {
  const { startQuickFix } = await import('./helpers/run-and-test-fixture.mjs');
  const command = { id: 'integration-tests', kind: 'test', argv: ['node', '--test', 'integration/qa.check.mjs'], workingDirectory: '.',
    affectedRoots: ['integration'], modelPolicy: 'never', result: { adapter: 'node-tap', path: '.sflow/results/integration.tap' } };
  const repo = await testsRepository(t, { implementQualityCommands: [command], files: { 'integration/qa.check.mjs': STORY_CHECK } });
  await writeFiles(repo.root, {
    'singularity/environments.yml': 'schemaVersion: 1\nenvironments:\n  qa:\n    requires:\n      - { name: API_BASE_URL, kind: endpoint, value: "https://qa.example.test" }\n    localFiles: [.env.qa]\nchecks:\n  integration-tests: { environment: qa }\n',
    'singularity/capabilities.yml': JSON.stringify({ version: 1, capabilities: { web: { kind: 'delivery', repository: 'web',
      application: { tests: [{ use: 'integration-tests', environments: ['qa'] }] }, policy: { localIntegrationEvidence: 'allowed' } } } }, null, 2)
  });
  repo.must('git', ['add', '.']);
  repo.must('git', ['commit', '-q', '-m', 'environment files']);
  await startQuickFix(repo);
  repo.sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is two', () => assert.equal(value, 2));\n");
  repo.sflow('prepare', 'implement');

  const local = repo.sflowJson('tests', 'run', '--work-id', 'QF-1', '--command', 'integration-tests');
  assert.equal(local.value.error?.code, 'ENV_FILE_MISSING', JSON.stringify(local.value).slice(0, 400));
  const blocked = repo.sflowJson('phase', 'publish', 'implement');
  assert.equal(blocked.status, 1);
  assert.match(JSON.stringify(blocked.value), /ENV_FILE_MISSING|needs a file of this repository that is missing on this machine: \.env\.qa/u);

  const created = repo.sflowJson('env', 'files', 'create', 'qa', '.env.qa').value;
  await writeFile(created.location, 'QA_SECRET_TOKEN=story-file-secret-8820\n');
  const published = repo.run(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'implement']);
  assert.equal(published.status, 0, `${published.stdout}\n${published.stderr}`);
  const attemptsDirectory = path.join(repo.root, 'singularity/work-items/QF-1/context/code-delivery/tests/attempts/implement');
  const attempts = await Promise.all((await readdir(attemptsDirectory)).map(async (name) => JSON.parse(await readFile(path.join(attemptsDirectory, name), 'utf8'))));
  const gate = attempts.find((attempt) => attempt.commandId === 'integration-tests' && attempt.purpose === 'preflight');
  assert.equal(gate.status, 'passed');
  const rawDirectory = path.join(repo.root, 'singularity/work-items/QF-1/context/code-delivery/tests/raw');
  const raw = (await Promise.all(gate.rawReports.map((report) => readFile(path.join(rawDirectory, path.basename(report.path)), 'utf8')))).join('\n');
  assert.match(raw, /qa file: QA_SECRET_TOKEN=\[redacted:ENV_QA-QA_SECRET_TOKEN\]/u);
  for (const ref of repo.must('git', ['for-each-ref', '--format=%(refname)']).trim().split('\n')) {
    assert.doesNotMatch(repo.run('git', ['log', '-p', '--all', ref]).stdout, /story-file-secret-8820/u);
  }
  assert.equal(repo.must('git', ['ls-files', '--', '.env.qa']), '', 'the placed file never entered Git');
});
