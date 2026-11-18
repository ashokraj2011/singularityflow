/** Native loopback channel: no bearer key on the wire, replay-bound messages and sealed inputs. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { UiError, insist, record } from './contracts.mjs';

export const nativeEqual = (a, b) => typeof a === 'string' && typeof b === 'string'
  && /^[a-f0-9]{64}$/u.test(a) && /^[a-f0-9]{64}$/u.test(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const nativeNonce = () => randomBytes(16).toString('hex');
const mac = (key, fields) => createHmac('sha256', key).update(JSON.stringify(fields)).digest('hex');
export const requestProof = (key, { instance, nonce, time, method, route, body }) => mac(key, ['sflow-native-request-v1', instance, nonce, time, method, route, body]);
export const responseProof = (key, { instance, nonce, status, body }) => mac(key, ['sflow-native-response-v1', instance, nonce, status, body]);
const encryptionKey = key => createHash('sha256').update('sflow-native-input-v1\0').update(key).digest();

export function sealInput(key, input, binding) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  cipher.setAAD(Buffer.from(binding));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(input), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64url'), data: bytes.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
export function openInput(key, input, binding) {
  record(input, ['iv', 'data', 'tag']);
  insist(typeof input.iv === 'string' && /^[A-Za-z0-9_-]{16}$/u.test(input.iv)
    && typeof input.tag === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(input.tag)
    && typeof input.data === 'string' && input.data.length <= 2 * 1024 * 1024,
  'UI_NATIVE_INPUT_INVALID', 'The native input envelope is invalid.', 401);
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), Buffer.from(input.iv, 'base64url'));
    decipher.setAAD(Buffer.from(binding)); decipher.setAuthTag(Buffer.from(input.tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(input.data, 'base64url')), decipher.final()]).toString('utf8'));
  } catch { throw new UiError('UI_NATIVE_INPUT_INVALID', 'The native input could not be authenticated.', null, 401); }
}
