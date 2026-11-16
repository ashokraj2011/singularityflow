/**
 * An open version as the opening operation leaves it on the checkout that opened it (src/story-version-opening.mjs): the
 * Story record's `versionOpening` pointer, this checkout's writer ID and the operation's sealed checkpoint. For tests that
 * build a Story record by hand and need its open version accepted, held by another writer, or still pending. It seals with
 * the checkout's own machine-local key, exactly as the operation does; nothing here is a shortcut the product takes.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CHECKPOINT_PURPOSE, CHECKPOINT_SCHEMA, WRITER_SCHEMA, checkpointFile, gitDirectories, readWriterId, sealHere, writerFile }
  from '../../src/story-version-acceptance.mjs';

const hex = (bytes) => randomBytes(bytes).toString('hex');

/**
 * Mark `phase`'s open `version` as opened by the operation. `state` is the checkpoint (shared-confirmed by default);
 * `writer: 'other'` names another checkout's writer. Mutates `phase` and returns the pointer; the caller saves the record.
 */
export async function acceptOpening(root, workflow, phase, { version = Number(phase.generationIntent?.generation ?? Number(phase.generation ?? 0) + 1),
  state = 'shared-confirmed', writer = 'current', fence = 1 } = {}) {
  const { gitDir, commonDir } = gitDirectories(root);
  const runtime = path.join(commonDir, 'singularity-flow');
  await mkdir(runtime, { recursive: true });
  const key = path.join(runtime, 'pending-publication-integrity.key');
  if (!await lstat(key).then(() => true, () => false)) await writeFile(key, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  let own = readWriterId(gitDir);
  if (!own) {
    own = `vw-${hex(16)}`;
    await mkdir(path.dirname(writerFile(gitDir)), { recursive: true });
    await writeFile(writerFile(gitDir), JSON.stringify({ schema: WRITER_SCHEMA, writerId: own, createdAt: new Date().toISOString() }));
  }
  const operationId = `vo-${hex(16)}`;
  const sha256 = `sha256:${hex(32)}`;
  phase.versionOpening = { operationId, version, highWatermark: version, reason: 'test-fixture',
    path: `singularity/work-items/${workflow.workItem.id}/context/version-openings/${phase.id}-v${version}.json`, sha256, consent: null,
    writer: { fence, writerId: writer === 'current' ? own : `vw-${hex(16)}`, operationId }, openedAt: new Date().toISOString() };
  const checkpoint = sealHere(commonDir, CHECKPOINT_PURPOSE, { schema: CHECKPOINT_SCHEMA, operationId, payloadDigest: `sha256:${hex(32)}`,
    workId: workflow.workItem.id, phase: phase.id, version, proposalDigest: null, state, recordSha256: sha256, history: [],
    updatedAt: new Date().toISOString() });
  await mkdir(path.dirname(checkpointFile(commonDir, workflow.workItem.id, operationId)), { recursive: true });
  await writeFile(checkpointFile(commonDir, workflow.workItem.id, operationId), JSON.stringify(checkpoint));
  return phase.versionOpening;
}
