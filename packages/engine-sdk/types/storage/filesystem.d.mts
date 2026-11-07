import type { NamespaceStore, NamespaceStoreOptions, NamespaceHostPorts } from '../namespace.mjs';
export declare function createFilesystemNamespaceStore(options: NamespaceStoreOptions & { root: string; create?: boolean },
  ports?: NamespaceHostPorts): Promise<NamespaceStore>;
