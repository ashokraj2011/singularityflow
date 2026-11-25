/** SFlow-owned loopback host. No cwd changes, console interception, Git or workflow policy here. */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL, MAX_BODY, MAX_CONTENT, MAX_NATIVE_BODY, MAX_REPLY, MAX_PENDING, MAX_RUNNING, TICKET_MS, SESSION_MS, UiError, insist, record, text, identifier, idleMinutes, nativeEnvironment, environmentScope, errorData } from './contracts.mjs';
import { buildIdentity, privateDirectory, readPrivate, writePrivate, removeOwnDescriptor, serviceDirectory } from './private-state.mjs';
import { operationShape, executeOperation, disposeReadWorkers, runCanonical } from './operations.mjs';
import { leaseOwnerAssessment, leaseOwnerIdentity } from '../lease-liveness.mjs';
import { nativeEqual, requestProof, responseProof, openInput } from './native-auth.mjs';
import { activeStorySelection, isEngineCheckout, launcherCheckout, matchesActiveStory } from './story-context.mjs';
import { CHAT_PAIRS } from '../ask/chat.mjs';
import { asksForStorySummary, readStorySources, relatedStoryTopics, searchTurn, storyForQuestion, storyQuestion } from './ask-story.mjs';

const randomKey = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const explainerAsset = kind => async () => {
  const { CX_STYLE, CODE_EXPLAINER_RUNTIME, codeExplainerMarkup } = await import('../code-intelligence/code-explainer-view.mjs');
  if (kind === 'script') return `export default ${CODE_EXPLAINER_RUNTIME};\n`;
  if (kind === 'style') return CX_STYLE;
  const { icon } = await import('./public/views.js');
  const names = { capability: 'checkout', collection: 'stories', impact: 'expand', refresh: 'history',
    search: 'search', skill: 'skills', visual: 'specs', workflow: 'workflows' };
  return codeExplainerMarkup(name => icon(names[name]));
};
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/sflow-brand.svg', ['../../../apps/vscode/media/brand.svg', 'image/svg+xml']],
  ['/favicon.svg', ['../../../apps/vscode/media/icon.svg', 'image/svg+xml']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/ask-navigation.js', ['../../ask/navigation.mjs', 'text/javascript; charset=utf-8']],
  ['/ask-history-display.js', ['../../ask/history-display.mjs', 'text/javascript; charset=utf-8']],
  ['/ask-query.js', ['../../ask/query.mjs', 'text/javascript; charset=utf-8']],
  ['/history-intent.mjs', ['../../ask/history-intent.mjs', 'text/javascript; charset=utf-8']],
  ['/ask.js', ['ask.js', 'text/javascript; charset=utf-8']],
  ['/ask-results.js', ['ask-results.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/views.js', ['views.js', 'text/javascript; charset=utf-8']],
  ['/code-explainer.js', ['code-explainer.js', 'text/javascript; charset=utf-8']],
  ['/code-explainer.css', ['code-explainer.css', 'text/css; charset=utf-8']],
  ['/code-explainer-view.js', [explainerAsset('script'), 'text/javascript; charset=utf-8']],
  ['/code-explainer-view.css', [explainerAsset('style'), 'text/css; charset=utf-8']],
  ['/code-explainer-view.html', [explainerAsset('markup'), 'text/html; charset=utf-8']],
  ['/code-explainer-model.js', ['../../code-intelligence/generated/code-explainer-model.mjs', 'text/javascript; charset=utf-8']]
]);
const terminal = new Set(['succeeded', 'failed', 'unknown', 'expired']);
const codeOperations = new Set(['code.changes', 'code.repository', 'code.source']);
const ASK_SELECTION_MS = 5 * 60_000;
const ASK_THREAD_TURNS = 8;
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
  const storyBindings = new WeakMap();
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
          if (codeOperations.has(job.operation)) await checkCodeContext(job.session, job.context);
          const story = job.machine ? null : await verifyStory(job.context);
          const result = await execute({ ...job, story, directory, onProgress: progress => event(job.session, 'progress', { invocationId: job.receipt.invocationId, ...progress }) });
          if (codeOperations.has(job.operation)) await checkCodeContext(job.session, job.context);
          if (job.operation === 'story.list') {
            job.session.choices.clear();
            result.choices = (result.value?.stories ?? []).filter(story => story.availability === 'ready').map(story => {
              const choiceId = randomUUID();
              job.session.choices.set(choiceId, story);
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
  async function contextFor(root, { launch = false } = {}) {
    let resolved = await realpath(text(root, 'Checkout', 8192));
    insist((await stat(resolved)).isDirectory(), 'UI_CONTEXT_UNAVAILABLE', 'The selected checkout is not a directory.');
    if (launch) resolved = await launcherCheckout(resolved);
    const engine = launch && await isEngineCheckout(resolved, identity.engineRoot);
    return { id: randomUUID(), key: digest(resolved), root: resolved, label: path.basename(resolved), ...(engine ? { engine: true } : {}) };
  }
  const sameStory = (entry, row) => entry?.workId === row.workId && entry.branch === row.branch
    && entry.checkoutPath === row.checkoutPath && (entry.repository.id ?? null) === (row.repository.id ?? null)
    && entry.workspace.id === row.workspace.id && (entry.role ?? 'story') === (row.role ?? 'story')
    && (entry.lifecycle?.checkoutPath ?? null) === (row.lifecycle?.checkoutPath ?? row.lifecycleCheckoutPath ?? null);
  function storyChanged(reason) {
    return new UiError('UI_STORY_CHECKOUT_CHANGED',
      `The selected Story checkout changed.${reason ? ' ' + reason + '.' : ''} Refresh Stories and open its current checkout.`, null, 409);
  }
  async function verifyStory(context) {
    const entry = storyBindings.get(context);
    if (!entry) return null;
    const { verifyStoryEntry } = await import('../story-index.mjs');
    const result = await verifyStoryEntry(entry);
    if (result.status !== 'valid' || result.entry.checkoutPath !== context.root) throw storyChanged(result.reason);
    return result.entry;
  }
  function bindStory(context, entry) {
    storyBindings.set(context, entry);
    context.label = entry.workId;
    context.story = { workId: entry.workId, title: entry.title, repositoryId: entry.repository.id,
      workspaceName: entry.workspace.name, role: entry.role ?? 'story', branch: entry.branch };
  }
  async function contextForStory(session, entry) {
    let context = [...session.contexts].map(id => contexts.get(id)).find(candidate => {
      const known = storyBindings.get(candidate);
      return sameStory(known, entry) && known.commonDir === entry.commonDir;
    });
    if (!context) {
      context = await contextFor(entry.checkoutPath);
      if (context.root !== entry.checkoutPath) throw storyChanged();
      if (session.contexts.size >= 32) {
        const oldest = [...session.contexts].find(id => id !== session.launcherId && id !== session.contextId);
        session.contexts.delete(oldest); contexts.delete(oldest);
      }
      contexts.set(context.id, context); session.contexts.add(context.id);
    }
    bindStory(context, entry);
    return context;
  }
  function contextView(session) {
    return { context: selected(session, session.contextId), capabilities: capabilitiesFor(session),
      followsActiveStory: session.followsActiveStory,
      ...(session.activeStoryIssue ? { activeStoryIssue: session.activeStoryIssue } : {}) };
  }
  async function syncActiveStory(session) {
    if (!session.followsActiveStory) return;
    if (session.activeStoryRead) return session.activeStoryRead;
    session.activeStoryRead = (async () => {
      let selection, context, issue;
      try {
        selection = await activeStorySelection(session.environment);
        if (selection) {
          if (!selection.stale && selection.checkoutPath) {
            const previous = selected(session, session.contextId);
            const binding = storyBindings.get(previous);
            const { checkoutGitFacts, verifiedStoryCheckoutAt } = await import('../story-index.mjs');
            if (matchesActiveStory(binding, selection)) {
              const facts = await checkoutGitFacts(binding.checkoutPath);
              if (facts?.commonDir === binding.commonDir && (facts.branch === binding.branch || facts.branch === null)) context = previous;
            }
            const entry = !context ? (await verifiedStoryCheckoutAt(selection.checkoutPath, {
              env: session.environment, workId: selection.workId
            }))?.entry : null;
            if (matchesActiveStory(entry, selection)) context = await contextForStory(session, entry);
          }
          if (!context) issue = `The checkout for the active Story ${selection.workId} is unavailable. Reopen it in SFlow, then return to the browser workspace.`;
        }
      } catch {
        issue = 'The active Story selection could not be read. Reopen it in SFlow.';
      }
      if (!session.followsActiveStory) return;
      session.activeStoryIssue = issue ?? null;
      session.contextId = context?.id ?? session.launcherId;
    })().finally(() => { session.activeStoryRead = null; });
    return session.activeStoryRead;
  }
  async function checkCodeContext(session, context) {
    await syncActiveStory(session);
    insist(session.contextId === context.id, 'UI_CODE_CONTEXT_CHANGED', 'The selected checkout changed. Open Code Explainer in the current Story.', 409);
    insist(!session.activeStoryIssue, 'UI_ACTIVE_STORY_UNAVAILABLE', session.activeStoryIssue, 409);
    insist(!context.engine || context.story, 'UI_CODE_STORY_REQUIRED', 'Open a Story to see its application code.', 409);
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
          const context = await contextFor(previous?.root ?? input.root, { launch: !previous });
          const { indexedCheckoutAt } = await import('../story-index.mjs');
          const story = await indexedCheckoutAt(context.root, { env: environment }).catch(() => null);
          if (story) bindStory(context, story);
          contexts.set(context.id, context);
          const ticket = randomKey(), link = `${origin}/#ticket=${ticket}`;
          const clientId = previous?.clientId ?? text(input.clientId, 'Client ID', 128);
          // Asked for by a launcher that opens a browser: the link goes into a private page, never a process's arguments.
          let launcher = null;
          if (input.launcher === true) {
            launcher = path.join(directory, `launch-${randomBytes(16).toString('hex')}.html`);
            await writeFile(launcher, launcherPage(link), { flag: 'wx', mode: 0o600 });
          }
          tickets.set(digest(ticket), { context, environment, environmentHash, clientId, launcher, resume: Boolean(previous), expiresAt: Date.now() + TICKET_MS });
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
          launcherId: grant.context.id, followsActiveStory: !grant.resume, activeStoryRead: null, activeStoryIssue: null,
          environment: grant.environment, environmentHash: grant.environmentHash,
          browser, expiresAt: Date.now() + SESSION_MS, sequence: 0, events: [], choices: new Map(), askSelections: new Map() };
        sessions.set(tabId, session);
        await syncActiveStory(session);
        res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=43200`);
        touch(); return send(res, 200, { tabId, csrf: session.csrf, build: identity, ...contextView(session) });
      }
      if (route.startsWith('/api/')) {
        // A visible tab's status poll is not work: an open tab alone never keeps the service from its idle stop.
        // A tab holding unsaved writing says so (`working=1`), and that person is still working.
        const poll = req.method === 'GET' && (route === '/api/events' && url.searchParams.get('working') !== '1'
          || route === '/api/session' && url.searchParams.get('follow') === '1');
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
        if (route === '/api/session' && req.method === 'GET') {
          await syncActiveStory(session);
          return send(res, 200, { csrf: session.csrf, build: identity, ...contextView(session) });
        }
        if (route === '/api/ask' && req.method === 'POST') {
          const request = await body(req);
          const interaction = request?.interaction;
          const chat = interaction === 'chat';
          const chatControl = ['chat-history', 'chat-reset'].includes(interaction);
          const prepareTask = interaction === 'task-prepare';
          const startTask = interaction === 'task-start';
          const task = prepareTask || startTask || interaction === 'task-status';
          const contextual = prepareTask || ['evidence', 'select', 'explain', 'forget'].includes(interaction);
          insist(chat || chatControl || contextual || task || ['activate', 'open-file', 'submit', 'continue', 'resume'].includes(interaction), 'UI_REQUEST_INVALID', 'Choose an Ask SFlow action.');
          const contextFields = ['conversationId', 'revision'];
          const supplied = chat ? ['query', 'workspace'] : chatControl ? []
            : prepareTask ? [...contextFields, 'target', 'words', 'kind', 'clauses', 'evidence']
            : task ? ['admissionId'] : interaction === 'submit' ? ['query', 'remember', 'portable', 'workspaceSearch', ...contextFields]
            : contextual ? [...contextFields, ...(['evidence', 'select'].includes(interaction) ? ['target'] : [])]
              : interaction === 'resume' ? ['portable', 'conversationId'] : ['selection'];
          const input = record(request, ['contextId', 'interaction', ...supplied]);
          await syncActiveStory(session);
          const context = selected(session, text(input.contextId, 'Context ID', 128));
          insist(context.id === session.contextId, 'UI_ASK_CONTEXT_CHANGED', 'The selected checkout changed. Review the Story before sending again.', 409);
          if (context.engine && !context.story) insist(!input.workspaceSearch && !(chat && input.workspace),
            'UI_ASK_STORY_REQUIRED', 'Open an application checkout to include workspace sources.', 409);
          const turns = session.askChat?.contextId === context.id ? session.askChat.turns : [];
          if (chatControl) {
            if (interaction === 'chat-reset') {
              insist(!session.askReading, 'UI_ASK_BUSY', 'Wait for the current reply before starting a new chat.', 429);
              session.askChat = null;
              session.askConversation = null;
              session.askTask = null;
              for (const [id, selection] of session.askSelections) if (selection.contextId === context.id) session.askSelections.delete(id);
            }
            return send(res, 200, { kind: 'chat-history', turns: interaction === 'chat-reset' ? [] : turns.map(({ modelSummary, ...turn }) => turn) });
          }
          if (interaction === 'resume' && input.conversationId !== undefined) {
            insist(typeof input.conversationId === 'string' && /^askp?-[a-f0-9]{32}$/u.test(input.conversationId),
              'UI_REQUEST_INVALID', 'Use an Ask conversation ID.');
          } else if (contextual || input.conversationId !== undefined || input.revision !== undefined) {
            const latest = session.askConversation;
            insist(input.conversationId && latest?.id === input.conversationId && latest?.revision === input.revision && latest?.contextId === context.id,
              'UI_ASK_CONVERSATION_CHANGED', 'Resume the current Ask conversation from this tab to continue.', 409);
          }
          const args = task ? ['work', 'handoff', '--for-person'] : ['ask', '--for-person'];
          let root = context.root;
          let question, topic;
          const previous = turns.at(-1);
          if (input.conversationId) args.push('--conversation=' + input.conversationId);
          if (input.revision !== undefined) args.push('--revision=' + input.revision);
          if (input.portable !== undefined) {
            insist(input.portable === true && (interaction === 'resume' || input.remember === true && !input.conversationId),
              'UI_REQUEST_INVALID', 'Choose a new or saved shared Ask conversation.');
            args.push('--portable');
          }
          if (chat) {
            question = text(input.query, 'Question', 2000).trim();
            insist(question && typeof input.workspace === 'boolean', 'UI_REQUEST_INVALID', 'Enter a question and choose whether to include workspace context.');
            topic = storyQuestion(question, previous);
            args.splice(1, 0, 'chat', '--query-stdin');
          } else if (prepareTask) {
            const ids = (value, limit, label) => {
              insist(Array.isArray(value) && value.length <= limit, 'UI_REQUEST_INVALID', `Choose up to ${limit} ${label}.`);
              return value.map(id => text(id, label, 160));
            };
            args.push('--request=' + text(input.words, 'Task', 2000), '--kind=' + text(input.kind, 'Task kind', 24),
              '--target=' + text(input.target, 'Selected evidence', 36),
              ...ids(input.clauses ?? [], 32, 'clauses').map(id => '--clause=' + id),
              ...ids(input.evidence ?? [], 7, 'evidence links').map(id => '--supporting-evidence=' + id));
          } else if (task) {
            const id = text(input.admissionId, 'Task handoff', 36);
            insist(session.askTask?.id === id && session.askTask.contextId === context.id,
              'UI_ASK_TASK_CHANGED', 'Resume the saved Ask conversation in this tab to open its task handoff.', 409);
            args.push(id);
            if (startTask) args.push('--start');
          } else if (interaction === 'submit') {
            insist(input.remember === undefined || (input.remember === true && !input.conversationId),
              'UI_REQUEST_INVALID', 'Choose a new or an existing Ask conversation.');
            args.push('--question=' + text(input.query, 'Question', 2000));
            if (input.remember) args.push('--remember');
            if (input.workspaceSearch !== undefined) {
              insist(input.workspaceSearch === true, 'UI_REQUEST_INVALID', 'Choose workspace search.');
              args.push('--all');
            }
          } else if (interaction === 'resume' || interaction === 'explain' || interaction === 'forget') {
            args.push('--' + interaction);
          } else if (interaction === 'evidence' || interaction === 'select') {
            const target = text(input.target, 'Selection', 36);
            insist(/^(?:ev-[a-f0-9]{24}|choice-[1-3])$/u.test(target), 'UI_REQUEST_INVALID', 'Choose a result or evidence link.');
            args.push('--' + interaction + '=' + target);
          } else {
            const selection = session.askSelections.get(text(input.selection, 'Selection', 36));
            insist(selection && selection.contextId === context.id && selection.expiresAt > Date.now()
                && interaction === selection.interaction,
              'UI_ASK_SELECTION_EXPIRED', 'Submit the original question again from this tab.', 409);
            if (interaction === 'continue') {
              args.push('--cursor=' + selection.cursor);
            } else if (interaction === 'open-file') {
              args.splice(1, 0, 'file');
              args.push('--ref=' + selection.revision, '--path=' + selection.file);
            } else {
              const { reference, stateCommit, manifestSha256 } = selection.specification;
              root = selection.root ?? root;
              args.push('--question=' + reference, '--open-spec', '--state-commit=' + stateCommit, '--manifest-sha256=' + manifestSha256);
            }
          }
          insist(!draining && running < MAX_RUNNING && !session.askReading, 'UI_ASK_BUSY', 'Wait for the current read or cancel it, then try again.', 429);
          const controller = new AbortController();
          const abort = () => controller.abort();
          session.askReading = true;
          running += 1;
          if (!startTask) res.once('close', abort);
          try {
            const story = await verifyStory(context);
            const evidenceStory = chat ? storyForQuestion(story, question, previous) : null;
            const evidenceRoot = evidenceStory?.lifecycle?.checkoutPath ?? context.root;
            const localSummary = evidenceStory && !input.workspace && asksForStorySummary(question);
            let records = [];
            let value;
            if (topic || localSummary || chat && input.workspace && evidenceStory) {
              if (!evidenceStory) {
                const subject = previous?.subject ?? null;
                value = { kind: 'chat', status: 'resolved', question, answeredBy: 'sflow', topic, subject, sources: [],
                  answer: subject ? `Open the checkout for Story ${subject} to read its recorded evidence.`
                    : 'Open a Story from Stories to read its recorded evidence.' };
              } else {
                const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(topic ? 19_000 : 8_000)]);
                const read = operation => executeOperation({ operation, input: {}, root: context.root, story: evidenceStory,
                  signal, environment: session.environment }).then(result => result.value);
                const specifications = workId => runCanonical(evidenceRoot, ['ask', '--for-person', '--question=spec used for story ' + workId], {
                  signal, environment: session.environment, timeoutMs: 18_000
                }).then(result => result.value);
                const load = name => readStorySources(evidenceStory, name, { read, specifications });
                if (topic) {
                  try { records = await load(topic); }
                  catch (error) {
                    if (signal.aborted && !controller.signal.aborted) throw new UiError('UI_ASK_TIMEOUT',
                      'SFlow did not finish reading the Story evidence. Your question is still in the composer.', error.details, 504);
                    throw error;
                  }
                  value = { kind: 'chat', status: 'resolved', question, answer: records[0].snippet, sources: records,
                    answeredBy: 'sflow', topic, subject: evidenceStory.workId };
                } else {
                  const names = localSummary ? ['status', 'decisions', 'tests'] : ['status', ...relatedStoryTopics(question, previous)];
                  const reads = await Promise.allSettled(names.map(load));
                  records = reads.flatMap(result => result.status === 'fulfilled' ? result.value : []).slice(0, 6);
                  if (localSummary) {
                    const summary = records.map(record => record.snippet);
                    if (reads.some(result => result.status === 'rejected')) {
                      summary.push('Some Story evidence could not be read. Open Decisions or Run & Test from the sidebar to inspect it.');
                    }
                    value = { kind: 'chat', status: 'resolved', question, answeredBy: 'sflow', subject: evidenceStory.workId,
                      sources: records, answer: summary.join('\n\n') };
                  }
                }
              }
            }
            if (!value) {
              const history = chat ? turns.filter(turn => input.workspace || !turn.scoped).slice(-CHAT_PAIRS) : [];
              const stdin = chat ? JSON.stringify({ question, workspace: input.workspace, records,
                previous: history.map(turn => ({ question: turn.question, answer: turn.modelSummary ?? turn.answer })) }) : null;
              ({ value } = await runCanonical(root, args, {
                timeoutMs: startTask || prepareTask ? 300_000 : chat ? 46_000 : 20_000,
                signal: controller.signal, environment: session.environment, personAskModel: interaction === 'explain' || chat, stdin
              }));
            }
            if (chat || interaction === 'submit') await syncActiveStory(session);
            insist(session.contextId === context.id && contexts.has(context.id),
              'UI_ASK_CONTEXT_CHANGED', 'The checkout changed while reading. Review the Story before sending again.', 409);
            if (value.conversation) session.askConversation = { id: value.conversation.id, revision: value.conversation.revision, contextId: context.id };
            const ended = ['workspace-search', 'forgotten'].includes(value.kind) || value.kind === 'conversation' && !value.conversation;
            if (ended) session.askConversation = null;
            const handoffId = value.resultType === 'sflow-task-handoff' ? value.id : value.conversation?.taskAdmissionId;
            if (value.conversation || handoffId) session.askTask = handoffId ? { id: handoffId, contextId: context.id } : null;
            if (ended) session.askTask = null;
            for (const specification of value.conversation ? [] : value.specifications ?? []) {
              const id = randomUUID();
              // The input to activation is opaque. Only an exact revision issued to this tab can open.
              session.askSelections.set(id, { interaction: 'activate', specification: { ...specification }, contextId: context.id, expiresAt: Date.now() + ASK_SELECTION_MS });
              specification.selection = id;
            }
            for (const result of [...(value.results ?? []), ...(value.sources ?? [])]) {
              const id = randomUUID();
              const bound = { contextId: context.id, expiresAt: Date.now() + ASK_SELECTION_MS };
              if (result.type === 'spec' && result.reference) {
                if (records.some(source => source.type === 'spec' && source.reference === result.reference && source.stateCommit === result.stateCommit &&
                    source.manifestSha256 === result.manifestSha256)) bound.root = evidenceRoot;
                session.askSelections.set(id, { ...bound, interaction: 'activate', specification: { ...result } });
                result.selection = id;
              } else if (result.type === 'file') {
                session.askSelections.set(id, { ...bound, interaction: 'open-file', revision: result.revision, file: result.id });
                result.selection = id;
              }
            }
            const turn = chat && value.status === 'resolved' ? { question: value.question, answer: value.answer,
              sources: value.sources, answeredBy: value.answeredBy ?? 'copilot', topic: value.topic,
              subject: value.subject ?? (input.workspace ? evidenceStory?.workId ?? previous?.subject : null),
              scoped: value.answeredBy === 'sflow' || input.workspace }
              : interaction === 'submit' ? searchTurn(input.query, value) : null;
            if (turn) {
              turn.id = randomUUID();
              session.askChat = { contextId: context.id, turns: [...turns, turn].slice(-ASK_THREAD_TURNS) };
              const { modelSummary, ...visible } = turn;
              value.turn = visible;
            }
            if (value.continuation?.cursor) {
              const id = randomUUID();
              session.askSelections.set(id, { interaction: 'continue', cursor: value.continuation.cursor,
                contextId: context.id, expiresAt: Date.now() + ASK_SELECTION_MS });
              value.continuation = { selection: id, behavior: value.continuation.behavior };
            }
            while (session.askSelections.size > 32) session.askSelections.delete(session.askSelections.keys().next().value);
            return send(res, 200, value);
          } catch (error) {
            if (!task && error?.code === 'UI_OPERATION_TIMEOUT') {
              throw new UiError('UI_ASK_TIMEOUT', chat && !topic ? 'Copilot did not finish this reply. Your question is still in the composer.'
                : 'Ask SFlow could not finish the read in 20 seconds. Submit the question again to retry.', error.details, 504);
            }
            throw error;
          } finally {
            res.off('close', abort);
            session.askReading = false;
            running -= 1;
            pump();
            if (draining) void finishShutdown();
          }
        }
        if (route === '/api/handoffs' && req.method === 'POST') {
          const input = record(await body(req), ['contextId', 'type', 'specId', 'menu']);
          const context = selected(session, text(input.contextId, 'Context ID', 128)), bridge = bridgeFor(session);
          insist(context.id === session.contextId && bridge, 'UI_BRIDGE_UNAVAILABLE', 'No matching VS Code window is connected to this tab and checkout.', 409);
          await verifyStory(context);
          insist(context.id === session.contextId, 'UI_BRIDGE_UNAVAILABLE', 'The selected checkout changed. Try the handoff in the current checkout.', 409);
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
        if (route === '/api/contexts' && req.method === 'GET') return send(res, 200, {
          contexts: [...session.contexts].map(id => selected(session, id)), currentId: session.contextId,
          followsActiveStory: session.followsActiveStory
        });
        if (route === '/api/contexts' && req.method === 'POST') {
          const input = record(await body(req), ['choiceId', 'contextId', 'followActiveStory']);
          insist((input.followActiveStory === undefined || input.followActiveStory === true)
            && [input.choiceId, input.contextId, input.followActiveStory].filter(Boolean).length === 1,
          'UI_REQUEST_INVALID', 'Choose the active Story or one issued checkout.');
          if (input.followActiveStory) {
            session.followsActiveStory = true;
            await syncActiveStory(session);
            return send(res, 200, contextView(session));
          }
          let context;
          if (input.contextId) {
            context = selected(session, text(input.contextId, 'Context ID', 128));
            await verifyStory(context);
            insist(await realpath(context.root) === context.root, 'UI_CONTEXT_MOVED', 'This checkout moved. Reopen it through the native client.', 409);
          } else {
            const choice = session.choices.get(text(input.choiceId, 'Context choice', 128));
            insist(choice, 'UI_CONTEXT_DENIED', 'Refresh Stories and select a currently available checkout.', 403);
            const { indexedCheckoutAt } = await import('../story-index.mjs');
            const entry = await indexedCheckoutAt(choice.checkoutPath, { env: session.environment });
            if (!sameStory(entry, choice)) throw storyChanged();
            context = await contextForStory(session, entry);
          }
          session.followsActiveStory = false;
          session.activeStoryIssue = null;
          session.contextId = context.id;
          return send(res, 200, contextView(session));
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
          const binding = shape.machine || shape.mutation ? null : storyBindings.get(context);
          const inputHash = digest(JSON.stringify([context.root, session.environmentHash, input.operation, input.input,
            ...(binding ? [[binding.workId, binding.branch, binding.commonDir, binding.lifecycle?.checkoutPath]] : [])]));
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
          queue.push({ operation: input.operation, input: input.input, root: context.root, context, machine: shape.machine,
            invocationId: receipt.invocationId, environment: session.environment, session, receipt });
          event(session, 'accepted', { invocationId: receipt.invocationId });
          send(res, 202, view(receipt)); pump(); return;
        }
        throw new UiError('UI_ROUTE_UNSUPPORTED', 'Unknown browser operation.', null, 404);
      }
      const asset = publicFiles.get(route);
      insist(req.method === 'GET' && asset, 'UI_ROUTE_UNSUPPORTED', 'Page not found.', 404);
      const bytes = typeof asset[0] === 'function' ? await asset[0]() : await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
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
