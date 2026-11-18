/** Ephemeral local HTTPS certificate, generated with Node built-ins on each host. */
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

function der(tag, body) {
  let size = body.length, length;
  if (size < 128) length = Buffer.from([size]);
  else {
    const bytes = [];
    while (size) { bytes.unshift(size & 255); size >>>= 8; }
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...values) => der(0x30, Buffer.concat(values));
function integer(bytes) {
  let data = typeof bytes === 'number' ? Buffer.from([bytes]) : Buffer.from(bytes);
  while (data.length > 1 && data[0] === 0 && !(data[1] & 128)) data = data.subarray(1);
  if (data[0] & 128) data = Buffer.concat([Buffer.from([0]), data]);
  return der(2, data);
}
function oid(value) {
  const parts = value.split('.').map(Number), bytes = [40 * parts[0] + parts[1]];
  for (const number of parts.slice(2)) {
    let current = number, encoded = [current & 127];
    while ((current = Math.floor(current / 128))) encoded.unshift(128 | (current & 127));
    bytes.push(...encoded);
  }
  return der(6, Buffer.from(bytes));
}
function pem(label, bytes) {
  return '-----BEGIN ' + label + '-----\n' + bytes.toString('base64').match(/.{1,64}/gu).join('\n') + '\n-----END ' + label + '-----\n';
}
function utc(date) {
  const digits = date.toISOString().replace(/[-:T]/gu, '').slice(2, 14);
  return der(0x17, Buffer.from(digits + 'Z'));
}
function extension(name, value, critical = false) {
  return sequence(oid(name), ...(critical ? [der(1, Buffer.from([255]))] : []), der(4, value));
}
export function localCertificate() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = sequence(oid('1.2.840.113549.1.1.11'), der(5, Buffer.alloc(0)));
  const subject = sequence(der(0x31, sequence(oid('2.5.4.3'), der(0x0c, Buffer.from('localhost')))));
  const serial = randomBytes(16); serial[0] &= 0x7f; serial[0] |= 1;
  const extensions = sequence(
    extension('2.5.29.19', sequence(der(1, Buffer.from([255]))), true),
    extension('2.5.29.15', der(3, Buffer.from([2, 0xa4])), true),
    extension('2.5.29.37', sequence(oid('1.3.6.1.5.5.7.3.1'))),
    extension('2.5.29.17', sequence(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1]))))
  );
  const now = Date.now();
  const body = sequence(
    der(0xa0, integer(2)), integer(serial), algorithm, subject,
    sequence(utc(new Date(now - 60000)), utc(new Date(now + 86400000))),
    subject, publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, extensions)
  );
  const certificate = sequence(body, algorithm, der(3, Buffer.concat([Buffer.from([0]), sign('RSA-SHA256', body, privateKey)])));
  const cert = pem('CERTIFICATE', certificate);
  if (!new X509Certificate(cert).verify(publicKey)) throw new Error('Local test certificate signature did not verify.');
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
