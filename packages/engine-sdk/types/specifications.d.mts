/** These values do not authenticate source bytes, retain evidence or grant publication/approval. */
export declare const TEXT_DIGEST_PROFILE:'sflow-text-digests/sha256-utf8-v1';
export interface SpecificationDigests { readonly profile:typeof TEXT_DIGEST_PROFILE; readonly sha256Utf8:(text:string)=>string }
export interface ClauseVerification { readonly methods:readonly VerificationMethod[]; readonly criterionId:string|null }
export interface SpecificationClause { readonly id:string; readonly namespace:string; readonly type:string; readonly number:number;
  readonly anchor:string; readonly source:{readonly path:string|null;readonly line:number}; readonly body:string;
  readonly bodySha256:string; readonly dependsOn:readonly string[]; readonly verification?:ClauseVerification }
export type ExternalSpecificationClause=Readonly<Pick<SpecificationClause,'id'>&Partial<Omit<SpecificationClause,'id'>>>;
export interface ClauseOptions { readonly sourcePath?:string|null; readonly namespace?:string|null;
  readonly limits?:{readonly maxClausesPerArtifact:number;readonly maxDependenciesPerClause:number};
  readonly externalClauseIds?:readonly string[]; readonly externalClauses?:readonly ExternalSpecificationClause[] }
export interface SpecificationIndexSource { readonly path:string; readonly sha256:string; readonly bytes:number }
export interface SpecificationIndex { readonly schemaVersion:1; readonly workId:string|null; readonly phase:string|null;
  readonly generation:number; readonly source:SpecificationIndexSource; readonly clauses:readonly SpecificationClause[]; readonly indexSha256:string }
export interface SpecificationIndexInputs { readonly workId?:string|null;readonly phase?:string|null;readonly generation?:number|string|null;
  readonly source:SpecificationIndexSource; readonly clauses:readonly SpecificationClause[] }
export interface SpecificationValues {
  extractClauses(markdown:string,options?:ClauseOptions):SpecificationClause[];
  specificationIndexRecord(inputs:SpecificationIndexInputs):SpecificationIndex;
}
export declare function specificationValuePolicies(digests:SpecificationDigests):Readonly<SpecificationValues>;
export declare function ignoredRanges(markdown:string,options?:{readonly includeInlineCode?:boolean}):number[][];
export declare function isIgnored(index:number,ranges:readonly (readonly number[])[]):boolean;
export declare function clauseReferences(text:unknown):string[];
export declare function plannedClaimSource(markdown:string):string;
export declare function canonicalJson(value:unknown):string;
export declare const SPECIFICATION_INDEX_SCHEMA:Readonly<{id:'specification-index';currentVersion:1;minimumReadableVersion:1;
  maximumReadableVersion:1;unversionedAs:null;immutable:true;migrationPolicy:'migrate-on-read'}>;
export type VerificationMethod='test'|'inspection'|'visual';
export declare const VERIFICATION_METHODS:readonly VerificationMethod[];
export interface VerificationSlot { readonly slot:string;readonly method:VerificationMethod;readonly role:'primary'|'supporting';
  readonly witness:{readonly path?:string;readonly paths?:readonly string[];readonly target?:string};readonly requiredAssurance:string|null }
export interface VerificationContract { readonly clauseId:string;readonly combination:'all'|'any';readonly reason?:string;
  readonly slots:readonly VerificationSlot[];readonly stated?:boolean }
export interface VerificationClaim {readonly tests?:readonly string[];readonly expectedPaths?:readonly string[];readonly testDisposition?:string;
  readonly fulfillment?:string;readonly verificationCriterion?:string}
export interface DraftDiagnostic {readonly code:string;readonly message:string;readonly line:number|null;readonly clauseId:string|null;
  readonly field:string|null;readonly details:Readonly<Record<string,unknown>>}
