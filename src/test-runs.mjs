/**
 * The local preview run store [RUN M2]: `tests run --capability` saves each run privately below the
 * Git common directory at `singularity-flow/test-runs/<capability>/<RUN-ID>.json` and keeps the
 * last 20. A preview never counts as evidence for any Story; it exists so a person (and VS Code)
 * can read one test summary of what just ran.
 */
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { listPrivateSidecar, readPrivateSidecar, writeImmutablePrivateSidecar } from './private-sidecar.mjs';
import { SingularityFlowError } from './util.mjs';

export const TEST_RUN_FORMAT = 'sflow-test-run/v1';
export const KEPT_TEST_RUNS = 20;
export const LOCAL_PREVIEW_LABEL = 'Local preview, not evidence';
const RUN_ID = /^RUN-\d{8}T\d{6}Z-[a-f0-9]{8}$/u;
const MAXIMUM_RUN_BYTES = 32 * 1024 * 1024;

/** A sortable run ID: its creation second, then 32 random bits. */
export function newTestRunId(now = new Date(), random = randomBytes) {
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  return `RUN-${stamp}-${random(4).toString('hex')}`;
}

export function isTestRunId(value) {
  return RUN_ID.test(String(value ?? ''));
}

export function testRunDirectory(root, capabilityId) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'test-runs', capabilityId);
}

function validRun(record, capabilityId) {
  return record?.format === TEST_RUN_FORMAT && record.capability === capabilityId && isTestRunId(record.runId)
    && Array.isArray(record.commands) && typeof record.startedAt === 'string';
}

export async function readTestRun(root, capabilityId, runId) {
  if (!isTestRunId(runId)) {
    throw new SingularityFlowError(`'${runId}' is not a local run ID (RUN-YYYYMMDDTHHMMSSZ-xxxxxxxx).`, { code: 'TESTS_RUN_NOT_FOUND' });
  }
  const bytes = await readPrivateSidecar(root, path.join(testRunDirectory(root, capabilityId), `${runId}.json`), {
    maximumBytes: MAXIMUM_RUN_BYTES, optional: true
  });
  const record = bytes ? JSON.parse(bytes.toString('utf8')) : null;
  if (!validRun(record, capabilityId)) {
    throw new SingularityFlowError(`No local run ${runId} is kept for capability '${capabilityId}'.`, {
      code: 'TESTS_RUN_NOT_FOUND', details: { capabilityId, runId } });
  }
  return record;
}

/** Every kept run of a capability, newest first. Unreadable entries are skipped, never trusted. */
export async function listTestRuns(root, capabilityId) {
  const entries = await listPrivateSidecar(root, testRunDirectory(root, capabilityId), { optional: true });
  const runs = [];
  for (const entry of entries) {
    const runId = entry.name.replace(/\.json$/u, '');
    if (!entry.isFile() || !isTestRunId(runId)) continue;
    try { runs.push(await readTestRun(root, capabilityId, runId)); } catch { /* not a run this store can read */ }
  }
  return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId));
}

/** Save one run immutably, then keep only the newest KEPT_TEST_RUNS. */
export async function saveTestRun(root, record) {
  if (!validRun(record, record?.capability)) throw new SingularityFlowError('A local test run record is malformed.', { code: 'TESTS_RUN_INVALID' });
  const directory = testRunDirectory(root, record.capability);
  await writeImmutablePrivateSidecar(root, path.join(directory, `${record.runId}.json`), `${JSON.stringify(record, null, 2)}\n`, {
    maximumBytes: MAXIMUM_RUN_BYTES
  });
  const kept = await listTestRuns(root, record.capability);
  for (const stale of kept.slice(KEPT_TEST_RUNS)) {
    await rm(path.join(directory, `${stale.runId}.json`), { force: true });
  }
  return record;
}
