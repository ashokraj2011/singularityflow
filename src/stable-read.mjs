/** Bounded optimistic read consistency; a snapshot never grants mutation authority. */
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { SingularityFlowError } from './util.mjs';

const MAXIMUM_FILES = 256;
const MAXIMUM_BYTES = 32 * 1024 * 1024;

export function assertReadNotCancelled(signal) {
  if (signal?.aborted) throw new SingularityFlowError('The read was cancelled; no lifecycle action was taken.', {
    code: 'READ_CANCELLED'
  });
}

/** Exact bytes and object identity, including missing-to-present changes; no mtime-only cache. */
async function fingerprint(file, signal) {
  assertReadNotCancelled(signal);
  let selected;
  try { selected = await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return { digest: 'missing', bytes: 0 }; throw error; }
  if (!selected.isFile() || selected.size > BigInt(MAXIMUM_BYTES)) throw new SingularityFlowError(
    'A read dependency cannot be safely snapshotted. Use the existing isolated read route.', { code: 'READ_SNAPSHOT_UNAVAILABLE' });
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    // A captured regular file may disappear or become a link before open. Rebuild the whole
    // response once; do not leak a raw filesystem race or consume its replacement as authority.
    // Windows reports EPERM/EBUSY while another process replaces the file; that is the same race.
    if (['ENOENT', 'ELOOP', 'ESTALE', 'EPERM', 'EBUSY'].includes(error.code)) throw new SingularityFlowError(
      'A read dependency changed during capture. Refresh the read.', { code: 'READ_SNAPSHOT_STALE' });
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== selected.dev || before.ino !== selected.ino || before.size !== selected.size) {
      throw new SingularityFlowError('A read dependency changed during capture. Refresh the read.', { code: 'READ_SNAPSHOT_STALE' });
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      assertReadNotCancelled(signal);
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > MAXIMUM_BYTES) throw new SingularityFlowError('Read snapshot byte limit exceeded.', { code: 'READ_SNAPSHOT_UNAVAILABLE' });
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new SingularityFlowError('A read dependency changed during capture. Refresh the read.', { code: 'READ_SNAPSHOT_STALE' });
    }
    // ctime also detects an A -> B -> A replacement between consumers when final bytes match.
    return { digest: `${after.dev}:${after.ino}:${after.ctimeNs}:${hash.digest('hex')}`, bytes };
  } finally { await handle.close(); }
}

/** Only the kernel supplies dependency paths; the set is private, per invocation and bounded. */
export async function withStableRead({ files = [], identity, signal = null, freshScope = fn => fn() }, read) {
  for (let attempt = 0; attempt < 2; attempt++) {
    assertReadNotCancelled(signal);
    try {
      return await freshScope(async () => {
        const initialIdentity = await identity();
        const watched = new Map();
        let total = 0;
        const watch = async file => {
          if (watched.has(file)) return watched.get(file);
          if (watched.size >= MAXIMUM_FILES) throw new SingularityFlowError('Read snapshot dependency limit exceeded.', { code: 'READ_SNAPSHOT_UNAVAILABLE' });
          const value = await fingerprint(file, signal);
          if ((total += value.bytes) > MAXIMUM_BYTES) throw new SingularityFlowError('Read snapshot aggregate byte limit exceeded.', { code: 'READ_SNAPSHOT_UNAVAILABLE' });
          watched.set(file, value.digest);
          return value.digest;
        };
        for (const file of files) await watch(file);
        const value = await read({ watch, signal });
        assertReadNotCancelled(signal);
        // null declines the projection: the caller takes its original reads, so nothing here is used.
        if (value === null) return null;
        for (const [file, expected] of watched) if ((await fingerprint(file, signal)).digest !== expected) {
          throw new SingularityFlowError('The read snapshot changed. Refresh before continuing.', { code: 'READ_SNAPSHOT_STALE' });
        }
        if (await identity() !== initialIdentity) throw new SingularityFlowError(
          'The repository or selection changed while reading. Refresh before continuing.', { code: 'READ_SNAPSHOT_STALE' });
        incrementCommandCounter('read-snapshot.completed');
        return value;
      });
    } catch (error) {
      if (error.code !== 'READ_SNAPSHOT_STALE' || attempt === 1) throw error;
      incrementCommandCounter('read-snapshot.rebuilds');
    }
  }
}
