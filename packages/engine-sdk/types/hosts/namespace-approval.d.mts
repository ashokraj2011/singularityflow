import type {Engine} from '../index.mjs';
import type {NamespaceStore,NamespaceScope} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {NamespaceStoryAccessFacts} from './namespace-story.mjs';
export declare const NAMESPACE_APPROVAL_PROFILE:'sflow-primary-document-approval/v1';
export declare const NAMESPACE_ROUTED_APPROVAL_PROFILE:'sflow-primary-document-approval/v2';
/** Authenticated application identity, independent of the phase author's prompt or agent. */
export interface NamespaceApprovalAccess {current(request:{readonly projectId:string;readonly workId:string;readonly operation:'phase.approve';readonly signal?:AbortSignal|null}):
  (NamespaceStoryAccessFacts&{readonly agentId:string|null})|Promise<NamespaceStoryAccessFacts&{readonly agentId:string|null}>}
export declare function createNamespaceApprovalEngine(options:{readonly records:NamespaceStore;readonly content:ContentStore;readonly localContent?:ContentStore|null;
  readonly scope:NamespaceScope;readonly workId:string;readonly authority:{readonly id:string;readonly epoch:number};
  readonly access:NamespaceApprovalAccess;readonly clock:{now():string|Promise<string>}}):Engine;
