import type { Engine } from '../index.mjs';
import type { NamespaceStore, NamespaceScope, JsonValue } from '../namespace.mjs';
import type { ContentStore } from '../content.mjs';
/** Implements phase.review/document.read only; lifecycle operations explicitly have no port. */
export declare function createNamespaceReadEngine(options: { records: NamespaceStore; content: ContentStore;
  localContent?: ContentStore | null; scope: NamespaceScope; workId: string }): Engine;
export declare function namespaceStoryReadKey(workId: string): string;
export declare function projectNamespaceReadState(workflow: unknown): Readonly<Record<string, JsonValue>>;
export declare function namespaceReadRecord(kind: 'head' | 'state' | 'policy' | 'documents', value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>>;
