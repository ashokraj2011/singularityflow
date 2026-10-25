import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/records.mjs';
import { cli, repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

/**
 * Gate test runs are clean and recorded [TCE:REQ-030], through the real CLI: a caller's CI and
 * selection variables never reach the run, the attempt says what shaped it, a process the command
 * left holding its output does not stall it, and an interrupted CLI leaves no test process behind.
 */
const posix = process.platform !== 'win32';
// What a developer's shell or a CI job may hold: each would narrow or change the run unseen.
const NARROWING = { CI: 'false', MAVEN_ARGS: '-Dtest=One', PYTEST_ADDOPTS: '-k one', NODE_OPTIONS: '--test-name-pattern=value', MAVEN_OPTS: '-Xmx64m' };
const REMOVED = ['MAVEN_ARGS', 'NODE_OPTIONS --test-name-pattern', 'PYTEST_ADDOPTS'];

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// ps lists every process still running whose command line holds the marker.
const running = (marker) => spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout
  .split('\n').filter((line) => line.includes(marker) && !line.includes('ps -ax'));
async function gone(pids, marker) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    if (!pids.some(alive) && !running(marker).length) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('a gate test run sees CI=1 and no inherited selection variable, and its attempt records what shaped it', slowLane({ timeout: 480_000 }), async (t) => {
  const repo = await repository(t, { implementCommands: false });
  const { root, sflow } = repo;
  await startQuickFix(repo);
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is two', () => assert.equal(value, 2));\n\n"
    + "test('the gate run is clean, whatever its caller set', () => {\n  assert.equal(process.env.CI, '1');\n"
    + "  for (const name of ['MAVEN_ARGS', 'PYTEST_ADDOPTS']) assert.equal(process.env[name], undefined, name);\n"
    + "  assert.doesNotMatch(process.env.NODE_OPTIONS ?? '', /--test-name-pattern/u);\n"
    + "  assert.equal(process.env.MAVEN_OPTS, '-Xmx64m', 'JVM options are not selection');\n});\n");
  sflow('prepare', 'implement');
  const env = { ...repo.env, ...NARROWING };
  const run = (...args) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd: root, env, encoding: 'utf8', timeout: childTimeout(240_000) });

  // The Story's local run, publication's preflight and submission run the same clean environment.
  const local = run('tests', 'run', '--work-id', 'QF-1', '--json');
  assert.equal(local.status, 0, local.stdout + local.stderr);
  const published = run('phase', 'publish', 'implement');
  assert.equal(published.status, 0, published.stdout + published.stderr);
  const submitted = run('submit', 'implement');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);

  const directory = path.join(root, 'singularity/work-items/QF-1/context/code-delivery/tests/attempts/implement');
  const attempts = await Promise.all((await readdir(directory)).map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  assert.deepEqual(attempts.map((attempt) => attempt.purpose).sort(), ['local', 'preflight', 'submission']);
  for (const attempt of attempts) {
    const { host, ...ran } = attempt.environment;
    assert.equal(host, `node ${process.versions.node}`);
    // The inferred command is `npm test`: Node and npm are its runner family.
    const { toolchain, ...shaped } = ran;
    assert.deepEqual(shaped, { platform: process.platform, arch: process.arch, ci: '1', removed: REMOVED, declaredSha256: null }, attempt.purpose);
    assert.deepEqual(Object.keys(toolchain), ['node', 'npm']);
    assert.equal(toolchain.node, process.versions.node);
    assert.match(toolchain.npm, /^\d+\.\d+\.\d+/u);
    assert.equal(attempt.environmentSha256, `sha256:${createHash('sha256').update(canonicalJson(ran)).digest('hex')}`);
    assert.deepEqual([attempt.status, attempt.tests.discovered, attempt.tests.passed], ['passed', 2, 2],
      `${attempt.purpose}: NODE_OPTIONS no longer narrows the run to the tests named like "value"`);
    assert.ok(!JSON.stringify(attempt).includes('-Dtest=One'), 'a removed value is never recorded');
  }
});

test('a test command whose process leaves output held ends promptly, and an interrupted CLI leaves no test process behind', { skip: !posix }, async (t) => {
  const marker = `sflow-held-${randomUUID()}`;
  const tool = (hang) => `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\n`
    + `const held = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', '${marker}'], { stdio: ['ignore', 'inherit', 'inherit'] });\n`
    + `writeFileSync(process.env.SFLOW_FIXTURE_PIDS, JSON.stringify([process.pid, held.pid]));\n`
    + (hang ? 'setTimeout(() => {}, 120000);\n' : "console.log('TOTAL: 1 SUCCESS');\nprocess.exit(0);\n");
  const command = (id) => ({ id, kind: 'test', argv: ['node', `tools/${id}.mjs`], workingDirectory: '.', affectedRoots: [id], modelPolicy: 'never',
    timeoutMs: 60_000, result: { adapter: 'karma-text', path: `.sflow/results/${id}.txt` } });
  const repo = await repository(t, { extraCommands: [command('leak'), command('hang')],
    files: { 'tools/leak.mjs': tool(false), 'tools/hang.mjs': tool(true) } });
  const pidsFile = path.join(repo.base, 'pids.json');
  const env = { ...repo.env, SFLOW_FIXTURE_PIDS: pidsFile };
  const leftover = [];
  t.after(() => { for (const pid of leftover) if (alive(pid)) process.kill(pid, 'SIGKILL'); });

  // The command exits and a process it started keeps its stdout open: the run still ends, passed.
  const started = Date.now();
  const leak = spawnSync(process.execPath, [cli, '--no-model', 'tests', 'run', '--command', 'leak', '--json'],
    { cwd: repo.root, env, encoding: 'utf8', timeout: childTimeout(120_000) });
  const elapsed = Date.now() - started;
  const leaked = JSON.parse(await readFile(pidsFile, 'utf8'));
  leftover.push(...leaked);
  assert.equal(leak.status, 0, leak.stdout + leak.stderr);
  assert.deepEqual(JSON.parse(leak.stdout).commands.map((entry) => [entry.id, entry.status]), [['leak', 'passed']]);
  assert.ok(elapsed < 45_000, `the run ended after ${elapsed} ms, not at its 60 s deadline`);
  assert.ok(await gone(leaked, marker), `the process holding the output was ended: ${running(marker).join('; ')}`);

  // The CLI is interrupted while its test command runs: the command and what it started end too.
  await writeFile(pidsFile, '');
  const cli2 = spawn(process.execPath, [cli, '--no-model', 'tests', 'run', '--command', 'hang', '--json'], { cwd: repo.root, env, stdio: 'ignore' });
  const exited = new Promise((resolve) => cli2.on('exit', (code, signal) => resolve({ code, signal })));
  let hung = null;
  for (const deadline = Date.now() + childTimeout(60_000); !hung && Date.now() < deadline;) {
    hung = await readFile(pidsFile, 'utf8').then((text) => (text ? JSON.parse(text) : null), () => null);
    if (!hung) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(hung, 'the test command started');
  leftover.push(...hung);
  cli2.kill('SIGINT');
  assert.deepEqual(await exited, { code: null, signal: 'SIGINT' });
  assert.ok(await gone(hung, marker), `no test process is left behind: ${running(marker).join('; ')}`);
});
