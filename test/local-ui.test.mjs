import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, chmod, utimes, stat, access } from 'node:fs/promises';
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

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-ui-'));
  const env = isolatedTestEnvironment(path.join(base, 'machine'));
  const previous = { ...process.env };
  const cleanups = [];
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  Object.assign(process.env, env);
  t.after(async () => { try { for (const cleanup of cleanups) await cleanup(); } finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, previous); await rm(base, { recursive: true, force: true }); } });
  const root = path.join(base, 'project'); await mkdir(root);
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
  await page.getByRole('heading', { name: /Good work starts/ }).waitFor();
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
  await second.goto(secondLaunch.url); await second.getByRole('heading', { name: /Good work starts/ }).waitFor();
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
