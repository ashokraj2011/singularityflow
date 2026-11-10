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
export declare const SOURCE_TEXT_DIFF_PROFILE:'sflow-source-text-hunks/v1';
export declare const SOURCE_TEXT_DIFF_LIMITS:Readonly<{maximumTextUnits:2097152;maximumWork:2000000;maximumTraceCells:1000000}>;
export interface SourceTextHunk {readonly beforeStart:number;readonly beforeLines:number;readonly afterStart:number;readonly afterLines:number}
export interface SourceTextDiff {readonly profile:typeof SOURCE_TEXT_DIFF_PROFILE;readonly beforeLines:number;readonly afterLines:number;
  readonly hunks:readonly SourceTextHunk[];readonly work:number;readonly traceCells:number}
export declare function sourceTextHunks(before:string,after:string,limits?:{readonly maximumTextUnits?:number;readonly maximumWork?:number;readonly maximumTraceCells?:number}):SourceTextDiff;
