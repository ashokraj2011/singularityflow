import type {NamespaceScope,NamespaceStore} from '../../namespace.mjs';
import type {ContentStore} from '../../content.mjs';
import type {OperationalStore} from '../storage.mjs';
export declare const SGOS_NAMESPACE_OPERATIONAL_STORE_PROFILE:'namespace-runtime-v1';
export declare function createNamespaceSgosOperationalStore(options:{readonly records:NamespaceStore;readonly content:ContentStore;
  readonly scope:NamespaceScope;readonly storeId:string}):Readonly<OperationalStore>;
