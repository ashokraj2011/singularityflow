import type { Engine } from '../index.mjs';
import type { NamespaceStore,NamespaceScope } from '../namespace.mjs';
import type { ContentStore } from '../content.mjs';
import type { SourceUnit } from '../source.mjs';
import type { NamespaceStoryAccessFacts } from './namespace-story.mjs';
export interface NamespaceSourceAccess { current(request: { readonly projectId: string; readonly workId: string;
  readonly operation: 'source.bind'; readonly signal?: AbortSignal | null }): NamespaceStoryAccessFacts | Promise<NamespaceStoryAccessFacts> }
export declare function createNamespaceSourceEngine(options: { readonly records: NamespaceStore; readonly content: ContentStore;
  readonly localContent?: ContentStore | null; readonly scope: NamespaceScope; readonly workId: string;
  readonly authority: { readonly id: string; readonly epoch: number }; readonly sources?: readonly SourceUnit[];
  readonly access: NamespaceSourceAccess; readonly clock: { now(): string | Promise<string> } }): Engine;