export interface VerificationContracts {
  proseVerificationDeclarations(markdown:string):{method:string;clauseIds:string[];line:number}[];
  validateRetainedEvidenceDeclarations(markdown:string,claims:Readonly<Record<string,VerificationClaim>>,options?:{readonly evidenceRoot?:string}):void;
  parseVerificationContracts(markdown:string,options?:{readonly clauseIds?:readonly string[];readonly plannedClaims?:Readonly<Record<string,VerificationClaim>>;
    readonly diagnostics?:DraftDiagnostic[]|null}):VerificationContract[];
  normalizeVerificationContracts(value:unknown):VerificationContract[];
  mergedVerificationContracts(records?:readonly {readonly verificationContracts?:readonly VerificationContract[]}[]):Map<string,VerificationContract>;
  effectiveContract(clauseId:string,contracts:ReadonlyMap<string,VerificationContract>,claim?:VerificationClaim|null):VerificationContract|null;
  contractRequiresTestTag(contract:VerificationContract|null):boolean;
  testSlotFor(contract:VerificationContract|null,witness:{readonly testSource:string}):VerificationSlot|null;
  contractSha256(contract:VerificationContract|null):string|null;
  witnessMappingCore(witness:Readonly<Record<string,unknown>>,binding:{readonly clauseBodySha256:string;readonly contract:VerificationContract|null}):Record<string,unknown>;
  witnessMappingSha256(core:unknown):string;
}
export declare const CONFIGURATION_PATH_SYNTAX:'sflow-configuration-path-syntax/v1';
export declare const CONFIGURATION_PATH_SYNTAX_V2:'sflow-configuration-path-syntax/v2';
/** The frozen v1/v2 path-value capability used by other kernel configuration rules; no I/O methods. */
export interface VerificationPathSyntax {
  readonly profile:typeof CONFIGURATION_PATH_SYNTAX|typeof CONFIGURATION_PATH_SYNTAX_V2;readonly grammar:'posix'|'win32';
  readonly isAbsolute:(value:string)=>boolean;readonly normalize:(value:string)=>string;readonly parse:(value:string)=>{readonly root:string};
  readonly posixIsAbsolute:(value:string)=>boolean;readonly posixNormalize:(value:string)=>string;readonly posixBasename:(value:string)=>string;
  readonly toPosix:(value:string)=>string;readonly posixDirname?:(value:string)=>string;readonly posixRelative?:(from:string,to:string)=>string;
  readonly win32IsAbsolute?:(value:string)=>boolean;
}
export declare function verificationContractPolicies(paths:VerificationPathSyntax,digests:SpecificationDigests):Readonly<VerificationContracts>;
export declare function parseVerificationIntent(markdown:string,clauses?:readonly {readonly id:string;readonly verification?:ClauseVerification}[],
  options?:{readonly externalClauses?:readonly {readonly id:string;readonly verification?:ClauseVerification}[]}):Map<string,ClauseVerification>;
export declare function nonTestVerification(clauseId:string,claim:VerificationClaim|null,contracts:ReadonlyMap<string,VerificationContract>,intent?:ClauseVerification|null):VerificationContract|null;
export declare function validatePlannedVerification(claims:Readonly<Record<string,VerificationClaim>>,contracts?:readonly VerificationContract[],
  clauses?:readonly {readonly id:string;readonly verification?:ClauseVerification}[]):void;
export declare const MAX_DRAFT_DIAGNOSTICS:256;
export declare function draftDiagnosticSummary(diagnostics:readonly DraftDiagnostic[]):{maximum:256;omitted:number;complete:boolean};
export declare function collectDraftDiagnostic(diagnostics:DraftDiagnostic[],error:{readonly message:string;readonly code?:string;readonly details?:object},location?:object):void;
export declare function inspectDraftValue<T>(diagnostics:DraftDiagnostic[],read:()=>T,location?:object):{valid:true;value:T}|{valid:false;value:null};
export declare function shown(value:unknown):string;
export declare function pathDefect(value:unknown):string|null;
