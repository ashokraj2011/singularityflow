import type {Engine} from '../index.mjs';
import type {NamespaceStore,NamespaceScope} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {NamespaceStoryAccessFacts} from './namespace-story.mjs';
export declare const NAMESPACE_SUBMISSION_PROFILE:'sflow-primary-document-submission/v1';
export interface NamespaceSubmissionAccess {current(request:{readonly projectId:string;readonly workId:string;readonly operation:'phase.submit';readonly signal?:AbortSignal|null}):
  (NamespaceStoryAccessFacts&{readonly agentId:string|null})|Promise<NamespaceStoryAccessFacts&{readonly agentId:string|null}>}
export declare function createNamespaceSubmissionEngine(options:{readonly records:NamespaceStore;readonly content:ContentStore;readonly localContent?:ContentStore|null;
  readonly scope:NamespaceScope;readonly workId:string;readonly authority:{readonly id:string;readonly epoch:number};
  readonly access:NamespaceSubmissionAccess;readonly clock:{now():string|Promise<string>};
  readonly notice?:(event:Readonly<{code:string;phase:string}>)=>void|Promise<void>}):Engine;
