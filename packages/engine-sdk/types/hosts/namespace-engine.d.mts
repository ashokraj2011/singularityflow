import type {Engine} from '../index.mjs';
import type {NamespaceStore,NamespaceScope} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {SourceUnit,SourceContentReader} from '../source.mjs';
import type {SourceControlReader} from '../source-control.mjs';
import type {NamespaceStoryAccessFacts} from './namespace-story.mjs';
import type {NamespaceChecksBindings} from './namespace-checks.mjs';
export type NamespaceAccessOperation='project.enroll'|'configuration.approve'|'story.create'|'source.bind'|'source.baseline.retain'|
  'clarification.status'|'clarification.record'|'phase.enter'|'phase.context.read'|'phase.prepare'|'phase.draft.read'|'phase.draft.write'|'phase.draft.rebase'|'phase.publish'|'phase.submit'|'phase.approve'|'decision.choose'|'phase.checks.run'|'phase.source.inspect'|'phase.source.retain';
export interface NamespaceEngineAccess {
  current(request:{readonly projectId:string;readonly workId?:string;readonly operation:NamespaceAccessOperation;readonly signal?:AbortSignal|null}):
    (NamespaceStoryAccessFacts&{readonly agentId:string|null})|Promise<NamespaceStoryAccessFacts&{readonly agentId:string|null}>;
}
export interface NamespaceEngineOptions {
  readonly records:NamespaceStore;readonly content:ContentStore;readonly scope:NamespaceScope;readonly workId:string;
  readonly authority:{readonly id:string;readonly epoch:number};readonly access:NamespaceEngineAccess;
  readonly clock:{now():string|Promise<string>};
  /** Separate device-bound private storage; required for new authoring, never created implicitly. */
  readonly working?:{readonly records:NamespaceStore;readonly content:ContentStore}|null;
  /** Optional local attachment store, distinct from the private draft store if supplied. */
  readonly localContent?:ContentStore|null;readonly sources?:readonly SourceUnit[];readonly modelEnabled?:boolean;
  readonly sourceReaders?:readonly SourceContentReader[];
  readonly sourceControlReaders?:readonly SourceControlReader[];
  readonly notice?:(notice:unknown)=>unknown;
  readonly checks?:NamespaceChecksBindings;
}
export declare function createNamespaceEngine(options:NamespaceEngineOptions):Engine;
