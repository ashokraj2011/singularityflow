import type { NamespaceStore, NamespaceStoreOptions, NamespaceHostPorts } from '../namespace.mjs';
export interface SqliteNamespaceStore extends NamespaceStore { close(): void }
export declare function createSqliteNamespaceStore(options: NamespaceStoreOptions & { filename: string; create?: boolean; busyTimeoutMs?: number },
  ports?: NamespaceHostPorts): Promise<SqliteNamespaceStore>;
