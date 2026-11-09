import type {Engine} from '../index.mjs';
import type {NamespaceStoryAccessFacts} from './namespace-story.mjs';
import type {createNamespacePreparationEngine,PreparationOperation} from './namespace-preparation.mjs';
export declare const NAMESPACE_PUBLICATION_PROFILE:'sflow-primary-document-publication/v1';
export declare const NAMESPACE_CHECKED_PUBLICATION_PROFILE:'sflow-primary-document-publication/v2';
export interface NamespacePublicationAccess {current(request:{readonly projectId:string;readonly workId:string;
  readonly operation:PreparationOperation|'phase.publish';readonly signal?:AbortSignal|null}):
  (NamespaceStoryAccessFacts&{readonly agentId:string|null})|Promise<NamespaceStoryAccessFacts&{readonly agentId:string|null}>}
export declare function createNamespacePublicationEngine(options:Omit<Parameters<typeof createNamespacePreparationEngine>[0],'access'> & {
  readonly access:NamespacePublicationAccess;readonly notice?:(event:Readonly<{code:string}>)=>void|Promise<void>}):Engine;
