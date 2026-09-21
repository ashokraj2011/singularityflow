#!/usr/bin/env node
/** Run the privacy-safe corpus measurement and sign its exact aggregate with an independent key. */
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSecurePrivateKey } from '../src/secure-private-key.mjs';
import { writeReleaseJsonNoClobber } from '../src/secure-release-files.mjs';
import { assertReleaseCheckoutClean } from '../src/verification-receipt.mjs';
import {
  signWelCorpusReviewReceipt, validateWelCorpusMeasurement,
  WEL_CORPUS_LIFECYCLE_AUTHORITY, WEL_CORPUS_MEASUREMENT_SCHEMA,
  WEL_CORPUS_REVIEW_ASSURANCE, WEL_CORPUS_REVIEW_RECEIPT_KIND,
  WEL_CORPUS_REVIEW_RECEIPT_VERSION, WEL_CORPUS_RUNNER_ENTRYPOINT
} from '../src/wel-corpus-review-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseOptions(argv) {
  const names = new Map([
    ['--manifest', 'manifest'], ['--samples', 'samples'], ['--signing-key', 'signingKey'],
    ['--identity', 'identity'], ['--review-reference', 'reviewReference'], ['--out', 'output']
  ]);
  const result = { manifest: null, samples: '3', signingKey: null, identity: null, reviewReference: null, output: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const field = names.get(option);
    if (!field) throw new Error(`Unknown WEL corpus review option '${option}'.`);
    if (seen.has(option)) throw new Error(`${option} was provided more than once.`);
    seen.add(option);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
    result[field] = value;
    index += 1;
  }
  if (!result.manifest || !result.signingKey || !result.identity || !result.reviewReference) {
    throw new Error(
      'Usage: node scripts/wel-corpus-review-receipt.mjs --manifest <reviewed.json> '
      + '--signing-key <independent-ed25519-private.pem> --identity <reviewer> '
      + '--review-reference <review:uuid|sha256:64hex> [--samples <1..20>] [--out <receipt.json>]'
    );
  }
  if (!/^(?:[1-9]|1\d|20)$/u.test(result.samples)) {
    throw new Error('--samples must be an integer from 1 to 20.');
  }
  return result;
}

function defaultOutput() {
  const result = spawnSync('git', [
    'rev-parse', '--path-format=absolute', '--git-path', 'singularity-flow/wel-corpus-review-receipt.json'
  ], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error('Could not resolve the private WEL corpus review receipt destination.');
  }
  return path.resolve(result.stdout.trim());
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const baseline = assertReleaseCheckoutClean(root, { label: 'WEL corpus independent review' });
  const signingAuthority = await readSecurePrivateKey(path.resolve(root, options.signingKey), {
    repository: root, label: 'Independent WEL corpus review signing key'
  });
  const output = path.resolve(root, options.output ?? defaultOutput());
  if (output === signingAuthority.path) {
    throw new Error('WEL corpus review receipt output must not overwrite its signing key.');
  }
  const measured = spawnSync(process.execPath, [
    WEL_CORPUS_RUNNER_ENTRYPOINT,
    '--manifest', options.manifest,
    '--samples', options.samples
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  });
  if (measured.error || measured.status !== 0) {
    const detail = String(measured.stderr || '').trim();
    throw new Error(`WEL corpus measurement did not produce reviewable evidence${detail ? `: ${detail}` : '.'}`);
  }
  let report;
  try { report = JSON.parse(measured.stdout); } catch {
    throw new Error('WEL corpus measurement did not emit one valid JSON report.');
  }
  const measurement = validateWelCorpusMeasurement(report, {
    platform: process.platform,
    architecture: process.arch,
    expectedNodeMajor: Number(process.versions.node.split('.')[0]),
    requireObserved: true
  });
  assertReleaseCheckoutClean(root, {
    expectedCommit: baseline.commit,
    expectedTree: baseline.tree,
    label: 'WEL corpus independent review post-measurement check'
  });
  const receipt = signWelCorpusReviewReceipt({
    schemaVersion: WEL_CORPUS_REVIEW_RECEIPT_VERSION,
    kind: WEL_CORPUS_REVIEW_RECEIPT_KIND,
    reviewedAt: new Date().toISOString(),
    reviewerIdentity: options.identity,
    independentReviewReference: options.reviewReference,
    sourceCommit: baseline.commit,
    sourceTree: baseline.tree,
    runner: {
      entrypoint: WEL_CORPUS_RUNNER_ENTRYPOINT,
      profile: report.corpusProfile,
      reportSchema: WEL_CORPUS_MEASUREMENT_SCHEMA,
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.versions.node
      }
    },
    measurement: measurement.evidence,
    measurementSha256: measurement.evidenceSha256,
    assurance: WEL_CORPUS_REVIEW_ASSURANCE,
    lifecycleAuthority: WEL_CORPUS_LIFECYCLE_AUTHORITY
  }, signingAuthority.bytes, options.identity);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeReleaseJsonNoClobber(output, receipt);
  console.log(`Signed content-free WEL corpus review receipt: ${output}`);
  console.log('Lifecycle authority remains none-observe-only.');
}

main().catch((error) => {
  console.error(`WEL corpus review failed: ${error.message}`);
  process.exitCode = 1;
});
