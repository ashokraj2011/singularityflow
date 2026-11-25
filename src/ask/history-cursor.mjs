import { createHash, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { localFingerprint } from '../repositories/store.mjs';
import { SingularityFlowError } from '../util.mjs';

const PREFIX = 'askp1.';
const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_ENCODED_LENGTH = 3600;

const invalid = () => new SingularityFlowError(
  'This continuation expired or belongs to another checkout or audience. Start the search again.',
  { code: 'ASK_CONTINUATION_INVALID' }
);

async function checkoutScope(root, context, audience) {
  const actor = context.actor ?? {};
  const directory = await realpath(root);
  const { dev, ino } = await stat(directory);
  return createHash('sha256').update(JSON.stringify([
    directory, dev, ino, context.workspace?.id ?? null, context.repositoryId ?? null,
    actor.id ?? null, actor.email ?? null, actor.login ?? null, audience
  ])).digest('hex');
}

async function signature(encoded) {
  const signed = await localFingerprint('ask-history-cursor-v1', encoded);
  return signed.slice('local-hmac:'.length);
}

export async function issueHistoryCursor({ root, context, audience, intent, window, next }) {
  const encoded = Buffer.from(JSON.stringify({
    scope: await checkoutScope(root, context, audience), expires: Date.now() + MAX_AGE_MS, intent, window, next
  })).toString('base64url');
  if (encoded.length > MAX_ENCODED_LENGTH) throw invalid();
  return PREFIX + encoded + '.' + await signature(encoded);
}

export async function readHistoryCursor(token, { root, context, audience }) {
  const found = /^askp1\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/u.exec(token);
  if (found?.[1].length > MAX_ENCODED_LENGTH) throw invalid();
  if (!found || !root) throw invalid();
  const [, encoded, received] = found;
  const expected = await signature(encoded);
  if (!timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'))) throw invalid();
  try {
    const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (request.expires >= Date.now() && request.scope === await checkoutScope(root, context, audience)) return request;
  } catch { /* Malformed or no longer locally accessible. */ }
  throw invalid();
}
