import type { Engine } from '../index.mjs';
import type { NamespaceStore, NamespaceScope } from '../namespace.mjs';
import type { ContentStore } from '../content.mjs';
export interface NamespaceStoryAccessFacts {
  readonly projectId: string; readonly principalId: string; readonly actorKind: 'human' | 'service';
  readonly permissions: readonly string[]; readonly identity: { readonly name: string; readonly email?: string | null; readonly login?: string | null };
}
export interface NamespaceStoryAccess {
  current(request: { readonly projectId: string; readonly workId: string; readonly operation: 'story.create'; readonly signal?: AbortSignal | null }):
    NamespaceStoryAccessFacts | Promise<NamespaceStoryAccessFacts>;
}
export declare function createNamespaceStoryEngine(options: {
  readonly records: NamespaceStore; readonly content: ContentStore; readonly localContent?: ContentStore | null;
  readonly scope: NamespaceScope; readonly workId: string; readonly authority: { readonly id: string; readonly epoch: number };
  readonly access: NamespaceStoryAccess; readonly clock: { now(): string | Promise<string> };
}): Engine;
