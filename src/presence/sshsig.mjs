/**
 * Security-key SSHSIG signatures, verified with no dependency (SPEC-PSS-v1 IFC-002).
 *
 * A person step is signed by a Secure Enclave identity through Apple's security-key provider, so the
 * key is `sk-ecdsa-sha2-nistp256@openssh.com` and each signature carries the flags byte and counter
 * the token returned. Only that key type is accepted: an ordinary SSH key's private half can sit in a
 * file an agent reads, so no other type ever verifies here. User presence (UP) is required. User
 * verification (UV) is reported but never required: Apple's provider does not set it (M0, 1 November
 * 2026), and biometry is the identity's own access control on the person's Mac.
 *
 * The formats are OpenSSH's PROTOCOL.sshsig and PROTOCOL.u2f. Verification here and `ssh-keygen -Y
 * verify` agree on every test fixture (test/presence-sshsig.test.mjs).
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

export const SK_ECDSA_KEY_TYPE = 'sk-ecdsa-sha2-nistp256@openssh.com';
export const PRESENCE_NAMESPACE = 'singularity-flow-person-step@1';
const MAGIC = Buffer.from('SSHSIG');
const ARMOR_BEGIN = '-----BEGIN SSH SIGNATURE-----';
const ARMOR_END = '-----END SSH SIGNATURE-----';
const FLAG_USER_PRESENCE = 0x01;
const FLAG_USER_VERIFICATION = 0x04;
const MAX_ARMORED_BYTES = 16 * 1024;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

class Reader {
  constructor(bytes) { this.bytes = bytes; this.at = 0; }
  take(length) {
    if (!Number.isInteger(length) || length < 0 || this.at + length > this.bytes.length) throw new Error('truncated');
    const value = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return value;
  }
  u8() { return this.take(1)[0]; }
  u32() { return this.take(4).readUInt32BE(0); }
  string() { return this.take(this.u32()); }
  text() { return this.string().toString('utf8'); }
  done() { return this.at === this.bytes.length; }
}

const sshString = (value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
};

/** An OpenSSH fingerprint, `SHA256:` and unpadded base64 of the key blob. */
export function keyFingerprint(blob) {
  return `SHA256:${sha256(blob).toString('base64').replace(/=+$/u, '')}`;
}

/** The parts of one security-key ECDSA public key blob, or a reason it is not one. */
function parseSkEcdsaBlob(blob) {
  try {
    const reader = new Reader(blob);
    const type = reader.text();
    if (type !== SK_ECDSA_KEY_TYPE) return { error: `key type ${type} is not ${SK_ECDSA_KEY_TYPE}` };
    if (reader.text() !== 'nistp256') return { error: 'the key curve is not nistp256' };
    const point = reader.string();
    const application = reader.text();
    if (!reader.done()) return { error: 'the key blob has trailing bytes' };
    if (point.length !== 65 || point[0] !== 0x04) return { error: 'the key point is not an uncompressed P-256 point' };
    return { type, point, application };
  } catch { return { error: 'the key blob is truncated' }; }
}

/**
 * One OpenSSH public key line (`<type> <base64> [comment]`) read for presence use: its type, blob,
 * fingerprint and normalized line. Any type other than a security-key P-256 key is refused.
 */
export function parsePresencePublicKey(line) {
  const [type, encoded] = String(line ?? '').trim().split(/\s+/u);
  if (!type || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return { valid: false, reason: 'not an OpenSSH public key line' };
  const blob = Buffer.from(encoded, 'base64');
  const parsed = parseSkEcdsaBlob(blob);
  if (parsed.error) return { valid: false, reason: type === SK_ECDSA_KEY_TYPE ? parsed.error : `key type ${type} is not ${SK_ECDSA_KEY_TYPE}`, type };
  if (type !== parsed.type) return { valid: false, reason: 'the key line names a different type than its blob' };
  return { valid: true, type, blob, keyId: keyFingerprint(blob), line: `${type} ${blob.toString('base64')}`, application: parsed.application };
}

/** The bytes inside an armored `SSH SIGNATURE`, or null. */
function unarmor(armored) {
  const text = String(armored ?? '').replace(/\r\n?/gu, '\n').trim();
  if (text.length > MAX_ARMORED_BYTES || !text.startsWith(ARMOR_BEGIN) || !text.endsWith(ARMOR_END)) return null;
  const body = text.slice(ARMOR_BEGIN.length, text.length - ARMOR_END.length).replace(/\s+/gu, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) return null;
  return Buffer.from(body, 'base64');
}

/** An SSH mpint as exactly 32 bytes, or null when it does not fit a P-256 scalar. */
function scalar(mpint) {
  let value = mpint;
  while (value.length > 32 && value[0] === 0) value = value.subarray(1);
  if (value.length > 32 || (value.length && value[0] & 0x80 && mpint.length === value.length)) return null;
  return Buffer.concat([Buffer.alloc(32 - value.length), value]);
}

function publicKeyObject(point) {
  const base64url = (bytes) => bytes.toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  return createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: base64url(point.subarray(1, 33)), y: base64url(point.subarray(33, 65)) } });
}

