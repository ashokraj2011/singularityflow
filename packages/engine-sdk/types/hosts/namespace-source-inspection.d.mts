import type {Engine} from '../index.mjs';
import type {NamespaceStore,NamespaceScope} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {SourceUnit} from '../source.mjs';
import type {NamespaceStoryAccessFacts} from './namespace-story.mjs';
export interface NamespaceSourceInspectionAccess {
  current(request:{readonly projectId:string;readonly workId:string;readonly operation:'phase.source.inspect';readonly signal?:AbortSignal|null}):
    (NamespaceStoryAccessFacts&{readonly agentId:string|null})|Promise<NamespaceStoryAccessFacts&{readonly agentId:string|null}>;
}
/** Read-only comparison of a device-local generation with actual SGOS source observations. */
export declare function createNamespaceSourceInspectionEngine(options:{readonly records:NamespaceStore;readonly content:ContentStore;
  readonly localRecords:NamespaceStore;readonly localContent:ContentStore;readonly scope:NamespaceScope;readonly workId:string;
  readonly authority:{readonly id:string;readonly epoch:number};readonly access:NamespaceSourceInspectionAccess;
  readonly clock:{now():string|Promise<string>};readonly sources?:readonly SourceUnit[];readonly modelEnabled?:boolean}):Engine;
