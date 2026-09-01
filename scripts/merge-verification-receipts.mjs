#!/usr/bin/env node
/** Merge reviewed single-host release receipts into one signed platform-matrix authority. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mergeSignedVerificationReceipts, REQUIRED_RELEASE_PLATFORM_MATRIX,
  verifyVerificationReceipt
} from '../src/verification-receipt.mjs';

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
  const signingKeyPath = option('--signing-key');
  const identity = option('--identity');
  const output = path.resolve(root, option('--out') ?? 'verification-matrix-receipt.json');
  if (!receiptPaths.length || !artifactReceiptPath || !signingKeyPath || !identity) {
    throw new Error(
      'Usage: node scripts/merge-verification-receipts.mjs --receipt <path> [--receipt <path> ...] '
      + '--artifact-receipt <path> --signing-key <ed25519-private.pem> '
      + '--identity <reviewer> [--out <path>]'
    );
  }
  const resolvedKey = path.resolve(root, signingKeyPath);
  if (!existsSync(resolvedKey)) throw new Error(`Signing key does not exist: ${resolvedKey}`);
  const receipts = await Promise.all(receiptPaths.map(async (file) => JSON.parse(
    await readFile(file, 'utf8')
  )));
  const artifactReceipt = JSON.parse(await readFile(path.resolve(root, artifactReceiptPath), 'utf8'));
  const aggregate = mergeSignedVerificationReceipts(
    receipts,
    await readFile(resolvedKey),
    identity,
    { artifactReceipt }
  );
  // This is the deliberate review boundary: a partial aggregate is useful diagnostics but must not
  // be written with a release-authority filename.
  verifyVerificationReceipt(aggregate, {
    trustedPublicKeyPem: createPublicKey({
      key: Buffer.from(aggregate.signature.publicKeySpki, 'base64'),
      format: 'der', type: 'spki'
    }).export({ type: 'spki', format: 'pem' }),
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX
  });
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(aggregate, null, 2)}\n`, { mode: 0o600 });
  console.log(`Signed platform-matrix verification receipt: ${output}`);
}

main().catch((error) => {
  console.error(`Verification receipt merge failed: ${error.message}`);
  process.exitCode = 1;
});
