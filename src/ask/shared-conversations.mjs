import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireFileLeaseWithin } from '../file-lease.mjs';
import { pinnedHttpRequest } from '../pinned-http.mjs';
import { recordSha256 } from '../records.mjs';
import { localFingerprint } from '../repositories/store.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { writeAtomic } from '../util.mjs';
import { conversationHome } from './conversation-store.mjs';
import { checkoutScope } from './history-cursor.mjs';
import { askRemote, portableSources } from './portable-evidence.mjs';
import { readPrivateConfiguration, readPrivateText } from './private-files.mjs';
import { clientConfiguration, failure, PORTABLE_ID, PROVIDER_PROTOCOL, PROVIDER_ROUTE, repositoryScope,
  RETENTION_MS, sharedContextSchema, sharedRecordSchema, STORE_BYTES } from './shared-contract.mjs';

const HOST_FAMILY = 'ask-portable-host';
const HEX = /^[a-f0-9]{64}$/u;
const OVERRIDE = 'SINGULARITY_FLOW_ASK_PROVIDER_CONFIG';
const configurationRequired = () => failure('ASK_PROVIDER_NOT_CONFIGURED', 'Configure an Ask provider for this repository before starting or resuming a shared conversation.');
const accessDenied = () => failure('ASK_PROVIDER_ACCESS_DENIED', 'The configured Ask provider did not authorize this owner and repository scope.');
const unavailable = () => failure('ASK_PROVIDER_UNAVAILABLE', 'The configured Ask provider is unavailable. Reconnect to it and resume the saved conversation.');
const hostBusy = () => failure('ASK_CONVERSATION_BUSY', 'Another Ask update is in progress on this device. Resume to see the latest result.');
const incompatible = () => failure('ASK_PROVIDER_INCOMPATIBLE', 'The configured Ask provider did not offer the required private storage, conditional updates, retention and deletion.');
const relativeInside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

async function outsideCheckout(root, file) {
  const actual = await realpath(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (relativeInside(root, file) || (actual && relativeInside(root, actual))) {
    throw failure('ASK_PROVIDER_PRIVATE_FILE_REQUIRED', 'Keep the Ask provider configuration and credentials outside the checkout.');
  }
}

async function bindingFor(root, env) {
  const file = path.resolve(env[OVERRIDE] || path.join(os.homedir(), '.singularity-flow', 'ask-provider.json'));
  const actualRoot = await realpath(root);
  await outsideCheckout(actualRoot, file);
  const config = await readPrivateConfiguration(file, clientConfiguration);
  const remotes = new Map();
  const matches = [];
  for (const binding of config?.bindings ?? []) {
    const name = binding.remote ?? 'origin';
    if (!remotes.has(name)) {
      let remote = null;
      try { remote = askRemote(root, name, env); }
      catch (error) { if (error.code !== 'ASK_SHARED_SOURCE_UNAVAILABLE') throw error; }
      remotes.set(name, remote);
    }
    const remote = remotes.get(name);
    if (remote && remote.repository === repositoryScope(binding.repository)) matches.push({ ...binding, remote });
  }
  if (!matches.length) throw configurationRequired();
  if (matches.length !== 1) throw failure('ASK_PROVIDER_SCOPE_AMBIGUOUS', 'Configure exactly one Ask provider binding for this checkout.');
  const binding = matches[0];
  const endpoint = new URL(binding.endpoint);
  const loopback = ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
      (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:'))) {
    throw failure('ASK_PROVIDER_CONFIGURATION_INVALID', 'Configure an HTTPS origin for the Ask provider.');
  }
  const tokenFile = path.resolve(path.dirname(file), binding.tokenFile);
  await outsideCheckout(actualRoot, tokenFile);
  const token = (await readPrivateText(tokenFile, 160))?.trim();
  if (!/^[A-Za-z0-9_-]{43,64}$/u.test(token ?? '')) throw accessDenied();
  return { ...binding, endpoint: new URL(PROVIDER_ROUTE, endpoint).href, token };
}

function responseError(status, reply) {
  const code = reply?.error?.code;
  const details = reply?.error?.details;
  if (status === 403) return accessDenied();
  if (status === 404 && code === 'ASK_CONVERSATION_UNAVAILABLE') {
    return failure(code, 'No saved Ask conversation is available in this provider scope.');
  }
  if (status === 409 && code === 'ASK_CONVERSATION_CONFLICT' && PORTABLE_ID.test(details?.conversationId ?? '') &&
      Number.isSafeInteger(details?.contextRevision) && details.contextRevision > 0) {
    return failure(code, 'This Ask conversation was updated on another device. Resume it to see the latest result.',
      { conversationId: details.conversationId, contextRevision: details.contextRevision });
  }
  if (status === 409 && code === 'ASK_TASK_BINDING_CONFLICT') return failure(code, 'The original task handoff is already bound to this conversation.');
  if (status === 503 && code === 'ASK_CONVERSATION_BUSY') return hostBusy();
  if (status === 413 && code === 'ASK_CONVERSATION_LIMIT') return failure(code, 'This result is too large to save in the Ask provider.');
  return unavailable();
}

function providerClient({ provider, workspace, remote, token, endpoint }) {
  let scope;
  async function request(operation, inputs = {}) {
    const response = await pinnedHttpRequest({ url: endpoint, network: 'private', timeoutMs: 8_000,
      maxResponseBytes: STORE_BYTES + 2048,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ operation, provider, workspace, repository: remote.repository, ...inputs }) });
    let reply;
    try { reply = JSON.parse(response.text); }
    catch { throw unavailable(); }
    if (response.status !== 200) throw responseError(response.status, reply);
    if (reply.protocol !== PROVIDER_PROTOCOL || reply.provider !== provider || !HEX.test(reply.scope ?? '') ||
        (scope !== undefined && scope !== reply.scope)) throw incompatible();
    if (operation === 'describe') {
      const capabilities = reply.capabilities;
      if (capabilities?.portable !== true || capabilities.private !== true || capabilities.conditionalWrites !== true || capabilities.deletion !== true ||
          !Number.isSafeInteger(capabilities.retentionMs) || capabilities.retentionMs < 1 || capabilities.retentionMs > RETENTION_MS) throw incompatible();
      scope = reply.scope;
      return { scope, retentionMs: capabilities.retentionMs };
    }
    if (operation === 'forget' && reply.value === null) return null;
    const parsed = sharedRecordSchema.safeParse(reply.value);
    if (!parsed.success || parsed.data.scope !== scope || (inputs.id && parsed.data.id !== inputs.id) ||
        (operation === 'create' && parsed.data.revision !== 1) ||
        (operation === 'update' && parsed.data.revision !== inputs.expected + 1) ||
        (operation === 'read' && inputs.expected !== null && parsed.data.revision !== inputs.expected)) throw incompatible();
    return parsed.data;
  }
  return request;
}

