/** Real subprocesses and private files: target isolation, service lifetime and evidence boundaries. */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { repository, git, withMachineState } from './helpers/environment-files-fixture.mjs';
import { resolveCapabilityApplication } from '../src/capability-application-context.mjs';
import { normalizeCapabilityApplication } from '../src/capabilities.mjs';
import { applicationCommandSha256, applicationStatus, appRecordPath, startApplication, readAppRecord, recordedProcessAlive,
  applicationCheckoutInUse, processStartIdentity } from '../src/application-run.mjs';
import { dependencyOrder } from '../src/application-dependencies.mjs';
import { saveLocalApplicationProfile, resetLocalApplicationProfile, localApplicationProfilePath } from '../src/local-application-profile.mjs';
import { commandScope, overrideStoryEnvironmentFile, environmentFilesReport, storyEnvironmentFilePath, placeEnvironmentFilesForRun } from '../src/environment-files.mjs';
import { checkApplicationConnections } from '../src/application-connections.mjs';

const server = `import http from 'node:http';
http.createServer((req,res)=>res.end('ok')).listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('service ready'));
`;
const quiet = { write() {} };
async function port() { const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const value = socket.address().port; await new Promise(resolve => socket.close(resolve)); return value; }
function entry(id, port, dependsOn = []) { return { id, argv: ['node', 'server.mjs', String(port)], url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 5000 }, ...(dependsOn.length ? { dependsOn } : {}) }; }
async function fixture(t, entries) { return repository(t, { files: { 'server.mjs': server, 'singularity/capabilities.yml': JSON.stringify({ version: 1, capabilities: { web: { kind: 'delivery', repository: 'web', application: { start: entries, tests: [] } } } }) } }); }
async function context(root) { return resolveCapabilityApplication(root, { capabilityId: 'web' }); }
function launch(root, context, entry, options = {}) {
  const cancel = new AbortController();
  let ready, failed;
  const readiness = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  const running = startApplication(root, context, entry, { output: quiet, errorOutput: quiet, signals: [], signal: cancel.signal, onReady: ready, ...options });
  running.then(result => failed(new Error(`Exited before readiness: ${JSON.stringify(result)}`)), failed);
  return { ready: readiness, running, async stop() { cancel.abort(); await running.catch(() => {}); } };
}

test('two linked Story checkouts have independent run records and cleanup preserves running work', async t => {
  const repo = await fixture(t, [entry('web', await port())]);
  await withMachineState(repo.env, async () => {
    const linked = path.join(repo.base, 'story'); git(repo.root, ['worktree', 'add', '-qb', 'story', linked]);
    const first = await context(repo.root), second = await context(linked);
    // A personal port override allows both copies of the application to run concurrently.
    await saveLocalApplicationProfile(linked, second, { start: [entry('web', await port())], tests: [] });
    const configured = await context(linked);
    assert.notEqual(appRecordPath(repo.root, 'web', 'web'), appRecordPath(linked, 'web', 'web'));
    assert.equal((await applicationStatus(linked, configured)).entries[0].started, false);
    const a = launch(repo.root, first, first.application.start[0]);
    const b = launch(linked, configured, configured.application.start[0]);
    try {
      await Promise.all([a.ready, b.ready]);
      assert.equal(await applicationCheckoutInUse(linked), true);
      const firstPid = (await readAppRecord(repo.root, 'web', 'web')).pid;
      assert.notEqual(firstPid, (await readAppRecord(linked, 'web', 'web')).pid);
      await b.stop();
      assert.equal(await applicationCheckoutInUse(linked), false);
      assert.equal(recordedProcessAlive(await readAppRecord(repo.root, 'web', 'web')), true);
    } finally { await b.stop(); await a.stop(); }
  });
});

