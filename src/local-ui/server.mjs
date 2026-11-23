/** SFlow-owned loopback host. No cwd changes, console interception, Git or workflow policy here. */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL, MAX_BODY, MAX_CONTENT, MAX_NATIVE_BODY, MAX_REPLY, MAX_PENDING, MAX_RUNNING, TICKET_MS, SESSION_MS, UiError, insist, record, text, identifier, idleMinutes, nativeEnvironment, environmentScope, errorData } from './contracts.mjs';
import { buildIdentity, privateDirectory, readPrivate, writePrivate, removeOwnDescriptor, serviceDirectory } from './private-state.mjs';
import { operationShape, executeOperation, disposeReadWorkers } from './operations.mjs';
import { leaseOwnerAssessment, leaseOwnerIdentity } from '../lease-liveness.mjs';
import { nativeEqual, requestProof, responseProof, openInput } from './native-auth.mjs';

const randomKey = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/views.js', ['views.js', 'text/javascript; charset=utf-8']],
  ['/code-explainer.js', ['code-explainer.js', 'text/javascript; charset=utf-8']],
  ['/code-explainer.css', ['code-explainer.css', 'text/css; charset=utf-8']]
]);
const terminal = new Set(['succeeded', 'failed', 'unknown', 'expired']);
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_RECORDS = 8192;
const MAX_RECORD_BYTES = MAX_REPLY * 2 + 64 * 1024;
/**
 * The page a native launcher opens instead of the link: a one-use link in a process's arguments is readable by
 * another local user for as long as that process runs. Only this user reads the private folder it is written to.
 */
const launcherPage = link => {
  const attribute = link.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">`
    + `<meta http-equiv="refresh" content="0;url=${attribute}"><title>Opening SFlow</title></head>`
    + `<body><p>Opening SFlow… <a href="${attribute}">Continue</a></p><script>location.replace(${JSON.stringify(link)});</script></body></html>\n`;
};
const removeLauncher = grant => grant?.launcher ? unlink(grant.launcher).catch(() => {}) : Promise.resolve();

