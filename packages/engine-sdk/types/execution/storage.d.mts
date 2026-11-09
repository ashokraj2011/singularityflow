import type {JsonValue} from '../namespace.mjs';
export type OperationalDigest=`sha256:${string}`;
export interface OperationalState {
  readonly format:'sflow.sgos.operational-state';readonly formatVersion:1;readonly storeId:string;
  readonly revision:number;readonly eventSha256:OperationalDigest|null;readonly entriesSha256:OperationalDigest;
  readonly entries:Readonly<Record<string,JsonValue>>;readonly stateSha256:OperationalDigest;
}
export type OperationalChange={readonly op:'put';readonly key:string;readonly value:JsonValue}|{readonly op:'delete';readonly key:string};
export interface OperationalTransaction {readonly expectedRevision:number;readonly expectedStateSha256:OperationalDigest;readonly changes:readonly OperationalChange[]}
export interface OperationalEvent {
  readonly format:'sflow.sgos.operational-event';readonly formatVersion:1;readonly storeId:string;readonly revision:number;
  readonly priorEventSha256:OperationalDigest|null;readonly beforeStateSha256:OperationalDigest;readonly afterEntriesSha256:OperationalDigest;
  readonly operation:'transact'|'rollback';readonly changes:readonly OperationalChange[];readonly rollbackRevision?:number;
  readonly eventSha256:OperationalDigest;
}
export interface OperationalBackup {readonly format:'sflow.sgos.operational-backup';readonly formatVersion:1;readonly profile:string;
  readonly storeId:string;readonly events:readonly OperationalEvent[];readonly head:OperationalState;readonly backupSha256:OperationalDigest}
export interface OperationalCapabilities {
  readonly authorityEligible:false;readonly compareAndSwap:true;readonly appendOnlyLineage:true;readonly serializedWriters:true;
  readonly livenessRecovery:true;readonly boundedRecords:true;readonly schemaValidation:true;readonly backupRestore:true;readonly rollback:true;
}
export interface OperationalDescriptor {readonly spiVersion:1;readonly role:'operational';readonly profile:string;readonly storeId:string;
  readonly durability:'ephemeral-reconstructable'|'durable-reconstructable';readonly authorityEligible:false;
  readonly maximumEntries:number;readonly maximumBytes:number;readonly maximumEvents?:number;readonly purposes:readonly string[]}
export interface OperationalRestorePlan {readonly kind:'sgos-operational-restore-plan';readonly storeId:string;readonly profile:string;
  readonly mode:'noop'|'fast-forward';readonly beforeStateSha256:OperationalDigest;readonly afterStateSha256:OperationalDigest;
  readonly backupSha256:OperationalDigest;readonly confirmationSha256:OperationalDigest}
export interface OperationalRollbackPlan {readonly kind:'sgos-operational-rollback-plan';readonly storeId:string;readonly profile:string;
  readonly beforeRevision:number;readonly beforeStateSha256:OperationalDigest;readonly targetRevision:number;
  readonly targetStateSha256:OperationalDigest;readonly confirmationSha256:OperationalDigest}
export interface OperationalStore {
  readonly spiVersion:1;readonly role:'operational';readonly profile:string;readonly storeId:string;readonly capabilities:OperationalCapabilities;
  descriptor():OperationalDescriptor;
  doctor():Promise<{readonly status:'ready'|'corrupt';readonly profile:string;readonly storeId:string;readonly revision:number;
    readonly durability:'ephemeral-reconstructable'|'durable-reconstructable';readonly authorityEligible:false}>;
  read():Promise<OperationalState>;transact(input:OperationalTransaction):Promise<OperationalState>;
  verify():Promise<{readonly valid:true;readonly profile:string;readonly storeId:string;readonly revision:number;readonly stateSha256:OperationalDigest;readonly eventCount:number}>;
  exportBackup():Promise<OperationalBackup>;planRestore(backup:OperationalBackup):Promise<OperationalRestorePlan>;
  restore(input:{readonly backup:OperationalBackup;readonly confirmationSha256:OperationalDigest}):Promise<{readonly restored:boolean;
    readonly mode:'noop'|'fast-forward';readonly storeId:string;readonly profile:string;readonly revision:number;readonly stateSha256:OperationalDigest;readonly planSha256:OperationalDigest}>;
  planRollback(revision:number):Promise<OperationalRollbackPlan>;
  rollback(input:{readonly revision:number;readonly confirmationSha256:OperationalDigest}):Promise<{readonly rolledBack:true;
    readonly storeId:string;readonly profile:string;readonly targetRevision:number;readonly revision:number;readonly stateSha256:OperationalDigest;readonly planSha256:OperationalDigest}>;
}
export declare const SGOS_OPERATIONAL_STORE_SPI_VERSION:1;
export declare const SGOS_OPERATIONAL_STORE_METHODS:readonly (keyof OperationalStore)[];
export declare const SGOS_OPERATIONAL_STORE_CAPABILITIES:Readonly<OperationalCapabilities>;
export declare function assertSgosOperationalStoreAdapter<T extends OperationalStore>(adapter:T):T;
export declare function assertSgosOperationalStoreSelection<T extends OperationalStore>(adapter:T,selection:{readonly purpose:'simulation'|'test';
  readonly programStorageProfileSha256:OperationalDigest;readonly selectedStorageProfileSha256:OperationalDigest}):T;