/**
 * Whether `armored` is a valid presence signature of `message` (a string or bytes) by `publicKey`
 * (an OpenSSH line), under `namespace`. Returns `{ valid, reason, keyId, userPresence,
 * userVerification, counter }`; a refusal always says why.
 */
export function verifyPresenceSignature({ message, armored, publicKey, namespace = PRESENCE_NAMESPACE }) {
  const expected = parsePresencePublicKey(publicKey);
  if (!expected.valid) return { valid: false, reason: expected.reason };
  const refused = (reason) => ({ valid: false, reason, keyId: expected.keyId });
  const bytes = unarmor(armored);
  if (!bytes) return refused('the signature is not an armored SSH signature');
  let parts;
  try {
    const reader = new Reader(bytes);
    if (!reader.take(6).equals(MAGIC)) return refused('the signature is not SSHSIG');
    const version = reader.u32();
    if (version !== 1) return refused(`SSHSIG version ${version} is not supported`);
    parts = { key: reader.string(), namespace: reader.text(), reserved: reader.string(), hash: reader.text(), signature: reader.string() };
    if (!reader.done()) return refused('the signature has trailing bytes');
  } catch { return refused('the signature is truncated'); }
  if (!parts.key.equals(expected.blob)) return refused('the signature was made by a different key');
  if (parts.namespace !== namespace) return refused(`the signature namespace is ${parts.namespace}, not ${namespace}`);
  if (!['sha256', 'sha512'].includes(parts.hash)) return refused(`hash ${parts.hash} is not supported`);
  let signature;
  try {
    const reader = new Reader(parts.signature);
    const type = reader.text();
    if (type !== SK_ECDSA_KEY_TYPE) return refused(`signature type ${type} is not ${SK_ECDSA_KEY_TYPE}`);
    const inner = new Reader(reader.string());
    const r = scalar(inner.string());
    const s = scalar(inner.string());
    if (!inner.done() || !r || !s) return refused('the ECDSA signature is malformed');
    signature = { rs: Buffer.concat([r, s]), flags: reader.u8(), counter: reader.u32() };
    if (!reader.done()) return refused('the security-key signature has trailing bytes');
  } catch { return refused('the security-key signature is truncated'); }
  const digest = createHash(parts.hash).update(Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8')).digest();
  const signed = Buffer.concat([MAGIC, sshString(parts.namespace), sshString(parts.reserved), sshString(parts.hash), sshString(digest)]);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signature.counter, 0);
  const data = Buffer.concat([sha256(Buffer.from(expected.application, 'utf8')), Buffer.from([signature.flags]), counter, sha256(signed)]);
  let valid = false;
  try { valid = verifySignature('sha256', data, { key: publicKeyObject(parseSkEcdsaBlob(expected.blob).point), dsaEncoding: 'ieee-p1363' }, signature.rs); }
  catch { valid = false; }
  const flags = { userPresence: Boolean(signature.flags & FLAG_USER_PRESENCE), userVerification: Boolean(signature.flags & FLAG_USER_VERIFICATION), counter: signature.counter };
  if (!valid) return { ...refused('the signature does not match the statement'), ...flags };
  if (!flags.userPresence) return { ...refused('the signature carries no user presence: nobody touched the key'), ...flags };
  return { valid: true, reason: null, keyId: expected.keyId, ...flags };
}

export const presenceSignatureFormat = Object.freeze({ MAGIC, sshString, unarmor, ARMOR_BEGIN, ARMOR_END, FLAG_USER_PRESENCE, FLAG_USER_VERIFICATION });
