import type {Engine} from '../index.mjs';
import type {NamespaceStore,NamespaceScope} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {NamespaceStoryAccessFacts} from './namespace-story.mjs';
export declare const NAMESPACE_ROUTING_CHOICE_PROFILE:'sflow-human-routing-choice/v1';
/** Authenticated human identity and route permission; an agent name is audit context only. */
export interface NamespaceRoutingChoiceAccess {current(request:{readonly projectId:string;readonly workId:string;
  readonly operation:'decision.choose';readonly signal?:AbortSignal|null}):
  (NamespaceStoryAccessFacts&{readonly agentId:string|null})|Promise<NamespaceStoryAccessFacts&{readonly agentId:string|null}>}
export declare function createNamespaceRoutingChoiceEngine(options:{readonly records:NamespaceStore;readonly content:ContentStore;
  readonly localContent?:ContentStore|null;readonly scope:NamespaceScope;readonly workId:string;
  readonly authority:{readonly id:string;readonly epoch:number};readonly access:NamespaceRoutingChoiceAccess;
  readonly clock:{now():string|Promise<string>}}):Engine;
