import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const DEFAULT_SCOPES = ['offline_access', 'User.Read', 'Files.ReadWrite.All'];
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024;

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function providerValue(provider, key) {
  const value = String(provider?.[key] ?? '').trim();
  if (!value) throw new Error(`SharePoint OAuth requires ${key} in singularity/portfolio.yml.`);
  return value;
}

function scopes(provider) {
  const values = provider?.scopes?.length ? provider.scopes : DEFAULT_SCOPES;
  const normalized = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (!normalized.length || normalized.some((value) => /\s/.test(value))) throw new Error('SharePoint OAuth scopes must be non-empty values without whitespace.');
  if (!normalized.includes('offline_access')) normalized.unshift('offline_access');
  return normalized;
}

function endpoint(provider, action) {
  return `https://login.microsoftonline.com/${encodeURIComponent(providerValue(provider, 'tenantId'))}/oauth2/v2.0/${action}`;
}

export function createSharePointAuthorization(provider, redirectUri, {
  state = base64Url(randomBytes(24)),
  verifier = base64Url(randomBytes(48))
} = {}) {
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const url = new URL(endpoint(provider, 'authorize'));
  url.search = new URLSearchParams({
    client_id: providerValue(provider, 'clientId'),
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: scopes(provider).join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  }).toString();
  return { url: url.toString(), state, verifier, redirectUri, scopes: scopes(provider) };
}

async function tokenRequest(provider, fields, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint(provider, 'token'), {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields)
    });
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TOKEN_RESPONSE_BYTES) throw new Error('Microsoft token response exceeded the safe size limit.');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_TOKEN_RESPONSE_BYTES) throw new Error('Microsoft token response exceeded the safe size limit.');
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('Microsoft token endpoint returned invalid JSON.'); }
    if (!response.ok || !payload.access_token) {
      throw new Error(`Microsoft sign-in failed (${response.status}): ${payload.error_description ?? payload.error ?? 'token unavailable'}`);
    }
    const expiresIn = Number(payload.expires_in);
    return {
      token: String(payload.access_token),
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
      tokenType: String(payload.token_type ?? 'Bearer'),
      scope: String(payload.scope ?? scopes(provider).join(' ')),
      expiresAt: Number.isFinite(expiresIn) ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      authMode: 'oauth-pkce'
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Microsoft sign-in timed out after ${timeoutMs} milliseconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function stateMatches(expected, actual) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(actual));
  return left.length === right.length && timingSafeEqual(left, right);
}

function callbackCode(server, expectedState, timeoutMs) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      action(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`Microsoft sign-in did not complete within ${timeoutMs} milliseconds.`));
    }, timeoutMs);
    cancel = (error = new Error('Microsoft sign-in was cancelled.')) => finish(reject, error);
    server.on('request', (request, response) => {
      const target = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (target.pathname !== '/oauth/callback') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      const state = target.searchParams.get('state');
      const code = target.searchParams.get('code');
      const oauthError = target.searchParams.get('error_description') ?? target.searchParams.get('error');
      if (!stateMatches(expectedState, state)) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Singularity Flow rejected an invalid OAuth state.');
        finish(reject, new Error('Microsoft sign-in returned an invalid OAuth state.'));
        return;
      }
      if (!code || oauthError) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Microsoft sign-in was not completed. Return to Singularity Flow.');
        finish(reject, new Error(`Microsoft sign-in was not completed: ${oauthError ?? 'authorization code missing'}`));
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
      });
      response.end('<!doctype html><title>Singularity Flow</title><style>body{font:16px system-ui;padding:48px;color:#173d29}</style><h1>SharePoint connected</h1><p>You can close this window and return to Singularity Flow.</p>');
      finish(resolve, code);
    });
  });
  return { promise, cancel };
}

export async function authorizeSharePoint(provider, {
  openExternal,
  fetchImpl = globalThis.fetch,
  timeoutMs = 180_000
} = {}) {
  if (typeof openExternal !== 'function') throw new Error('SharePoint OAuth requires a system-browser launcher.');
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  const authorization = createSharePointAuthorization(provider, redirectUri);
  const callback = callbackCode(server, authorization.state, timeoutMs);
  try {
    await openExternal(authorization.url);
    const code = await callback.promise;
    return tokenRequest(provider, {
      client_id: providerValue(provider, 'clientId'),
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: authorization.verifier,
      scope: authorization.scopes.join(' ')
    }, { fetchImpl, timeoutMs: Math.min(timeoutMs, 120_000) });
  } catch (error) {
    callback.cancel(error);
    await callback.promise.catch(() => {});
    throw error;
  }
}

export async function refreshSharePointCredential(provider, credential, options = {}) {
  if (!credential?.refreshToken) throw new Error('Microsoft session has no refresh token. Sign in to SharePoint again.');
  const refreshed = await tokenRequest(provider, {
    client_id: providerValue(provider, 'clientId'),
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    scope: scopes(provider).join(' ')
  }, options);
  return {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? credential.refreshToken
  };
}

export async function sharePointAccessToken(providerId, provider, store, options = {}) {
  const credential = await store.load(providerId);
  const expiresAt = Date.parse(credential.expiresAt ?? '');
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now() + 60_000) return credential.token;
  const refreshed = await refreshSharePointCredential(provider, credential, options);
  await store.saveOAuth(providerId, refreshed);
  return refreshed.token;
}
