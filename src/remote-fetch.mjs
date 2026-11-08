import { NODE_NETWORK_ADDRESS_SYNTAX } from './engine-compatibility/node-network-syntax.mjs';
import { createMarketplacePolicyCompiler } from './kernel/configuration-policy.mjs';
const remoteContentPolicy = /* @__PURE__ */ createMarketplacePolicyCompiler(NODE_NETWORK_ADDRESS_SYNTAX);
export const isPublicRemoteAddress = /* @__PURE__ */ (() => remoteContentPolicy.isPublicRemoteAddress)();
export const validatePublicHttpsUrl = /* @__PURE__ */ (() => remoteContentPolicy.validatePublicHttpsUrl)();
/**
 * The one hardened HTTPS reader for content a repository chooses to take from the Internet: agent
 * Markdown dependencies, imported skills, templates and agents, and marketplace indexes.
 *
 * Every request is a public HTTPS URL without credentials; every host's DNS answers are checked
 * against private and special ranges and the request is pinned to a checked address, so a second
 * lookup cannot rebind it; redirects are followed by hand, at most three, each re-validated; bodies
 * are bounded while streaming. Callers receive the exact bytes and their SHA-256: anything that is
 * pinned by hash must be written with those bytes, never with a re-encoded string.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { isIP } from 'node:net';
import { SingularityFlowError } from './util.mjs';
import { measurePerformance } from './dx-timing-context.mjs';

export const DEFAULT_REMOTE_MAX_BYTES = 1024 * 1024;
export const HARD_REMOTE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/**
 * Tests and offline demonstrations point this at a directory; `https://host/a/b.md` is then read
 * from `<dir>/host/a/b.md` after the same URL validation. It is never set in normal use.
 */
export const REMOTE_FIXTURES_ENV = 'SINGULARITY_FLOW_TEST_REMOTE_FIXTURES';

export function sha256Hex(value) { return createHash('sha256').update(value).digest('hex'); }

export async function resolvePublicRemoteHost(url, { lookupImpl = dnsLookup } = {}) {
  const parsed = new URL(url);
  const literal = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(literal);
  const addresses = literalFamily
    ? [{ address: literal, family: literalFamily }]
    : await lookupImpl(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new SingularityFlowError(`Remote host '${parsed.hostname}' did not resolve to an address.`);
  const blocked = addresses.find((entry) => !isPublicRemoteAddress(entry.address));
  if (blocked) {
    throw new SingularityFlowError(
      `Remote host '${parsed.hostname}' resolved to non-public address ${blocked.address}; request blocked.`
    );
  }
  // Every returned address is checked, not merely the selected one. Pinning one
  // validated result below prevents a second DNS lookup from rebinding the host.
  return addresses[0];
}

function pinnedHttpsFetch(url, { signal, headers }, resolved, maxBytes) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'GET',
      headers,
      signal,
      lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family)
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new SingularityFlowError(`Remote content ${url} exceeds its ${maxBytes} byte limit.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          status: response.statusCode ?? 0,
          headers: { get: (name) => response.headers[String(name).toLowerCase()] ?? null },
          arrayBuffer: async () => bytes
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function resolveRemoteHostWithTimeout(url, lookupImpl, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      resolvePublicRemoteHost(url, { lookupImpl }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new SingularityFlowError(`DNS lookup for ${url} timed out.`)), timeoutMs);
      })
    ]);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`Unable to resolve the remote host for ${url}: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** The offline fixture response for `url`, or null when fixtures are not in use. */
async function fixtureResponse(url) {
  const directory = process.env[REMOTE_FIXTURES_ENV];
  if (!directory) return null;
  const parsed = new URL(url);
  const segments = [parsed.hostname, ...decodeURIComponent(parsed.pathname).split('/').filter(Boolean)];
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.includes('\\'))) {
    return { ok: false, status: 400, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
  }
  const file = path.join(path.resolve(directory), ...segments);
  try {
    const bytes = await readFile(file);
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes };
  } catch {
    return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
  }
}

/**
 * Fetch exact bytes from a public HTTPS URL. Returns `{ bytes, size, sha256, url, resolvedUrl }`.
 * `label` names the thing being read in every refusal.
 */
export async function fetchRemoteBytes(url, options = {}) {
  return measurePerformance('network', 'http.download', () => fetchRemoteBytesImpl(url, options));
}

async function fetchRemoteBytesImpl(url, {
  maxBytes = DEFAULT_REMOTE_MAX_BYTES,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  lookupImpl = fetchImpl === globalThis.fetch ? dnsLookup : null,
  accept = '*/*',
  label = 'Remote content',
  noun = 'content'
} = {}) {
  if (typeof fetchImpl !== 'function') throw new SingularityFlowError('This Node runtime does not provide HTTPS fetch support.');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_REMOTE_MAX_BYTES) {
    throw new SingularityFlowError(`${label} byte limit must be between 1 and ${HARD_REMOTE_MAX_BYTES}.`);
  }
  let current = validatePublicHttpsUrl(url, `${label} URL`);
  const useFixtures = fetchImpl === globalThis.fetch && Boolean(process.env[REMOTE_FIXTURES_ENV]);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response;
    if (useFixtures) response = await fixtureResponse(current);
    else {
      const resolved = lookupImpl ? await resolveRemoteHostWithTimeout(current, lookupImpl, timeoutMs) : null;
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const requestOptions = { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { accept } };
        response = resolved && fetchImpl === globalThis.fetch
          ? await pinnedHttpsFetch(current, requestOptions, resolved, maxBytes)
          : await fetchImpl(current, requestOptions);
      }
      catch (error) { throw new SingularityFlowError(`Unable to fetch ${current}: ${error.name === 'AbortError' ? 'request timed out' : error.message}`); }
      finally { clearTimeout(timeout); }
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === MAX_REDIRECTS) throw new SingularityFlowError(`${label} URL exceeded ${MAX_REDIRECTS} redirects: ${url}`);
      const rawLocation = response.headers.get('location');
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (!location) throw new SingularityFlowError(`${label} redirect has no location: ${current}`);
      current = validatePublicHttpsUrl(new URL(location, current).toString(), `${label} redirect`);
      continue;
    }
    if (!response.ok) throw new SingularityFlowError(`${label} ${current} returned HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new SingularityFlowError(`${label} ${current} returned empty ${noun}.`);
    if (bytes.length > maxBytes) throw new SingularityFlowError(`${label} ${current} exceeds its ${maxBytes} byte limit.`);
    return { bytes, size: bytes.length, sha256: sha256Hex(bytes), url, resolvedUrl: current };
  }
  throw new SingularityFlowError(`Unable to fetch ${url}.`);
}

/** Strict UTF-8 text of exact bytes; a byte-order mark is kept in the bytes and dropped from the text. */
export function decodeUtf8(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new SingularityFlowError(`${label} is not valid UTF-8 text.`); }
}

/**
 * Fetch Markdown: the exact bytes plus their strict UTF-8 text. Returns
 * `{ content, bytes, size, sha256, url, resolvedUrl }`; hash and bytes describe the same thing.
 */
export async function fetchRemoteMarkdown(url, options = {}) {
  const fetched = await fetchRemoteBytes(url, {
    ...options, accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.1', label: options.label ?? 'Remote Markdown', noun: 'Markdown'
  });
  return { ...fetched, content: decodeUtf8(fetched.bytes, `Remote Markdown ${fetched.resolvedUrl}`) };
}
