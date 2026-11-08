import type { Engine } from '../index.mjs';
import type { NamespaceStore, NamespaceScope } from '../namespace.mjs';
import type { ContentStore } from '../content.mjs';

export interface NamespaceProjectAccess {
  current(request: { readonly projectId: string; readonly operation: 'project.enroll'; readonly signal?: AbortSignal | null }):
    { readonly projectId: string; readonly principalId: string; readonly permissions: readonly string[] }
    | Promise<{ readonly projectId: string; readonly principalId: string; readonly permissions: readonly string[] }>;
}
export interface NamespaceProjectClock { now(): string | Promise<string> }
export declare function createNamespaceProjectEngine(options: {
  readonly records: NamespaceStore; readonly content: ContentStore; readonly scope: NamespaceScope;
  readonly authority: { readonly id: string; readonly epoch: 1 };
  readonly access: NamespaceProjectAccess; readonly clock: NamespaceProjectClock;
}): Engine;
