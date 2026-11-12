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

test('an occupied port names who holds it: another Story checkout\'s SFlow run with its exact stop, else the process', async t => {
  // The refusal named nobody, run records are per checkout, and the skill's "never kill any other process" overrode
  // the person's own "kill the app on 5173" (session mining N2, 2026-11-11).
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  try {
    const repo = await fixture(t, [entry('web', port)]);
    await withMachineState(repo.env, async () => {
      const c = await context(repo.root);
      const refusal = async () => {
        try { await startApplication(repo.root, c, c.application.start[0], { output: quiet, signals: [] }); } catch (error) { return error; }
        assert.fail('the start was not refused');
      };
      // A process no SFlow run started: its pid (and name where the system says it), and the personal-port route.
      if (process.platform !== 'win32') {
        const plain = await refusal();
        assert.equal(plain.code, 'APP_PORT_IN_USE');
        if (plain.details.holder) {
          assert.equal(plain.details.holder.pid, process.pid);
          assert.match(plain.message, new RegExp(`process ${process.pid}\\b[^.]*no SFlow run started[^]*kill ${process.pid}`, 'u'));
        }
        assert.equal(plain.details.nextAction.copilotCommand, '/sf-run-app suggest');
      }
      // Another Story checkout's SFlow run of the same repository holds it: its exact stop, run from that checkout.
      const other = path.join(path.dirname(appRecordPath(repo.root, 'web', 'web')), '..', 'worktrees', 'b'.repeat(32), 'web', 'web.json');
      await mkdir(path.dirname(other), { recursive: true });
      await writeFile(other, JSON.stringify({ format: 'sflow-app-run/v1', capability: 'web', id: 'web', pid: process.pid, runId: 'r',
        checkout: '/elsewhere/story-checkout', url: `http://127.0.0.1:${port}/`, startedAt: new Date().toISOString(),
        commandSha256: `sha256:${'0'.repeat(64)}`, processStartedAt: null, environment: null, readyAt: null }));
      const held = await refusal();
      assert.deepEqual(held.details.holder.sflowRun, { capability: 'web', startId: 'web', checkout: '/elsewhere/story-checkout' });
      assert.equal(held.details.nextAction.command, 'singularity-flow app stop web --capability web --context-root /elsewhere/story-checkout');
      assert.match(held.message, /SFlow's run of 'web' from the checkout \/elsewhere\/story-checkout \(pid \d+\) already listens there\. Stop it with singularity-flow app stop web --capability web --context-root \/elsewhere\/story-checkout/u);
    });
  } finally { await new Promise(resolve => socket.close(resolve)); }
});


// What Windows prints (netstat -ano -p tcp / -p tcpv6, tasklist /FO CSV /NH), read by an injected exec on any machine.
const NETSTAT_HEAD = '\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n';
const netstatRows = (rows) => NETSTAT_HEAD + rows.map((row) => `  ${row}\r\n`).join('');
function windowsExec({ tcp = '', tcpv6 = '', tasklist = (pid) => ({ status: 0, stdout: `"node.exe","${pid}","Console","1","52,340 K"\r\n` }) } = {}) {
  const calls = [];
  const exec = (command, args, options) => {
    calls.push([command, ...args]);
    assert.equal(options.windowsHide, true);
    if (command === 'netstat') return { status: 0, stdout: args.at(-1) === 'tcpv6' ? tcpv6 : tcp };
    if (command === 'tasklist') return tasklist(Number(args[1].replace('PID eq ', '')));
    throw new Error(`unexpected command ${command}`);
  };
  return { exec, calls };
}

test('Windows: the port holder is read from netstat LISTENING rows, IPv4 and IPv6, and named by tasklist', async () => {
  const { windowsPortListener } = await import('../src/application-run.mjs');
  const noise = ['TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012',
    'TCP    127.0.0.1:51730        0.0.0.0:0              LISTENING       7001',
    'TCP    192.168.1.20:5173      0.0.0.0:0              LISTENING       7002',
    'TCP    127.0.0.1:5173         127.0.0.1:60211        ESTABLISHED     7003'];
  for (const [address, table] of [['0.0.0.0', 'tcp'], ['127.0.0.1', 'tcp'], ['[::]', 'tcpv6'], ['[::1]', 'tcpv6']]) {
    const row = `TCP    ${address}:5173${' '.repeat(10)}${table === 'tcp' ? '0.0.0.0:0' : '[::]:0'}              LISTENING       4242`;
    const { exec, calls } = windowsExec({ [table]: netstatRows([...noise, row]) });
    assert.deepEqual(windowsPortListener(5173, { exec, host: '127.0.0.1' }), { pid: 4242, command: 'node.exe' }, address);
    assert.deepEqual(calls.at(-1), ['tasklist', '/FI', 'PID eq 4242', '/FO', 'CSV', '/NH']);
    assert.deepEqual(calls.filter(([command]) => command === 'netstat'), table === 'tcp' ? [['netstat', '-ano', '-p', 'tcp']]
      : [['netstat', '-ano', '-p', 'tcp'], ['netstat', '-ano', '-p', 'tcpv6']], 'IPv4 first for an IPv4 host, then IPv6');
  }
  // An IPv6 host reads IPv6 first; a state Windows names in another language still counts by its zero remote port.
  const v6 = windowsExec({ tcpv6: netstatRows(['TCP    [::1]:5173             [::]:0                 ABHÖREN         5150']) });
  assert.deepEqual(windowsPortListener(5173, { exec: v6.exec, host: '::1' }), { pid: 5150, command: 'node.exe' });
  assert.deepEqual(v6.calls[0], ['netstat', '-ano', '-p', 'tcpv6']);

  // No listener on the port: no holder, and tasklist is never asked.
  const none = windowsExec({ tcp: netstatRows(noise) });
  assert.equal(windowsPortListener(5173, { exec: none.exec }), null);
  assert.equal(none.calls.some(([command]) => command === 'tasklist'), false);
  const listening = netstatRows(['TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242']);
  // tasklist refuses (access denied), finds nothing, or answers for another pid: the pid without a name.
  for (const tasklist of [() => ({ status: 1, stdout: '', stderr: 'ERROR: Access denied\r\n' }),
    () => ({ status: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' }),
    () => ({ status: 0, stdout: '"other.exe","9999","Console","1","1,000 K"\r\n' })]) {
    assert.deepEqual(windowsPortListener(5173, { exec: windowsExec({ tcp: listening, tasklist }).exec }), { pid: 4242, command: null });
  }
  // A missing command (or one that throws) is no holder, or a pid without a name.
  const missing = (command) => (name, args) => name === command ? { error: Object.assign(new Error(`spawnSync ${name} ENOENT`), { code: 'ENOENT' }), status: null, stdout: null }
    : name === 'netstat' ? { status: 0, stdout: listening } : { status: 0, stdout: '"node.exe","4242","Console","1","1 K"' };
  assert.equal(windowsPortListener(5173, { exec: missing('netstat') }), null);
  assert.deepEqual(windowsPortListener(5173, { exec: missing('tasklist') }), { pid: 4242, command: null });
  assert.equal(windowsPortListener(5173, { exec: () => { throw new Error('spawn EPERM'); } }), null);
});

test('Windows: the refusal names taskkill /PID for the person\'s own terminal and a quoted checkout path in the stop route; SFlow kills nothing', async t => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  try {
    const repo = await fixture(t, [entry('web', port)]);
    await withMachineState(repo.env, async () => {
      const c = await context(repo.root);
      const { exec, calls } = windowsExec({ tcp: netstatRows([`TCP    127.0.0.1:${port}         0.0.0.0:0              LISTENING       4242`]) });
      const refusal = async () => {
        try { await startApplication(repo.root, c, c.application.start[0], { output: quiet, signals: [], platform: 'win32', spawnSyncCommand: exec }); } catch (error) { return error; }
        assert.fail('the start was not refused');
      };
      const plain = await refusal();
      assert.equal(plain.code, 'APP_PORT_IN_USE');
      assert.deepEqual(plain.details.holder, { pid: 4242, command: 'node.exe', personStop: 'taskkill /PID 4242' });
      assert.match(plain.message, /process 4242 \(node\.exe\), which no SFlow run started, already listens there\. It is not SFlow's to stop: a person who asked for it stops it in their own terminal \(taskkill \/PID 4242\)\./u);
      assert.doesNotMatch(plain.message, /\bkill 4242/u);
      assert.equal(plain.details.nextAction.copilotCommand, '/sf-run-app suggest');
      // Another Story checkout's SFlow run holds it: the stop route quotes its Windows path, in the shell's own form.
      const checkout = 'C:\\Users\\dev\\Story Checkout';
      const other = path.join(path.dirname(appRecordPath(repo.root, 'web', 'web')), '..', 'worktrees', 'c'.repeat(32), 'web', 'web.json');
      await mkdir(path.dirname(other), { recursive: true });
      await writeFile(other, JSON.stringify({ format: 'sflow-app-run/v1', capability: 'web', id: 'web', pid: process.pid, runId: 'r',
        checkout, url: `http://127.0.0.1:${port}/`, startedAt: new Date().toISOString(),
        commandSha256: `sha256:${'0'.repeat(64)}`, processStartedAt: null, environment: null, readyAt: null }));
      const held = await refusal();
      assert.deepEqual(held.details.holder, { pid: process.pid, command: null, sflowRun: { capability: 'web', startId: 'web', checkout } });
      assert.equal(held.details.nextAction.command, "singularity-flow app stop web --capability web --context-root 'C:\\Users\\dev\\Story Checkout'");
      assert.equal(held.details.nextAction.platformCommands.win32,
        "& 'singularity-flow' 'app' 'stop' 'web' '--capability' 'web' '--context-root' 'C:\\Users\\dev\\Story Checkout'");
      assert.ok(held.message.includes(`from the checkout ${checkout} (pid ${process.pid}) already listens there. Stop it with ${held.details.nextAction.platformCommands.win32}, or`), held.message);
      // Reading who holds the port only ever asks netstat and tasklist: the agent never kills a process.
      assert.deepEqual([...new Set(calls.map(([command]) => command))], ['netstat', 'tasklist']);
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
