/**
 * The last Story intake catalog per repository, so Start Work paints real choices at once. `[perf]`
 *
 * `workspace branches --intake` reads approved configuration and every remote base, which takes
 * seconds on a real repository. The form paints this copy, says it is checking for changes, and
 * the fresh listing replaces it. Entries are keyed by the Git common directory, so every Story
 * worktree of one repository shares one, and bound to the CLI build that wrote them.
 *
 * It only accelerates the first paint. It never selects a base branch and never enables Start:
 * a fresh exact-base readiness check is still required. A missing, foreign or unreadable entry is
 * no cache at all.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { RepositorySnapshotFileCache } from './snapshot-file-cache.ts';

export const MAX_INTAKE_CATALOG_CACHE_BYTES = 512 * 1024;
export const MAX_INTAKE_CATALOG_CACHE_REPOSITORIES = 16;
const ENTRY_SCHEMA = 'sflow.vscode.intake-catalog.v1';

interface CatalogEntry {
  readonly schema: typeof ENTRY_SCHEMA;
  readonly cliBuild: string;
  readonly savedAt: string;
  readonly listed: object;
}

/** What one open form reads and writes: the entry for the repository it was opened on. */
export interface IntakeCatalogCacheBinding {
  read(): { listed: object; savedAt: string } | null;
  write(listed: object): void;
}

/**
 * Changes whenever the CLI answering `workspace branches` is replaced or rebuilt. The entry
 * point alone rarely changes, so the module that builds the listing and the package are included.
 */
export function cliBuildIdentity(cli: string): string {
  const hash = createHash('sha256').update(path.resolve(cli));
  const root = path.resolve(path.dirname(cli), '..');
  for (const file of [cli, path.join(root, 'src', 'cli.mjs'), path.join(root, 'package.json')]) {
    try {
      const entry = statSync(file);
      hash.update(`\0${entry.size}:${entry.mtimeMs}`);
    } catch {
      hash.update('\0absent');
    }
  }
  return hash.digest('hex').slice(0, 32);
}

export class IntakeCatalogCache {
  private readonly files: RepositorySnapshotFileCache<CatalogEntry>;
  private readonly cli: string;

  constructor(globalStorageDirectory: string, cli: string) {
    this.cli = cli;
    this.files = new RepositorySnapshotFileCache<CatalogEntry>(globalStorageDirectory, {
      directoryName: 'intake-catalog-cache-v1',
      maxBytes: MAX_INTAKE_CATALOG_CACHE_BYTES,
      maxRepositories: MAX_INTAKE_CATALOG_CACHE_REPOSITORIES
    });
  }

  read(key: string): { listed: object; savedAt: string } | null {
    const entry = this.files.read(key);
    if (!entry || entry.schema !== ENTRY_SCHEMA || entry.cliBuild !== cliBuildIdentity(this.cli)
        || typeof entry.savedAt !== 'string' || !entry.listed || typeof entry.listed !== 'object'
        || Array.isArray(entry.listed)) return null;
    return { listed: entry.listed, savedAt: entry.savedAt };
  }

  write(key: string, listed: object): void {
    this.files.write(key, {
      schema: ENTRY_SCHEMA, cliBuild: cliBuildIdentity(this.cli),
      savedAt: new Date().toISOString(), listed
    });
  }

  bind(key: string): IntakeCatalogCacheBinding {
    return { read: () => this.read(key), write: (listed) => this.write(key, listed) };
  }

  flush(): Promise<void> {
    return this.files.flush();
  }
}
