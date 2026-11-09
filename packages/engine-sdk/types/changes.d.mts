/** Explicit value primitives are trusted host capabilities, not request data or Git execution. */
export declare const REPOSITORY_CHANGE_SET_VALUES:'sflow-repository-change-set-values/v1';
export interface ChangeSetValuePrimitives {
  readonly profile:typeof REPOSITORY_CHANGE_SET_VALUES;
  readonly sha256Text:(text:string)=>string;
  readonly compareUtf8:(left:string,right:string)=>number;
}
export interface RepositoryChangeSetCodec {
  readonly compareRepositoryIdentity:(left:unknown,right:unknown)=>number;
  readonly entryOrder:(left:Readonly<Record<string,unknown>>,right:Readonly<Record<string,unknown>>)=>number;
  readonly withEntryIdentity:<T extends Readonly<Record<string,unknown>>>(entry:T)=>T&{readonly changeId:string};
  readonly repositoryChangeSetDigest:(value:unknown)=>string;
  readonly verifyRepositoryChangeSetIntegrity:(value:unknown)=>{readonly valid:boolean;readonly digest:string;readonly entryFailures:readonly unknown[]};
}
/** Construction validates/captures the frozen bindings without calling either primitive. */
export declare function createRepositoryChangeSetCodec(values:ChangeSetValuePrimitives):RepositoryChangeSetCodec;
