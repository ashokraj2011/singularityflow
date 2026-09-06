/**
 * Bounded machine-local persistence for the last confirmed repository snapshot.
 *
 * VS Code Mementos are convenient, but extension-test hosts can acknowledge an update and exit
 * before their backing database is flushed. A large JSON projection is also a poor fit for the
 * shared key/value database. This cache lives beneath `globalStorageUri`, uses only a hash of the
 * canonical repository as its filename, writes atomically, and is never synced.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CACHE_SCHEMA_VERSION = 1;
export const MAX_SNAPSHOT_CACHE_BYTES = 4 * 1024 * 1024;
export const MAX_SNAPSHOT_CACHE_REPOSITORIES = 8;

interface CacheEnvelope<T> {
  readonly schemaVersion: 1;
  readonly snapshot: T;
}

function identity(repository: string): string {
  return createHash('sha256').update(repository).digest('hex');
}

export class RepositorySnapshotFileCache<T extends object> {
  private readonly directory: string;
  private pending: Promise<void> = Promise.resolve();
  private lastWriteFailed = false;

  constructor(globalStorageDirectory: string) {
    this.directory = path.join(globalStorageDirectory, 'snapshot-cache-v2');
  }

  private target(repository: string): string {
    return path.join(this.directory, `${identity(repository)}.json`);
  }

  /** Bounded synchronous read so cached UI can paint before the first asynchronous refresh. */
  read(repository: string): T | null {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(this.target(repository), 'r');
      const size = fstatSync(descriptor).size;
      if (!Number.isSafeInteger(size) || size < 2 || size > MAX_SNAPSHOT_CACHE_BYTES) return null;
      const bytes = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const count = readSync(descriptor, bytes, offset, size - offset, offset);
        if (!count) return null;
        offset += count;
      }
      const envelope = JSON.parse(bytes.toString('utf8')) as CacheEnvelope<T>;
      return envelope?.schemaVersion === CACHE_SCHEMA_VERSION
        && envelope.snapshot !== null && typeof envelope.snapshot === 'object'
        && !Array.isArray(envelope.snapshot) ? envelope.snapshot : null;
    } catch {
      return null;
    } finally {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* cache descriptor already closed */ }
      }
    }
  }

  /** Queue writes so a slower old projection can never replace a newer confirmed projection. */
  write(repository: string, snapshot: T): void {
    const envelope: CacheEnvelope<T> = { schemaVersion: CACHE_SCHEMA_VERSION, snapshot };
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
    if (bytes.length > MAX_SNAPSHOT_CACHE_BYTES) return;
    const target = this.target(repository);
    this.pending = this.pending.catch(() => {}).then(async () => {
      const temporary = path.join(this.directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, bytes, { mode: 0o600 });
        await rename(temporary, target);
        this.lastWriteFailed = false;
        await this.prune();
      } catch {
        this.lastWriteFailed = true;
        await rm(temporary, { force: true }).catch(() => {});
        // This cache is an acceleration only. Keep the queued promise settled so a read-only UI
        // cannot acquire an unhandled rejection merely because machine-local cache storage became
        // unavailable; `persist()` still reports the failure to the benchmark explicitly.
      }
    });
  }

  async persist(repository: string, snapshot: T): Promise<boolean> {
    this.write(repository, snapshot);
    await this.pending.catch(() => {});
    return !this.lastWriteFailed && this.read(repository) !== null;
  }

  async flush(): Promise<void> {
    await this.pending.catch(() => {});
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length <= MAX_SNAPSHOT_CACHE_REPOSITORIES) return;
    const dated = await Promise.all(names.map(async (name) => ({
      name,
      modified: await stat(path.join(this.directory, name)).then((entry) => entry.mtimeMs).catch(() => 0)
    })));
    dated.sort((left, right) => right.modified - left.modified || left.name.localeCompare(right.name));
    await Promise.all(dated.slice(MAX_SNAPSHOT_CACHE_REPOSITORIES)
      .map(({ name }) => rm(path.join(this.directory, name), { force: true })));
  }
}
