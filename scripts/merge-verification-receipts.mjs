#!/usr/bin/env node
/** Merge reviewed single-host release receipts into one signed platform-matrix authority. */
import { mkdir } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mergeSignedVerificationReceipts, REQUIRED_RELEASE_PLATFORM_MATRIX,
  verifyVerificationReceipt
} from '../src/verification-receipt.mjs';
import { readSecurePrivateKey, readSecurePublicKey } from '../src/secure-private-key.mjs';
import {
  readStableReleaseJson, writeReleaseJsonNoClobber
} from '../src/secure-release-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function repeated(name) {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);
}

async function main() {
  const receiptPaths = repeated('--receipt').map((value) => path.resolve(root, value));
  const artifactReceiptPath = option('--artifact-receipt');
  const artifactKeyPath = option('--artifact-key');
  const signingKeyPath = option('--signing-key');
  const identity = option('--identity');
  const output = path.resolve(root, option('--out') ?? 'verification-matrix-receipt.json');
  if (!receiptPaths.length || !artifactReceiptPath || !artifactKeyPath || !signingKeyPath || !identity) {
    throw new Error(
      'Usage: node scripts/merge-verification-receipts.mjs --receipt <path> [--receipt <path> ...] '
      + '--artifact-receipt <path> --artifact-key <trusted-builder-public.pem> '
      + '--signing-key <ed25519-private.pem> '
      + '--identity <reviewer> [--out <path>]'
    );
  }
  if (receiptPaths.length > REQUIRED_RELEASE_PLATFORM_MATRIX.length) {
    throw new Error(`At most ${REQUIRED_RELEASE_PLATFORM_MATRIX.length} platform receipts may be merged.`);
  }
  const resolvedKey = path.resolve(root, signingKeyPath);
  const signingAuthority = await readSecurePrivateKey(resolvedKey, {
    repository: root, label: 'Verification matrix signing key'
  });
  if (output === signingAuthority.path) {
    throw new Error('Verification matrix output must not overwrite its signing key.');
  }
  const receipts = [];
  for (const file of receiptPaths) {
    receipts.push((await readStableReleaseJson(file, {
      label: 'Platform verification receipt', maxBytes: 8 * 1024 * 1024
    })).value);
  }
  const artifactReceipt = (await readStableReleaseJson(path.resolve(root, artifactReceiptPath), {
    label: 'Release artifact receipt', maxBytes: 1024 * 1024
  })).value;
  const artifactKey = (await readSecurePublicKey(path.resolve(root, artifactKeyPath), {
    repository: root, label: 'Trusted artifact-builder public key'
  })).bytes;
  const aggregate = mergeSignedVerificationReceipts(
    receipts,
    signingAuthority.bytes,
    identity,
    { artifactReceipt, trustedArtifactPublicKeyPem: artifactKey, requireSgosEndToEnd: true }
  );
  // This is the deliberate review boundary: a partial aggregate is useful diagnostics but must not
  // be written with a release-authority filename.
  verifyVerificationReceipt(aggregate, {
    trustedPublicKeyPem: createPublicKey({
      key: Buffer.from(aggregate.signature.publicKeySpki, 'base64'),
      format: 'der', type: 'spki'
    }).export({ type: 'spki', format: 'pem' }),
    artifactReceipt,
    trustedArtifactPublicKeyPem: artifactKey,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX,
    requireSgosEndToEnd: true
  });
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeReleaseJsonNoClobber(output, aggregate);
  console.log(`Signed platform-matrix verification receipt: ${output}`);
}

main().catch((error) => {
  console.error(`Verification receipt merge failed: ${error.message}`);
  process.exitCode = 1;
});
