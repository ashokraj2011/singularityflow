import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/**
 * `session open --for-agent --json` must finish or refuse with a classified reason in bounded time.
 * It once waited 125 seconds and then said only that Git exceeded its deadline: the repository's own
 * Git files were undownloaded cloud placeholders (simulated here by named pipes, which block Git
 * the same way), and a Git child it started outlived it.
 */
const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const posix = process.platform !== 'win32';

function fixtureEnv(base, extra = {}) {
  return { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Bounded Opener',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Bounded Opener',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'bounded.opener@example.invalid', ...extra };
}

async function storyFixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-bounded-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = fixtureEnv(base);
  const must = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  };
  must('git', ['init', '-q', '-b', 'main', root], base);
  await writeFile(path.join(root, 'README.md'), '# Bounded session open\n');
  must(process.execPath, [cli, '--no-model', 'init']);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.ledger.enabled = true;
  await writeFile(definitionPath, YAML.stringify(definition));
  must('git', ['add', '.']);
  must('git', ['commit', '-q', '-m', 'Bounded fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  must(process.execPath, [cli, '--no-model', 'start', 'BOUND-1', '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Bounded open', '--description', 'Session open is bounded.']);
  must('git', ['checkout', '-q', 'main']);
  return { base, root };
}

/** A copy whose registries and Git directory belong to it alone. */
function copyFixture(fixture, name) {
  const base = path.join(fixture.base, name);
  cpSync(fixture.root, path.join(base, 'repo'), { recursive: true });
  return { base, root: path.join(base, 'repo') };
}

function openSession(copy, extra) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, [cli, 'session', 'open', '--for-agent', '--json', '--refresh'], {
      cwd: copy.root, env: fixtureEnv(copy.base, extra), stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    const cap = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('close', (code) => {
      clearTimeout(cap);
      let result = null;
      try {
        result = JSON.parse(stdout);
        if (result.agentOutput?.path) result = JSON.parse(readFileSync(result.agentOutput.path, 'utf8'));
      } catch { /* asserted by the caller */ }
      resolve({ code, elapsedMs: performance.now() - started, stdout, result });
    });
  });
}

function gitProcessesUsing(text) {
  const listed = spawnSync('pgrep', ['-fl', text], { encoding: 'utf8' }).stdout ?? '';
  return listed.split('\n').filter((line) => /\bgit\b/.test(line));
}

test('session open refuses within its bounds when Git cannot read the repository, or the remote is silent or unreachable',
  { skip: !posix, timeout: 300_000 }, async (t) => {
    const fixture = await storyFixture(t);

    await t.test('undownloaded Git files are named instead of waiting for a Git deadline', async () => {
      const copy = copyFixture(fixture, 'unreadable');
      const objects = path.join(copy.root, '.git', 'objects');
      for (const directory of readdirSync(objects).filter((name) => /^[0-9a-f]{2}$/.test(name))) {
        for (const object of readdirSync(path.join(objects, directory))) {
          const file = path.join(objects, directory, object);
          rmSync(file);
          execFileSync('mkfifo', [file]);
        }
      }
      const opened = await openSession(copy, {
        SINGULARITY_FLOW_GIT_STORAGE_CHECK: 'always', SINGULARITY_FLOW_GIT_STORAGE_DOWNLOAD_TIMEOUT_MS: '500'
      });
      assert.notEqual(opened.code, 0);
      assert.ok(opened.elapsedMs < 20_000, `refused in ${Math.round(opened.elapsedMs)} ms`);
      assert.ok(opened.result, opened.stdout);
      assert.equal(opened.result.error.code, 'GIT_STORAGE_UNAVAILABLE');
      assert.ok(opened.result.error.message.includes(path.join(copy.root, '.git')), opened.result.error.message);
      // This remote has no approved configuration branch, so the Stories cannot be listed from it either.
      assert.match(opened.result.error.message, /Listing the Stories from the remote instead also failed/);
      assert.equal(opened.result.act.state, 'refused');
    });

    await t.test('a silent remote ends in a classified timeout and leaves no Git behind', async (t2) => {
      const sockets = new Set();
      const server = net.createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t2.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
      const url = `http://127.0.0.1:${server.address().port}/silent.git`;
      const copy = copyFixture(fixture, 'silent');
      execFileSync('git', ['remote', 'set-url', 'origin', url], { cwd: copy.root });
      const opened = await openSession(copy, {
        SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS: '1500', SINGULARITY_FLOW_GIT_CONFIGURATION_TIMEOUT_MS: '1500'
      });
      assert.notEqual(opened.code, 0);
      assert.ok(opened.elapsedMs < 30_000, `refused in ${Math.round(opened.elapsedMs)} ms`);
      assert.equal(opened.result?.error?.code, 'SESSION_STATE_REFRESH_UNAVAILABLE', opened.stdout);
      const failure = opened.result.error.remoteFailure ?? opened.result.error.details?.remoteFailure;
      assert.equal(failure.failure.classification, 'operation-timeout');
      assert.equal(failure.evidence.timedOut, true);
      assert.deepEqual(gitProcessesUsing(String(server.address().port)), []);
    });

    await t.test('an unreachable remote is refused promptly as a network failure', async () => {
      const probe = net.createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      const copy = copyFixture(fixture, 'unreachable');
      execFileSync('git', ['remote', 'set-url', 'origin', `http://127.0.0.1:${port}/closed.git`], { cwd: copy.root });
      const opened = await openSession(copy, {});
      assert.notEqual(opened.code, 0);
      assert.ok(opened.elapsedMs < 30_000, `refused in ${Math.round(opened.elapsedMs)} ms`);
      assert.equal(opened.result?.error?.code, 'SESSION_STATE_REFRESH_UNAVAILABLE', opened.stdout);
      const failure = opened.result.error.remoteFailure ?? opened.result.error.details?.remoteFailure;
      assert.equal(failure.failure.classification, 'network-transient');
    });
  });
