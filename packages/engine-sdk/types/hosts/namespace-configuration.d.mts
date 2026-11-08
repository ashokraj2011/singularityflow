import type { Engine } from '../index.mjs';
import type { NamespaceStore, NamespaceScope } from '../namespace.mjs';
import type { ContentStore } from '../content.mjs';
export declare const NAMESPACE_CONFIGURATION_HEAD_KEY: 'configuration/current';
export interface NamespaceConfigurationAccess {
  current(request: { readonly projectId: string; readonly operation: 'configuration.approve'; readonly signal?: AbortSignal | null }):
    { readonly projectId: string; readonly principalId: string; readonly permissions: readonly string[]; readonly actorKind: 'human' | 'service' }
    | Promise<{ readonly projectId: string; readonly principalId: string; readonly permissions: readonly string[]; readonly actorKind: 'human' | 'service' }>;
}
export declare function createNamespaceConfigurationEngine(options: {
  readonly records: NamespaceStore; readonly content: ContentStore; readonly scope: NamespaceScope;
  readonly authority: { readonly id: string; readonly epoch: number };
  readonly access: NamespaceConfigurationAccess; readonly clock: { now(): string | Promise<string> };
}): Engine;
