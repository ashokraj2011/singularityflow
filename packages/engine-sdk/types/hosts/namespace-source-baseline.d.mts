import type {Engine} from '../index.mjs';
import type {NamespaceStore,NamespaceScope} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {SourceUnit,SourceContentReader} from '../source.mjs';
import type {NamespaceStoryAccessFacts} from './namespace-story.mjs';
export interface NamespaceSourceBaselineOptions {readonly records:NamespaceStore;readonly content:ContentStore;
  readonly scope:NamespaceScope;readonly workId:string;readonly authority:{readonly id:string;readonly epoch:number};
  readonly access:{current(request:{readonly projectId:string;readonly workId:string;readonly operation:'source.baseline.retain';readonly signal?:AbortSignal|null}):
    (NamespaceStoryAccessFacts&{readonly agentId:string|null})|Promise<NamespaceStoryAccessFacts&{readonly agentId:string|null}>};
  readonly clock:{now():string|Promise<string>};readonly sources?:readonly SourceUnit[];readonly sourceReaders?:readonly SourceContentReader[]}
/** Archive or acknowledge original selected application bytes; never infer a lifecycle approval. */
export declare function createNamespaceSourceBaselineEngine(options:NamespaceSourceBaselineOptions):Engine;