function sidecarStore(env, device, providerScope, retentionMs) {
  const base = conversationHome(env);
  const version = path.join(base, 'device-v1');
  const directory = path.join(version, recordSha256([device, providerScope]));
  const file = id => path.join(directory, id + '.json');
  async function ready(create) {
    for (const part of [base, version, directory]) {
      if (create) await mkdir(part, { recursive: true, mode: 0o700 });
      const info = await lstat(part).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) return false;
      if (!info.isDirectory() || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) {
        throw failure('ASK_CONVERSATION_STORE_UNSAFE', 'Ask conversation storage must be private to the local user.');
      }
    }
    return true;
  }
  async function entry(id) {
    const content = await readPrivateText(file(id), STORE_BYTES);
    if (!content) return null;
    const { record } = readRecord(HOST_FAMILY, content);
    return record.id === id && Number.isSafeInteger(record.updatedAt) ? record : null;
  }
  async function locked(operation) {
    const lease = await acquireFileLeaseWithin(path.join(directory, '.lock'), 2000);
    if (!lease) throw hostBusy();
    try { return await operation(); }
    finally { await lease.release(); }
  }
  return {
    async read(id) {
      if (!await ready(false)) return {};
      const data = await entry(id);
      return data && Date.now() - data.updatedAt <= retentionMs ? data.values : {};
    },
    async save(id, additions, keep) {
      if (!Object.keys(additions).length) return;
      await ready(true);
      await locked(async () => {
        const data = await entry(id);
        const values = { ...data?.values, ...additions };
        let body = JSON.stringify({ schemaVersion: currentSchemaVersion(HOST_FAMILY), id, updatedAt: Date.now(), values });
        if (Buffer.byteLength(body) > STORE_BYTES) {
          body = JSON.stringify({ schemaVersion: currentSchemaVersion(HOST_FAMILY), id, updatedAt: Date.now(),
            values: Object.fromEntries(Object.entries(values).filter(([key]) => keep.has(key))) });
        }
        if (Buffer.byteLength(body) > STORE_BYTES) throw failure('ASK_CONVERSATION_LIMIT', 'This device has too much local evidence to save this result.');
        await writeAtomic(file(id), body, { mode: 0o600 });
        for (const name of await readdir(directory)) {
          const previous = name.slice(0, -5);
          if (previous === id || !name.endsWith('.json') || !PORTABLE_ID.test(previous)) continue;
          const old = await entry(previous);
          if (old && Date.now() - old.updatedAt > retentionMs) await unlink(file(previous));
        }
      });
    },
    async forget(id) {
      if (!await ready(false)) return;
      await locked(() => unlink(file(id)).catch(error => { if (error.code !== 'ENOENT') throw error; }));
    }
  };
}

