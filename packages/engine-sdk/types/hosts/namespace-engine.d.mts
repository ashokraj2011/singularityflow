import type {Engine,EngineOperation} from '../index.mjs';
import type {NamespaceStore,NamespaceScope} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {SourceUnit,SourceContentReader} from '../source.mjs';
import type {SourceControlReader} from '../source-control.mjs';
import type {NamespaceStoryAccessFacts} from './namespace-story.mjs';
import type {NamespaceChecksBindings} from './namespace-checks.mjs';
import type {ExecutionUnit} from '../execution.mjs';
import type {ExecutionOwner} from '../execution/runtime.mjs';
export interface NamespaceTestRepairBindings {
  readonly mode?:never;
  /** SGOS owns external execution and its durable interruption recovery. */
  readonly owner:ExecutionOwner;
  readonly bindings:readonly {readonly phaseId:string;readonly unit:ExecutionUnit}[];
}
/** Effect-free acknowledgement/takeover of completed runs; no executor or execution owner is implied. */
export interface NamespaceRetainedExecutionBinding {readonly mode:'retained-only';readonly owner?:never;readonly bindings?:never}
export type NamespaceAccessOperation=EngineOperation;
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
  readonly checks?:NamespaceChecksBindings|NamespaceRetainedExecutionBinding;
  /** Optional source-scoped repair units; never implied by enabled recovery or failed tests. */
  readonly repairs?:NamespaceTestRepairBindings|NamespaceRetainedExecutionBinding;
}
export declare function createNamespaceEngine(options:NamespaceEngineOptions):Engine;
