/**
 * What this Mac says about a presence key (SPEC-PSS-v1 REQ-025): whether it is a non-exportable,
 * Touch ID protected Secure Enclave identity, and whether a copy an agent could use sits in a
 * readable file or in ssh-agent. Every program runs by absolute path, never through PATH.
 *
 * `sc_auth list-ctk-identities -t ssh` prints, per identity: key type, public key hash (the SSH
 * fingerprint), protection, label, common name, email address, "Valid To" and "Valid". The last two
 * are the identity's certificate: `sc_auth` gives it one year (M1 finding, macOS 26.7), so an identity
 * whose Valid column says NO is expired and is refused (PSS_KEY_EXPIRED) until it is rotated.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { keyFingerprint } from './sshsig.mjs';

export const SC_AUTH = '/usr/sbin/sc_auth';
export const SSH_KEYGEN = '/usr/bin/ssh-keygen';
export const SSH_ADD = '/usr/bin/ssh-add';
export const SSH = '/usr/bin/ssh';
export const SK_PROVIDER = '/usr/lib/ssh-keychain.dylib';
const MAX_KEY_FILE = 64 * 1024;
const OPENSSH_MAGIC = Buffer.from('openssh-key-v1\0');

/** A minimal environment for the system tools: nothing an agent set reaches them. */
export function systemToolEnvironment(extra = {}) {
  return { HOME: os.homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', ...extra };
}

function run(program, args, { input } = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', input, env: systemToolEnvironment(), timeout: 15_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ?? null };
}

/** The rows of `sc_auth list-ctk-identities -t ssh`. */
export function parseCtkListing(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens.length < 4 || tokens[0] === 'Key' || !/^p-\d{3}/u.test(tokens[0])) continue;
    const valid = /^(YES|NO)$/u.test(tokens.at(-1)) ? tokens.at(-1) === 'YES' : null;
    const validTo = line.match(/(\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)/u)?.[1] ?? null;
    rows.push({ keyType: tokens[0], keyId: tokens[1], protection: tokens[2], label: tokens[3], validTo, valid });
  }
  return rows;
}

/** This Mac's CTK identities, or why they could not be read. */
export function ctkIdentities({ platform = process.platform, exec = run } = {}) {
  if (platform !== 'darwin' || !existsSync(SC_AUTH)) return { available: false, reason: 'this computer has no macOS sc_auth', identities: [] };
  const result = exec(SC_AUTH, ['list-ctk-identities', '-t', 'ssh']);
  if (result.status !== 0) return { available: false, reason: `sc_auth list-ctk-identities failed: ${(result.stderr || result.stdout).trim() || result.error?.message}`, identities: [] };
  return { available: true, reason: null, identities: parseCtkListing(result.stdout) };
}

/** Whether `keyId` is a Secure Enclave, Touch ID protected, unexpired identity in `listing`. */
export function presenceIdentityStanding(listing, keyId) {
  if (!listing.available) return { ok: false, code: 'PSS_SIGNER_UNAVAILABLE', reason: listing.reason };
  const row = listing.identities.find((entry) => entry.keyId === keyId);
  if (!row) return { ok: false, code: 'PSS_KEY_NOT_PRESENCE', reason: `${keyId} is not a CTK identity on this Mac` };
  if (row.keyType !== 'p-256-ne') return { ok: false, code: 'PSS_KEY_NOT_PRESENCE', reason: `${keyId} is a ${row.keyType} identity, not a non-exportable p-256-ne one` };
  if (row.protection !== 'bio') return { ok: false, code: 'PSS_KEY_NOT_PRESENCE', reason: `${keyId} is protected by '${row.protection}', not Touch ID (bio)` };
  if (row.valid === false) return { ok: false, code: 'PSS_KEY_EXPIRED', reason: `${keyId}'s identity expired${row.validTo ? ` on ${row.validTo}` : ''}`, row };
  return { ok: true, code: null, reason: null, row };
}

/** The public key lines an OpenSSH private key file names in its unencrypted header. */
function opensshPrivatePublicKeys(bytes) {
  const text = bytes.toString('utf8');
  const body = text.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/u)?.[1];
  if (!body) return null;
  const raw = Buffer.from(body.replace(/\s+/gu, ''), 'base64');
  if (!raw.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) return null;
  let at = OPENSSH_MAGIC.length;
  const take = () => {
    const length = raw.readUInt32BE(at);
    const value = raw.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    return value;
  };
  try {
    take(); take(); take();
    const count = raw.readUInt32BE(at); at += 4;
    const blobs = [];
    for (let index = 0; index < count && index < 16; index += 1) blobs.push(take());
    return blobs;
  } catch { return null; }
}

/** Key type of an SSH public key blob. */
function blobType(blob) {
  try { return blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('utf8'); } catch { return null; }
}

/** Every private key file under ~/.ssh and at the IdentityFile paths `ssh -G` names. */
export function candidateKeyFiles({ home = os.homedir(), exec = run, hosts = [['github', 'com'].join('.'), 'localhost'] } = {}) {
  const files = new Set();
  const sshDirectory = path.join(home, '.ssh');
  try {
    for (const name of readdirSync(sshDirectory)) {
      if (name.endsWith('.pub') || name === 'known_hosts' || name === 'config' || name === 'authorized_keys') continue;
      files.add(path.join(sshDirectory, name));
    }
  } catch { /* no ~/.ssh */ }
  if (existsSync(SSH)) {
    for (const host of hosts) {
      const result = exec(SSH, ['-G', host]);
      for (const line of result.status === 0 ? result.stdout.split('\n') : []) {
        const match = line.match(/^identityfile\s+(.+)$/iu);
        if (match) files.add(match[1].trim().replace(/^~(?=\/|$)/u, home));
      }
    }
  }
  return [...files];
}

/**
 * Where a usable copy of `keyId` sits, if anywhere: a private key file whose header names it, or a
 * plain (non security-key) ssh-agent identity. A security-key handle is not a copy: it signs only
 * with the token's touch, so it is never counted as readable.
 */
export function readableCopies(keyId, { files = candidateKeyFiles(), exec = run, readFile = (file) => readFileSync(file) } = {}) {
  const found = [];
  for (const file of files) {
    let bytes;
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size > MAX_KEY_FILE) continue;
      bytes = readFile(file);
    } catch { continue; }
    let blobs = opensshPrivatePublicKeys(bytes);
    if (!blobs && /PRIVATE KEY-----/u.test(bytes.toString('utf8'))) {
      // A PEM private key: its public half from the .pub beside it, or ssh-keygen with an empty passphrase.
      const pub = `${file}.pub`;
      const line = existsSync(pub) ? readFileSync(pub, 'utf8') : (exec(SSH_KEYGEN, ['-y', '-P', '', '-f', file]).stdout ?? '');
      const encoded = String(line).trim().split(/\s+/u)[1];
      blobs = encoded ? [Buffer.from(encoded, 'base64')] : [];
    }
    for (const blob of blobs ?? []) {
      if (keyFingerprint(blob) === keyId && !String(blobType(blob)).startsWith('sk-')) found.push({ where: 'file', path: file });
    }
  }
  const agent = existsSync(SSH_ADD) ? exec(SSH_ADD, ['-L']) : { status: 1, stdout: '' };
  for (const line of agent.status === 0 ? agent.stdout.split('\n') : []) {
    const [type, encoded] = line.trim().split(/\s+/u);
    if (!encoded || type.startsWith('sk-')) continue;
    if (keyFingerprint(Buffer.from(encoded, 'base64')) === keyId) found.push({ where: 'ssh-agent', path: null });
  }
  return found;
}
