/**
 * SF Guard's signer on macOS (SPEC-PSS-v1 IFC-003, REQ-012): the person's Secure Enclave identity,
 * through OpenSSH and Apple's security-key provider. No helper: SFlow drives /usr/bin/ssh-keygen and
 * /usr/lib/ssh-keychain.dylib by absolute path with a minimal environment.
 *
 * The Touch ID prompt is the system's and cannot name the action, so the card is printed to the
 * person's terminal by this process immediately before it starts the signing, with the statement it
 * rendered. A statement prepared anywhere else is never signed. Signing needs a terminal for the
 * card; it refuses without one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SK_PROVIDER, SSH_KEYGEN, systemToolEnvironment } from './local-keys.mjs';
import { keyFingerprint, PRESENCE_NAMESPACE, verifyPresenceSignature } from './sshsig.mjs';
import { statementText } from './statement.mjs';
import { SingularityFlowError } from '../util.mjs';

const RULE = 'Touch the sensor only for a command you started yourself, right after its card. A prompt you did not start is an agent asking: decline it.';

/** The card a person reads before their touch. */
export function presenceCard({ title, lines, keyId }) {
  return [
    '', `SF Guard: ${title}`, ...lines.map((line) => `  ${line}`), `  Signing key: ${keyId}`, `  ${RULE}`, ''
  ].join('\n');
}

function signerUnavailable(reason) {
  return new SingularityFlowError(`SF Guard cannot sign on this computer: ${reason}. Run this step on a Mac whose presence key is registered, or ask another approver.`,
    { code: 'PSS_SIGNER_UNAVAILABLE', details: { reason } });
}

/** Whether this computer can sign at all, before anything is shown. */
export function signerAvailability({ platform = process.platform } = {}) {
  if (platform !== 'darwin') return { available: false, reason: 'presence signing needs macOS' };
  for (const file of [SSH_KEYGEN, SK_PROVIDER]) if (!existsSync(file)) return { available: false, reason: `${file} is missing (macOS 26 or later is needed)` };
  return { available: true, reason: null };
}

/**
 * Key stubs for this Mac's Secure Enclave identities, in a private temporary directory: references,
 * with no secret material. Returns `{ directory, stubs: [{ keyId, publicKey, file }] }`.
 */
export async function presenceKeyStubs({ exec = spawnSync } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-sf-guard-'));
  const result = exec(SSH_KEYGEN, ['-w', SK_PROVIDER, '-K', '-N', ''], {
    cwd: directory, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: systemToolEnvironment({ SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: '/usr/bin/true' })
  });
  if (result.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw signerUnavailable(`ssh-keygen could not read this Mac's Secure Enclave identities: ${String(result.stderr ?? '').trim() || result.error?.message || `exit ${result.status}`}`);
  }
  const stubs = [];
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith('.pub'))) {
    const publicKey = (await readFile(path.join(directory, name), 'utf8')).trim().split(/\s+/u).slice(0, 2).join(' ');
    const encoded = publicKey.split(' ')[1];
    if (encoded) stubs.push({ keyId: keyFingerprint(Buffer.from(encoded, 'base64')), publicKey, file: path.join(directory, name.slice(0, -4)) });
  }
  return { directory, stubs };
}

/**
 * Show `card` on the person's terminal, then sign `statement` with the identity `keyId` (one Touch ID
 * prompt). Returns `{ signature, userVerification }` once the signature verifies against
 * `publicKey`. Declining the prompt throws PSS_PRESENCE_DECLINED and nothing is written.
 */
export async function signWithPresence({ statement, keyId, publicKey, card, terminal = process.stderr, exec = spawnSync }) {
  const availability = signerAvailability();
  if (!availability.available) throw signerUnavailable(availability.reason);
  if (!terminal?.isTTY) {
    throw new SingularityFlowError('SF Guard shows the card in your own terminal before your touch, and this has no terminal. Run the command in your own terminal.',
      { code: 'PSS_CARD_NOT_SHOWN' });
  }
  const { directory, stubs } = await presenceKeyStubs({ exec });
  try {
    const stub = stubs.find((entry) => entry.keyId === keyId);
    if (!stub) throw signerUnavailable(`this Mac's Secure Enclave does not hold ${keyId}`);
    const message = statementText(statement);
    terminal.write(card);
    const result = exec(SSH_KEYGEN, ['-Y', 'sign', '-f', stub.file, '-n', PRESENCE_NAMESPACE], {
      input: message, encoding: 'utf8', timeout: 120_000, stdio: ['pipe', 'pipe', 'inherit'],
      env: systemToolEnvironment({ SSH_SK_PROVIDER: SK_PROVIDER, SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: '/usr/bin/true' })
    });
    if (result.status !== 0 || !String(result.stdout ?? '').includes('BEGIN SSH SIGNATURE')) {
      throw new SingularityFlowError('Nothing was signed: the Touch ID prompt was declined or failed. Nothing was written.', { code: 'PSS_PRESENCE_DECLINED' });
    }
    const verified = verifyPresenceSignature({ message, armored: result.stdout, publicKey });
    if (!verified.valid) throw new SingularityFlowError(`The new signature does not verify (${verified.reason}). Nothing was written.`, { code: 'PSS_SIGNATURE_INVALID' });
    return { signature: result.stdout, userVerification: verified.userVerification };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