async function contentBytes(req, limit) {
  insist(req.headers['content-length'] == null || Number(req.headers['content-length']) <= limit, 'UI_REQUEST_TOO_LARGE', 'The request exceeds its content limit.', 413);
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    insist(bytes <= limit, 'UI_REQUEST_TOO_LARGE', 'The request exceeds its content limit.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(req, limit = MAX_BODY) {
  insist((req.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'UI_CONTENT_TYPE_REQUIRED', 'Use application/json.', 415);
  const bytes = await contentBytes(req, limit);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new UiError('UI_JSON_INVALID', 'The request is not valid JSON.'); }
}
async function contentOperation(req) {
  insist(req.headers['content-type'] === 'application/octet-stream', 'UI_CONTENT_TYPE_REQUIRED', 'Use a binary content upload.', 415);
  let input;
  try { input = JSON.parse(decodeURIComponent(text(req.headers['x-sflow-content'], 'Content descriptor', 8192))); }
  catch { throw new UiError('UI_CONTENT_DESCRIPTOR_INVALID', 'The content descriptor is invalid.'); }
  record(input, ['contextId', 'invocationId', 'operation', 'input']);
  insist(['spec.save', 'spec.fork', 'spec.source.add'].includes(input.operation), 'UI_OPERATION_UNSUPPORTED', 'This operation does not accept file content.');
  record(input.input, input.operation === 'spec.source.add' ? ['specId', 'name', 'restore'] : ['specId', 'sequence', 'title', 'kind']);
  const bytes = await contentBytes(req, input.operation === 'spec.source.add' ? MAX_CONTENT : 1024 * 1024);
  if (input.operation === 'spec.source.add') input.input.data = bytes.toString('base64');
  else {
    try { input.input.content = new TextDecoder('utf8', { fatal: true }).decode(bytes); }
    catch { throw new UiError('UI_CONTENT_INVALID', 'Specification wording must be valid UTF-8 text.'); }
  }
  return input;
}

export async function startService(options = {}) {
  insist(process.platform !== 'win32', 'UI_PLATFORM_UNQUALIFIED', 'Native Windows credential ACL and process-lifetime qualification are required before starting this service.');
  const directory = options.directory ?? serviceDirectory();
  await privateDirectory(directory);
  const { acquireFileLeaseWithin, heldFileLeaseRoute } = await import('../file-lease.mjs');
  const file = path.join(directory, 'instance.lease');
  const lease = await acquireFileLeaseWithin(file, 1000, { staleMs: 30_000 });
  if (!lease) {
    const held = await heldFileLeaseRoute(file);
    throw new UiError('UI_INSTANCE_OWNED', `Another process owns the local workspace service.${held.message}`, held.details, 409);
  }
  try { return await listenService({ ...options, directory, instanceLease: lease }); }
  catch (error) { await lease.release(); throw error; }
}

async function listenService({ directory, idle = 10, execute = executeOperation, build = null, instanceLease } = {}) {
  const minutes = idleMinutes(idle);
  const requestsDir = path.join(directory, 'requests');
  await privateDirectory(requestsDir);
  const identity = build ?? await buildIdentity();
  const instance = randomUUID(), credential = randomKey(), descriptorFile = path.join(directory, 'instance.json');
  const existing = await readPrivate(descriptorFile);
  if (existing?.pid) {
    const state = existing.owner ? leaseOwnerAssessment(existing.owner).state : 'unknown';
    insist(state === 'dead', 'UI_INSTANCE_OWNED', 'A live or unverified process already owns this descriptor. Use the native launcher to verify or drain it.', 409);
  }
  const cookieName = `sflow_${instance.replaceAll('-', '')}`;
  const tickets = new Map(), sessions = new Map(), browsers = new Map(), contexts = new Map(), jobs = new Map(), queue = [], runningRoots = new Set();
  const admissions = new Map();
  const bridges = new Map(), handoffs = new Map(), resources = new Map(), nativeNonces = new Map();
  let running = 0, draining = false, lastActivity = Date.now(), origin, server, closed = false;
  let closeResolve;
  const done = new Promise(resolve => { closeResolve = resolve; });

  // Only this instance (it holds the instance lease) uses these: a crash left them behind, with wording,
  // uploaded bytes or a one-use link in them. Remove them before accepting anything.
  for (const name of await readdir(directory)) {
    if (/^(?:save|upload)-[A-Za-z0-9]{6}$/u.test(name) || /^launch-[a-f0-9]{32}\.html$/u.test(name)) {
      await rm(path.join(directory, name), { recursive: true, force: true });
    }
  }
  // A transport crash does not decide whether a canonical mutation happened. Preserve its ID.
  const names = (await readdir(requestsDir)).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name));
  const kept = [];
  for (const name of names) {
    const receipt = await readPrivate(path.join(requestsDir, name), { maxBytes: MAX_RECORD_BYTES });
    if (!receipt) continue;
    // Reads are never journaled; an older build's read receipt has nothing to recover. Every outcome, an unknown
    // one included, ages out RETENTION_MS after it was settled; the canonical store keeps what happened.
    const settledAt = Date.parse(receipt.completedAt ?? receipt.acceptedAt);
    if (!receipt.mutation || (terminal.has(receipt.state) && !(settledAt >= Date.now() - RETENTION_MS))) {
      await unlink(path.join(requestsDir, name)); continue;
    }
    kept.push([name, receipt]);
  }
  // Counted after cleanup: aged-out records never keep a service from starting.
  insist(kept.length <= MAX_RECORDS, 'UI_JOURNAL_CAPACITY', 'The browser request journal needs inspection. Canonical SFlow operations and all work were preserved.');
  for (const [name, receipt] of kept) {
    if (!terminal.has(receipt.state)) {
      receipt.state = 'unknown'; receipt.completedAt = new Date().toISOString();
      receipt.error = { code: 'UI_OUTCOME_UNKNOWN', message: 'The service restarted before observing completion. Inspect the original operation; do not repeat a write automatically.' };
      await writePrivate(path.join(requestsDir, name), receipt);
    }
    jobs.set(receipt.invocationId, receipt);
  }
  /**
   * What a receipt keeps on disk: a write's identity, input binding and outcome, its result reduced to the
   * identifiers a lost reply is checked by. Answers themselves (specification wording, Story listings) stay
   * in this process's memory; a read is never written down.
   */
  const durable = receipt => {
    const { result, ...rest } = receipt;
    const value = result?.value && typeof result.value === 'object' ? result.value : {};
    const identifiers = Object.fromEntries(['resultType', 'action', 'specId', 'sequence', 'operationId']
      .filter(key => ['string', 'number'].includes(typeof value[key])).map(key => [key, value[key]]));
    return { ...rest, ...(result ? { result: { value: identifiers, transport: result.transport } } : {}) };
  };
  const persist = receipt => {
    if (!receipt.mutation) return Promise.resolve();
    const record = durable(receipt);
    insist(Buffer.byteLength(JSON.stringify(record)) <= MAX_RECORD_BYTES, 'UI_RECEIPT_TOO_LARGE', 'The transport receipt exceeds its retention limit. Inspect the canonical operation.');
    return writePrivate(path.join(requestsDir, `${receipt.invocationId}.json`), record);
  };
  async function prune() {
    const completed = [...jobs.values()].filter(job => ['succeeded', 'failed'].includes(job.state))
      .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
    const reads = completed.filter(job => !job.mutation);
    for (const job of reads.slice(64)) jobs.delete(job.invocationId);
    // Compact old write results, retaining identity/input binding so they can never be re-enqueued.
    for (const job of completed.filter(job => job.mutation).slice(128)) {
      delete job.result; job.state = 'expired';
      job.error = { code: 'UI_RECEIPT_EXPIRED', message: 'The original transport result was compacted. Inspect the canonical draft/history; this write was not repeated.' };
      await persist(job);
    }
  }
  const touch = () => { lastActivity = Date.now(); };
  const event = (session, type, value) => {
    session.sequence += 1;
    session.events.push({ sequence: session.sequence, type, ...value });
    if (session.events.length > 128) session.events.shift();
  };
  const view = receipt => {
    const { inputHash, clientId, root, session, environmentHash, ...value } = receipt;
    return { ...value, contextKey: digest(root), contextLabel: path.basename(root) };
  };
  const activityView = receipt => {
    const { result, error, ...summary } = view(receipt);
    return { ...summary, ...(result?.value?.specId ? { result: { value: { specId: result.value.specId } } } : {}),
      ...(error ? { error: { code: error.code, message: error.message } } : {}) };
  };
  const status = () => ({ protocol: PROTOCOL, instance, build: identity, pid: process.pid, origin, draining, lastActivityAt: new Date(lastActivity).toISOString(),
    running, queued: queue.length, admitting: admissions.size, sessions: sessions.size, idleMinutes: minutes,
    recent: [...jobs.values()].filter(job => job.mutation).sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt)).slice(0, 64)
      .map(job => ({ invocationId: job.invocationId, operation: job.operation, state: job.state,
        acceptedAt: job.acceptedAt, contextLabel: path.basename(job.root) })),
    recovery: [...jobs.values()].filter(job => job.state === 'unknown').map(job => ({ invocationId: job.invocationId, operation: job.operation, state: job.state, acceptedAt: job.acceptedAt })) });
  const bridgeFor = session => [...bridges.values()].find(bridge => bridge.clientId === session.clientId
    && bridge.root === contexts.get(session.contextId)?.root && bridge.expiresAt > Date.now());
  const capabilitiesFor = session => ({ copilot: bridgeFor(session)?.copilot === true, signing: false,
    nativeMenus: Boolean(bridgeFor(session)), fileReveal: false });
  async function finishShutdown() {
    if (closed || running || queue.length || admissions.size) return;
    closed = true; clearInterval(maintenance);
    await Promise.all([...tickets.values()].map(removeLauncher)); tickets.clear();
    disposeReadWorkers();
    server.closeIdleConnections();
    server.close(async () => {
      await removeOwnDescriptor(descriptorFile, instance).catch(() => {});
      await instanceLease.release().catch(() => {});
      closeResolve();
    });
  }
  function pump() {
    while (running < MAX_RUNNING) {
      const at = queue.findIndex(item => !runningRoots.has(item.root));
      if (at === -1) break;
      const job = queue.splice(at, 1)[0];
      running += 1; runningRoots.add(job.root);
      void (async () => {
        job.receipt.state = 'running'; job.receipt.startedAt = new Date().toISOString();
        try {
          await persist(job.receipt);
          const result = await execute({ ...job, directory, onProgress: progress => event(job.session, 'progress', { invocationId: job.receipt.invocationId, ...progress }) });
          if (job.operation === 'story.list') {
            job.session.choices.clear();
            result.choices = (result.value?.stories ?? []).filter(story => story.availability === 'ready').map(story => {
              const choiceId = randomUUID();
              job.session.choices.set(choiceId, { root: story.checkoutPath, label: story.workId });
              return { choiceId, checkoutPath: story.checkoutPath, workId: story.workId };
            });
          }
          if (job.operation === 'spec.source.read') {
            result.resources = (result.value?.sources ?? []).filter(source => source.status === 'image-ready'
              && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(source.mediaType)).map(source => {
              const id = randomUUID();
              resources.set(id, { path: source.path, sha256: source.sha256, mediaType: source.mediaType, clientId: job.session.clientId,
                root: job.root, expiresAt: Date.now() + SESSION_MS });
              return { id, mediaType: source.mediaType, sha256: source.sha256 };
            });
          }
          Object.assign(job.receipt, { state: 'succeeded', result });
        } catch (error) {
          // A deadline, a cut reply, or a child that stopped without SFlow's own answer leaves a write's effect unknown.
          const unknown = job.receipt.mutation && (error.outcomeUnknown === true
            || ['UI_OPERATION_TIMEOUT', 'UI_WAIT_CANCELLED', 'UI_REPLY_TOO_LARGE', 'UI_RESULT_INVALID'].includes(error.code));
          Object.assign(job.receipt, { state: unknown ? 'unknown' : 'failed', error: errorData(error) });
        }
        job.receipt.completedAt = new Date().toISOString();
        try { await persist(job.receipt); }
        catch (error) {
          // Never turn an unretained write acknowledgement into success.
          Object.assign(job.receipt, { state: 'unknown', error: { code: 'UI_RECEIPT_WRITE_FAILED', message: error.message } });
        }
        event(job.session, 'result', { invocationId: job.receipt.invocationId, state: job.receipt.state });
        await prune().catch(() => {}); // Cleanup cannot change an observed canonical outcome.
      })().finally(() => {
        running -= 1; runningRoots.delete(job.root); touch(); pump();
        if (draining) void finishShutdown();
      });
    }
  }
  async function contextFor(root) {
    const resolved = await realpath(text(root, 'Checkout', 8192));
    insist((await stat(resolved)).isDirectory(), 'UI_CONTEXT_UNAVAILABLE', 'The selected checkout is not a directory.');
    return { id: randomUUID(), key: digest(resolved), root: resolved, label: path.basename(resolved) };
  }
  function browserCookie(req) {
    return String(req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  }
  function sessionFor(req, { activity = true } = {}) {
    const token = browserCookie(req), session = sessions.get(req.headers['x-sflow-tab']);
    insist(token && session && equal(session.browser, digest(token)) && Date.now() < session.expiresAt,
      'UI_SESSION_EXPIRED', 'Reopen SFlow from the CLI or VS Code to reconnect.', 401);
    session.expiresAt = Date.now() + SESSION_MS;
    if (activity) touch();
    return session;
  }
  function selected(session, id) {
    const context = contexts.get(id);
    insist(context && session.contexts.has(id), 'UI_CONTEXT_DENIED', 'This tab is not attached to that context.', 403);
    return context;
  }
  function send(res, code, value) {
    const body = JSON.stringify(value);
    if (res.sflowNativeNonce) res.setHeader('X-SFlow-Native-Proof', responseProof(credential, { instance, nonce: res.sflowNativeNonce, status: code, body }));
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body);
  }
  server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const requestId = randomUUID(); res.setHeader('X-SFlow-Request-Id', requestId);
    try {
      insist(req.headers.host === new URL(origin).host, 'UI_HOST_DENIED', 'Unexpected local workspace host.', 403);
      insist(!req.headers.origin || req.headers.origin === origin, 'UI_ORIGIN_DENIED', 'Cross-origin local workspace requests are refused.', 403);
      const url = new URL(req.url, origin);
      insist(url.origin === origin, 'UI_ORIGIN_DENIED', 'Unexpected request origin.', 403);
      const route = url.pathname;
      if (route === '/health' && req.method === 'GET') return send(res, 200, { protocol: PROTOCOL, status: draining ? 'draining' : 'ready', instance });
      if (route.startsWith('/control/')) {
        const nonce = req.headers['x-sflow-native-nonce'], time = req.headers['x-sflow-native-time'];
        insist(req.headers['x-sflow-native-instance'] === instance && typeof nonce === 'string' && /^[a-f0-9]{32}$/u.test(nonce)
          && typeof time === 'string' && /^[0-9]{13}$/u.test(time) && Math.abs(Date.now() - Number(time)) <= 30_000
          && !nativeNonces.has(nonce), 'UI_NATIVE_AUTH_REQUIRED', 'Native client authentication is required.', 401);
        const wireInput = req.method === 'POST' ? await body(req, MAX_NATIVE_BODY) : null;
        const wireBody = req.method === 'POST' ? JSON.stringify(wireInput) : '';
        insist(nativeEqual(req.headers['x-sflow-native-proof'], requestProof(credential, { instance, nonce, time, method: req.method, route, body: wireBody })),
          'UI_NATIVE_AUTH_REQUIRED', 'Native client authentication is required.', 401);
        insist(!nativeNonces.has(nonce), 'UI_NATIVE_REPLAY', 'This native request was already used.', 409);
        insist(nativeNonces.size < 4096, 'UI_NATIVE_RATE_LIMIT', 'The native request limit was reached. Retry after older requests expire.', 429);
        nativeNonces.set(nonce, Date.now()); res.sflowNativeNonce = nonce;
        if (route !== '/control/bridge/poll') touch();
        if (route === '/control/status' && req.method === 'GET') return send(res, 200, status());
        insist(req.method === 'POST', 'UI_METHOD_DENIED', 'Unsupported method.', 405);
        const input = openInput(credential, wireInput, JSON.stringify([instance, nonce, time, req.method, route]));
        if (route === '/control/bootstrap') {
          record(input, ['root', 'clientId', 'resume', 'environment', 'launcher']);
          insist(!draining, 'UI_SERVICE_DRAINING', 'The local workspace is finishing existing work.', 409);
          insist(tickets.size < 128 && sessions.size < 64, 'UI_CLIENT_LIMIT', 'Too many browser clients. Close unused tabs and retry.', 429);
          const previous = input.resume ? jobs.get(identifier(input.resume, 'Invocation ID')) : null;
          if (input.resume) insist(previous, 'UI_REQUEST_NOT_FOUND', 'The original operation is not retained.', 404);
          const environment = nativeEnvironment(input.environment), environmentHash = digest(environmentScope(environment));
          insist(!previous?.environmentHash || previous.environmentHash === environmentHash, 'UI_CLIENT_SCOPE_CHANGED',
            'The native environment changed. Open a new browser client and inspect the original canonical draft/history using your current credentials; the old write will not be repeated.', 409);
          const context = await contextFor(previous?.root ?? input.root);
          contexts.set(context.id, context);
          const ticket = randomKey(), link = `${origin}/#ticket=${ticket}`;
          const clientId = previous?.clientId ?? text(input.clientId, 'Client ID', 128);
          // Asked for by a launcher that opens a browser: the link goes into a private page, never a process's arguments.
          let launcher = null;
          if (input.launcher === true) {
            launcher = path.join(directory, `launch-${randomBytes(16).toString('hex')}.html`);
            await writeFile(launcher, launcherPage(link), { flag: 'wx', mode: 0o600 });
          }
          tickets.set(digest(ticket), { context, environment, environmentHash, clientId, launcher, expiresAt: Date.now() + TICKET_MS });
          return send(res, 200, { url: link, instance, build: identity, clientId, ...(launcher ? { launcher } : {}) });
        }
        if (route === '/control/bridge/register') {
          record(input, ['clientId', 'root', 'copilot', 'build']);
          insist(input.build === identity.fingerprint, 'UI_BUILD_MISMATCH', 'The editor and local workspace builds differ.', 409);
          const root = (await contextFor(input.root)).root;
          insist(bridges.size < 32, 'UI_CLIENT_LIMIT', 'Too many editor bridges.', 429);
          const id = randomUUID();
          bridges.set(id, { id, root, clientId: text(input.clientId, 'Client ID', 128), copilot: input.copilot === true, expiresAt: Date.now() + 30_000 });
          return send(res, 200, { bridgeId: id, leaseMs: 30_000 });
        }
        if (['/control/bridge/poll', '/control/bridge/result', '/control/bridge/close'].includes(route)) {
          record(input, route.endsWith('/result') ? ['bridgeId', 'handoffId', 'outcome', 'message'] : ['bridgeId']);
          const bridge = bridges.get(text(input.bridgeId, 'Bridge ID', 128));
          insist(bridge && bridge.expiresAt > Date.now(), 'UI_BRIDGE_EXPIRED', 'The editor bridge disconnected.', 410);
          if (route.endsWith('/close')) { bridges.delete(bridge.id); return send(res, 200, { status: 'closed' }); }
          bridge.expiresAt = Date.now() + 30_000;
          if (route.endsWith('/result')) {
            const handoff = handoffs.get(text(input.handoffId, 'Handoff ID', 128));
            insist(handoff?.bridgeId === bridge.id && handoff.state === 'dispatched', 'UI_HANDOFF_INVALID', 'This handoff is not awaiting that editor.', 409);
            insist(['delivered', 'refused'].includes(input.outcome), 'UI_REQUEST_INVALID', 'Unknown handoff outcome.');
            handoff.state = input.outcome; handoff.message = text(input.message, 'Handoff result', 2048);
            event(handoff.session, 'handoff', { handoffId: handoff.id, state: handoff.state });
            return send(res, 200, { status: 'recorded' });
          }
          const pending = [...handoffs.values()].filter(item => item.bridgeId === bridge.id && item.state === 'queued');
          for (const item of pending) item.state = 'dispatched'; // A lost poll reply never repeats a chat handoff.
          return send(res, 200, { requests: pending.map(({ session, ...item }) => item) });
        }
        if (route === '/control/stop') {
          record(input, ['drain']);
          if ((running || queue.length || admissions.size) && input.drain !== true) throw new UiError('UI_SERVICE_BUSY', 'The local workspace is busy. Wait or request a drain; active operations were preserved.', { running, queued: queue.length, admitting: admissions.size }, 409);
          draining = true; send(res, 200, { ...status(), status: running || queue.length || admissions.size ? 'draining' : 'stopping' });
          void finishShutdown(); return;
        }
        throw new UiError('UI_ROUTE_UNSUPPORTED', 'Unknown native operation.', null, 404);
      }
      if (route === '/api/session' && req.method === 'POST') {
        insist(req.headers.origin === origin, 'UI_ORIGIN_REQUIRED', 'A same-origin browser request is required.', 403);
        const input = record(await body(req), ['ticket']); text(input.ticket, 'Ticket', 128);
        const key = digest(input.ticket), grant = tickets.get(key); tickets.delete(key); await removeLauncher(grant);
        insist(grant && Date.now() < grant.expiresAt, 'UI_TICKET_EXPIRED', 'This link expired or was already used. Open a new link from SFlow.', 401);
        insist(sessions.size < 64, 'UI_CLIENT_LIMIT', 'Too many browser clients. Disconnect an unused tab from About, or wait for its lease to expire.', 429);
        // Cookies are shared by tabs. A separate tab handle binds each context to the same
        // authenticated browser without replacing another tab's session on the next launch.
        let token = browserCookie(req);
        if (!token || !browsers.has(digest(token))) token = randomKey();
        const browser = digest(token), tabId = randomUUID(); browsers.set(browser, Date.now());
        const session = { clientId: grant.clientId, csrf: randomKey(), contexts: new Set([grant.context.id]), contextId: grant.context.id,
          environment: grant.environment, environmentHash: grant.environmentHash,
          browser, expiresAt: Date.now() + SESSION_MS, sequence: 0, events: [], choices: new Map() };
        sessions.set(tabId, session);
        res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=43200`);
        touch(); return send(res, 200, { tabId, csrf: session.csrf, context: grant.context, build: identity, capabilities: capabilitiesFor(session) });
      }
      if (route.startsWith('/api/')) {
        // A visible tab's status poll is not work: an open tab alone never keeps the service from its idle stop.
        // A tab holding unsaved writing says so (`working=1`), and that person is still working.
        const poll = route === '/api/events' && req.method === 'GET' && url.searchParams.get('working') !== '1';
        const session = sessionFor(req, { activity: !poll });
        if (route.startsWith('/api/content/') && req.method === 'GET') {
          const resource = resources.get(route.slice('/api/content/'.length));
          insist(resource && resource.clientId === session.clientId && resource.root === selected(session, session.contextId).root
            && resource.expiresAt > Date.now(), 'UI_CONTENT_UNAVAILABLE', 'Read the original source again from this tab.', 404);
          const info = await stat(resource.path);
          insist(info.isFile() && info.size <= 5 * 1024 * 1024, 'UI_CONTENT_UNAVAILABLE', 'The original image is unavailable or exceeds the preview limit.', 409);
          const bytes = await readFile(resource.path);
          insist(digest(bytes) === resource.sha256, 'UI_CONTENT_CHANGED', 'The original image changed. Read its source again before continuing.', 409);
          res.writeHead(200, { 'Content-Type': resource.mediaType }); res.end(bytes); return;
        }
        if (req.method !== 'GET') insist(req.headers.origin === origin && equal(req.headers['x-sflow-csrf'], session.csrf), 'UI_CSRF_DENIED', 'Refresh this browser session before making a change.', 403);
        if (route === '/api/session/close' && req.method === 'POST') {
          record(await body(req), []);
          sessions.delete(req.headers['x-sflow-tab']);
          for (const id of session.contexts) contexts.delete(id);
          return send(res, 200, { status: 'disconnected', operations: 'preserved' });
        }
        if (route === '/api/session' && req.method === 'GET') return send(res, 200, { csrf: session.csrf, context: selected(session, session.contextId), build: identity,
          capabilities: capabilitiesFor(session) });
        if (route === '/api/handoffs' && req.method === 'POST') {
          const input = record(await body(req), ['contextId', 'type', 'specId', 'menu']);
          const context = selected(session, text(input.contextId, 'Context ID', 128)), bridge = bridgeFor(session);
          insist(context.id === session.contextId && bridge, 'UI_BRIDGE_UNAVAILABLE', 'No matching VS Code window is connected to this tab and checkout.', 409);
          insist(['spec.assist', 'native.menu'].includes(input.type), 'UI_REQUEST_INVALID', 'Unknown editor handoff.');
          if (input.type === 'spec.assist') {
            insist(bridge.copilot, 'UI_COPILOT_UNAVAILABLE', 'Copilot handoff is unavailable in this window.', 409);
            identifier(input.specId, 'Specification ID');
          } else {
            insist(['specs', 'workflows', 'stories', 'intake', 'run', 'decisions', 'configuration', 'code'].includes(input.menu), 'UI_REQUEST_INVALID', 'Unknown native menu.');
            if (input.specId) identifier(input.specId, 'Specification ID');
          }
          insist(handoffs.size < 256, 'UI_HANDOFF_LIMIT', 'Reopen the browser workspace to clear old editor handoffs.', 429);
          const id = randomUUID();
          const handoff = { id, bridgeId: bridge.id, clientId: session.clientId, contextId: context.id, root: context.root,
            type: input.type, ...(input.type === 'spec.assist' ? { specId: input.specId } : { menu: input.menu, ...(input.specId ? { specId: input.specId } : {}) }), state: 'queued', session, createdAt: Date.now() };
          handoffs.set(id, handoff); return send(res, 202, { id, state: 'queued' });
        }
        if (route.startsWith('/api/handoffs/') && req.method === 'GET') {
          const handoff = handoffs.get(route.slice('/api/handoffs/'.length));
          insist(handoff && handoff.clientId === session.clientId && session.contexts.has(handoff.contextId), 'UI_REQUEST_NOT_FOUND', 'This handoff does not belong to this tab.', 404);
          return send(res, 200, { id: handoff.id, state: handoff.state, message: handoff.message ?? null, modelExecution: 'not-observed' });
        }
        if (route === '/api/contexts' && req.method === 'GET') return send(res, 200, { contexts: [...session.contexts].map(id => selected(session, id)), currentId: session.contextId });
        if (route === '/api/contexts' && req.method === 'POST') {
          const input = record(await body(req), ['choiceId', 'contextId']);
          insist(Boolean(input.choiceId) !== Boolean(input.contextId), 'UI_REQUEST_INVALID', 'Select one issued context or Story choice.');
          if (input.contextId) {
            const context = selected(session, text(input.contextId, 'Context ID', 128));
            insist(await realpath(context.root) === context.root, 'UI_CONTEXT_MOVED', 'This checkout moved. Reopen it through the native client.', 409);
            session.contextId = context.id;
            return send(res, 200, { context, capabilities: capabilitiesFor(session) });
          }
          const choice = session.choices.get(text(input.choiceId, 'Context choice', 128));
          insist(choice, 'UI_CONTEXT_DENIED', 'Refresh Stories and select a currently available checkout.', 403);
          const context = await contextFor(choice.root); context.label = choice.label;
          if (session.contexts.size >= 32) {
            const oldest = session.contexts.values().next().value;
            session.contexts.delete(oldest); contexts.delete(oldest);
          }
          contexts.set(context.id, context); session.contexts.add(context.id); session.contextId = context.id;
          return send(res, 200, { context, capabilities: capabilitiesFor(session) });
        }
        if (route === '/api/events' && req.method === 'GET') {
          const after = Number(url.searchParams.get('after') ?? 0);
          insist(Number.isSafeInteger(after) && after >= 0, 'UI_REQUEST_INVALID', 'Invalid event cursor.');
          return send(res, 200, { sequence: session.sequence, resync: after < (session.events[0]?.sequence ?? 1) - 1, events: session.events.filter(item => item.sequence > after) });
        }
        const allowedRoot = root => [...session.contexts].some(id => contexts.get(id)?.root === root);
        if (route === '/api/requests' && req.method === 'GET') return send(res, 200, { requests: [...jobs.values()].filter(job => job.clientId === session.clientId && allowedRoot(job.root)).slice(-64).map(activityView) });
        if (route.startsWith('/api/requests/') && req.method === 'GET') {
          const job = jobs.get(route.slice('/api/requests/'.length));
          insist(job && job.clientId === session.clientId && allowedRoot(job.root), 'UI_REQUEST_NOT_FOUND', 'This request does not belong to this browser context.', 404);
          return send(res, 200, view(job));
        }
        if (['/api/operations', '/api/content'].includes(route) && req.method === 'POST') {
          const input = route === '/api/content' ? await contentOperation(req) : record(await body(req), ['contextId', 'invocationId', 'operation', 'input']);
          const context = selected(session, text(input.contextId, 'Context ID', 128));
          text(input.invocationId, 'Invocation ID', 36);
          insist(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input.invocationId), 'UI_REQUEST_INVALID', 'Use a UUID invocation ID.');
          const shape = operationShape(text(input.operation, 'Operation', 128), input.input);
          const inputHash = digest(JSON.stringify([context.root, session.environmentHash, input.operation, input.input]));
          const previous = jobs.get(input.invocationId);
          if (previous) {
            insist(previous.clientId === session.clientId && previous.inputHash === inputHash, 'UI_INVOCATION_CONFLICT', 'This invocation ID belongs to different input or another client.', 409);
            if (admissions.has(input.invocationId)) await admissions.get(input.invocationId);
            return send(res, 200, view(previous));
          }
          insist(!draining, 'UI_SERVICE_DRAINING', 'The local workspace is finishing existing work. Reopen after it stops.', 409);
          insist(queue.length + admissions.size < MAX_PENDING, 'UI_QUEUE_FULL', 'The local workspace queue is full. Existing work is preserved.', 429);
          insist(jobs.size < MAX_RECORDS, 'UI_JOURNAL_CAPACITY', 'The browser request journal is full. Inspect unresolved original operations through SFlow; no work was deleted.', 429);
          const receipt = { invocationId: input.invocationId, operation: input.operation, mutation: shape.mutation, root: context.root,
            clientId: session.clientId, environmentHash: session.environmentHash, inputHash, state: 'queued', acceptedAt: new Date().toISOString() };
          // Reserve synchronously before filesystem I/O: two simultaneous retries must enqueue once.
          jobs.set(receipt.invocationId, receipt);
          const admission = persist(receipt); admissions.set(receipt.invocationId, admission);
          try { await admission; }
          catch (error) {
            jobs.delete(receipt.invocationId);
            if (draining) queueMicrotask(() => { void finishShutdown(); });
            throw error;
          }
          finally { admissions.delete(receipt.invocationId); }
          queue.push({ operation: input.operation, input: input.input, root: context.root, invocationId: receipt.invocationId, environment: session.environment, session, receipt });
          event(session, 'accepted', { invocationId: receipt.invocationId });
          send(res, 202, view(receipt)); pump(); return;
        }
        throw new UiError('UI_ROUTE_UNSUPPORTED', 'Unknown browser operation.', null, 404);
      }
      const asset = publicFiles.get(route);
      insist(req.method === 'GET' && asset, 'UI_ROUTE_UNSUPPORTED', 'Page not found.', 404);
      const bytes = await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1] }); res.end(bytes);
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 500, { error: errorData(error), requestId });
      else res.end();
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  server.maxConnections = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const descriptor = { protocol: PROTOCOL, instance, credential, origin, build: identity, pid: process.pid, owner: leaseOwnerIdentity(), startedAt: new Date().toISOString() };
  try { await writePrivate(descriptorFile, descriptor); }
  catch (error) { server.close(); throw error; }
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const [nonce, at] of nativeNonces) if (now - at > 30_000) nativeNonces.delete(nonce);
    for (const [id, resource] of resources) if (resource.expiresAt < now) resources.delete(id);
    for (const [id, bridge] of bridges) if (bridge.expiresAt < now) bridges.delete(id);
    for (const [id, handoff] of handoffs) {
      if (now - handoff.createdAt > 30 * 60_000) { handoffs.delete(id); continue; }
      if (['queued', 'dispatched'].includes(handoff.state) && !bridges.has(handoff.bridgeId)) {
        handoff.state = handoff.state === 'queued' ? 'refused' : 'unknown';
        handoff.message = 'The matching editor disconnected. Inspect Copilot before retrying; no execution was observed.';
      }
    }
    for (const [key, ticket] of tickets) if (ticket.expiresAt < now) { tickets.delete(key); contexts.delete(ticket.context.id); void removeLauncher(ticket); }
    for (const [key, session] of sessions) if (session.expiresAt < now) {
      sessions.delete(key); for (const id of session.contexts) contexts.delete(id);
    }
    const liveBrowsers = new Set([...sessions.values()].map(session => session.browser));
    for (const key of browsers.keys()) if (!liveBrowsers.has(key)) browsers.delete(key);
    if (!running && !queue.length && !admissions.size && now - lastActivity > minutes * 60_000) { draining = true; void finishShutdown(); }
  }, 1000);
  return { descriptor, status, done, close: async () => { draining = true; await finishShutdown(); await done; } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = process.send ? await new Promise((resolve, reject) => {
      const disconnected = () => { clearTimeout(timer); reject(new UiError('UI_STARTUP_CLIENT_GONE', 'The native launcher disconnected before startup.')); };
      const timer = setTimeout(() => { process.removeListener('disconnect', disconnected); reject(new UiError('UI_STARTUP_HANDSHAKE_REQUIRED', 'The native startup handshake did not arrive.')); }, 5000);
      process.once('disconnect', disconnected);
      process.once('message', message => {
        clearTimeout(timer); process.removeListener('disconnect', disconnected);
        if (message?.type !== 'sflow-ui-start') return reject(new UiError('UI_STARTUP_HANDSHAKE_INVALID', 'Unexpected startup handshake.'));
        resolve({ directory: message.directory, idle: message.idle });
      });
    }) : { idle: process.env.SINGULARITY_FLOW_UI_IDLE_MINUTES ?? 10 };
    const service = await startService(options);
    if (process.connected) process.send({ type: 'sflow-ui-ready', instance: service.descriptor.instance }, () => {});
    process.on('SIGTERM', () => { void service.close(); });
    process.on('SIGINT', () => { void service.close(); });
    await service.done;
  } catch (error) { if (process.connected) process.send({ type: 'sflow-ui-error', error: errorData(error) }, () => {}); process.exitCode = 1; }
}
