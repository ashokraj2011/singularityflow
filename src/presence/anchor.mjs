/**
 * SF Guard's trust anchor (SPEC-PSS-v1 REQ-021): a presence key is pinned only while the approver's
 * GitHub account lists it as an SSH signing key. Adding one needs the person's browser sign-in, which
 * an agent on this computer does not have.
 *
 * GitHub is read only when a key is registered, rotated or recovered, and by the remote check; never
 * when a signature is verified, so an unreachable GitHub never blocks a person's step. The read uses
 * Node's bundled root certificates and no environment proxy, so neither NODE_EXTRA_CA_CERTS nor
 * HTTPS_PROXY can put a forged listing in front of it. Unreachable is reported as unavailable, never as
 * listed.
 */
import { createHash } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';

import { parsePresencePublicKey } from './sshsig.mjs';
import { keyFingerprint } from './sshsig.mjs';

const PUBLIC_GITHUB_HOST = ['github', 'com'].join('.');
const GITHUB_API_HOST = `api.${PUBLIC_GITHUB_HOST}`;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
/** Where a person adds an SSH signing key to their account. */
export const GITHUB_SIGNING_KEY_PAGE = `https://${PUBLIC_GITHUB_HOST}/settings/ssh/new`;
/** Where a person removes a key from their account. */
export const GITHUB_KEYS_PAGE = `https://${PUBLIC_GITHUB_HOST}/settings/keys`;
const MAX_BODY = 1024 * 1024;

/** GET one JSON document from GitHub's REST API: `{ status, body }`, or throws on a transport failure. */
export function githubApiJson(pathname, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: GITHUB_API_HOST, servername: GITHUB_API_HOST, port: 443, method: 'GET', path: pathname,
      ca: tls.rootCertificates, agent: false, timeout: timeoutMs,
      headers: { 'User-Agent': 'singularity-flow-sf-guard', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) { request.destroy(new Error('GitHub answered with more than 1 MiB')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`GitHub did not answer within ${timeoutMs / 1000} s`)));
    request.on('error', reject);
    request.end();
  });
}

/** Every key's normalized line and fingerprint, whatever its type. */
function listedKey(entry) {
  const [type, encoded] = String(entry?.key ?? '').trim().split(/\s+/u);
  if (!type || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  const blob = Buffer.from(encoded, 'base64');
  return { line: `${type} ${blob.toString('base64')}`, keyId: keyFingerprint(blob), type, presence: parsePresencePublicKey(`${type} ${encoded}`).valid };
}

/**
 * The SSH signing keys GitHub lists for `login`: `{ status: 'listed'|'not-found'|'unavailable',
 * keys, snapshotSha256, fetchedAt, reason }`. `request` is the transport; tests pass their own.
 */
export async function githubSigningKeys(login, { request = githubApiJson, now = () => new Date() } = {}) {
  const fetchedAt = now().toISOString();
  if (!GITHUB_LOGIN.test(String(login ?? ''))) return { status: 'not-found', keys: [], snapshotSha256: null, fetchedAt, reason: 'the approver has no valid GitHub login in the approved configuration' };
  let answer;
  try { answer = await request(`/users/${encodeURIComponent(login)}/ssh_signing_keys?per_page=100`); }
  catch (error) { return { status: 'unavailable', keys: [], snapshotSha256: null, fetchedAt, reason: `GitHub could not be reached: ${error.message}` }; }
  if (answer.status === 404) return { status: 'not-found', keys: [], snapshotSha256: null, fetchedAt, reason: 'GitHub has no such account' };
  if (answer.status !== 200) return { status: 'unavailable', keys: [], snapshotSha256: null, fetchedAt, reason: `GitHub answered ${answer.status}` };
  let body;
  try { body = JSON.parse(answer.body); } catch { return { status: 'unavailable', keys: [], snapshotSha256: null, fetchedAt, reason: 'GitHub answered with something that is not JSON' }; }
  if (!Array.isArray(body)) return { status: 'unavailable', keys: [], snapshotSha256: null, fetchedAt, reason: 'GitHub answered with something that is not a key list' };
  const keys = body.map(listedKey).filter(Boolean).sort((left, right) => left.keyId.localeCompare(right.keyId));
  const snapshotSha256 = `sha256:${createHash('sha256').update(JSON.stringify(keys.map((key) => key.line))).digest('hex')}`;
  return { status: 'listed', keys, snapshotSha256, fetchedAt, reason: null };
}

/** Whether `keyId` is among the listed keys; never true for an unavailable read. */
export function githubListsKey(snapshot, keyId) {
  return snapshot?.status === 'listed' && snapshot.keys.some((key) => key.keyId === keyId);
}
