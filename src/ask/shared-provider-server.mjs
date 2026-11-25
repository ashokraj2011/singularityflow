import { createHash, timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import path from 'node:path';
import { recordSha256 } from '../records.mjs';
import { conversationDirectory } from './conversation-store.mjs';
import { readPrivateConfiguration, readPrivateText } from './private-files.mjs';
import { failure, PORTABLE_ID, PROVIDER_PROTOCOL, PROVIDER_ROUTE, providerRequest, repositoryScope, RETENTION_MS,
  serverConfiguration, SHARED_FAMILY, sharedRecordSchema, STORE_BYTES } from './shared-contract.mjs';

const forbidden = () => failure('ASK_PROVIDER_ACCESS_DENIED', 'The configured Ask provider did not authorize this owner and repository scope.');
const invalid = () => failure('ASK_PROVIDER_REQUEST_INVALID', 'This provider request does not match the Ask conversation protocol.');
const HTTP = Object.freeze({ ASK_PROVIDER_ACCESS_DENIED: 403, ASK_PROVIDER_REQUEST_INVALID: 400,
  ASK_CONVERSATION_UNAVAILABLE: 404, ASK_CONVERSATION_EXISTS: 409, ASK_CONVERSATION_CONFLICT: 409,
  ASK_TASK_BINDING_CONFLICT: 409, ASK_CONVERSATION_BUSY: 503, ASK_CONVERSATION_LIMIT: 413, SCHEMA_VERSION_FUTURE: 422 });

async function requestBody(req) {
  if (req.headers['content-type'] !== 'application/json') throw invalid();
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > STORE_BYTES + 1024) throw failure('ASK_CONVERSATION_LIMIT', 'This Ask conversation exceeds the provider size limit.');
    chunks.push(chunk);
  }
  try { return providerRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw invalid(); }
}

function response(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function verifyTaskBinding(before, next) {
  if ((before.localTask && before.localTask !== next.localTask) || (before.taskPublication &&
      recordSha256(before.taskPublication) !== recordSha256(next.taskPublication ?? null))) {
    throw failure('ASK_TASK_BINDING_CONFLICT', 'The original task handoff is already bound to this conversation.');
  }
}

const tokenDigest = token => createHash('sha256').update(token).digest();

/** Private reference provider. All clients share this authority's persistent, server-local filesystem. */
export async function serveAskProvider(configFile, { now = Date.now } = {}) {
  const config = await readPrivateConfiguration(configFile, serverConfiguration);
  if (!config) throw failure('ASK_PROVIDER_CONFIGURATION_INVALID', 'Pass the path to the private Ask provider server configuration.');
  const fromConfig = value => path.resolve(path.dirname(configFile), value);
  const base = fromConfig(config.directory);
  const host = config.host ?? '127.0.0.1';
  if (!config.tls && !['127.0.0.1', '::1'].includes(host)) {
    throw failure('ASK_PROVIDER_TLS_REQUIRED', 'An Ask provider listening beyond loopback requires a TLS certificate and key.');
  }
  const lookup = async (digest, { provider, workspace, repository }) => {
    // Grants are read for every operation and again after queued writes acquire their lease.
    const current = await readPrivateConfiguration(configFile, serverConfiguration);
    if (!current || current.name !== config.name || fromConfig(current.directory) !== base || provider !== config.name) throw forbidden();
    const matches = current.grants.filter(grant => timingSafeEqual(Buffer.from(grant.tokenSha256, 'hex'), digest) &&
      workspace === grant.workspace && repository === repositoryScope(grant.repository) && (!grant.expiresAt || Date.parse(grant.expiresAt) > now()));
    if (matches.length !== 1) throw forbidden();
    return recordSha256([provider, workspace, repository, matches[0].owner]);
  };
  function directory(scope, authorize) {
    return conversationDirectory({ base, scope, family: SHARED_FAMILY, idPattern: PORTABLE_ID,
      validate: record => sharedRecordSchema.parse(record), validateUpdate: verifyTaskBinding, authorize, now });
  }
  const handler = async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== PROVIDER_ROUTE) { response(res, 404, {}); return; }
      const bearer = /^Bearer ([A-Za-z0-9_-]{43,64})$/u.exec(req.headers.authorization ?? '')?.[1];
      if (!bearer) throw forbidden();
      const digest = tokenDigest(bearer);
      const input = await requestBody(req);
      const scope = await lookup(digest, input);
      const authorize = async () => { if (await lookup(digest, input) !== scope) throw forbidden(); };
      const store = directory(scope, authorize);
      let value = null;
      if (input.operation === 'create') {
        if (input.context.localTask) throw invalid();
        value = await store.create(input.context, input.id);
      }
      if (input.operation === 'update') value = await store.update(input.id, input.expected, input.context);
      if (input.operation === 'read') value = await store.read(input.id, input.expected);
      if (input.operation === 'forget') await store.forget(input.id, input.expected);
      await authorize();
      response(res, 200, { protocol: PROVIDER_PROTOCOL, provider: config.name, scope,
        ...(input.operation === 'describe' ? { capabilities: { portable: true, private: true, conditionalWrites: true,
          deletion: true, retentionMs: RETENTION_MS } } : { value }) });
    } catch (error) {
      const status = HTTP[error.code] ?? 500;
      if (!res.destroyed) response(res, status, { error: { code: status === 500 ? 'ASK_PROVIDER_UNAVAILABLE' : error.code,
        message: status === 500 ? 'The Ask provider could not finish the request.' : error.message,
        ...(error.code === 'ASK_CONVERSATION_CONFLICT' ? { details: error.details } : {}) } });
    }
  };
  const options = { requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 };
  let server;
  if (config.tls) {
    const key = await readPrivateText(fromConfig(config.tls.key), 65_536);
    const cert = await readFile(fromConfig(config.tls.cert), 'utf8');
    if (!key) throw failure('ASK_PROVIDER_TLS_REQUIRED', 'The provider TLS key is unavailable.');
    server = createSecureServer({ ...options, key, cert }, handler);
  } else server = createServer(options, handler);
  const done = new Promise(resolve => server.once('close', resolve));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port ?? 8787, host, resolve); });
  const sweep = async () => {
    const scopes = await readdir(path.join(base, 'v1')).catch(() => []);
    for (const scope of scopes.filter(value => /^[a-f0-9]{64}$/u.test(value))) await directory(scope).prune().catch(() => {});
  };
  const retention = setInterval(() => { void sweep(); }, 60 * 60 * 1000).unref();
  void sweep();
  return { name: config.name, port: server.address().port, tls: Boolean(config.tls), done,
    async close() { clearInterval(retention); server.close(); await done; } };
}