test('dependency order deduplicates diamonds; confirmation changes when any required command changes', async t => {
  const list = [entry('db', await port()), entry('api', await port(), ['db']), entry('worker', await port(), ['db']), entry('web', await port(), ['api', 'worker'])];
  const repo = await fixture(t, list);
  await withMachineState(repo.env, async () => {
    const original = await context(repo.root), main = original.application.start[3];
    assert.deepEqual(dependencyOrder(original, main).map(item => item.id), ['db', 'api', 'worker']);
    const changed = structuredClone(original); changed.application.start[0].argv.push('new-option');
    assert.notEqual(applicationCommandSha256(original, main), applicationCommandSha256(changed, changed.application.start[3]));
    await assert.rejects(startApplication(repo.root, changed, changed.application.start[3], { expectedCommandSha256: applicationCommandSha256(original, main) }), { code: 'APP_COMMAND_CHANGED' });
    assert.equal(await readAppRecord(repo.root, 'web', 'db'), null);
    assert.throws(() => normalizeCapabilityApplication('web', { repository: 'web', application: { start: [entry('web', 4000, ['missing'])] } }), /dependency|dependsOn|unknown/i);
    assert.throws(() => normalizeCapabilityApplication('web', { repository: 'web', application: { start: [entry('web', 4000, ['db']), entry('db', 4001, ['web'])] } }), /cycle/i);
  });
});

test('required services start before the application and are stopped with their owning run', async t => {
  const repo = await fixture(t, [entry('api', await port()), entry('web', await port(), ['api'])]);
  await withMachineState(repo.env, async () => {
    const c = await context(repo.root), app = launch(repo.root, c, c.application.start[1]);
    try {
      await app.ready;
      assert.equal((await readAppRecord(repo.root, 'web', 'api')).managedDependency, true);
      assert.equal(recordedProcessAlive(await readAppRecord(repo.root, 'web', 'api')), true);
    } finally { await app.stop(); }
    assert.equal(await readAppRecord(repo.root, 'web', 'api'), null);
    assert.equal(await readAppRecord(repo.root, 'web', 'web'), null);
  });
});

test('a compatible manually started service is reused and not stopped by a dependent application', async t => {
  const repo = await fixture(t, [entry('api', await port()), entry('web', await port(), ['api'])]);
  await withMachineState(repo.env, async () => {
    const c = await context(repo.root), api = launch(repo.root, c, c.application.start[0]);
    let app;
    try {
      await api.ready; const pid = (await readAppRecord(repo.root, 'web', 'api')).pid;
      app = launch(repo.root, c, c.application.start[1]); await app.ready; await app.stop();
      assert.equal((await readAppRecord(repo.root, 'web', 'api')).pid, pid);
      assert.equal(recordedProcessAlive(await readAppRecord(repo.root, 'web', 'api')), true);
    } finally { await app?.stop(); await api.stop(); }
  });
});

test('a service failure prevents the parent from starting and preserves no owned processes', async t => {
  const bad = entry('api', await port()); bad.argv = ['node', '-e', 'process.exit(7)'];
  // Its exit is what this proves: a loaded machine took over 5 s to start Node, and readiness refused first.
  bad.ready = { ...bad.ready, timeoutMs: 120_000 };
  const repo = await fixture(t, [bad, entry('web', await port(), ['api'])]);
  await withMachineState(repo.env, async () => {
    const c = await context(repo.root);
    await assert.rejects(startApplication(repo.root, c, c.application.start[1], { output: quiet, errorOutput: quiet, signals: [] }), /exited|ended/i);
    assert.equal(await readAppRecord(repo.root, 'web', 'api'), null);
    assert.equal(await readAppRecord(repo.root, 'web', 'web'), null);
  });
});

