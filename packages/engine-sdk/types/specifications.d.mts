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

/** Candidate native-v2 claim values. The clock checkpoint does not grant retention/approval. */
export declare const TEXT_VALUE_SYNTAX_PROFILE:'sflow-text-values/utf8-sha256-v1';
export interface SpecificationTextValues {readonly profile:typeof TEXT_VALUE_SYNTAX_PROFILE;
  readonly byteLengthUtf8:(text:string)=>number;readonly sha256Utf8:(text:string)=>string}
export declare const SPECIFICATION_CLAIM_TIMESTAMP_REQUEST:Readonly<{kind:'specification-claim-timestamp';version:1}>;
export type ClaimTimestampRequest=typeof SPECIFICATION_CLAIM_TIMESTAMP_REQUEST;
export type Fulfillment='new'|'modified'|'existing'|'removed'|'test-only'|'document'|'configuration'|'evidence';
export declare const FULFILLMENT_TYPES:readonly Fulfillment[];
export interface PlannedSpecificationClaim {readonly expectedPaths:readonly string[];readonly tests:readonly string[];
  readonly testDisposition:'applicable'|'not-applicable'|'non-test'|'unspecified';readonly testReason:string|null;
  readonly verificationCriterion?:string;readonly deviation:string|null;readonly fulfillment?:Fulfillment;
  readonly steps?:readonly string[];readonly observableResult?:string}
export interface ObservedSpecificationClaim {readonly observedPaths:readonly string[];readonly testResults:readonly string[];
  readonly commits:readonly string[];readonly verdict:'matched'|'partial'|'missing'|'deviated'|'unplanned';readonly deviation:string|null}
export interface SpecificationSupportingFile {readonly path:string;readonly class:string;readonly reason:string}
export interface PlannedSpecificationClaimMap {readonly schemaVersion:2;readonly kind:'planned';readonly recordedAt:string;
  readonly claims:Readonly<Record<string,PlannedSpecificationClaim>>;readonly supportingFiles?:readonly string[];
  readonly supportingFileDetails?:readonly SpecificationSupportingFile[];readonly verificationContracts?:readonly VerificationContract[]}
export interface ObservedSpecificationClaimMap {readonly schemaVersion:2;readonly kind:'observed';readonly recordedAt:string;
  readonly claims:Readonly<Record<string,ObservedSpecificationClaim>>}
export type SpecificationClaimMap=PlannedSpecificationClaimMap|ObservedSpecificationClaimMap;
export interface ClaimNormalizationOptions {readonly kind:'planned'|'observed';readonly clauseIds?:readonly string[];
  readonly policy?:Readonly<Record<string,unknown>>;readonly plannedClaims?:Readonly<Record<string,VerificationClaim>>}
export interface PlannedClaimOptions {readonly clauseIds?:readonly string[];readonly clauses?:readonly {readonly id:string;readonly verification?:ClauseVerification}[];
  readonly policy?:Readonly<Record<string,unknown>>;readonly evidenceRoot?:string|null;readonly requireComplete?:boolean}
export interface PlannedClaimDerivation {readonly claimMap:PlannedSpecificationClaimMap;readonly supportingFiles:readonly string[];
  readonly supportingFileDetails:readonly SpecificationSupportingFile[];readonly missingClauseIds:readonly string[];readonly missingTestClauseIds:readonly string[]}
export interface PlannedClaimInspection extends Omit<PlannedClaimDerivation,'claimMap'> {readonly valid:boolean;readonly diagnostics:readonly DraftDiagnostic[];
  readonly diagnosticSummary:{readonly maximum:256;readonly omitted:number;readonly complete:boolean};readonly claimMap:PlannedSpecificationClaimMap|null}
export interface SpecificationClaimValues {
  normalizeClaimMapReplay(value:unknown,options:ClaimNormalizationOptions):Generator<ClaimTimestampRequest,SpecificationClaimMap,string>;
  inspectPlannedClaimMapReplay(markdown:string,options?:PlannedClaimOptions):Generator<ClaimTimestampRequest,PlannedClaimInspection,string>;
  derivePlannedClaimMapReplay(markdown:string,options?:PlannedClaimOptions):Generator<ClaimTimestampRequest,PlannedClaimDerivation,string>;
  /** commits retain their native full-Git-SHA meaning; this is not a generic source-revision codec. */
  deriveObservedClaimMapReplay(planned:unknown,delivery?:unknown,options?:{readonly clauseIds?:readonly string[];readonly policy?:Readonly<Record<string,unknown>>;
    readonly generationCommit?:string|null;readonly requireSourceBindings?:boolean}):Generator<ClaimTimestampRequest,ObservedSpecificationClaimMap,string>;
  validatePlannedEvidenceTypes(claims:Readonly<Record<string,VerificationClaim>>,options?:{readonly evidenceRoot?:string|null}):void;
  planSupportingFiles(markdown:string):SpecificationSupportingFile[];
  testOnlyClaimEvidence(id:string,plan:VerificationClaim|null,claim:{readonly observedPaths?:readonly string[];readonly testResults?:readonly string[]}|null,
    options?:{readonly complete?:boolean}):boolean;
}
export declare function specificationClaimPolicies(paths:VerificationPathSyntax,values:SpecificationTextValues):Readonly<SpecificationClaimValues>;
export declare const SPECIFICATION_CLAIM_MAP_SCHEMA:Readonly<{id:'specification-claim-map';currentVersion:2;minimumReadableVersion:1;
  maximumReadableVersion:2;unversionedAs:null;immutable:true;migrationPolicy:'migrate-on-read'}>;
