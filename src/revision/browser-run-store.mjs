/** Private, immutable storage for candidate-bound BRL receipts and artifact bytes. */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import {
  readPrivateSidecar, writeImmutablePrivateSidecar
} from '../private-sidecar.mjs';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  readRevisionBrowserRunArtifactBytes, validateRevisionBrowserRunReceipt
} from './browser-loop.mjs';

const HASH = /^sha256:([a-f0-9]{64})$/;
const RUN_ID = /^BRL-[a-f0-9]{12}$/;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function bytesHash(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(value)).digest('hex')}`;
}
function digest(value, label) {
  const match = HASH.exec(String(value ?? ''));
  if (!match) fail('REV_BROWSER_STORE_SCOPE', `${label} needs an exact SHA-256 digest.`);
  return match[1];
}
function runId(value) {
  if (!RUN_ID.test(String(value ?? ''))) {
    fail('REV_BROWSER_STORE_SCOPE', 'Browser run needs an exact BRL run ID.');
  }
  return value;
}
function base(root) {
  return path.join(path.resolve(gitCommonDir(root)), 'singularity-flow', 'revision-browser-runs');
}
function runDirectory(root, selectedRunId) {
  return path.join(base(root), runId(selectedRunId));
}
function receiptPath(root, selectedRunId) {
  return path.join(runDirectory(root, selectedRunId), 'receipt.json');
}
function artifactPath(root, selectedRunId, artifactSha256) {
  return path.join(runDirectory(root, selectedRunId), 'artifacts',
    digest(artifactSha256, 'artifact'));
}

function parseReceipt(bytes) {
  let parsed;
  try { parsed = JSON.parse(bytes); }
  catch { fail('REV_BROWSER_STORE_CORRUPT', 'Stored browser receipt is not JSON.'); }
  return validateRevisionBrowserRunReceipt(parsed);
}

async function readStoredReceipt(root, selectedRunId, {
  receiptSha256 = null, optional = false
} = {}) {
  runId(selectedRunId);
  if (receiptSha256 !== null) digest(receiptSha256, 'receipt');
  const bytes = await readPrivateSidecar(root, receiptPath(root, selectedRunId), {
    maximumBytes: MAX_RECEIPT_BYTES, optional, enforceWindowsAcl: true
  });
  if (bytes === null) return null;
  const receipt = parseReceipt(bytes);
  if (receipt.runKey.runId !== selectedRunId
      || (receiptSha256 !== null && receipt.receiptSha256 !== receiptSha256)) {
    fail('REV_BROWSER_STORE_CORRUPT', 'Stored browser receipt differs from its selected run identity.');
  }
  return receipt;
}

/** Persist original same-process receipt/artifact handoff. Stored paths contain no source names. */
export async function writeRevisionBrowserRunReceipt(root, receiptObject) {
  const receipt = validateRevisionBrowserRunReceipt(receiptObject);
  const selectedRunId = runId(receipt.runKey.runId);
  const artifactBytes = readRevisionBrowserRunArtifactBytes(receiptObject);
  const expected = new Set(receipt.artifacts.map((item) => item.sha256));
  if (artifactBytes.size !== expected.size
      || [...artifactBytes.keys()].some((item) => !expected.has(item))) {
    fail('REV_BROWSER_STORE_ARTIFACT_MISMATCH', 'Browser artifact handoff differs from its receipt inventory.');
  }
  const existing = await readStoredReceipt(root, selectedRunId, { optional: true });
  if (existing) {
    if (existing.receiptSha256 !== receipt.receiptSha256) {
      fail('REV_BROWSER_STORE_RUN_IMMUTABLE',
        'Browser run already has a different immutable receipt. Create a new run ID.');
    }
    return Object.freeze({
      receipt: existing, created: false, runId: selectedRunId,
      runKeySha256: existing.runKey.runKeySha256,
      receiptSha256: existing.receiptSha256
    });
  }
  for (const artifact of receipt.artifacts) {
    const bytes = artifactBytes.get(artifact.sha256);
    if (!Buffer.isBuffer(bytes) || bytes.length !== artifact.bytes
        || bytesHash(bytes) !== artifact.sha256) {
      fail('REV_BROWSER_STORE_ARTIFACT_MISMATCH', 'Browser artifact bytes differ from their receipt inventory.');
    }
    await writeImmutablePrivateSidecar(
      root, artifactPath(root, selectedRunId, artifact.sha256), bytes,
      { maximumBytes: MAX_ARTIFACT_BYTES, enforceWindowsAcl: true }
    );
  }
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`);
  let publication;
  try {
    publication = await writeImmutablePrivateSidecar(
      root, receiptPath(root, selectedRunId), bytes,
      { maximumBytes: MAX_RECEIPT_BYTES, enforceWindowsAcl: true }
    );
  } catch (error) {
    if (error?.code === 'PRIVATE_SIDECAR_RECORD_CONFLICT') {
      fail('REV_BROWSER_STORE_RUN_IMMUTABLE',
        'Browser run concurrently acquired a different immutable receipt. Create a new run ID.');
    }
    throw error;
  }
  return Object.freeze({
    receipt, created: publication.created,
    runId: selectedRunId,
    runKeySha256: receipt.runKey.runKeySha256,
    receiptSha256: receipt.receiptSha256
  });
}

export async function readRevisionBrowserRunReceipt(root, { runId: selectedRunId, receiptSha256 = null }) {
  return readStoredReceipt(root, selectedRunId, { receiptSha256 });
}

/** Compatibility name: one explicit run has at most one immutable receipt, never a "latest" set. */
export async function readLatestRevisionBrowserRunReceipt(root, selectedRunId) {
  return readStoredReceipt(root, selectedRunId, { optional: true });
}

export async function readRevisionBrowserArtifact(root, {
  runId: selectedRunId, artifactSha256, maximumBytes = MAX_ARTIFACT_BYTES
}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
      || maximumBytes > MAX_ARTIFACT_BYTES) {
    fail('REV_BROWSER_STORE_LIMIT', 'Browser artifact read bound is invalid.');
  }
  const bytes = await readPrivateSidecar(root, artifactPath(root, selectedRunId, artifactSha256), {
    maximumBytes, enforceWindowsAcl: true
  });
  if (bytesHash(bytes) !== artifactSha256) {
    fail('REV_BROWSER_STORE_CORRUPT', 'Stored browser artifact content hash does not match.');
  }
  return bytes;
}
