// Software stand-ins for a Secure Enclave presence key, for tests only. They produce real
// sk-ecdsa-sha2-nistp256@openssh.com SSHSIG signatures (PROTOCOL.u2f), which is exactly what Apple's
// security-key provider returns, so the verifier is exercised on the true format. Production never
// signs this way: src/presence/signer.mjs only drives /usr/bin/ssh-keygen with the Secure Enclave.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { keyFingerprint, presenceSignatureFormat, PRESENCE_NAMESPACE, SK_ECDSA_KEY_TYPE } from '../../src/presence/sshsig.mjs';

const { MAGIC, sshString, ARMOR_BEGIN, ARMOR_END } = presenceSignatureFormat;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

function mpint(bytes) {
  let value = bytes;
  while (value.length > 1 && value[0] === 0) value = value.subarray(1);
  return sshString(value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

/** A security-key P-256 key: its OpenSSH public line, fingerprint, and a signer with chosen flags. */
export function softwarePresenceKey({ application = 'ssh:', comment = 'test-presence-key' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const blob = Buffer.concat([sshString(SK_ECDSA_KEY_TYPE), sshString('nistp256'), sshString(point), sshString(application)]);
  const line = `${SK_ECDSA_KEY_TYPE} ${blob.toString('base64')}`;
  let counter = 0;
  const signer = (message, { namespace = PRESENCE_NAMESPACE, flags = 0x01, hash = 'sha512' } = {}) => {
    const digest = createHash(hash).update(Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8')).digest();
    const signed = Buffer.concat([MAGIC, sshString(namespace), sshString(''), sshString(hash), sshString(digest)]);
    counter += 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter, 0);
    const data = Buffer.concat([sha256(Buffer.from(application, 'utf8')), Buffer.from([flags]), count, sha256(signed)]);
    const rs = sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const ecdsa = Buffer.concat([mpint(rs.subarray(0, 32)), mpint(rs.subarray(32))]);
    const signature = Buffer.concat([sshString(SK_ECDSA_KEY_TYPE), sshString(ecdsa), Buffer.from([flags]), count]);
    const body = Buffer.concat([MAGIC, Buffer.from([0, 0, 0, 1]), sshString(blob), sshString(namespace), sshString(''), sshString(hash), sshString(signature)])
      .toString('base64').match(/.{1,70}/gu).join('\n');
    return `${ARMOR_BEGIN}\n${body}\n${ARMOR_END}\n`;
  };
  return { line, comment, keyId: keyFingerprint(blob), sign: signer };
}

/** The `sc_auth list-ctk-identities -t ssh` listing a Mac would print for these identities. */
export function ctkListing(identities) {
  const header = 'Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid ';
  const rows = identities.map(({ keyType = 'p-256-ne', keyId, protection = 'bio', label = 'sflow-presence', validTo = '11/1/27, 9:42 PM', valid = 'YES' }) =>
    `${keyType} ${keyId} ${protection}  ${label} ${label}               ${validTo} ${valid}   `);
  return [header, ...rows].join('\n');
}
