import type {Engine} from '../index.mjs';
import type {NamespaceStore,NamespaceScope} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {SourceUnit} from '../source.mjs';
import type {NamespaceSourceInspectionAccess} from './namespace-source-inspection.mjs';
/** Read-only candidate source/test proof; never a publication or acceptance verdict. */
export declare function createNamespaceDeliveryInspectionEngine(options:{readonly records:NamespaceStore;readonly content:ContentStore;
  readonly localRecords:NamespaceStore;readonly localContent:ContentStore;readonly scope:NamespaceScope;readonly workId:string;
  readonly authority:{readonly id:string;readonly epoch:number};readonly access:NamespaceSourceInspectionAccess;
  readonly clock:{now():string|Promise<string>};readonly sources?:readonly SourceUnit[];readonly modelEnabled?:boolean}):Engine;
