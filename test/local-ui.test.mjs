import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, chmod, utimes, stat, access, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, createServer as httpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { inventedValue } from './helpers/invented-secrets.mjs';
import { startService } from '../src/local-ui/server.mjs';
import { control, ensureService, openWorkspace, serviceStatus, stopService } from '../src/local-ui/client.mjs';
import { readPrivate, writePrivate, buildIdentity } from '../src/local-ui/private-state.mjs';
import { operationShape, runCanonical, executeOperation } from '../src/local-ui/operations.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { argvAllowed } from '../src/copilot-mutation-guard.mjs';
import { serviceDirectory, cliPath } from '../src/local-ui/private-state.mjs';
import { nativeNonce, requestProof, sealInput } from '../src/local-ui/native-auth.mjs';
import { withUiRecovery } from '../src/local-ui/cli-recovery.mjs';
import { UiError, nativeEnvironment } from '../src/local-ui/contracts.mjs';
import { browserLaunch } from '../src/local-ui/cli.mjs';

async function fixture(t, { checkout = 'project' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-ui-'));
  const env = isolatedTestEnvironment(path.join(base, 'machine'));
  const previous = { ...process.env };
  const cleanups = [];
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  Object.assign(process.env, env);
  t.after(async () => { try { for (const cleanup of cleanups) await cleanup(); } finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, previous); await rm(base, { recursive: true, force: true }); } });
  const root = path.join(base, checkout); await mkdir(root, { recursive: true });
  const mustGit = (...args) => { const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  mustGit('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'README.md'), '# Isolated local workspace fixture\n');
  mustGit('add', '.'); mustGit('commit', '-qm', 'Fixture');
  const directory = path.join(base, 'service');
  return { base, root, directory, env, mustGit, cleanup: callback => cleanups.unshift(callback) };
}
async function connect(service, root, { clientId = randomUUID(), cookie: previousCookie, environment } = {}) {
  const bootstrap = await control(service.descriptor, 'bootstrap', { root, clientId, ...(environment ? { environment } : {}) });
  const ticket = new URLSearchParams(new URL(bootstrap.url).hash.slice(1)).get('ticket');
  const response = await fetch(`${service.descriptor.origin}/api/session`, { method: 'POST', headers: { Origin: service.descriptor.origin, 'Content-Type': 'application/json', ...(previousCookie ? { Cookie: previousCookie } : {}) }, body: JSON.stringify({ ticket }) });
  assert.equal(response.status, 200); const session = await response.json();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const api = async (route, data, extra = {}) => {
    const reply = await fetch(`${service.descriptor.origin}${route}`, { method: data ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-SFlow-Tab': session.tabId,
      ...(data ? { Origin: service.descriptor.origin, 'Content-Type': 'application/json', 'X-SFlow-CSRF': session.csrf } : {}), ...extra }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: reply.status, value: await reply.json(), headers: reply.headers };
  };
  const upload = async (operation, input, bytes) => {
    const invocationId = randomUUID();
    const descriptor = { contextId: session.context.id, invocationId, operation, input };
    const response = await fetch(`${service.descriptor.origin}/api/content`, { method: 'POST', headers: {
      Cookie: cookie, 'X-SFlow-Tab': session.tabId, Origin: service.descriptor.origin,
      'X-SFlow-CSRF': session.csrf, 'Content-Type': 'application/octet-stream',
      'X-SFlow-Content': encodeURIComponent(JSON.stringify(descriptor)) }, body: bytes });
    return { status: response.status, value: await response.json(), invocationId };
  };
  return { api, upload, session, cookie, ticket, clientId };
}
async function settle(browser, id) {
  for (let at = 0; at < 400; at++) {
    const { value } = await browser.api(`/api/requests/${id}`);
    if (!['queued', 'running'].includes(value.state)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Operation did not settle');
}
async function invoke(browser, operation, input = {}, invocationId = randomUUID()) {
  const accepted = await browser.api('/api/operations', { contextId: browser.session.context.id, invocationId, operation, input });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
  return settle(browser, invocationId);
}

test('loopback host authenticates native clients and one-use browser tickets; tabs keep separate contexts', async t => {
  const { root, directory, base, cleanup } = await fixture(t);
  const service = await startService({ directory, execute: async () => ({ value: { ok: true } }) }); cleanup(() => service.close());
  const first = await connect(service, root);
  const otherRoot = path.join(base, 'second'); await mkdir(otherRoot);
  const second = await connect(service, otherRoot, { cookie: first.cookie });
  assert.equal(first.cookie, second.cookie, 'a second tab must not replace the first cookie');
  assert.notEqual(first.session.tabId, second.session.tabId);
  assert.equal((await first.api('/api/session')).value.context.root, await (await import('node:fs/promises')).realpath(root));
  assert.equal((await second.api('/api/session')).value.context.root, await (await import('node:fs/promises')).realpath(otherRoot));
  assert.equal((await fetch(`${service.descriptor.origin}/control/status`)).status, 401);
  assert.equal((await first.api('/api/session', { ticket: first.ticket })).status, 401, 'ticket cannot replay');
  assert.equal((await first.api('/api/operations', { contextId: second.session.context.id, invocationId: randomUUID(), operation: 'about', input: {} })).status, 403);
  assert.equal((await first.api('/api/operations', {}, { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await first.api('/api/operations', {}, { 'X-SFlow-CSRF': 'forged' })).status, 403);
  assert.equal((await first.api('/api/operations', { extra: 'a'.repeat(256 * 1024) })).status, 413);
  assert.equal((await first.upload('shell.exec', {}, Buffer.from('whoami'))).value.error.code, 'UI_OPERATION_UNSUPPORTED');
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${service.descriptor.origin}/health`, { headers: { Host: 'foreign.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); req.end();
  }); assert.equal(hostStatus, 403);
  assert.match(first.session.build.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(first.session.capabilities.signing, false);
});

test('native control never discloses credentials or environments to a reused foreign port and refuses replay', async t => {
  const { root, directory, cleanup } = await fixture(t);
  const service = await startService({ directory }); cleanup(() => service.close());
  const nonce = nativeNonce(), time = String(Date.now()), route = '/control/bootstrap', method = 'POST';
  const wire = JSON.stringify(sealInput(service.descriptor.credential, { root, clientId: randomUUID() },
    JSON.stringify([service.descriptor.instance, nonce, time, method, route])));
  const headers = { 'Content-Type': 'application/json', 'X-SFlow-Native-Instance': service.descriptor.instance,
    'X-SFlow-Native-Nonce': nonce, 'X-SFlow-Native-Time': time,
    'X-SFlow-Native-Proof': requestProof(service.descriptor.credential, { instance: service.descriptor.instance, nonce, time, method, route, body: wire }) };
  const accepted = await fetch(`${service.descriptor.origin}${route}`, { method, headers, body: wire });
  assert.equal(accepted.status, 200); await accepted.json();
  const replayed = await fetch(`${service.descriptor.origin}${route}`, { method, headers, body: wire });
  assert.equal(replayed.status, 401); await replayed.json();
  const tampered = await fetch(`${service.descriptor.origin}${route}`, { method, headers: { ...headers, 'X-SFlow-Native-Nonce': nativeNonce() }, body: wire });
  assert.equal(tampered.status, 401); await tampered.json();
  const seen = []; let empty = false;
  const foreign = httpServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push(JSON.stringify({ headers: req.headers, body }));
    res.writeHead(empty ? 204 : 200, { 'Content-Type': 'application/json' });
    res.end(empty ? undefined : JSON.stringify({ status: 'running', instance: service.descriptor.instance }));
  });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  cleanup(() => new Promise(resolve => foreign.close(resolve)));
  const replaced = { ...service.descriptor, origin: `http://127.0.0.1:${foreign.address().port}` };
  await assert.rejects(control(replaced, 'bootstrap', { root, clientId: 'private-client-marker', environment: { TOKEN: inventedValue('private-', 'token-marker') } }), { code: 'UI_NATIVE_AUTH_REQUIRED' });
  empty = true;
  await assert.rejects(control(replaced, 'status'), { code: 'UI_NATIVE_AUTH_REQUIRED' });
  await writePrivate(path.join(directory, 'instance.json'), replaced);
  try {
    await assert.rejects(ensureService({ directory }), { code: 'UI_NATIVE_AUTH_REQUIRED' });
    assert.equal((await readPrivate(path.join(directory, 'instance.json'))).origin, replaced.origin,
      'a live owner with a foreign listener is neither overwritten nor killed');
  } finally { await writePrivate(path.join(directory, 'instance.json'), service.descriptor); }
  assert.ok(seen.every(item => !item.includes(service.descriptor.credential) && !item.includes('authorization')
    && !item.includes('private-client-marker') && !item.includes('private-token-marker') && !item.includes(root)));
});

test('request admission is once per invocation, bounded and responsive during a slow owner', async t => {
  const { root, directory, cleanup } = await fixture(t);
  let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const service = await startService({ directory, execute: async () => { calls++; await blocked; return { value: { sequence: 2 } }; } });
  cleanup(async () => { release(); await service.close(); });
  const browser = await connect(service, root), id = randomUUID();
  const input = { contextId: browser.session.context.id, invocationId: id, operation: 'spec.save', input: { specId: 'SPEC-A', sequence: 1, content: '# Work' } };
  const replies = await Promise.all([browser.api('/api/operations', input), browser.api('/api/operations', input)]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 202]);
  const healthAt = performance.now(); assert.equal((await fetch(`${service.descriptor.origin}/health`)).status, 200);
  assert.ok(performance.now() - healthAt < 500, 'health does not await the slow owner');
  assert.equal((await browser.api('/api/operations', { ...input, input: { ...input.input, content: '# Other' } })).status, 409);
  await assert.rejects(control(service.descriptor, 'stop', { drain: false }), { code: 'UI_SERVICE_BUSY' });
  release(); const result = await settle(browser, id); assert.equal(result.state, 'succeeded');
  assert.equal(calls, 1);
  assert.equal((await control(service.descriptor, 'status')).recent.find(entry => entry.invocationId === id).state, 'succeeded',
    'native recovery can find completed writes even after a lost browser reply');
  assert.equal((await browser.api('/api/operations', input)).value.result.value.sequence, 2);
  const other = await connect(service, root);
  assert.equal((await other.api(`/api/requests/${id}`)).status, 404);
  assert.equal((await browser.api('/api/events')).value.events.filter(item => item.type === 'accepted').length, 1);
});

test('canonical Spec Studio creates, saves, reopens and refuses stale edits with original errors', async t => {
  const { root, directory, mustGit, cleanup } = await fixture(t);
  const service = await startService({ directory }); cleanup(() => service.close());
  const browser = await connect(service, root);
  const created = await invoke(browser, 'spec.create', { title: 'A clear business need', kind: 'business', intent: 'Make an account easy to close.' });
  assert.equal(created.state, 'succeeded', JSON.stringify(created));
  const specId = created.result.value.specId;
  const draft = await invoke(browser, 'spec.read', { specId });
  assert.equal(draft.state, 'succeeded', JSON.stringify(draft));
  assert.equal(draft.result.value.title, 'A clear business need');
  const content = '# Close an account\n\nPeople can close an account.\n\nUnicode: résumé, 日本語.\n';
  const saved = await invoke(browser, 'spec.save', { specId, sequence: 1, title: 'Close an account', content });
  assert.equal(saved.state, 'succeeded', JSON.stringify(saved));
  assert.equal(saved.result.value.sequence, 2);
  const receipt = await invoke(browser, 'spec.read', { specId, operationId: `lws-${saved.invocationId}` });
  assert.equal(receipt.result.value.saveReceipt.state, 'recorded');
  assert.equal(receipt.result.value.saveReceipt.sequence, 2);
  const reopened = await invoke(browser, 'spec.read', { specId });
  assert.equal(reopened.result.value.spec, content);
  const direct = await runCanonical(root, ['spec', 'author', 'status', specId, '--quick', '--for-person']);
  assert.deepEqual(reopened.result.value, direct.value, 'browser projection equals the canonical CLI');
  const stale = await invoke(browser, 'spec.save', { specId, sequence: 1, content: 'Do not overwrite' });
  assert.equal(stale.state, 'failed'); assert.ok(stale.error.code.startsWith('SPEC_'), JSON.stringify(stale));
  assert.ok(stale.error.details.original.error, 'canonical error and recovery details are retained');
  assert.equal((await invoke(browser, 'spec.read', { specId })).result.value.spec, content);
  const forked = await invoke(browser, 'spec.fork', { specId, content: '# Preserved alternative\n\nMy writing.\n' });
  assert.equal(forked.state, 'succeeded', JSON.stringify(forked));
  assert.notEqual(forked.result.value.specId, specId);
  assert.equal((await invoke(browser, 'spec.read', { specId: forked.result.value.specId })).result.value.spec, '# Preserved alternative\n\nMy writing.\n');
  assert.equal((await invoke(browser, 'spec.read', { specId })).result.value.spec, content);
  assert.equal(mustGit('log', '--format=%s'), 'Fixture', 'local saves do not publish or approve');
  assert.equal((await browser.api('/api/operations', { contextId: browser.session.context.id, invocationId: randomUUID(), operation: 'approve', input: { human: true } })).status, 400);
});

test('draining concurrent admissions finishes every retained request before the service releases ownership', async t => {
  const { root, directory, cleanup } = await fixture(t);
  let calls = 0;
  const service = await startService({ directory, execute: async () => { calls++; return { value: { saved: true } }; } });
  cleanup(() => service.close());
  const browser = await connect(service, root);
  const pending = Array.from({ length: 12 }, () => browser.api('/api/operations', {
    contextId: browser.session.context.id, invocationId: randomUUID(), operation: 'spec.save',
    input: { specId: 'SPEC-A', sequence: 1, content: '# A preserved draft' }
  }));
  // Network requests and fsync acknowledgements overlap; native stop must include admissions,
  // not merely work already dispatched to an owner. No fixed disk-speed assumption is required.
  const status = await control(service.descriptor, 'status');
  assert.ok(Number.isSafeInteger(status.admitting));
  await control(service.descriptor, 'stop', { drain: true });
  await service.done; await Promise.allSettled(pending);
  const files = (await readdir(path.join(directory, 'requests'))).filter(name => name.endsWith('.json'));
  assert.ok(files.length > 0);
  const records = await Promise.all(files.map(file => readPrivate(path.join(directory, 'requests', file))));
  assert.ok(records.every(record => record.state === 'succeeded'), JSON.stringify(records));
  assert.equal(calls, records.length);
  assert.equal(await readPrivate(path.join(directory, 'instance.json')), null);
});

test('restart marks interrupted writes unknown, preserving original IDs without replay', async t => {
  const { root, directory, cleanup } = await fixture(t);
  const old = await startService({ directory }); await old.close();
  const id = randomUUID();
  await writeFile(path.join(directory, 'requests', `${id}.json`), JSON.stringify({ invocationId: id, operation: 'spec.save', mutation: true, clientId: 'test-client', root, state: 'running' }), { mode: 0o600 });
  let calls = 0;
  const fresh = await startService({ directory, execute: () => { calls++; } }); cleanup(() => fresh.close());
  assert.equal(fresh.status().recovery[0].state, 'unknown'); assert.equal(calls, 0);
  const bootstrap = await control(fresh.descriptor, 'bootstrap', { root, clientId: 'recovery', resume: id });
  assert.ok(bootstrap.url.includes('#ticket='));
  assert.equal(JSON.parse(await readFile(path.join(directory, 'requests', `${id}.json`))).invocationId, id);
});

test('CLI launch reuses one independent service and ownership checks refuse unsafe discovery', async t => {
  const { root, directory, cleanup } = await fixture(t);
  const starts = await Promise.all([ensureService({ directory }), ensureService({ directory })]);
  cleanup(() => stopService({ directory, drain: true }));
  assert.equal(starts[0].descriptor.instance, starts[1].descriptor.instance);
  assert.equal(starts.filter(item => !item.reused).length, 1);
  const opened = await openWorkspace({ directory, root }); assert.equal(opened.reused, true);
  const status = await serviceStatus({ directory }); assert.equal(status.status, 'running'); assert.notEqual(status.pid, process.pid);
  const build = await buildIdentity(); assert.equal(status.build.fingerprint, build.fingerprint);
  await assert.rejects(control({ ...starts[0].descriptor, credential: 'x'.repeat(43) }, 'status'), { code: 'UI_NATIVE_AUTH_REQUIRED' });
  await chmod(path.join(directory, 'instance.json'), 0o644);
  if (process.platform !== 'win32') await assert.rejects(readPrivate(path.join(directory, 'instance.json')), { code: 'UI_PRIVATE_STATE_UNSAFE' });
  await chmod(path.join(directory, 'instance.json'), 0o600);
});

test('transport vocabulary is closed, model-free and machine-local', async () => {
  for (const action of ['open', 'serve', 'status', 'stop']) {
    const op = resolveOperation({ requestedCommand: 'ui', positionals: ['ui', action], options: {} });
    assert.equal(op.modelPolicy, 'never'); assert.equal(op.classification, action === 'status' ? 'read' : 'upkeep');
  }
  assert.throws(() => operationShape('spec.save', { specId: 'SPEC-X', sequence: 1, content: '# Good', argv: ['approve'] }), { code: 'UI_REQUEST_INVALID' });
  assert.throws(() => operationShape('shell', { command: 'anything' }), { code: 'UI_OPERATION_UNSUPPORTED' });
  for (const mode of ['read', 'authoring', 'kernel-only', 'read-only-review', 'approval-only', 'run-and-test']) {
    const scope = { skill: 'sf-ui', contract: { workId: 'W-1', phaseId: 'implementation' } };
    for (const action of ['open', 'serve', 'stop']) assert.equal(argvAllowed(['ui', action, '--json'], mode, scope), false);
    assert.equal(argvAllowed(['ui', 'status', '--json'], mode, scope), true);
  }
  const { isGatewayReachable } = await import('../src/gateway/operations.mjs');
  for (const action of ['open', 'serve', 'stop']) assert.equal(isGatewayReachable(`ui.${action}`), false,
    'a model-facing gateway must not expose native browser grants or lifecycle control');
});

test('client environments stay scoped, tokens are not retained, and machine reads need no Git checkout', async t => {
  const { root, directory, cleanup, base } = await fixture(t);
  const service = await startService({ directory }); cleanup(() => service.close());
  const scoped = name => ({ ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: name,
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: `${name}@example.invalid`, UI_TEST_CREDENTIAL: `${name}-private-marker` });
  const one = await connect(service, root, { environment: scoped('one') });
  const two = await connect(service, root, { environment: scoped('two') });
  const createdOne = await invoke(one, 'spec.create', { title: 'One idea', kind: 'business' });
  const createdTwo = await invoke(two, 'spec.create', { title: 'Another idea', kind: 'business' });
  const first = await invoke(one, 'spec.history', { specId: createdOne.result.value.specId });
  const second = await invoke(two, 'spec.history', { specId: createdTwo.result.value.specId });
  assert.equal(first.result.value.versions[0].savedBy.name, 'one');
  assert.equal(second.result.value.versions[0].savedBy.name, 'two');
  const retained = await readFile(path.join(directory, 'requests', `${createdOne.invocationId}.json`), 'utf8');
  assert.ok(!retained.includes('one-private-marker'));
  assert.ok(!JSON.stringify(one.session).includes('one-private-marker'));
  await assert.rejects(control(service.descriptor, 'bootstrap', { root, clientId: randomUUID(), resume: createdOne.invocationId, environment: scoped('two') }), { code: 'UI_CLIENT_SCOPE_CHANGED' });
  const outside = path.join(base, 'workspace-without-git'); await mkdir(outside);
  const workspaceBrowser = await connect(service, outside);
  const about = await invoke(workspaceBrowser, 'about');
  assert.equal(about.state, 'succeeded', JSON.stringify(about));
  const listing = await invoke(workspaceBrowser, 'workspace.list');
  assert.equal(listing.state, 'succeeded', JSON.stringify(listing));
});

test('an interrupted empty startup claim is recovered by the existing fenced lease owner', async t => {
  const { directory, cleanup } = await fixture(t);
  await mkdir(directory, { mode: 0o700 });
  const claim = path.join(directory, 'starting.lease'); await writeFile(claim, '', { mode: 0o600 });
  const old = new Date(Date.now() - 60_000); await utimes(claim, old, old);
  const launched = await ensureService({ directory }); cleanup(() => stopService({ directory, drain: true }));
  assert.equal(launched.reused, false);
  assert.equal((await serviceStatus({ directory })).status, 'running');
});

test('native lifecycle refusals preserve actual errors and recover locally without Story or generic diagnostic loops', async () => {
  for (const code of ['UI_COMMAND_INVALID', 'UI_IDLE_INVALID', 'UI_SERVICE_BUSY', 'UI_SERVICE_DRAINING',
    'UI_BUILD_MISMATCH', 'UI_PLATFORM_UNQUALIFIED', 'UI_REMOTE_UNQUALIFIED', 'UI_REQUEST_NOT_FOUND',
    'UI_CLIENT_SCOPE_CHANGED', 'UI_PRIVATE_STATE_UNSAFE', 'UI_STATE_UNREADABLE', 'UI_NATIVE_AUTH_REQUIRED',
    'UI_DISCOVERY_INVALID', 'UI_INSTANCE_MISMATCH', 'UI_STARTUP_TIMEOUT', 'UI_OPERATION_TIMEOUT']) {
    const error = new UiError(code, 'Exact original error', { timeoutMs: 37, stage: 'native-reply', cause: 'ETIMEDOUT' });
    assert.equal(await withUiRecovery(error, ['ui', 'open', '--json']), error);
    const envelope = error.relayedResult;
    assert.equal(envelope.error.code, code); assert.equal(envelope.error.message, 'Exact original error');
    assert.equal(envelope.error.details.timeoutMs, 37); assert.equal(envelope.error.details.cause, 'ETIMEDOUT');
    assert.ok(envelope.remediationPlan.steps.length > 0);
    for (const step of envelope.remediationPlan.steps) {
      assert.equal(step.commandRejected, undefined);
      if (step.command) assert.match(step.command, /^singularity-flow (?:ui|about)\b/u);
      assert.notEqual(step.copilotCommand, '/sf-ui open');
    }
    assert.equal(envelope.remediationPlan.retry.automatic, false);
  }
});

test('canonical timeouts keep their real deadline and never diagnose DNS', async t => {
  const { root } = await fixture(t);
  await assert.rejects(runCanonical(root, ['about'], { machine: true, timeoutMs: 1 }), error => {
    assert.equal(error.code, 'UI_OPERATION_TIMEOUT'); assert.equal(error.details.timeoutMs, 1);
    assert.equal(error.details.stage, 'canonical-cli'); assert.doesNotMatch(error.message, /DNS/iu); return true;
  });
});

test('a native CLI launcher exits while the service keeps running; status and stop need no repository', async t => {
  const { root, cleanup } = await fixture(t);
  const child = spawnSync(process.execPath, [cliPath, 'ui', 'open', '--no-open', '--json'], {
    cwd: root, env: process.env, encoding: 'utf8', timeout: 20_000
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const opened = JSON.parse(child.stdout);
  cleanup(() => stopService({ directory: serviceDirectory(), drain: true }));
  assert.equal(opened.launcher, undefined, '--no-open returns the link itself and writes no opening page');
  assert.equal((await serviceStatus()).instance, opened.instance, 'independent process survived its launch command');
  const status = spawnSync(process.execPath, [cliPath, 'ui', 'status', '--json'], { cwd: path.dirname(root), env: process.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(status.status, 0, status.stderr + status.stdout);
  assert.equal(JSON.parse(status.stdout).status, 'running');
});

test('local files and images use the canonical source store; missing originals request matching re-upload', async t => {
  const { root, directory, mustGit, cleanup } = await fixture(t);
  const service = await startService({ directory }); cleanup(() => service.close());
  const browser = await connect(service, root);
  const created = await invoke(browser, 'spec.create', { title: 'An illustrated need', kind: 'business' });
  const specId = created.result.value.specId;
  const accepted = await browser.upload('spec.source.add', { specId, name: 'brief.txt' }, Buffer.from('A local document describing the intended outcome.'));
  assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
  const upload = await settle(browser, accepted.invocationId);
  assert.equal(upload.state, 'succeeded', JSON.stringify(upload));
  const sourceId = upload.result.value.sources[0].id;
  const read = await invoke(browser, 'spec.source.read', { specId, sourceId });
  assert.equal(read.result.value.sources[0].text, 'A local document describing the intended outcome.');
  const original = read.result.value.sources[0].path;
  assert.ok(!mustGit('ls-files').includes('brief.txt'), 'original bytes are not committed');
  await rm(original);
  const stored = await (await import('../src/document-storage.mjs')).readLocalDocument(root, specId, upload.result.value.sources[0]);
  await rm(stored.storePath);
  const missing = await invoke(browser, 'spec.source.read', { specId, sourceId });
  assert.equal(missing.result.value.sources[0].status, 'upload-required');
  const wrong = await invoke(browser, 'spec.source.add', { specId, name: 'brief.txt', data: Buffer.from('Different file.').toString('base64'), restore: sourceId });
  assert.equal(wrong.error.code, 'SPEC_SOURCE_REPLACEMENT_REQUIRED');
  const restored = await invoke(browser, 'spec.source.add', { specId, name: 'brief.txt', data: Buffer.from('A local document describing the intended outcome.').toString('base64'), restore: sourceId });
  assert.equal(restored.state, 'succeeded');
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=';
  const uploadedImage = await invoke(browser, 'spec.source.add', { specId, name: 'reference.png', data: image });
  assert.equal(uploadedImage.state, 'succeeded', JSON.stringify(uploadedImage));
  const imageId = uploadedImage.result.value.sources.find(item => item.name === 'reference.png').id;
  const imageRead = await invoke(browser, 'spec.source.read', { specId, sourceId: imageId });
  assert.equal(imageRead.result.value.sources[0].status, 'image-ready');
  const resource = imageRead.result.resources[0];
  const response = await fetch(`${service.descriptor.origin}/api/content/${resource.id}`, { headers: { Cookie: browser.cookie, 'X-SFlow-Tab': browser.session.tabId } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), image);
  const other = await connect(service, root);
  assert.equal((await other.api(`/api/content/${resource.id}`)).status, 404);
  await writeFile(imageRead.result.value.sources[0].path, 'Changed after the canonical read');
  assert.equal((await browser.api(`/api/content/${resource.id}`)).value.error.code, 'UI_CONTENT_CHANGED');
});

test('the editor bridge is exact-window scoped and acknowledges handoff, never model execution', async t => {
  const { root, directory, cleanup } = await fixture(t);
  const service = await startService({ directory }); cleanup(() => service.close());
  const browser = await connect(service, root);
  const request = { contextId: browser.session.context.id, type: 'spec.assist', specId: 'SPEC-A' };
  assert.equal((await browser.api('/api/handoffs', request)).value.error.code, 'UI_BRIDGE_UNAVAILABLE');
  const registered = await control(service.descriptor, 'bridge/register', { clientId: browser.clientId, root, copilot: true, build: service.descriptor.build.fingerprint });
  assert.equal((await browser.api('/api/session')).value.capabilities.copilot, true);
  const other = await connect(service, root);
  assert.equal((await other.api('/api/handoffs', { ...request, contextId: other.session.context.id })).value.error.code, 'UI_BRIDGE_UNAVAILABLE');
  const accepted = await browser.api('/api/handoffs', request);
  assert.equal(accepted.status, 202);
  const polled = await control(service.descriptor, 'bridge/poll', { bridgeId: registered.bridgeId });
  assert.equal(polled.requests[0].specId, 'SPEC-A');
  assert.equal((await control(service.descriptor, 'bridge/poll', { bridgeId: registered.bridgeId })).requests.length, 0, 'a lost poll is not delivered twice');
  await control(service.descriptor, 'bridge/result', { bridgeId: registered.bridgeId, handoffId: accepted.value.id, outcome: 'delivered', message: 'Prepared for review in the matching window.' });
  const result = await browser.api(`/api/handoffs/${accepted.value.id}`);
  assert.equal(result.value.state, 'delivered'); assert.equal(result.value.modelExecution, 'not-observed');
  await control(service.descriptor, 'bridge/close', { bridgeId: registered.bridgeId });
  assert.equal((await browser.api('/api/session')).value.capabilities.copilot, false);
});

const gone = file => access(file).then(() => false, () => true);

test('a native launcher opens a private page, never the one-use link; the page goes once the link is used or expires with the service', async t => {
  const { root, directory, cleanup } = await fixture(t);
  const opened = await openWorkspace({ directory, root, launch: true });
  cleanup(() => stopService({ directory, drain: true }));
  const [, args] = browserLaunch(opened);
  assert.deepEqual(args, [opened.launcher]);
  assert.ok(!args.some(arg => arg.includes('#ticket=') || arg.includes(new URL(opened.url).hash.slice(8))), 'no process argument carries the link');
  assert.equal(path.dirname(opened.launcher), directory);
  assert.equal((await stat(opened.launcher)).mode & 0o777, 0o600);
  assert.ok((await readFile(opened.launcher, 'utf8')).includes(JSON.stringify(opened.url)));
  const ticket = new URLSearchParams(new URL(opened.url).hash.slice(1)).get('ticket');
  const origin = new URL(opened.url).origin;
  const redeemed = await fetch(`${origin}/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(redeemed.status, 200); await redeemed.json();
  assert.ok(await gone(opened.launcher), 'a used link takes its page with it');
  const second = path.join(path.dirname(directory), 'second-service');
  const service = await startService({ directory: second });
  const unused = await control(service.descriptor, 'bootstrap', { root, clientId: randomUUID(), launcher: true });
  assert.ok(!await gone(unused.launcher));
  await service.close();
  assert.ok(await gone(unused.launcher), 'an unused link\'s page goes with the service');
});

test('only a service from this very engine is reused; the bridge is this engine\'s own', async t => {
  const { root, directory, base, cleanup } = await fixture(t);
  const own = await buildIdentity();
  // The same fingerprinted files at another path: before, it was reused and its bridge path was trusted.
  const foreign = await startService({ directory, build: { ...own, engineRoot: path.join(base, 'another-engine') } });
  cleanup(() => foreign.close());
  await assert.rejects(ensureService({ directory }), { code: 'UI_BUILD_MISMATCH' });
  await assert.rejects(openWorkspace({ directory, root }), { code: 'UI_BUILD_MISMATCH' });
  await foreign.close();
  const opened = await openWorkspace({ directory, root });
  cleanup(() => stopService({ directory, drain: true }));
  assert.equal(opened.bridgeModule, path.join(own.engineRoot, 'src', 'local-ui', 'bridge-client.mjs'));
});

test('receipts keep a write\'s identifiers only and never a read; a write whose child stopped without an answer is unknown', async t => {
  const { root, directory, cleanup } = await fixture(t);
  const wording = 'Wording the person wrote, kept by its owner only';
  const service = await startService({ directory, execute: async ({ operation, input }) => {
    if (input.specId === 'SPEC-STOPPED') throw Object.assign(new UiError('UI_OPERATION_FAILED', 'The child stopped.'), { outcomeUnknown: true });
    return operation === 'spec.read' ? { value: { specId: input.specId, sequence: 2, spec: wording } }
      : { value: { resultType: 'sflow-spec-author', action: 'edit', specId: input.specId, sequence: 2, operationId: 'lws-x', draft: { spec: wording } } };
  } });
  cleanup(() => service.close());
  const browser = await connect(service, root);
  const saved = await invoke(browser, 'spec.save', { specId: 'SPEC-A', sequence: 1, content: wording });
  assert.equal(saved.result.value.draft.spec, wording, 'the running service still answers the tab in full');
  const read = await invoke(browser, 'spec.read', { specId: 'SPEC-A' });
  assert.equal(read.result.value.spec, wording);
  const files = await readdir(path.join(directory, 'requests'));
  assert.deepEqual(files, [`${saved.invocationId}.json`], 'a read is never written down');
  const kept = JSON.parse(await readFile(path.join(directory, 'requests', files[0]), 'utf8'));
  assert.deepEqual(kept.result.value, { resultType: 'sflow-spec-author', action: 'edit', specId: 'SPEC-A', sequence: 2, operationId: 'lws-x' });
  assert.ok(!JSON.stringify(kept).includes(wording));
  assert.equal((await invoke(browser, 'spec.save', { specId: 'SPEC-STOPPED', sequence: 1, content: wording })).state, 'unknown');
  assert.equal((await invoke(browser, 'spec.read', { specId: 'SPEC-STOPPED' })).state, 'failed', 'a read is simply asked again');
});

test('canonical children: killed, exiting without an answer, or printing credentials are unknown and redacted', async t => {
  const { root } = await fixture(t);
  const credential = inventedValue('ghp_', 'LOCALUITESTFAKE', 'Q'.repeat(21));
  const remote = `https://person:${credential}@git.example.test/shop.git`;
  const preload = code => ({ ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(code)}`.trim() });
  const progress = [];
  await assert.rejects(runCanonical(root, ['about'], { machine: true, onProgress: item => progress.push(item.message),
    environment: preload(`process.stderr.write(${JSON.stringify(`fatal: could not read ${remote}\n`)}, () => process.kill(process.pid, 9));`) }), error => {
    assert.equal(error.outcomeUnknown, true); assert.equal(error.details.signal, 'SIGKILL');
    assert.ok(!JSON.stringify([error.message, error.details]).includes(credential), JSON.stringify(error.details));
    return true;
  });
  assert.ok(progress.length > 0 && !progress.join('').includes(credential), 'progress events are redacted');
  await assert.rejects(runCanonical(root, ['about'], { machine: true, environment: preload('process.exit(3);') }), error => {
    assert.equal(error.outcomeUnknown, true); assert.equal(error.details.exitCode, 3); return true;
  });
});

test('browser values are single option words and links are http(s): a title cannot name another checkout', async t => {
  const { root, base, directory, cleanup } = await fixture(t);
  for (const url of ['file:///etc/hosts', 'javascript:alert(1)', '--file=/etc/hosts', 'not a link']) {
    assert.throws(() => operationShape('spec.source.link', { specId: 'SPEC-A', url }), { code: 'UI_REQUEST_INVALID' }, url);
  }
  assert.equal(operationShape('spec.source.link', { specId: 'SPEC-A', url: 'https://docs.example.test/brief' }).mutation, true);
  const service = await startService({ directory }); cleanup(() => service.close());
  const browser = await connect(service, root);
  const title = `--context-root=${path.join(base, 'elsewhere')}`;
  const created = await invoke(browser, 'spec.create', { title, kind: 'business', intent: '--' });
  assert.equal(created.state, 'succeeded', JSON.stringify(created));
  assert.equal((await invoke(browser, 'spec.read', { specId: created.result.value.specId })).result.value.title, title);
});

test('startup removes stale temporary files, aged and read receipts; a tab\'s status poll is not activity; odd environment names are left out', async t => {
  const { root, directory, cleanup } = await fixture(t);
  await mkdir(path.join(directory, 'requests'), { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  for (const folder of ['save-AbC123', 'upload-xYz789']) { await mkdir(path.join(directory, folder)); await writeFile(path.join(directory, folder, 'wording.md'), 'left by a crash'); }
  const page = path.join(directory, `launch-${'a'.repeat(32)}.html`); await writeFile(page, 'stale', { mode: 0o600 });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(), recent = new Date().toISOString();
  const receipts = { aged: { mutation: true, state: 'unknown', acceptedAt: old, completedAt: old }, read: { mutation: false, state: 'succeeded', acceptedAt: recent, completedAt: recent },
    kept: { mutation: true, state: 'unknown', acceptedAt: recent, completedAt: recent } };
  const ids = {};
  for (const [name, receipt] of Object.entries(receipts)) {
    ids[name] = randomUUID();
    await writePrivate(path.join(directory, 'requests', `${ids[name]}.json`), { invocationId: ids[name], operation: 'spec.save', clientId: 'c', root, ...receipt });
  }
  const service = await startService({ directory, execute: async () => ({ value: {} }) }); cleanup(() => service.close());
  assert.deepEqual((await readdir(directory)).filter(name => /^(?:save|upload|launch)-/u.test(name)), []);
  assert.deepEqual(await readdir(path.join(directory, 'requests')), [`${ids.kept}.json`]);
  const browser = await connect(service, root);
  const before = service.status().lastActivityAt;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await browser.api('/api/events?after=0')).status, 200);
  assert.equal(service.status().lastActivityAt, before, 'an open tab polling is not work');
  assert.equal((await browser.api('/api/events?after=0&working=1')).status, 200);
  assert.notEqual(service.status().lastActivityAt, before, 'a tab holding unsaved writing is');
  assert.deepEqual(nativeEnvironment({ PATH: '/usr/bin', 'BASH_FUNC_module%%': '() {  :; }' }), { PATH: '/usr/bin' });
});

test('browser Code Explainer shares the editor views and keeps actions bound to captured code', { timeout: 90_000 }, async t => {
  const screenshot = process.env.SINGULARITY_FLOW_CODE_EXPLAINER_SCREENSHOT;
  const { root, directory, mustGit, cleanup } = await fixture(t);
  await mkdir(path.join(root, 'src'));
  const quote = path.join(root, 'src', 'quote.js');
  const original = [
    "import { calculateTax } from './tax.js';",
    '',
    'export function quoteTotal(subtotal) {',
    "  if (subtotal < 0) throw new Error('Subtotal must be positive');",
    '  return subtotal + calculateTax(subtotal);',
    '}',
    ''
  ].join('\n');
  await writeFile(quote, original);
  await writeFile(path.join(root, 'src', 'tax.js'), 'export function calculateTax(subtotal) {\n  return subtotal * 0.08;\n}\n');
  await writeFile(path.join(root, 'src', 'receipt.js'), [
    "import { quoteTotal } from './quote.js';",
    'export function formatReceipt(subtotal) {',
    '  return quoteTotal(subtotal).toFixed(2);',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'types.ts'), 'export interface Quote {\n  subtotal: number;\n  tax: number;\n}\n');
  await writeFile(path.join(root, 'src', 'api.js'), [
    "import { formatReceipt } from './receipt.js';",
    'export function submitQuote(request, response) {',
    '  response.send(formatReceipt(request.body.amount));',
    '}',
    'export function register(app) {',
    "  app.post('/quote', submitQuote);",
    '}', ''
  ].join('\n'));
  await mkdir(path.join(root, 'singularity'));
  await writeFile(path.join(root, 'singularity', 'private-example.js'), 'export function internalOnly() { return 7; }\n');
  await mkdir(path.join(root, 'test'));
  const regression = path.join(root, 'test', 'quote.test.js');
  await writeFile(regression, "import test from 'node:test';\n");
  mustGit('add', '.');
  mustGit('commit', '-qm', 'Checkout source');
  await writeFile(quote, original
    .replace('export function quoteTotal', '// @clause:QUOTE-1:AC-001 reject an invalid subtotal\nexport function quoteTotal')
    .replace('subtotal < 0', 'subtotal <= 0'));
  await writeFile(regression, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { quoteTotal } from '../src/quote.js';",
    '// @ac:QUOTE-1:AC-001',
    "test('rejects a zero subtotal', () => assert.throws(() => quoteTotal(0)));", ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'z-local.js'), 'export function temporaryDiscount() {\n  return 0.05;\n}\n');
  const before = mustGit('status', '--porcelain');

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true }); cleanup(() => browser.close());
  const service = await startService({ directory }); cleanup(() => service.close());
  const launch = await control(service.descriptor, 'bootstrap', { root, clientId: randomUUID() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(launch.url);
  await page.getByRole('link', { name: 'Code Explainer', exact: true }).click();
  await page.locator('#cx-nodes .cx-row').filter({ hasText: 'quoteTotal' }).waitFor();
  assert.ok((await page.locator('#cx-canvas').boundingBox()).height > 250, 'the graph has room when its note is hidden');
  assert.equal(await page.getByRole('tab', { name: /^My change/ }).getAttribute('aria-selected'), 'true');
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });

  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.locator('.cx-ins-title').getByText('quoteTotal', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Who calls it/ }).click();
  await inspector.locator('[data-section="callers"]').getByRole('button', { name: /formatReceipt/ }).waitFor();
  await inspector.locator('[data-section="callees"]').getByRole('button', { name: /calculateTax/ }).waitFor();
  await page.locator('#cx-edges .edge.inferred').first().waitFor({ state: 'attached' });
  const world = page.locator('#cx-world');
  const transform = await world.evaluate(node => node.style.transform);
  await page.locator('[data-action="zoom-in"]').click();
  assert.notEqual(await world.evaluate(node => node.style.transform), transform);

  await inspector.getByRole('button', { name: 'Compare diff', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const diff = dialog.getByRole('list', { name: 'Captured diff' });
  await diff.getByText(/subtotal <= 0/).waitFor();
  assert.deepEqual((await diff.locator('li[data-diff="+"]').filter({ hasText: 'subtotal <= 0' }).locator('span').allTextContents()), ['', '5', '+']);
  assert.deepEqual((await diff.locator('li[data-diff="-"]').filter({ hasText: 'subtotal < 0' }).locator('span').allTextContents()), ['4', '', '-']);
  await dialog.getByRole('button', { name: 'Close preview' }).click();
  await inspector.getByRole('button', { name: 'Open source' }).click();
  await dialog.getByRole('list', { name: 'Source excerpt' }).getByText(/subtotal <= 0/).waitFor();
  await dialog.getByRole('button', { name: 'Close preview' }).click();

  const inView = await readFile(quote, 'utf8');
  await writeFile(quote, inView.replace('subtotal <= 0', 'subtotal < 1'));
  await inspector.getByRole('button', { name: 'Open source' }).click();
  await dialog.getByRole('alert').getByText(/This file changed or became unavailable/).waitFor();
  await dialog.getByRole('button', { name: 'Close preview' }).click();
  await writeFile(quote, inView);

  await page.getByRole('button', { name: 'Steps and decisions', exact: true }).click();
  await page.locator('#cx-logic .cx-logic-node.decision').getByText(/subtotal <= 0/).waitFor();
  await page.getByRole('tab', { name: /^My change/ }).click();
  await page.getByRole('tab', { name: /^Requirements → tests/ }).click();
  await page.locator('#cx-trace').getByRole('button', { name: /^QUOTE-1:AC-001/ }).waitFor();
  await page.locator('#cx-trace').getByText('quote.test.js', { exact: true }).waitFor();
  await page.locator('#cx-trace').getByText('No test run is recorded for this phase generation.').waitFor();
  await page.getByRole('tab', { name: /^Walk through it/ }).click();
  await page.locator('#cx-walk').getByText(/^Step 1 of/).waitFor();
  await page.locator('#cx-walk').getByRole('button', { name: /Next/ }).click();
  await page.locator('#cx-walk').getByText(/^Step 2 of/).waitFor();

  const search = page.getByRole('searchbox', { name: 'Find a function' });
  await search.fill('temporaryDiscount');
  await search.press('Enter');
  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  await inspector.locator('.cx-ins-title').getByText('temporaryDiscount', { exact: true }).waitFor();
  await inspector.getByRole('button', { name: 'Open source' }).click();
  await dialog.getByRole('list', { name: 'Source excerpt' }).getByText('return 0.05;').waitFor();
  await dialog.getByRole('button', { name: 'Close preview' }).click();
  await search.fill('');

  await page.getByRole('tab', { name: 'Map', exact: true }).click();
  const repo = page.locator('#cx-repo');
  await repo.getByRole('button', { name: /^src\// }).click();
  await repo.getByRole('button', { name: /^src\/tax\.js/ }).waitFor();
  const pathInput = page.getByRole('searchbox', { name: 'Repository-relative path' });
  await pathInput.fill('src/tax.js');
  await pathInput.press('Enter');
  await repo.getByRole('button', { name: 'function calculateTax', exact: true }).click();
  await inspector.locator('.cx-ins-title').getByText('calculateTax', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder the full view maps' }).selectOption('-1');
  await page.locator('#cx-nodes .cx-row').filter({ hasText: 'formatReceipt' }).waitFor();
  await page.getByRole('tab', { name: 'What it is about', exact: true }).click();
  await page.locator('#cx-concepts').getByRole('heading', { name: /How it is organised/ }).waitFor();
  await page.getByRole('tab', { name: 'The data it holds', exact: true }).click();
  await page.locator('#cx-entities').getByText('Quote', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  await page.getByRole('button', { name: 'Data in and out', exact: true }).click();
  await page.getByRole('combobox', { name: 'Entry point' }).locator('option').filter({ hasText: 'POST /quote' }).waitFor({ state: 'attached' });

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole('button', { name: 'More', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const report = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  assert.equal(report.authority, 'none');
  assert.ok(report.symbols.some(symbol => symbol.name === 'calculateTax'));
  assert.ok(report.symbols.every(symbol => symbol.name !== 'internalOnly'));
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.ok(!JSON.stringify(stored).includes('calculateTax'));

  await page.getByRole('button', { name: 'Ask Copilot', exact: true }).click();
  const question = page.getByRole('textbox', { name: 'Ask a question' });
  await question.waitFor();
  assert.match(await question.inputValue(), /Code Explainer/u);
  assert.equal(await page.getByRole('log', { name: 'Chat conversation' }).textContent(), '');
  assert.equal(mustGit('status', '--porcelain'), before);
  assert.deepEqual(errors, []);
});

test('actual browser creates, edits, previews, saves and reloads a draft without retaining prose in browser storage', async t => {
  const { root, directory, cleanup } = await fixture(t);
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true }); cleanup(() => browser.close());
  const service = await startService({ directory, execute: async request => request.operation === 'instruction.list'
    ? { value: { schemaVersion: 2, resultType: 'command-result', data: { instructions: [
      { id: 'fixture-standard', label: 'Fixture standard', description: 'A projected native reader result.' }
    ] } } } : executeOperation(request) }); cleanup(() => service.close());
  const bootstrap = await control(service.descriptor, 'bootstrap', { root, clientId: randomUUID() });
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(bootstrap.url);
  await page.getByRole('heading', { name: 'Workspace overview', exact: true }).waitFor();
  assert.ok(!page.url().includes('ticket='));
  await page.getByRole('button', { name: /New specification/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Browser acceptance journey');
  await page.getByLabel(/Your starting idea/).fill('Explain how people can close an account.');
  await page.getByRole('button', { name: 'Create specification' }).click();
  await page.getByRole('textbox', { name: 'Specification content' }).waitFor();
  await page.getByRole('textbox', { name: 'Specification content' }).fill('# Browser acceptance journey\n\nThe person can close an account.');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('heading', { name: 'Browser acceptance journey' }).waitFor();
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved · version 2').waitFor();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Saved versions', exact: true }).click();
  await page.locator('#history-result').getByText('Version 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Checks', exact: true }).click();
  await page.getByRole('button', { name: 'Check draft', exact: true }).click();
  await page.locator('#check-result .pill').waitFor();
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  if (process.env.SINGULARITY_FLOW_UI_SCREENSHOT) await page.screenshot({ path: process.env.SINGULARITY_FLOW_UI_SCREENSHOT, fullPage: true });
  await page.reload();
  assert.equal(await page.getByRole('textbox', { name: 'Specification content' }).inputValue(), '# Browser acceptance journey\n\nThe person can close an account.');
  let interrupted = false;
  await page.route('**/api/requests/*', async route => { if (!interrupted) { interrupted = true; await route.abort('failed'); } else await route.continue(); });
  await page.getByRole('textbox', { name: 'Specification content' }).fill('# A second saved version\n\nWriting survives a lost reply.');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Check previous save', exact: true }).waitFor();
  await page.unroute('**/api/requests/*');
  await page.getByRole('button', { name: 'Check previous save', exact: true }).click();
  await page.getByText('All changes saved · version 3').waitFor();
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.ok(!JSON.stringify(stored).includes('close an account'));
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  assert.equal(await page.locator('body').evaluate(element => element.classList.contains('collapsed')), true);
  const second = await context.newPage();
  const secondLaunch = await control(service.descriptor, 'bootstrap', { root, clientId: randomUUID() });
  await second.goto(secondLaunch.url);
  await second.getByRole('heading', { name: 'Workspace overview', exact: true }).waitFor();
  const originalHash = new URL(page.url()).hash;
  await second.evaluate(hash => { location.hash = hash; }, originalHash);
  await second.getByRole('textbox', { name: 'Specification content' }).waitFor();
  await page.getByRole('textbox', { name: 'Specification content' }).fill('# First tab saved writing');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved · version 4').waitFor();
  await second.getByRole('textbox', { name: 'Specification content' }).fill('# My independently written alternative');
  await second.getByRole('button', { name: 'Save changes', exact: true }).click();
  await second.getByRole('button', { name: 'Save as another draft', exact: true }).waitFor();
  await second.getByRole('button', { name: 'Save as another draft', exact: true }).click();
  await second.waitForFunction(hash => location.hash !== hash, originalHash);
  await second.getByRole('textbox', { name: 'Specification content' }).waitFor();
  assert.equal(await second.getByRole('textbox', { name: 'Specification content' }).inputValue(), '# My independently written alternative');
  await page.reload(); await page.getByRole('textbox', { name: 'Specification content' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Specification content' }).inputValue(), '# First tab saved writing');
  await page.locator('#source-upload').setInputFiles({ name: 'référence.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=', 'base64') });
  await page.getByText('référence.png', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Read source', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#support-result img')?.naturalWidth === 1);
  await page.getByRole('link', { name: 'Instructions', exact: true }).click();
  await page.getByRole('heading', { name: 'Fixture standard', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('browser navigation, Story sorting and readable summaries work on desktop and narrow screens', async t => {
  const { root, base, directory, cleanup } = await fixture(t);
  const other = path.join(base, 'checkout-b');
  await mkdir(other);
  const calls = [];
  const values = {
    'story.list': { stories: [
      { workId: 'SW-1', title: 'Checkout recovery', createdAt: '2026-10-01T10:00:00Z', createdBy: 'Team A',
        phase: 'implementation', repository: { id: 'checkout' }, checkoutPath: other, availability: 'ready' },
      { workId: 'SW-2', title: 'Payment reporting', createdAt: '2026-10-02T10:00:00Z', createdBy: 'Team B',
        phase: 'planning', repository: { id: 'reporting' }, availability: 'remote-only' }
    ] },
    'spec.list': { drafts: [{ specId: 'SPEC-CHECKOUT', title: 'Local checkout idea', sequence: 2 }],
      specs: [{ specId: 'SPEC-CHECKOUT', latest: { title: 'Shared checkout rules', revision: 3, reviewState: 'reviewed' } }] },
    'decision.list': { resultType: 'sflow-decisions', workId: 'SW-1', phaseLabel: 'Implementation',
      plain: { headline: 'One decision is waiting.' },
      items: [{ title: 'Review the checkout result', plain: { why: 'A visual check is required.' },
        decidedBy: { words: 'A reviewer from Team A can answer.' } }] },
    'app.plan': { resultType: 'sflow-app-plan', entries: [{ id: 'web', name: 'Checkout app', argv: ['npm', 'run', 'dev'] }] },
    'app.status': { resultType: 'sflow-app-status', entries: [{ id: 'web', name: 'Checkout app', started: false, ready: false }] },
    'tests.plan': { resultType: 'sflow-test-plan', commands: [{ id: 'smoke', argv: ['npm', 'test'] }] },
    'tests.summary': { resultType: 'sflow-test-summary', run: { id: 'run-1', label: 'Checkout tests' },
      totals: { passed: 6, failed: 1, skipped: 0 }, commands: [{ id: 'smoke', status: 'failed' }] }
  };
  const service = await startService({ directory, execute: async ({ operation }) => {
    calls.push(operation);
    assert.ok(Object.hasOwn(values, operation), `Unexpected operation: ${operation}`);
    return { value: values[operation] };
  } });
  cleanup(() => service.close());
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true }); cleanup(() => browser.close());
  const launch = await control(service.descriptor, 'bootstrap', { root, clientId: randomUUID() });
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(launch.url);
  await page.getByRole('heading', { name: 'Workspace overview' }).waitFor();
  assert.deepEqual(calls, [], 'the overview renders from the session without asking for repository reads');
  await nav.getByRole('link', { name: 'Stories' }).click();
  const stories = page.getByRole('table', { name: 'Stories' });
  await stories.waitFor();
  assert.match(await stories.getByRole('row').nth(1).textContent(), /Payment reporting/u);
  await stories.getByRole('button', { name: 'Created' }).click();
  assert.match(await stories.getByRole('row').nth(1).textContent(), /Checkout recovery/u);
  await page.getByRole('searchbox', { name: 'Find a Story' }).fill('team b');
  assert.equal(await stories.getByRole('row').count(), 2);
  await page.getByRole('searchbox', { name: 'Find a Story' }).clear();
  await page.getByRole('button', { name: 'Can open here' }).click();
  assert.equal(await stories.getByRole('row').count(), 2);

  await nav.getByRole('link', { name: 'Spec Studio' }).click();
  await page.getByRole('button', { name: 'Published', exact: true }).click();
  await page.getByRole('link', { name: 'Shared checkout rules', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Local checkout idea', exact: true }).count(), 0);
  await page.getByRole('searchbox', { name: 'Find a specification' }).fill('unmatched');
  await page.getByRole('heading', { name: 'No matching specifications' }).waitFor();

  await nav.getByRole('link', { name: 'Decisions' }).click();
  await page.getByRole('heading', { name: 'Review the checkout result' }).waitFor();
  await page.getByText('A visual check is required.', { exact: true }).waitFor();
  assert.equal(await page.locator('#main pre').isVisible(), false, 'the native packet is available on demand');
  await page.getByText('Technical details', { exact: true }).click();
  assert.equal(await page.locator('#main pre').isVisible(), true);
  await nav.getByRole('link', { name: 'Run & Test' }).click();
  await page.getByText('npm run dev', { exact: true }).waitFor();
  await page.getByText('Not started', { exact: true }).waitFor();
  await page.getByText('Checkout tests', { exact: true }).waitFor();
  await page.getByText('6 passed', { exact: true }).waitFor();
  assert.equal(await page.locator('#main pre:visible').count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole('button', { name: 'Open navigation' });
  assert.equal(await nav.isVisible(), false);
  await menu.click();
  assert.equal(await nav.isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await nav.isVisible(), false);
  assert.equal(await menu.evaluate(element => element === document.activeElement), true);
  await menu.click();
  await nav.getByRole('link', { name: 'Stories' }).click();
  await stories.waitFor();
  assert.equal(await nav.isVisible(), false);
  const width = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth
  }));
  assert.equal(width.content, width.viewport, 'the Story table scrolls within the page at phone width');
  assert.deepEqual(errors, []);
});

test('browser Stories bind code, decisions, questions and test evidence to the real Story worktree', { timeout: 85_000 }, async t => {
  const { root, base, directory, env, mustGit, cleanup } = await fixture(t, { checkout: 'workspace/repos/app' });
  const workspacePath = path.join(base, 'workspace');
  const remote = path.join(base, 'app.git');
  const apiRemote = path.join(base, 'api.git');
  const apiRoot = path.join(workspacePath, 'repos', 'api');
  const id = 'BROWSER-101';
  const title = 'Track invoice totals';
  const git = (checkout, ...args) => mustGit('-C', checkout, ...args);
  const cli = (checkout, ...args) => {
    const result = spawnSync(process.execPath, [cliPath, ...args, '--no-model', '--json'], {
      cwd: checkout, env, encoding: 'utf8', timeout: 30_000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const [{ default: YAML }, { readWorkspace }, { rememberWorkspace }, { chromium }] = await Promise.all([
    import('yaml'), import('../src/workspace-manifest.mjs'), import('../src/workspace.mjs'), import('playwright-core')
  ]);
  cli(root, 'init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.repositoryReadiness.requiredBeforeStory = false;
  const standin = path.join(base, 'story-chat.mjs');
  const chatCalls = path.join(base, 'story-chat.jsonl');
  await writeFile(standin, [
    'import { readFileSync, appendFileSync } from "node:fs";',
    'const args = process.argv.slice(2);',
    'const input = JSON.parse(readFileSync(args[args.indexOf("--attachment") + 1], "utf8").split("\\n").at(-1));',
    'appendFileSync(' + JSON.stringify(chatCalls) + ', JSON.stringify(input) + "\\n");',
    'const tests = input.records.find(record => record.type === "story-tests");',
    'process.stdout.write(tests ? "Review the recorded tests [" + tests.citation + "]." : "General answer.");'
  ].join('\n'));
  config.models = { defaultProvider: 'chat-test', providers: { 'chat-test': {
    type: 'copilot-cli', executable: process.execPath, arguments: [standin], promptTransport: 'attachment'
  } } };
  await writeFile(configPath, YAML.stringify(config));
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.repositories = { app: { url: remote, defaultBranch: 'main', required: true },
    api: { url: apiRemote, defaultBranch: 'main', required: true } };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  await writeFile(path.join(root, 'singularity/capabilities.yml'), YAML.stringify({
    version: 1, capabilities: {
      enterprise: { kind: 'collection', parent: null, policy: {} },
      product: { kind: 'collection', parent: 'enterprise', policy: {} },
      delivery: { kind: 'delivery', parent: 'product', repositories: ['app', 'api'], policy: {} }
    }
  }));
  await writeFile(path.join(root, 'invoice.js'), 'export function invoiceTotal(value) { return value; }\n');
  mustGit('add', '.'); mustGit('commit', '-qm', 'Initialize application');
  mustGit('branch', 'sflow/config');
  mustGit('init', '--bare', '-q', '-b', 'main', remote);
  mustGit('init', '--bare', '-q', '-b', 'main', apiRemote);
  mustGit('remote', 'add', 'origin', remote);
  mustGit('push', '-qu', 'origin', 'main', 'sflow/config');
  mustGit('clone', '--no-local', '-q', remote, apiRoot);
  git(apiRoot, 'remote', 'set-url', 'origin', apiRemote);
  await writeFile(path.join(apiRoot, 'payments.js'), 'export function reconcileInvoice(value) { return value; }\n');
  git(apiRoot, 'add', 'payments.js'); git(apiRoot, 'commit', '-qm', 'Initialize API');
  git(apiRoot, 'push', '-qu', 'origin', 'main');
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify({
    version: 1, id: 'browser-stories', name: 'Invoice workspace', anchor: { provider: 'workspace', key: 'browser-stories' },
    leadRepository: 'app', capabilities: ['delivery'], repositories: {
      app: { url: remote, path: 'repos/app', defaultBranch: 'main', capabilities: ['delivery'] },
      api: { url: apiRemote, path: 'repos/api', defaultBranch: 'main', capabilities: ['delivery'] }
    }
  }));
  await rememberWorkspace(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(workspacePath));
  cli(root, 'workspace', 'use', workspacePath, '--repository', 'app');
  cli(root, 'start', id, '--isolated-worktree', '--from-branch', 'main', '--capability', 'delivery', '--work-type', 'feature',
    '--title', title, '--description', 'Return a normalized invoice total.');
  const canonical = JSON.parse(cli(root, 'workspace', 'stories', id)).stories;
  assert.deepEqual(canonical.map(({ role, availability }) => [role, availability]).sort(),
    [['secondary', 'ready'], ['story', 'ready']]);
  const { checkoutPath, branch } = canonical.find(item => item.role === 'story');
  const { checkoutPath: apiCheckout } = canonical.find(item => item.role === 'secondary');
  assert.notEqual(checkoutPath, await realpath(root));
  await writeFile(path.join(checkoutPath, 'invoice.js'), 'export function invoiceTotal(value) { return Math.round(value); }\n');
  await writeFile(path.join(apiCheckout, 'payments.js'), 'export function reconcileInvoice(value) { return Math.abs(value); }\n');
  git(apiCheckout, 'add', 'payments.js');
  git(apiCheckout, 'commit', '-qm', 'Implement invoice reconciliation in the API');
  const storyBefore = git(checkoutPath, 'status', '--porcelain');
  const refBefore = git(checkoutPath, 'rev-parse', 'HEAD');

  const browser = await chromium.launch({ headless: true }); cleanup(() => browser.close());
  const service = await startService({ directory }); cleanup(() => service.close());
  const launch = await control(service.descriptor, 'bootstrap', { root, clientId: randomUUID(), environment: env });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(12_000);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const openStory = page.getByRole('button', { name: 'Open ' + title, exact: true });
  const responses = [];
  page.on('response', async response => {
    if (new URL(response.url()).pathname.startsWith('/api/requests/') && response.ok()) {
      const receipt = await response.json();
      if (receipt.state === 'succeeded') responses.push(receipt);
    }
  });
  await page.goto(launch.url);
  await nav.getByRole('link', { name: 'Stories' }).click();
  await openStory.click();
  await page.getByRole('heading', { name: 'Workspace overview' }).waitFor();
  assert.equal(await page.locator('#context-name').textContent(), id);
  assert.equal(await page.locator('#context-switch').getAttribute('title'), checkoutPath);

  await nav.getByRole('link', { name: 'Code Explainer' }).click();
  await page.locator('#cx-nodes .cx-row').filter({ hasText: 'invoiceTotal' }).waitFor();
  const code = responses.find(item => item.operation === 'code.changes')?.result?.value;
  assert.equal((code?.data ?? code)?.codeMap?.model?.story?.workId, id);
  await nav.getByRole('link', { name: 'Ask SFlow' }).click();
  const field = page.getByRole('textbox', { name: 'Ask a question' });
  await field.fill('current story');
  await field.press('Enter');
  await page.getByRole('log', { name: 'Chat conversation' }).getByText(new RegExp(title)).waitFor();
  const thread = page.getByRole('log', { name: 'Chat conversation' });
  await field.fill('What changed?');
  await field.press('Enter');
  await thread.getByText(/1 changed file in app/).waitFor();
  await thread.getByText(/invoice\.js/).waitFor();
  await field.fill('What needs a decision?');
  await field.press('Enter');
  await thread.getByRole('link', { name: 'Open Decisions' }).waitFor();
  await field.fill('What tests ran?');
  await field.press('Enter');
  await thread.getByText(`No retained test run for ${id} in this phase.`).waitFor();
  await field.fill('Did they pass?');
  await field.press('Enter');
  const followUp = thread.locator('.ask-turn').filter({ hasText: 'Did they pass?' });
  await followUp.getByText(`No retained test run for ${id} in this phase.`).waitFor();
  await followUp.getByRole('link', { name: 'Open Run & Test' }).waitFor();
  await thread.getByText(/1 changed file in app/).waitFor();
  await field.fill("What's left on this Story?");
  await field.press('Enter');
  await thread.locator('.ask-turn').filter({ hasText: "What's left on this Story?" })
    .getByRole('link', { name: 'Open Run & Test' }).waitFor();
  await assert.rejects(access(chatCalls));
  const include = page.getByRole('checkbox', { name: 'Include Story and workspace context' });
  await include.check();
  await field.fill('What should I review before I hand it off?');
  await field.press('Enter');
  const modelReply = thread.locator('.ask-turn').filter({ hasText: 'What should I review before I hand it off?' });
  await modelReply.getByRole('link', { name: /Open Run & Test/ }).waitFor();
  await include.uncheck();
  await field.fill('Explain how tidal power works.');
  await field.press('Enter');
  await thread.getByText('General answer.').waitFor();
  const prompts = (await readFile(chatCalls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(prompts[0].records.filter(record => record.type.startsWith('story-')).map(({ type, id }) => [type, id]),
    ['story-status', 'story-decisions', 'story-tests'].map(type => [type, id]));
  assert.ok(prompts[0].previous.some(turn => turn.question === 'Did they pass?' && turn.answer.includes(id)));
  assert.deepEqual(prompts[1].previous, []);
  assert.deepEqual(prompts[1].records, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.setViewportSize({ width: 1440, height: 960 });
  await nav.getByRole('link', { name: 'Decisions' }).click();
  await page.locator('.decision-summary').getByText(new RegExp('^' + id + ' ·')).waitFor();
  await nav.getByRole('link', { name: 'Run & Test' }).click();
  await page.getByText(`No retained test run for ${id} in this phase.`).waitFor();
  const summary = responses.find(item => item.operation === 'tests.summary')?.result?.value;
  assert.equal(summary?.scope?.workId, id, JSON.stringify(summary?.scope));
  assert.equal(git(checkoutPath, 'status', '--porcelain'), storyBefore);
  assert.equal(git(checkoutPath, 'rev-parse', 'HEAD'), refBefore);
  assert.equal(mustGit('status', '--porcelain'), '');

  await nav.getByRole('link', { name: 'Stories' }).click();
  await page.getByRole('button', { name: 'Open ' + title + ' in api', exact: true }).click();
  await page.getByRole('heading', { name: 'Selected Story' }).waitFor();
  assert.equal(await page.locator('#context-switch').getAttribute('title'), apiCheckout);
  await nav.getByRole('link', { name: 'Code Explainer' }).click();
  await page.locator('#cx-nodes .cx-row').filter({ hasText: 'reconcileInvoice' }).waitFor();
  await page.getByText(`Story ${id} · api · ${branch}`, { exact: true }).waitFor();
  assert.equal(await page.locator('#cx-nodes .cx-row').filter({ hasText: 'invoiceTotal' }).count(), 0);
  await nav.getByRole('link', { name: 'Decisions' }).click();
  await page.locator('.decision-summary').getByText(new RegExp('^' + id + ' ·')).waitFor();
  await nav.getByRole('link', { name: 'Run & Test' }).click();
  await page.getByText(`No retained test run for ${id} in this phase.`).waitFor();

  await page.locator('#context-switch').click();
  await page.getByRole('button', { name: /^app/ }).click();
  await nav.getByRole('link', { name: 'Stories' }).click();
  await openStory.waitFor();
  // The folder still exists, but a different branch now occupies it.
  git(checkoutPath, 'switch', '-qc', 'other-invoice');
  await openStory.click();
  await page.locator('#banner-message').filter({ hasText: 'Refresh Stories' }).waitFor();
  assert.equal(await page.locator('#context-switch').getAttribute('title'), await realpath(root));
  assert.equal(git(checkoutPath, 'branch', '--show-current'), 'other-invoice');
  git(checkoutPath, 'switch', '-q', branch);
});

test('Code Explainer follows the active Story from an engine clone and updates an open tab', { timeout: 60_000 }, async t => {
  const { root, base, directory, env, mustGit, cleanup } = await fixture(t, { checkout: 'workspace/repos/app' });
  const workspace = path.join(base, 'workspace');
  const engine = path.join(base, 'engine');
  const remote = path.join(base, 'app.git');
  const git = (checkout, ...args) => mustGit('-C', checkout, ...args);
  const [{ chromium }, { rememberWorkspace, readWorkspace }, { recordStoryCheckout, storyIndexFile },
    { activateWorkspaceContext, activateWorkspaceStoryContext }] = await Promise.all([
    import('playwright-core'), import('../src/workspace.mjs'), import('../src/story-index.mjs'), import('../src/workspace-context.mjs')
  ]);
  await mkdir(path.join(engine, 'bin'), { recursive: true });
  git(engine, 'init', '-q', '-b', 'main');
  await writeFile(path.join(engine, 'package.json'), '{"name":"singularity-flow"}\n');
  await writeFile(path.join(engine, 'bin', 'singularity-flow.mjs'), 'export function engineOnly() { return 1; }\n');
  git(engine, 'add', '.'); git(engine, 'commit', '-qm', 'Engine fixture');
  await writeFile(path.join(engine, 'bin', 'singularity-flow.mjs'), 'export function engineOnly() { return 2; }\n');
  mustGit('init', '--bare', '-q', '-b', 'main', remote);
  mustGit('remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'totals.js'), 'export function total(value) { return value; }\n');
  mustGit('add', '.'); mustGit('commit', '-qm', 'Application baseline');
  const baseCommit = mustGit('rev-parse', 'HEAD');
  await writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({
    version: 1, id: 'example-app', name: 'Application', anchor: { provider: 'workspace', key: 'example-app' },
    leadRepository: 'app', repositories: { app: { url: remote, path: 'repos/app', defaultBranch: 'main' } }
  }));
  const registry = env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, selection = env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  await rememberWorkspace(registry, await readWorkspace(workspace));
  const active = await activateWorkspaceContext(registry, selection, workspace, { repositoryId: 'app' });
  assert.equal(active.storyId, null);
  async function makeStory(id, branch, name) {
    const checkout = path.join(workspace, branch);
    mustGit('worktree', 'add', '-qb', branch, checkout, baseCommit);
    await writeFile(path.join(checkout, 'totals.js'), `export function ${name}(value) { return value + 10; }\n`);
    git(checkout, 'add', 'totals.js'); git(checkout, 'commit', '-qm', 'Implement the Story');
    const implementation = git(checkout, 'rev-parse', 'HEAD');
    const storyFolder = path.join(checkout, 'singularity', 'work-items', id);
    await mkdir(storyFolder, { recursive: true });
    await writeFile(path.join(storyFolder, 'workflow.json'), JSON.stringify({
      schemaVersion: 1, status: 'in_progress', workItem: { id, title: name, branch, baseCommit },
      currentPhase: 'verification', phaseOrder: ['verification'],
      phases: { verification: { id: 'verification', status: 'in_progress', generation: 1,
        generationIntent: { baseline: { commit: implementation } }, artifacts: [] } }
    }));
    git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'Start verification');
    const recorded = await recordStoryCheckout(checkout, { env });
    assert.equal(recorded.recorded, true, JSON.stringify(recorded));
    return { id, branch, name, checkout: await realpath(checkout) };
  }
  const first = await makeStory('INV-1', 'explain-first', 'firstStoryTotal');
  const second = await makeStory('INV-2', 'explain-next', 'secondStoryTotal');
  const attach = story => activateWorkspaceStoryContext(selection, registry, story.checkout, { storyId: story.id });
  const browser = await chromium.launch({ headless: true }); cleanup(() => browser.close());
  const service = await startService({ directory }); cleanup(() => service.close());
  const open = () => control(service.descriptor, 'bootstrap', { root: path.join(engine, 'bin'), clientId: randomUUID(), environment: env });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(12_000);
  await page.goto((await open()).url);
  await page.getByRole('link', { name: 'Code Explainer', exact: true }).click();
  await page.getByRole('heading', { name: 'Open a Story to see its code' }).waitFor();
  const rows = page.locator('#cx-nodes .cx-row');
  assert.equal(await rows.filter({ hasText: 'engineOnly' }).count(), 0);

  await attach(first);
  await rows.filter({ hasText: first.name }).waitFor();
  assert.equal(await page.locator('#context-switch').getAttribute('title'), first.checkout);
  const reopened = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await reopened.goto((await open()).url);
  await reopened.getByRole('heading', { name: 'Selected Story' }).waitFor();
  assert.equal(await reopened.locator('#context-switch').getAttribute('title'), first.checkout);
  await reopened.close();

  // A Story from an older install can still be selected before its index is rebuilt.
  const indexPath = storyIndexFile(env);
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.entries = index.entries.filter(entry => entry.workId !== second.id);
  await writeFile(indexPath, JSON.stringify(index));
  await attach(second);
  await rows.filter({ hasText: second.name }).waitFor();
  assert.equal(await rows.filter({ hasText: first.name }).count(), 0);
  await page.getByText(`Story ${second.id} · app · ${second.branch}`, { exact: true }).waitFor();

  await page.locator('#context-switch').click();
  await page.getByRole('button', { name: new RegExp('^' + first.id) }).click();
  await rows.filter({ hasText: first.name }).waitFor();
  assert.equal(await page.locator('#context-switch').getAttribute('aria-description'), 'Using the checkout selected in this tab');
  await page.locator('#context-switch').click();
  await page.getByRole('button', { name: 'Follow active Story', exact: true }).click();
  await rows.filter({ hasText: second.name }).waitFor();

  await page.getByRole('link', { name: 'Ask SFlow', exact: true }).click();
  const question = page.getByRole('textbox', { name: 'Ask a question' });
  const thread = page.getByRole('log', { name: 'Chat conversation' });
  await question.fill('What phase are we in?');
  await question.press('Enter');
  await thread.getByText(new RegExp(second.id)).waitFor();
  await question.fill('Where does this Story stand?');
  await attach(first);
  await page.locator('.ask-context').getByText(first.name, { exact: true }).waitFor();
  assert.equal(await question.inputValue(), 'Where does this Story stand?');
  assert.equal(await thread.getByText(new RegExp(second.id)).count(), 0);
  await question.press('Enter');
  await thread.getByText(new RegExp(first.id)).waitFor();
  const workflowFile = path.join(first.checkout, 'singularity', 'work-items', first.id, 'workflow.json');
  const closed = JSON.parse(await readFile(workflowFile, 'utf8'));
  await writeFile(workflowFile, JSON.stringify({ ...closed, status: 'closed', currentPhase: null }));
  await question.fill('how to start the work');
  await question.press('Enter');
  const startHelp = thread.locator('.ask-turn').filter({ hasText: 'how to start the work' });
  await startHelp.getByText('The selected Story is closed.', { exact: true }).waitFor();
  await startHelp.getByText('Start new work', { exact: true }).waitFor();
  await startHelp.getByText('Clone Story', { exact: true }).waitFor();
  await startHelp.getByRole('link', { name: 'Browse Stories', exact: true }).waitFor();
  await startHelp.getByRole('button', { name: /Starting work/ }).waitFor();
  await attach(second);
  await page.getByRole('link', { name: 'Code Explainer', exact: true }).click();
  await rows.filter({ hasText: second.name }).waitFor();

  git(second.checkout, 'switch', '-qc', 'different-branch');
  await page.getByText(/checkout for the active Story INV-2 is unavailable/u).waitFor();
  assert.equal(await rows.filter({ hasText: second.name }).count(), 0);
  assert.equal(await rows.filter({ hasText: 'engineOnly' }).count(), 0);
  assert.equal(new URL(page.url()).hash, '#code');
});

test('an agent turn only reads the service status: ui open, serve and stop with --for-agent are refused with the person\'s route', async () => {
  const { run } = await import('../src/local-ui/cli.mjs');
  for (const action of ['open', 'serve', 'stop']) {
    await assert.rejects(run(['ui', action, '--for-agent'], { positionals: ['ui', action], options: { 'for-agent': true } }), (error) => {
      assert.equal(error.code, 'UI_FOREGROUND_NATIVE_ONLY');
      assert.match(error.message, new RegExp(`^ui ${action} runs only from the person's own terminal or VS Code`, 'u'));
      return true;
    });
  }
  // `ui status` is never refused for being an agent turn (it may still fail for another reason, never this one).
  await run(['ui', 'status', '--for-agent'], { positionals: ['ui', 'status'], options: { 'for-agent': true } })
    .then(() => {}, (error) => assert.notEqual(error.code, 'UI_FOREGROUND_NATIVE_ONLY'));
});

test('Ask SFlow agrees across CLI, browser and Copilot reads and reopens the issued revision', { timeout: 60_000 }, async t => {
  const { root, directory, env, mustGit, cleanup } = await fixture(t);
  const { revisionFiles } = await import('../src/spec-library/library.mjs');
  const { revisionDirectory } = await import('../src/spec-library/ids.mjs');
  const { createHash } = await import('node:crypto');
  const { createHostGateway, boundedToolAnswer } = await import('../src/gateway/host.mjs');
  const { gatewayPlanners } = await import('../src/gateway/planners/index.mjs');
  const specId = 'SPEC-ASK-FIXTURE';
  const secret = inventedValue('gh', 'p_', 'R7sV'.repeat(10));
  const firstBody = ['# Checkout pricing', '', 'api_key = "' + secret + '"', ''].join('\n');
  const originalBranch = mustGit('branch', '--show-current');
  const now = '2026-01-10T12:00:00.000Z';
  const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
  const newRevision = async (revision, title, body, parent = null) => {
    const built = revisionFiles({
      specId, revision, parent, reviewState: 'reviewed', operationId: 'test-ask-revision-' + revision,
      actor: { name: 'Example Reviewer', email: 'reviewer@example.test' }, recordedAt: now,
      head: { sequence: revision, snapshotSha256: hash(body), draft: { title, kind: 'business', spec: body, gaps: [], research: [] } },
      report: { counts: { d: 0, a: 0, h: 0 }, blocking: [] }
    });
    const target = path.join(root, revisionDirectory(specId, revision));
    await mkdir(target, { recursive: true });
    for (const [name, bytes] of Object.entries(built.files)) await writeFile(path.join(target, name), bytes);
    mustGit('add', '-A'); mustGit('commit', '-qm', 'Fixture specification revision ' + revision);
    return { revision, stateCommit: mustGit('rev-parse', 'HEAD'), manifestSha256: hash(built.files['manifest.json']) };
  };
  mustGit('switch', '-qc', 'state');
  const original = await newRevision(1, 'Checkout pricing', firstBody);
  mustGit('switch', '-qc', 'ask-order', originalBranch);
  const stateDir = path.join(root, 'singularity/work-items/ASK-ORDER');
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1, state: 'in-progress',
    workItem: { id: 'ASK-ORDER', branch: 'ask-order', title: 'Order discount',
      source: { specification: [{ ...original, revision: specId + '@1' }] } },
    phaseOrder: ['implementation'], currentPhase: 'implementation',
    phases: { implementation: { id: 'implementation', status: 'in-progress', generation: 0,
      requiredArtifact: { path: 'implementation-summary.md' }, artifacts: [] } }
  }));
  mustGit('add', '-A'); mustGit('commit', '-qm', 'Fixture Story');
  const stateFile = path.join(stateDir, 'workflow.json');
  const workBefore = await readFile(stateFile, 'utf8');
  const refsBefore = mustGit('show-ref');
  const checkoutBefore = mustGit('rev-parse', 'HEAD');
  const cli = (...args) => {
    const child = spawnSync(process.execPath, [cliPath, 'ask', ...args, '--json', '--no-model'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };

  const service = await startService({ directory }); cleanup(() => service.close());
  const first = await connect(service, root);
  const otherTab = await connect(service, root, { clientId: first.clientId, cookie: first.cookie });
  const ask = (tab, input) => tab.api('/api/ask', { contextId: tab.session.context.id, ...input });
  const query = 'spec used for this Story';
  const native = cli(query, '--for-person');
  assert.equal(native.work.id, 'ASK-ORDER', JSON.stringify(native));
  assert.deepEqual(native.work.blockers, ['required-artifact-missing']);
  assert.equal(native.specifications[0].reference, specId + '@1');
  const submitted = await ask(first, { interaction: 'submit', query });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.value));
  assert.deepEqual(submitted.value.work, native.work);
  const [selection] = submitted.value.specifications;
  const { selection: opaque, ...binding } = selection;
  assert.deepEqual(binding, native.specifications[0]);
  assert.equal(submitted.value.resultSetId, native.resultSetId);
  assert.equal((await ask(otherTab, { interaction: 'activate', selection: opaque })).status, 409);
  assert.equal((await ask(first, { interaction: 'activate', selection: opaque, reference: specId + '@2' })).status, 400);
  assert.equal((await ask(first, { interaction: 'submit', query, operation: 'work.start' })).status, 400);

  const host = createHostGateway({ root, hostSessionId: 'ask-fixture', planners: gatewayPlanners() });
  const resolved = await host.kernel.resolve({ utterance: 'ask sflow', arguments: { query } });
  const read = await host.kernel.read({ resolutionId: resolved.next[0]?.handle });
  assert.equal(read.operation.id, 'ask.lookup', JSON.stringify(read));
  assert.equal(JSON.stringify(read).includes(secret), false);
  assert.deepEqual(read.data.work, native.work);
  assert.deepEqual(read.data.specifications, native.specifications);
  const onWire = boundedToolAnswer('sflow_read', read);
  assert.equal(JSON.stringify(onWire).includes(secret), false);
  assert.equal(argvAllowed([cliPath, 'ask', specId + '@1', '--open-spec', '--for-person'], 'read-only-review', {}), false);

  assert.equal(await readFile(stateFile, 'utf8'), workBefore);
  assert.equal(mustGit('show-ref'), refsBefore);
  assert.equal(mustGit('rev-parse', 'HEAD'), checkoutBefore);
  assert.equal(mustGit('status', '--porcelain'), '');
  const modelArtifact = cli(specId + '@1', '--open-spec');
  assert.equal(modelArtifact.artifact.content.includes(secret), false);
  assert.equal(cli(specId + '@1', '--open-spec', '--for-person').artifact.content, firstBody);

  mustGit('switch', '-q', 'state');
  await newRevision(2, 'Newer checkout pricing', '# Revised terms\n', original);
  mustGit('switch', '-q', 'ask-order');
  const opened = await ask(first, { interaction: 'activate', selection: opaque });
  assert.equal(opened.status, 200, JSON.stringify(opened.value));
  assert.equal(opened.value.artifact.content, firstBody);
  assert.equal(opened.value.artifact.reference, specId + '@1');
  assert.equal(cli(specId).specifications[0].reference, specId + '@2');
  assert.equal(cli(query).specifications[0].reference, specId + '@1');

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true }); cleanup(() => browser.close());
  const launch = await control(service.descriptor, 'bootstrap', { root, clientId: randomUUID() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const loads = [];
  page.on('request', request => {
    if (['/api/ask', '/api/operations'].includes(new URL(request.url()).pathname)
        && request.postDataJSON()?.interaction !== 'chat-history') loads.push(request.url());
  });
  await page.goto(launch.url);
  await page.getByRole('link', { name: 'Ask SFlow', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Ask a question' });
  await field.fill('specifcation');
  await page.getByRole('list', { name: 'Suggested destinations' }).getByRole('button', { name: /Spec Studio/ }).waitFor();
  assert.equal(loads.length, 0);
  await field.fill('How do I publish?');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('heading', { name: 'Artifacts, templates, and publication' }).waitFor();
  assert.equal(loads.length, 1);
  await field.fill(query);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Open ' + specId + '@1 · Checkout pricing' }).click();
  await page.getByRole('heading', { name: 'Checkout pricing', exact: true, level: 2 }).waitFor();
  await field.fill('story ASK-ORDER');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Open ' + specId + '@1 · Checkout pricing' }).waitFor({ state: 'detached' });
  const linked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ask' &&
    response.request().postDataJSON().query === 'show the specification behind the first result');
  await page.getByRole('button', { name: 'Open the spec used for this Story' }).click();
  assert.equal((await (await linked).json()).evidence.revision, original.stateCommit);
  assert.equal(mustGit('status', '--porcelain'), '');
});

test('Ask SFlow history follows its pinned next page in the browser', { timeout: 60_000 }, async t => {
  const { root, directory, mustGit, cleanup } = await fixture(t);
  for (let index = 0; index < 20; index++) mustGit('commit', '--allow-empty', '-qm', 'History row ' + index);
  const pinned = mustGit('rev-parse', 'HEAD');
  const initial = mustGit('rev-list', '--max-parents=0', 'HEAD');
  const service = await startService({ directory });
  cleanup(() => service.close());
  const tab = await connect(service, root);
  const otherTab = await connect(service, root, { clientId: tab.clientId, cookie: tab.cookie });
  const query = 'commits from 2000-01-01 to 2099-12-31 in UTC on HEAD';
  const first = await tab.api('/api/ask', { contextId: tab.session.context.id, interaction: 'submit', query });
  assert.equal(first.status, 200);
  assert.equal(first.value.history.scope.revision, pinned);
  assert.equal(first.value.continuation.cursor, undefined);
  const selection = first.value.continuation.selection;
  assert.equal((await otherTab.api('/api/ask', { contextId: otherTab.session.context.id, interaction: 'continue', selection })).status, 409);
  assert.equal((await tab.api('/api/ask', { contextId: tab.session.context.id, interaction: 'activate', selection })).status, 409);

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true });
  cleanup(() => browser.close());
  const launch = await control(service.descriptor, 'bootstrap', { root, clientId: randomUUID() });
  const page = await browser.newPage();
  await page.goto(launch.url);
  await page.getByRole('link', { name: 'Ask SFlow', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Ask a question' });
  await field.fill(query);
  const submitted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ask' && response.request().postDataJSON().interaction === 'submit');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const response = await submitted;
  const browserValue = await response.json();
  assert.equal(browserValue.history?.scope?.revision, pinned, JSON.stringify(browserValue));
  await page.waitForFunction(() => document.querySelector('#ask-status')?.textContent !== 'Reading…');
  assert.equal(await page.locator('#ask-status').textContent(), 'Answer ready.');
  await page.getByRole('heading', { name: 'Git commits by committer date' }).waitFor({ timeout: 5000 });
  await page.getByText('20 commits retrieved so far · Partial coverage').waitFor();
  mustGit('commit', '--allow-empty', '-qm', 'New after pinned history');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.getByText('21 commits · Complete coverage', { exact: true }).waitFor();
  assert.equal(await page.getByText('New after pinned history').count(), 0);
  assert.equal(await page.getByText(new RegExp(initial)).count(), 1);

  await field.fill('compare ' + initial + ' with ' + pinned);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('heading', { name: 'Revision comparison' }).waitFor();
  await page.getByText('No matching paths · Complete coverage').waitFor();
  assert.equal(mustGit('status', '--porcelain'), '');
});

test('Ask SFlow resumes private context in a new browser tab and opens the saved evidence', { timeout: 45_000 }, async t => {
  const { root, directory, env, mustGit, cleanup } = await fixture(t);
  env.SINGULARITY_FLOW_NO_MODEL = '1';
  const initial = mustGit('rev-parse', 'HEAD');
  mustGit('commit', '--allow-empty', '-qm', 'First visible result');
  const service = await startService({ directory });
  cleanup(() => service.close());
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true });
  cleanup(() => browser.close());
  async function launchAsk() {
    const launch = await control(service.descriptor, 'bootstrap', { root, clientId: randomUUID(), environment: env });
    const page = await browser.newPage();
    await page.goto(launch.url);
    await page.getByRole('link', { name: 'Ask SFlow', exact: true }).click();
    return page;
  }
  const first = await launchAsk();
  const field = first.getByRole('textbox', { name: 'Ask a question' });
  await field.fill('commits from 2000-01-01 to 2099-12-31 on HEAD');
  await first.getByRole('button', { name: 'Search', exact: true }).click();
  await first.getByText('2 commits · Complete coverage').waitFor();
  mustGit('commit', '--allow-empty', '-qm', 'Newer than the saved page');
  await first.close();

  const next = await launchAsk();
  await next.getByText('Saved searches', { exact: true }).click();
  await next.getByRole('button', { name: 'Resume saved conversation' }).click();
  await next.getByText('2 commits · Complete coverage').waitFor();
  assert.equal(await next.getByText('Newer than the saved page').count(), 0);
  const followUp = next.getByRole('textbox', { name: 'Ask a question' });
  await followUp.fill('the second result');
  await next.getByRole('button', { name: 'Search', exact: true }).click();
  const evidence = next.getByRole('region', { name: 'Evidence and explanation' });
  await evidence.getByText(new RegExp(initial)).waitFor();
  await next.getByRole('button', { name: 'Explain with Copilot' }).click();
  await evidence.getByRole('heading', { name: 'Explanation from recorded evidence' }).waitFor();
  await assert.rejects(access(path.join(root, '.git/singularity-flow/model-invocations')));
});

test('browser search finds pinned files and Copilot chat keeps scoped follow-ups within its ACP token limit', { timeout: 65_000 }, async t => {
  const { base, root, directory, env, mustGit, cleanup } = await fixture(t);
  const [{ initializeDefinition }, { revisionFiles }, { revisionDirectory }, { chromium }, { default: YAML }] = await Promise.all([
    import('../src/config.mjs'), import('../src/spec-library/library.mjs'), import('../src/spec-library/ids.mjs'), import('playwright-core'), import('yaml')
  ]);
  await initializeDefinition(root);
  const standin = path.join(base, 'chat-standin.mjs');
  const calls = path.join(base, 'chat-calls.jsonl');
  const secret = inventedValue('gh', 'p_', 'M2sV'.repeat(10));
  await writeFile(standin, [
    'import { appendFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    'const args = process.argv.slice(2);',
    'const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");',
    'for await (const line of createInterface({ input: process.stdin })) {',
    '  const { id, method, params } = JSON.parse(line);',
    '  if (method === "initialize") send({ id, result: { protocolVersion: params.protocolVersion, agentCapabilities: {} } });',
    '  if (method === "session/new") send({ id, result: { sessionId: "ask-chat" } });',
    '  if (method !== "session/prompt") continue;',
    '  const prompt = params.prompt.map(item => item.text).join("");',
    '  const input = JSON.parse(prompt.split("\\n").at(-1));',
    '  appendFileSync(' + JSON.stringify(calls) + ', JSON.stringify({ ...input, toolsDisabled: !args.includes("--allow-all-tools"), argvContainsQuestion: args.includes(input.question) }) + "\\n");',
    '  const spec = input.records.find(item => item.type === "spec");',
    '  const answer = spec ? "Read the Harbor invoice spec [" + spec.citation + "]. [S999]"',
    '    : input.previous.length ? "This follows the earlier question about tidal power." : "Tidal power uses moving water. <img src=x onerror=alert(1)>";',
    '  send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk",',
    '    messageId: "answer", content: { type: "text", text: answer } } } });',
    '  const inputTokens = input.question === "Explain deep ocean currents." ? 39_900 : 13_065;',
    '  send({ id, result: { stopReason: "end_turn", usage: { inputTokens, outputTokens: 167, totalTokens: inputTokens + 167 } } });',
    '}'
  ].join('\n'));
  const workflow = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflow, 'utf8'));
  definition.models = { defaultProvider: 'chat-test', providers: { 'chat-test': {
    type: 'copilot-cli', executable: process.execPath, arguments: [standin], promptTransport: 'acp-stdio'
  } } };
  await writeFile(workflow, YAML.stringify(definition));
  const code = path.join(root, 'harbor-invoice.mjs');
  await writeFile(code, 'export const harborInvoice = true;\n// Harbor invoice marker\n// api_key = "' + secret + '"\n');
  const storyDir = path.join(root, 'singularity/work-items/HARBOR-17');
  await mkdir(storyDir, { recursive: true });
  await writeFile(path.join(storyDir, 'workflow.json'), JSON.stringify({ schemaVersion: 1, status: 'in-progress',
    workItem: { id: 'HARBOR-17', title: 'Harbor invoice retries', branch: 'main', description: 'LOCAL_DRAFT_CANARY' },
    currentPhase: 'intake', phaseOrder: ['intake'], phases: { intake: { id: 'intake', status: 'in-progress', generation: 0 } }
  }));
  mustGit('add', '-A'); mustGit('commit', '-qm', 'Search fixtures');
  const original = mustGit('rev-parse', 'HEAD');
  const spec = 'SPEC-HARBOR-INVOICE';
  const built = revisionFiles({ specId: spec, revision: 1, reviewState: 'reviewed', operationId: 'browser-search-fixture',
    actor: { name: 'Fixture Reviewer', email: 'reviewer@example.test' }, recordedAt: '2026-11-06T00:00:00Z',
    head: { sequence: 1, snapshotSha256: 'sha256:' + 'a'.repeat(64), draft: { title: 'Harbor invoice reconciliation',
      kind: 'business', spec: '# Harbor invoice reconciliation\n\nKeep the receipt for each invoice.\n', gaps: [], research: [] } },
    report: { counts: { d: 0, a: 0, h: 0 }, blocking: [] } });
  mustGit('switch', '-qc', 'state', original);
  const published = path.join(root, revisionDirectory(spec, 1));
  await mkdir(published, { recursive: true });
  for (const [name, bytes] of Object.entries(built.files)) await writeFile(path.join(published, name), bytes);
  mustGit('add', '-A'); mustGit('commit', '-qm', 'Published invoice specification');
  mustGit('switch', '-q', 'main');

  const service = await startService({ directory });
  cleanup(() => service.close());
  const browser = await chromium.launch({ headless: true });
  cleanup(() => browser.close());
  const launch = await control(service.descriptor, 'bootstrap', { root, clientId: randomUUID(), environment: env });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(launch.url);
  await page.getByRole('button', { name: 'Search or ask SFlow' }).waitFor();
  await page.keyboard.press('Control+k');
  const search = page.getByRole('textbox', { name: 'Ask a question' });
  await search.waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'ask-question');
  await page.getByRole('button', { name: 'Publishing help' }).click();
  await page.getByRole('region', { name: 'Search answer', exact: true }).getByRole('heading', { name: /story lifecycle/i }).waitFor();
  await search.fill('Harbor invoice');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const results = page.getByRole('region', { name: 'Workspace search results' });
  await results.getByRole('button', { name: 'Harbor invoice retries' }).waitFor();
  await results.getByRole('button', { name: 'Harbor invoice reconciliation' }).waitFor();
  await results.getByRole('button', { name: /Files/ }).click();
  assert.equal(await results.getByRole('button', { name: 'Harbor invoice retries' }).count(), 0);
  const file = results.getByRole('button', { name: 'harbor-invoice.mjs' });
  await file.waitFor();
  await assert.rejects(access(calls));

  await writeFile(code, 'export const harborInvoice = false; // newer changes\n');
  mustGit('add', 'harbor-invoice.mjs'); mustGit('commit', '-qm', 'Change file after search');
  await file.click();
  const evidence = page.getByRole('region', { name: 'Evidence and explanation' });
  await evidence.getByText('Commit', { exact: false }).first().waitFor();
  const preview = await evidence.textContent();
  assert.match(preview, /export const harborInvoice = true/u);
  assert.ok(!preview.includes(secret) && !preview.includes('newer changes'));
  await search.fill('RECEIPT FOR EACH INVOICE');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await results.getByRole('button', { name: 'Harbor invoice reconciliation' }).waitFor();
  await results.getByText(/Keep the receipt for each invoice/).waitFor();

  const question = page.getByRole('textbox', { name: 'Ask a question' });
  await question.fill('How do I publish?');
  await question.press('Enter');
  await page.getByRole('log', { name: 'Chat conversation' }).getByRole('button', { name: /Artifacts, templates, and publication/ }).waitFor();
  await question.fill('zqxwuvunmatched');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('heading', { name: 'No matching results' }).waitFor();
  await page.getByRole('button', { name: 'Ask Copilot', exact: true }).click();
  assert.equal(await question.inputValue(), 'zqxwuvunmatched');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await question.count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await assert.rejects(access(calls));
  await page.setViewportSize({ width: 1280, height: 900 });
  await question.fill('How does tidal power work?');
  await page.getByRole('button', { name: 'Send' }).click();
  const chat = page.getByRole('log', { name: 'Chat conversation' });
  await chat.getByText('Tidal power uses moving water.', { exact: false }).waitFor();
  assert.equal(await chat.locator('img').count(), 0);
  await question.fill('Can you give me another example?');
  await question.press('Enter');
  await chat.getByText('This follows the earlier question about tidal power.').waitFor();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Search or ask SFlow' }).click();
  await chat.getByText('This follows the earlier question about tidal power.').waitFor();
  await page.getByRole('checkbox', { name: 'Include workspace context' }).check();
  await question.fill('Tell me about Harbor invoice ' + secret);
  await question.press('Enter');
  await chat.getByRole('button', { name: /Harbor invoice reconciliation/ }).waitFor();
  assert.doesNotMatch(await chat.textContent(), /S999/u);
  const requests = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].records, []);
  assert.match(requests[1].previous[0].question, /tidal power/u);
  assert.ok(requests[2].records.some(record => record.reference === spec + '@1'));
  assert.ok(!JSON.stringify(requests).includes(secret) && !JSON.stringify(requests).includes('LOCAL_DRAFT_CANARY'));
  assert.ok(requests.every(request => request.toolsDisabled && !request.argvContainsQuestion));

  await question.fill('Explain deep ocean currents.');
  await question.press('Enter');
  const budget = page.locator('#ask-status');
  await budget.getByText(/Copilot reported 40,067 tokens, above Ask SFlow’s 24,576-token limit/).waitFor();
  assert.equal(await budget.getByText(/sign-in/i).count(), 0);
  assert.equal(await question.inputValue(), 'Explain deep ocean currents.');

  await page.getByRole('button', { name: 'New chat' }).click();
  await chat.getByText('This follows the earlier question about tidal power.').waitFor({ state: 'detached' });
  const noModel = await connect(service, root, { environment: { ...env, SINGULARITY_FLOW_NO_MODEL: '1' } });
  const disabled = await noModel.api('/api/ask', { contextId: noModel.session.context.id, interaction: 'chat', query: 'An unrelated question', workspace: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.value.diagnostic.code, 'MODEL_UNAVAILABLE');
  assert.equal(mustGit('status', '--porcelain'), '');
});