test('personal profiles cannot replace tests; reset preserves their data and team changes require review', async t => {
  const repo = await fixture(t, [entry('web', await port())]);
  await withMachineState(repo.env, async () => {
    const c = await context(repo.root);
    await assert.rejects(saveLocalApplicationProfile(repo.root, c, { start: [], tests: [{ use: 'different-tests' }] }), { code: 'APP_LOCAL_TEST_SCOPE_DENIED' });
    await saveLocalApplicationProfile(repo.root, c, { start: [], tests: [] });
    assert.equal((await context(repo.root)).applicationSource, 'personal-checkout');
    const file = localApplicationProfilePath(repo.root, 'web'), bytes = await readFile(file);
    const teamFile = path.join(repo.root, 'singularity/capabilities.yml');
    await writeFile(teamFile, (await readFile(teamFile, 'utf8')).replace('"web":', '"web": '));
    await assert.rejects(context(repo.root), { code: 'APP_LOCAL_PROFILE_STALE' });
    await resetLocalApplicationProfile(repo.root, 'web');
    const retained = (await readdir(path.dirname(file))).find(name => name.includes('.retained-'));
    assert.deepEqual(await readFile(path.join(path.dirname(file), retained)), bytes);
    assert.equal((await context(repo.root)).applicationSource, 'team');
  });
});

test('Story YAML overrides are private, isolated, excluded, and retained when reset', async t => {
  const repo = await repository(t, { declaration: 'schemaVersion: 1\nenvironments:\n  dev:\n    requires: [{ name: API_URL, kind: endpoint, value: "https://api.example.test" }]\n    localFiles: [config/dev.local.yml]\n', files: { 'config/dev.example.yml': 'endpoint: localhost\n' } });
  await withMachineState(repo.env, async () => {
    const linked = path.join(repo.base, 'story'); git(repo.root, ['worktree', 'add', '-qb', 'story', linked]);
    const scope = await commandScope(linked);
    const result = await overrideStoryEnvironmentFile(scope, 'dev', 'config/dev.local.yml');
    await writeFile(result.location, 'token: story-only-private-value\n', { mode: 0o600 });
    await placeEnvironmentFilesForRun(linked, 'dev');
    const report = await environmentFilesReport(linked, { environment: 'dev' });
    assert.doesNotMatch(JSON.stringify(report), /story-only-private-value/);
    assert.equal(await readFile(path.join(linked, 'config/dev.local.yml'), 'utf8'), 'token: story-only-private-value\n');
    assert.notEqual(result.location, storyEnvironmentFilePath(repo.root, 'dev', 'config/dev.local.yml'));
    assert.equal(git(linked, ['check-ignore', 'config/dev.local.yml']).status, 0);
    const cleared = await overrideStoryEnvironmentFile(scope, 'dev', 'config/dev.local.yml', { clear: true });
    assert.match(await readFile(cleared.location, 'utf8'), /story-only-private-value/);
    assert.equal(cleared.preserved, true);
  });
});

test('connection checks are bounded, parallel, credential-free and return metadata only', async t => {
  const declaration = { schemaVersion: 1, environments: { dev: { requires: Array.from({ length: 6 }, (_, i) => ({ name: `API_${i}`, kind: 'endpoint', value: `https://api-${i}.example.test/private` })) } } };
  const repo = await repository(t, { declaration: JSON.stringify(declaration) });
  await withMachineState(repo.env, async () => {
    let active = 0, peak = 0;
    const result = await checkApplicationConnections(repo.root, 'dev', { request: async (url, options) => {
      assert.equal(options.method, 'HEAD'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual'); assert.equal(options.headers, undefined);
      active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 10)); active--;
      return { status: url.hostname.includes('1.') ? 401 : 204, body: null };
    } });
    assert.ok(peak > 1 && peak <= 4);
    assert.equal(result.credentialsSent, false); assert.equal(result.evidenceClass, 'local-preview');
    assert.equal(result.connections[1].authentication, 'required-or-refused');
    assert.doesNotMatch(JSON.stringify(result), /example.test|\/private/);
    const cancel = new AbortController(); cancel.abort(); let calls = 0;
    const cancelled = await checkApplicationConnections(repo.root, 'dev', { signal: cancel.signal, request: async () => { calls++; } });
    assert.equal(calls, 0); assert.ok(cancelled.connections.every(item => item.status === 'cancelled'));
  });
});

