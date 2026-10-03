/**
 * HTTP to an address that configuration chose. Shared by the after-step outbox and the writers that
 * talk to Confluence and Microsoft Graph, so every such request gets the same rules.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPublicRemoteAddress } from './remote-fetch.mjs';

const MAX_RESPONSE_BYTES = 16 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** A short, secret-free description of a transport error. */
export function boundedDetail(text) {
  return String(text ?? '')
    .replace(/(authorization|token|secret|signature|api[-_]?key|password)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s"']+/g, (url) => { try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}/…`; } catch { return '[address]'; } })
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * One HTTP request to an address configuration chose: https only (plain http only to this machine),
 * the host resolved once and the connection pinned to that address, private addresses refused
 * unless the target is marked private, redirects never followed, the answer bounded. Returns the
 * answer, or `transport` with an attempt result when no answer came.
 */
export async function pinnedHttpRequest({
  url, method = 'POST', headers = {}, body = null, timeoutMs, network = 'public', lookupImpl = dnsLookup, maxResponseBytes = MAX_RESPONSE_BYTES
}) {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const loopback = LOOPBACK_HOSTS.has(host);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    return { transport: { outcome: 'failed', code: 'STEP_ACTION_ADDRESS_REFUSED', detail: 'Only https:// addresses, or http:// to this machine, are delivered to.' } };
  }
  let addresses;
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookupImpl(host, { all: true, verbatim: true });
  } catch (error) {
    return { transport: { outcome: 'retry', code: 'STEP_ACTION_DNS_FAILED', detail: boundedDetail(error?.message) } };
  }
  if (!addresses?.length) return { transport: { outcome: 'retry', code: 'STEP_ACTION_DNS_FAILED', detail: `${host} did not resolve.` } };
  if (network === 'public' && !loopback) {
    const blocked = addresses.find((entry) => !isPublicRemoteAddress(entry.address));
    if (blocked) {
      return { transport: { outcome: 'failed', code: 'STEP_ACTION_ADDRESS_REFUSED',
        detail: `${host} resolved to a private address. Mark the target network: private if it is an internal service.` } };
    }
  }
  const pinned = addresses[0];
  const bytes = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const requestImpl = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const request = requestImpl(parsed, {
      method,
      headers: { ...headers, ...(bytes ? { 'content-length': String(bytes.length) } : {}) },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      }
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => { if (size < maxResponseBytes) { chunks.push(chunk); size += chunk.length; } });
      response.on('error', (error) => finish({ transport: { outcome: 'retry', code: 'STEP_ACTION_NETWORK_FAILED', detail: boundedDetail(error?.message) } }));
      response.on('end', () => finish({ status: response.statusCode ?? 0, headers: response.headers ?? {}, text: Buffer.concat(chunks).subarray(0, maxResponseBytes).toString('utf8') }));
    });
    const timer = setTimeout(() => {
      request.destroy();
      finish({ transport: { outcome: 'retry', code: 'STEP_ACTION_TIMEOUT', detail: `No answer within ${Math.round(timeoutMs / 1000)} seconds.` } });
    }, timeoutMs);
    request.on('error', (error) => finish({ transport: { outcome: 'retry', code: 'STEP_ACTION_NETWORK_FAILED', detail: boundedDetail(error?.message) } }));
    request.end(bytes ?? undefined);
  });
}
