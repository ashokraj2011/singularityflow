import type {Engine} from '../index.mjs';
import type {NamespaceStore,NamespaceScope} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {SourceUnit,SourceContentReader} from '../source.mjs';
import type {NamespaceStoryAccessFacts} from './namespace-story.mjs';
export interface NamespaceSourceRetentionAccess {current(request:{readonly projectId:string;readonly workId:string;
  readonly operation:'phase.source.retain';readonly signal?:AbortSignal|null}):
  (NamespaceStoryAccessFacts&{readonly agentId:string|null})|Promise<NamespaceStoryAccessFacts&{readonly agentId:string|null}>}
export interface NamespaceSourceRetentionOptions {readonly records:NamespaceStore;readonly content:ContentStore;
  readonly scope:NamespaceScope;readonly workId:string;readonly authority:{readonly id:string;readonly epoch:number};
  readonly access:NamespaceSourceRetentionAccess;readonly clock:{now():string|Promise<string>};
  readonly localRecords?:NamespaceStore;readonly localContent?:ContentStore;readonly sources?:readonly SourceUnit[];
  readonly sourceReaders?:readonly SourceContentReader[];readonly modelEnabled?:boolean}
/** Retain or acknowledge one registered generation's exact changed application contents. */
export declare function createNamespaceSourceRetentionEngine(options:NamespaceSourceRetentionOptions):Engine;