test('Windows process identity uses the system executable, numeric PID and a bounded request', () => {
  let invocation;
  assert.equal(processStartIdentity(1234, { platform: 'win32', spawnSyncCommand: (...args) => { invocation = args; return { status: 0, stdout: '123456789\r\n' }; } }), '123456789');
  assert.match(invocation[0], /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(invocation[2].timeout, 2000); assert.equal(invocation[2].windowsHide, true);
  assert.match(invocation[1].at(-1), /GetProcessById\(1234\)/);
  assert.equal(processStartIdentity(-1), null);
});


test('the actual CLI saves a personal profile without changing team configuration', async t => {
  const repo = await fixture(t, [entry('web', await port())]);
  const file = path.join(repo.base, 'application.json');
  await writeFile(file, JSON.stringify({ start: [], tests: [] }));
  const before = await readFile(path.join(repo.root, 'singularity/capabilities.yml'));
  const saved = repo.json(['app', 'config', 'save-local', '--capability', 'web', '--application-file', file]);
  assert.equal(saved.status, 0, saved.stderr); assert.equal(saved.value.scope, 'checkout');
  const plan = repo.json(['app', 'plan', '--capability', 'web']);
  assert.equal(plan.status, 0, plan.stderr); assert.equal(plan.value.applicationSource, 'personal-checkout'); assert.deepEqual(plan.value.entries, []);
  assert.deepEqual(await readFile(path.join(repo.root, 'singularity/capabilities.yml')), before);
  assert.equal(repo.json(['app', 'config', 'reset-local', '--capability', 'web']).status, 0);
});

test('personal run configurations also work before an explicit capability map exists', async t => {
  const repo = await repository(t);
  await withMachineState(repo.env, async () => {
    const c = await resolveCapabilityApplication(repo.root, { readApplication: false });
    await saveLocalApplicationProfile(repo.root, c, { start: [entry('local', await port())], tests: [] });
    const configured = await resolveCapabilityApplication(repo.root);
    assert.equal(configured.implicit, true); assert.equal(configured.application.start[0].id, 'local');
  });
});

test('cancelling dependency startup stops owned services before the main process starts', async t => {
  const never = entry('api', await port()); never.argv = ['node', '-e', 'setInterval(() => {}, 1000)'];
  const repo = await fixture(t, [never, entry('web', await port(), ['api'])]);
  await withMachineState(repo.env, async () => {
    const c = await context(repo.root), app = launch(repo.root, c, c.application.start[1]);
    // Attach a handler to readiness too, since this run intentionally never reaches it.
    app.ready.catch(() => {});
    try {
      const deadline = Date.now() + 5000;
      while (!await readAppRecord(repo.root, 'web', 'api') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(await readAppRecord(repo.root, 'web', 'api'));
    } finally { await app.stop(); }
    assert.equal((await app.running).outcome, 'stopped');
    assert.equal((await app.running).exitCode, 0);
    assert.equal(await readAppRecord(repo.root, 'web', 'api'), null);
    assert.equal(await readAppRecord(repo.root, 'web', 'web'), null);
  });
});

test('an occupied port never counts as readiness of a different Story process', async t => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  try {
    const repo = await fixture(t, [entry('web', socket.address().port)]);
    await withMachineState(repo.env, async () => {
      const c = await context(repo.root);
      await assert.rejects(startApplication(repo.root, c, c.application.start[0], { output: quiet, signals: [] }), { code: 'APP_PORT_IN_USE' });
      assert.equal(await readAppRecord(repo.root, 'web', 'web'), null);
    });
  } finally { await new Promise(resolve => socket.close(resolve)); }
});


test('the editor preview accepts a complete service graph and rejects cycles before saving', async () => {
  const { previewApplication } = await import('../src/run-configurations.mjs');
  const base = { start: [entry('api', 4001), entry('web', 4002, ['api'])], tests: [] };
  assert.equal(previewApplication('web', base, { repositories: ['web'] }).valid, true);
  base.start[0].dependsOn = ['web'];
  const cycle = previewApplication('web', base, { repositories: ['web'] });
  assert.equal(cycle.valid, false); assert.match(cycle.errors[0].message, /cycle/);
});