export async function sharedConversations({ root, context, audience, env }) {
  if (audience !== 'person') throw accessDenied();
  const binding = await bindingFor(root, env);
  const request = providerClient(binding);
  const { scope, retentionMs } = await request('describe');
  const device = await checkoutScope(root, context, audience);
  const secret = await localFingerprint('ask-device-v1', JSON.stringify([device, scope]), { env });
  const alias = (...inputs) => 'ev-' + recordSha256([secret, ...inputs]).slice(0, 24);
  const sidecar = sidecarStore(env, device, scope, retentionMs);
  const sources = portableSources(root, binding.remote, env);
  const observed = new Map();

  async function hydrate(wire) {
    observed.set(wire.id, wire);
    const host = await sidecar.read(wire.id);
    const ref = link => link?.ref.kind === 'local' && host[link.id]?.ref
      ? { ...link, ref: host[link.id].ref, originalId: host[link.id].originalId, local: true } : link;
    const history = wire.result.history;
    const pending = wire.result.pending;
    const record = { ...wire, selected: ref(wire.selected), result: { ...wire.result, refs: wire.result.refs.map(ref),
      history: history?.localId ? host[history.localId]?.history ?? null : history,
      pending: pending?.localId ? host[pending.localId]?.pending ?? null : pending } };
    const handles = new Map([...record.result.refs, record.selected].filter(Boolean).map(link => [link.id, alias('handle', wire.id, link.id)]));
    Object.defineProperty(record, 'shared', { value: {
      toHandle: id => handles.get(id) ?? null,
      fromHandle: id => [...handles].find(([, key]) => key === id)?.[0],
      missingHistory: Boolean(history?.localId && !record.result.history),
      missingPending: Boolean(pending?.localId && !record.result.pending)
    } });
    if (wire.localTask && host[wire.localTask]?.taskAdmissionId) record.taskAdmissionId = host[wire.localTask].taskAdmissionId;
    return record;
  }

  async function encode(id, before, fields, value) {
    // Only the closed wire projection may cross the provider boundary.
    const additions = {};
    const keep = new Set();
    function local(kind, item) {
      const key = alias(id, kind, item);
      additions[key] = item;
      keep.add(key);
      return key;
    }
    const links = new Map([...(before?.result.refs ?? []), before?.selected].filter(Boolean).map(link => [link.id, link]));
    async function evidence(link) {
      if (!link) return null;
      if (links.has(link.id)) {
        keep.add(link.id);
        return links.get(link.id);
      }
      const bound = await sources.bind(link, value);
      if (bound) return bound;
      return { id: local('evidence', { ref: link.ref, originalId: link.id }), ref: { kind: 'local' } };
    }
    const context = { ...before, ...fields };
    delete context.id;
    delete context.scope;
    delete context.schemaVersion;
    delete context.updatedAt;
    delete context.revision;
    delete context.taskAdmissionId;
    if (fields.result) {
      const { refs, history, pending } = fields.result;
      let savedHistory = history && await sources.bindHistory(history);
      if (history && !savedHistory) savedHistory = { localId: local('history', { history }) };
      const savedPending = pending?.choices.every(choice => choice.kind === 'help') ? pending
        : pending ? { localId: local('pending', { pending }) } : null;
      context.result = { id: 'ask-' + randomUUID().replaceAll('-', ''), refs: await Promise.all(refs.map(evidence)),
        history: savedHistory ?? null, pending: savedPending };
    }
    if (Object.hasOwn(fields, 'selected')) {
      const raw = fields.selected;
      const position = fields.result?.refs.findIndex(item => item.id === raw?.id) ?? -1;
      context.selected = position >= 0 ? context.result.refs[position] : await evidence(raw);
    }
    if (fields.taskAdmissionId) context.localTask = local('task', { taskAdmissionId: fields.taskAdmissionId });
    if (fields.taskPublication) context.taskPublication = fields.taskPublication;
    if (context.localTask) keep.add(context.localTask);
    if (context.result.history?.localId) keep.add(context.result.history.localId);
    if (context.result.pending?.localId) keep.add(context.result.pending.localId);
    for (const link of [...context.result.refs, context.selected].filter(Boolean)) keep.add(link.id);
    const checked = sharedContextSchema.safeParse(context);
    if (!checked.success) throw failure('ASK_PORTABLE_CONTEXT_INVALID', 'This saved result cannot be represented by the shared Ask provider.');
    await sidecar.save(id, additions, keep);
    return checked.data;
  }

  async function read(id = null, expected = null) {
    let wire;
    try { wire = await request('read', { id, expected }); }
    catch (error) {
      if (id && error.code === 'ASK_CONVERSATION_UNAVAILABLE') await sidecar.forget(id);
      throw error;
    }
    return hydrate(wire);
  }
  return {
    sources, read,
    taskKey: (id, requestDigest) => 'itw-' + recordSha256([secret, 'task', id, requestDigest]).slice(0, 32),
    async create(fields, value) {
      const id = 'askp-' + randomUUID().replaceAll('-', '');
      const context = await encode(id, null, fields, value);
      return hydrate(await request('create', { id, context }));
    },
    async update(id, expected, fields, value) {
      if (observed.get(id)?.revision !== expected) await read(id, expected);
      const context = await encode(id, observed.get(id), fields, value);
      return hydrate(await request('update', { id, expected, context }));
    },
    async forget(id, expected) {
      await request('forget', { id, expected });
      await sidecar.forget(id);
    }
  };
}
