import type { NamespaceStore, NamespaceStoreOptions, NamespaceHostPorts } from '../namespace.mjs';
import type { NamespaceJournal } from './journal.mjs';
export declare function createApplicationNamespaceStore(options: NamespaceStoreOptions & { id: string; qualification: 'production' | 'test-only' },
  ports: NamespaceHostPorts & { journal: NamespaceJournal }): NamespaceStore;
