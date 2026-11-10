import type { Engine } from '../index.mjs';
import type { NamespaceStore,NamespaceScope } from '../namespace.mjs';
import type { ContentStore } from '../content.mjs';
import type { SourceUnit } from '../source.mjs';
import type { NamespaceStoryAccessFacts } from './namespace-story.mjs';
export type PreparationOperation = 'phase.begin' | 'phase.inputs' | 'phase.prepare' | 'phase.draft.read' | 'phase.draft.write' | 'phase.draft.rebase' | 'phase.artifact.attach' | 'phase.artifact.remove' | 'phase.artifact.inspect';
export interface NamespacePreparationAccess { current(request: { readonly projectId: string; readonly workId: string;
  readonly operation: PreparationOperation; readonly signal?: AbortSignal | null }):
  (NamespaceStoryAccessFacts & { readonly agentId: string | null }) | Promise<NamespaceStoryAccessFacts & { readonly agentId: string | null }> }
export declare function createNamespacePreparationEngine(options: { readonly records: NamespaceStore; readonly content: ContentStore;
  readonly localRecords: NamespaceStore; readonly localContent: ContentStore; readonly inputContent?:ContentStore; readonly scope: NamespaceScope;
  readonly workId: string; readonly authority: { readonly id: string; readonly epoch: number };
  readonly access: NamespacePreparationAccess; readonly clock: { now(): string | Promise<string> };
  readonly sources?: readonly SourceUnit[]; readonly modelEnabled?: boolean }): Engine;
