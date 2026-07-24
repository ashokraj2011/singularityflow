import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeSharePoint,
  createSharePointAuthorization,
  sharePointAccessToken
} from '../apps/desktop/electron/sharepoint-oauth.mjs';

const provider = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: '22222222-2222-2222-2222-222222222222',
  siteId: 'site',
  driveId: 'drive',
  scopes: ['offline_access', 'User.Read', 'Sites.ReadWrite.All']
};

function tokenResponse(payload) {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(text)) : null },
    text: async () => text
  };
}

test('SharePoint authorization uses a system-browser PKCE request without a client secret', () => {
  const authorization = createSharePointAuthorization(provider, 'http://127.0.0.1:4567/oauth/callback', {
    state: 'fixed-state',
    verifier: 'fixed-verifier-with-enough-random-looking-characters'
  });
  const url = new URL(authorization.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'login.microsoftonline.com');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'fixed-state');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.match(url.searchParams.get('scope'), /offline_access/);
});

test('SharePoint browser callback exchanges the code and returns refreshable delegated credentials', async () => {
  let tokenBody = null;
  const credential = await authorizeSharePoint(provider, {
    openExternal: async (authorizationUrl) => {
      const url = new URL(authorizationUrl);
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', url.searchParams.get('state'));
      callback.searchParams.set('code', 'authorization-code');
      setTimeout(() => fetch(callback), 5);
    },
    fetchImpl: async (_url, options) => {
      tokenBody = new URLSearchParams(options.body);
      return tokenResponse({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'offline_access User.Read Sites.ReadWrite.All'
      });
    },
    timeoutMs: 5_000
  });
  assert.equal(tokenBody.get('grant_type'), 'authorization_code');
  assert.equal(tokenBody.has('client_secret'), false);
  assert.ok(tokenBody.get('code_verifier'));
  assert.equal(credential.token, 'access-token');
  assert.equal(credential.refreshToken, 'refresh-token');
  assert.equal(credential.authMode, 'oauth-pkce');
});

test('expired SharePoint credentials refresh through the public client and are saved atomically', async () => {
  const saved = [];
  const store = {
    load: async () => ({
      token: 'expired',
      refreshToken: 'refresh-token',
      expiresAt: '2000-01-01T00:00:00.000Z',
      authMode: 'oauth-pkce'
    }),
    saveOAuth: async (providerId, credential) => saved.push({ providerId, credential })
  };
  const token = await sharePointAccessToken('sharepoint', provider, store, {
    fetchImpl: async (_url, options) => {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.has('client_secret'), false);
      return tokenResponse({ access_token: 'refreshed', token_type: 'Bearer', expires_in: 3600 });
    }
  });
  assert.equal(token, 'refreshed');
  assert.equal(saved[0].providerId, 'sharepoint');
  assert.equal(saved[0].credential.refreshToken, 'refresh-token');
});
