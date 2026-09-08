import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createRepoContext } from './repo-context.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { assertFosFeature } from './fos-features.mjs';
import { nowIso, SingularityFlowError, writeAtomic } from './util.mjs';

const MAX_BUFFERS = 100;
const MAX_BUFFER_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/;

function fail(message, code = 'WORK_PRESERVATION_FAILED') { throw new SingularityFlowError(message, { code }); }
function recoveryRoot(commonDir) {
  return path.join(commonDir, 'singularity-flow', 'recovery', 'fos', 'story-switch');
}
function contentDigest(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

export async function createFosStorySwitchCheckpoint(root, {
  sourceWorktree, targetWorktree, buffers = [], consent = false, features = {}
} = {}) {
  assertFosFeature(features, 'story-switching');
  if (!Array.isArray(buffers) || buffers.length > MAX_BUFFERS) fail('Story-switch buffer count exceeds its safe limit.', 'LIMIT_EXCEEDED');
  const source = await createRepoContext(sourceWorktree).identity();
  const target = await createRepoContext(targetWorktree).identity();
  if (source.repositoryInstanceId !== target.repositoryInstanceId || source.worktreeInstanceId === target.worktreeInstanceId) {
    fail('Story switching requires two distinct worktrees from the same Git repository.');
  }
  const normalized = buffers.map((buffer) => {
    if (!ID.test(buffer?.id ?? '')) fail('Every recoverable editor buffer needs a bounded stable identity.');
    const bytes = Buffer.isBuffer(buffer.bytes) ? Buffer.from(buffer.bytes) : Buffer.from(String(buffer.bytes ?? ''), 'utf8');
    if (bytes.length > MAX_BUFFER_BYTES) fail('A Story-switch buffer exceeds its safe byte limit.', 'LIMIT_EXCEEDED');
    return { id: buffer.id, bytes, dirty: buffer.dirty === true, baseSha256: buffer.baseSha256 ?? null, language: buffer.language ?? null };
  });
  if (normalized.some((buffer) => buffer.dirty) && consent !== true) fail(
    'Dirty or untitled buffers require explicit local recovery consent before changing editor focus.'
  );
  const totalBytes = normalized.reduce((sum, buffer) => sum + buffer.bytes.length, 0);
  if (totalBytes > MAX_TOTAL_BYTES) fail('Story-switch recovery bytes exceed their safe total limit.', 'LIMIT_EXCEEDED');
  const checkpointId = `fos-switch-${randomUUID()}`;
  const directory = path.join(recoveryRoot(source.commonDir), checkpointId);
  const records = [];
  await mkdir(path.join(directory, 'buffers'), { recursive: true, mode: 0o700 });
  for (let index = 0; index < normalized.length; index += 1) {
    const buffer = normalized[index];
    const contentSha256 = contentDigest(buffer.bytes);
    const filename = `${String(index).padStart(3, '0')}-${contentSha256.slice(7)}.bin`;
    await writeAtomic(path.join(directory, 'buffers', filename), buffer.bytes, { mode: 0o600 });
    records.push({
      id: buffer.id, contentSha256, bytes: buffer.bytes.length, dirty: buffer.dirty,
      baseSha256: buffer.baseSha256, language: buffer.language, object: `buffers/${filename}`
    });
  }
  const manifest = {
    schemaVersion: currentSchemaVersion('fos-story-switch-checkpoint'),
    kind: 'fos-story-switch-checkpoint',
    checkpointId,
    repositoryInstanceId: source.repositoryInstanceId,
    source: { worktreeInstanceId: source.worktreeInstanceId, path: path.resolve(sourceWorktree) },
    target: { worktreeInstanceId: target.worktreeInstanceId, path: path.resolve(targetWorktree) },
    buffers: records,
    totalBytes,
    recordedAt: nowIso(),
    state: 'prepared',
    cache: false
  };
  const complete = { ...manifest, checkpointSha256: `sha256:${recordSha256(manifest)}` };
  await writeAtomic(path.join(directory, 'checkpoint.json'), `${JSON.stringify(complete, null, 2)}\n`, { mode: 0o600 });
  await verifyFosStorySwitchCheckpoint(source.commonDir, checkpointId);
  return Object.freeze({ status: 'checkpointed', checkpoint: Object.freeze(complete), path: directory });
}

export async function verifyFosStorySwitchCheckpoint(commonDir, checkpointId) {
  if (!/^fos-switch-[a-f0-9-]{36}$/.test(checkpointId ?? '')) fail('Story-switch checkpoint ID is invalid.');
  const directory = path.join(recoveryRoot(commonDir), checkpointId);
  const stored = readRecord('fos-story-switch-checkpoint', await readFile(path.join(directory, 'checkpoint.json'))).record;
  const { checkpointSha256, ...body } = stored;
  if (checkpointSha256 !== `sha256:${recordSha256(body)}` || stored.cache !== false) fail('Story-switch checkpoint integrity failed.');
  for (const buffer of stored.buffers) {
    const target = path.resolve(directory, buffer.object);
    if (!target.startsWith(`${path.resolve(directory)}${path.sep}`)) fail('Story-switch checkpoint object escaped recovery storage.');
    const bytes = await readFile(target);
    if (bytes.length !== buffer.bytes || contentDigest(bytes) !== buffer.contentSha256) fail('Story-switch buffer integrity failed.');
  }
  return Object.freeze(stored);
}

export async function recordFosStorySwitchOutcome(commonDir, checkpointId, {
  targetOpened, activeWorktreeId, errorCode = null
} = {}) {
  const checkpoint = await verifyFosStorySwitchCheckpoint(commonDir, checkpointId);
  if (typeof targetOpened !== 'boolean') fail('Story-switch outcome must say whether the target opened.');
  const outcome = {
    schemaVersion: currentSchemaVersion('fos-story-switch-outcome'),
    kind: 'fos-story-switch-outcome',
    checkpointId,
    checkpointSha256: checkpoint.checkpointSha256,
    status: targetOpened ? 'target-active' : 'recovery-available',
    activeWorktreeId: activeWorktreeId ?? checkpoint.source.worktreeInstanceId,
    errorCode,
    recordedAt: nowIso(),
    recoveryRetained: true
  };
  const complete = { ...outcome, outcomeSha256: `sha256:${recordSha256(outcome)}` };
  const target = path.join(recoveryRoot(commonDir), checkpointId, 'outcome.json');
  await writeAtomic(target, `${JSON.stringify(complete, null, 2)}\n`, { mode: 0o600 });
  return Object.freeze(complete);
}
