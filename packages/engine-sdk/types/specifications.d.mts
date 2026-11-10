/** These values do not authenticate source bytes, retain evidence or grant publication/approval. */
export declare const TEXT_DIGEST_PROFILE:'sflow-text-digests/sha256-utf8-v1';
export interface SpecificationDigests { readonly profile:typeof TEXT_DIGEST_PROFILE; readonly sha256Utf8:(text:string)=>string }
/** Text analysis records associations and gaps; it does not execute tests or accept requirements. */
export declare const JAVASCRIPT_DECLARATION_SCHEMA:'javascript-test-v2';
export interface JavaScriptDeclarationOptions {readonly sourcePath?:string;readonly framework?:string}
export interface JavaScriptSourceToken {readonly type:string;readonly start:number;readonly end:number;readonly line:number;readonly [key:string]:unknown}
export interface JavaScriptDeclarationGap {readonly code:string;readonly message:string}
export interface JavaScriptAssertionObservations {readonly count:number;readonly tautological:number;readonly negative:boolean;
  readonly boundary:boolean;readonly nullability:boolean;readonly adequacy:'missing'|'tautological'|'adequate';readonly subjects:readonly string[]}
export interface JavaScriptTestDeclaration {readonly schema:typeof JAVASCRIPT_DECLARATION_SCHEMA;readonly sourcePath:string|undefined;
  readonly framework:string|undefined;readonly suitePath:readonly (string|null)[];readonly name:string|null;
  readonly logicalTestId:string;readonly line:number;readonly span:{readonly start:number;readonly end:number};readonly declarationSha256:string;
  readonly modifiers:readonly string[];readonly skipped:boolean;readonly focused:boolean;readonly clauseIds:readonly string[];
  readonly parameters:null|{readonly kind:'static'|'dynamic';readonly count:number|null;readonly titlePattern:string|null};
  readonly assertions:JavaScriptAssertionObservations;readonly gaps:readonly JavaScriptDeclarationGap[]}
export interface JavaScriptDeclarationResult {readonly schema:typeof JAVASCRIPT_DECLARATION_SCHEMA;readonly sourcePath:string|undefined;
  readonly framework:string|undefined;readonly declarations:readonly JavaScriptTestDeclaration[];
  readonly unattachedTags:readonly (JavaScriptDeclarationGap&{readonly line:number;readonly clauseIds:readonly string[]})[];
  readonly fileGaps:readonly JavaScriptDeclarationGap[]}
export interface JavaScriptDeclarationValues {scanJavaScriptDeclarations(source:string,options?:JavaScriptDeclarationOptions):JavaScriptDeclarationResult}
export declare function javascriptDeclarationPolicies(digests:SpecificationDigests):Readonly<JavaScriptDeclarationValues>;
export declare function tokenizeJavaScript(source:string):JavaScriptSourceToken[];
export declare function eachTitlePattern(template:string):string|null;
export declare function analyzeTestDeclarationAssertions(tokens:readonly JavaScriptSourceToken[],callOpen:number,callClose:number,source?:string):JavaScriptAssertionObservations;
export interface SourceClauseTag {readonly clauseId:string;readonly line:number;readonly tag:string}
export declare function javascriptSourceComments(source:string,options?:{readonly jsx?:boolean}):Readonly<Record<string,unknown>>[];
export declare function scanSourceClauseTags(source:string,options?:{readonly legacy?:boolean;readonly sourcePath?:string|null}):SourceClauseTag[];
export declare function isQualifiedAcceptanceId(value:unknown):boolean;
export declare function acceptanceTagsInComment(text:unknown):string[];
export declare function adjacentWhitespace(text:unknown):boolean;
export declare function acceptanceTagsAboveLine(lines:readonly unknown[],lineIndex:number):{clauseIds:string[];firstCommentLine:number|null};
export declare function acceptanceTagLines(source:unknown):{clauseId:string;line:number}[];
/** Exact-region/explanation values do not authenticate their inputs or record approval. */
export interface ImplementationChange {readonly oldPath:string|null;readonly newPath:string|null;readonly status:string;readonly untracked?:boolean;readonly [key:string]:unknown}
export interface ImplementationChangeSet {readonly entries:readonly ImplementationChange[];readonly [key:string]:unknown}
export interface ImplementationObligation {readonly clauseId:string;readonly expectedPaths:readonly string[]}
export interface ImplementationTag {readonly clauseId:string;readonly sourcePath:string;readonly line:number|null;readonly tag:string}
export interface ImplementationHunk {readonly beforeStart:number|null;readonly beforeLines:number|null;readonly afterStart:number|null;readonly afterLines:number|null}
export interface PublicDeclaration {readonly line:number;readonly kind:string;readonly name:string;readonly documented:boolean}
export interface ImplementationRegion {readonly path:string;readonly change:'deleted'|'added'|'renamed'|'modified';readonly hunks:readonly ImplementationHunk[];
  readonly symbols:readonly Pick<PublicDeclaration,'name'|'kind'|'line'>[];readonly symbolAssurance:'heuristic'|'unsupported-language'}
export interface ImplementationBinding {readonly clauseId:string;readonly explanation:null|{readonly text:string;readonly path:string;readonly line:number};readonly regions:readonly ImplementationRegion[]}
export interface ImplementationBindingResult {readonly bindings:readonly ImplementationBinding[];readonly bindingsSha256:string;readonly problems:readonly string[];
  readonly problemFindings:readonly {readonly code:string;readonly path:string|null;readonly value:string}[];
  readonly explanationsMissing:readonly {readonly clauseId:string;readonly path:string|null;readonly line:number|null}[]}
export interface ImplementationDiffPreview {readonly files?:readonly {readonly pathAfter?:string|null;readonly pathBefore?:string|null;readonly hunks?:readonly ImplementationHunk[]}[]}
export type ImplementationBindingRequest=Readonly<{kind:'implementation-diff-preview';changeSet:ImplementationChangeSet;contextLines:0;paths:readonly string[]}>
  |Readonly<{kind:'implementation-source';path:string;maximumBytes:2097152}>;
export interface ImplementationBindingValues {
  implementationBindingsReplay(input:{readonly changeSet:ImplementationChangeSet|null;readonly required?:readonly ImplementationObligation[];readonly tags?:readonly ImplementationTag[]}):Generator<ImplementationBindingRequest,ImplementationBindingResult,ImplementationDiffPreview|string|null>;
  bindingsDigest(bindings?:readonly ImplementationBinding[]):string;
}
export declare function implementationBindingPolicies(paths:VerificationPathSyntax,digests:SpecificationDigests):Readonly<ImplementationBindingValues>;
export declare const EXPLANATION_LIMITS:Readonly<{minimum:10;maximum:300}>;
export declare function clauseTagExplanation(line:unknown,clauseId:unknown):string|null;
/** Candidate origin values consume explicit facts. They authenticate no source, phase or person. */
export declare const SOURCE_TAG_ORIGIN_VALUES_PROFILE:'sflow-source-tag-origin-values/v1';
export type SourceTagKind='clause'|'ac';
export interface SourceTagOccurrence {readonly path:string;readonly clauseId:string;readonly line:number;readonly tag?:string}
export interface SourceOriginChange {readonly oldPath:string|null;readonly newPath:string|null;readonly previousRegular:boolean}
export interface SourceOriginPathContext {readonly caseInsensitivePaths:boolean;readonly governedRoots:readonly string[];readonly governedPaths:readonly string[]}
export type SourceOriginLineDelta=Readonly<{side:'removed';path:string|null;line:null;text:string}>|Readonly<{side:'added';path:string;line:number;text:string}>;
export type CarriedTagRequest=Readonly<{kind:'origin-baseline-texts';baseline:string;paths:readonly string[];maximumObjectBytes:16777216;maximumBytes:67108864}>
  |Readonly<{kind:'origin-comment-tags';source:string;path:string}>;
export type StoryTagRequest=Readonly<{kind:'origin-line-deltas';baseline:string;tag:SourceTagKind}>
  |Readonly<{kind:'origin-tracked-paths';paths:readonly string[]}>|Readonly<{kind:'origin-untracked-text';path:string}>;
export interface SourceTagOriginValues {
  readonly profile:typeof SOURCE_TAG_ORIGIN_VALUES_PROFILE;
  carriedTagIdsReplay(input:{readonly baseline:string|null;readonly changes:readonly SourceOriginChange[];readonly occurrences:readonly SourceTagOccurrence[];readonly tag:SourceTagKind}):
    Generator<CarriedTagRequest,Set<string>,ReadonlyMap<string,string>|readonly SourceClauseTag[]>;
  storyTagLinesReplay(input:{readonly baseline:string|null;readonly occurrences:readonly SourceTagOccurrence[];readonly tag:SourceTagKind;readonly pathContext:SourceOriginPathContext}):
    Generator<StoryTagRequest,Set<string>|null,readonly SourceOriginLineDelta[]|ReadonlySet<string>|string>;
}
export declare function sourceTagOriginPolicies(paths:VerificationPathSyntax,roots:readonly string[]):Readonly<SourceTagOriginValues>;
export declare const BINDING_DECISIONS:readonly ('accepted'|'accepted-with-exception')[];
export interface ImplementationBindingDecision {readonly clauseId:string;readonly decision:'accept'|'exception';readonly reason?:string}
export declare function reviewBindings(submitted:{readonly bindings:readonly ImplementationBinding[];readonly bindingsSha256:string}|null,
  requested?:readonly ImplementationBindingDecision[]):null|{bindingsSha256:string;decisions:{clauseId:string;decision:'accepted'|'accepted-with-exception';reason?:string}[]};
export interface CodeDocumentationValues {documentationLanguage(filePath:unknown):string|null;unsupportedSourceLanguage(filePath:unknown):boolean}
export declare function codeDocumentationPolicies(paths:VerificationPathSyntax):Readonly<CodeDocumentationValues>;
export declare function publicDeclarations(source:string,language:string|null):PublicDeclaration[];
export declare function changedDeclarations(declarations:readonly PublicDeclaration[],changedLines:Iterable<number>,sourceLines:readonly string[]|number):PublicDeclaration[];
export declare const POLYGLOT_STRUCTURAL_LANGUAGES:readonly string[];
export declare function maskPolyglotNonCode(source:string,language:string):string;
export declare function extractPolyglotSymbols(source:string,language:string):{kind:string;name:string;line:number}[];
export declare function extractPolyglotImports(source:string,language:string):{target:string;line:number}[];
export interface PolyglotPathValues {resolvePolyglotLocal(from:string,target:string,language:string,knownPaths:Iterable<string>):string|null}
export declare function polyglotPathPolicies(paths:VerificationPathSyntax&{readonly profile:typeof CONFIGURATION_PATH_SYNTAX_V2}):Readonly<PolyglotPathValues>;
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
  readonly fulfillment?:string;readonly verificationCriterion?:string;readonly steps?:readonly string[]}
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
  requiredAcceptanceFromPlan(clauseIds:readonly string[],claims:Readonly<Record<string,VerificationClaim>>,contracts:ReadonlyMap<string,VerificationContract>,phaseId:string):string[];
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
  mergeObservedClaimRecords(maps?:readonly ObservedCoverageRecord[],planned?:Readonly<Record<string,CoveragePlannedClaim>>,
    options?:{readonly workflow?:Readonly<Record<string,unknown>>|null}):Readonly<Record<string,ObservedSpecificationClaim>>;
  evaluateSpecCoverageReplay(records:SpecificationCoverageRecords,changedPaths?:readonly string[],policy?:Readonly<Record<string,unknown>>,
    options?:{readonly verifyEvidence?:boolean;readonly workflow?:Readonly<Record<string,unknown>>|null}):Generator<CoverageEvidenceRequest,SpecificationCoverageResult,boolean>;
  evaluateSpecAcceptance(records:SpecificationCoverageRecords,policy?:Readonly<Record<string,unknown>>,expected?:{
    readonly workId?:string;readonly phase?:string;readonly generation?:number;readonly sourceTreeSha256?:string;readonly commandSetSha256?:string}):SpecificationAcceptanceResult;
  candidateSpecificationCoverageReplay(config:Readonly<Record<string,unknown>>,workflow:Readonly<Record<string,unknown>>,phase:Readonly<Record<string,unknown>>,delivery:Readonly<Record<string,unknown>>,
    options:{readonly pathContext:SourceOriginPathContext}):Generator<CandidateCoverageRecordRequest|ClaimTimestampRequest,CandidateSpecificationCoverage|null,Required<SpecificationCoverageRecords>|string>;
}
export interface CoverageMetadata {readonly schemaVersion?:number;readonly kind?:string;readonly workId?:string;readonly phase?:string;readonly generation?:number;
  readonly recordedAt?:string;readonly completedAt?:string;readonly source?:{readonly path?:string;readonly sha256?:string;readonly bytes?:number}}
export interface CoveragePlannedClaim extends Partial<PlannedSpecificationClaim> {readonly obligations?:readonly (CoveragePlannedClaim&{readonly owner?:string|null})[]}
export interface PlannedCoverageRecord extends CoverageMetadata {readonly claims:Readonly<Record<string,CoveragePlannedClaim>>;
  readonly supportingFiles?:readonly string[];readonly amendment?:boolean;readonly accountedPaths?:Readonly<Record<string,readonly string[]>>;
  readonly verificationContracts?:readonly VerificationContract[]}
export interface ObservedCoverageRecord extends CoverageMetadata {readonly claims:Readonly<Record<string,Partial<ObservedSpecificationClaim>>>}
export interface CoverageAcceptanceRecord extends CoverageMetadata {readonly recordSha256?:string;readonly status?:string;readonly sourceChangedDuringRun?:boolean;
  readonly sourceTreeSha256?:string;readonly commandSetSha256?:string;readonly commands?:readonly {readonly id:string;readonly status:string}[]}
export interface SpecificationCoverageRecords {readonly indexes?:readonly (CoverageMetadata&{readonly clauses?:readonly {readonly id:string;readonly verification?:ClauseVerification}[]})[];
  readonly planned?:readonly PlannedCoverageRecord[];readonly observed?:readonly ObservedCoverageRecord[];readonly acceptance?:readonly CoverageAcceptanceRecord[]}
export interface SpecificationCoverageResult {readonly schemaVersion:1;readonly mode:string;readonly totals:{readonly clauses:number;readonly planned:number;readonly observed:number;readonly changedPaths:number};
  readonly unimplemented:readonly string[];readonly testPresenceOnly:readonly string[];readonly unclaimedChangedPaths:readonly string[];readonly supportingChangedPaths:readonly string[];
  readonly withdrawnButClaimed:readonly string[];readonly invalidEvidence:readonly string[];readonly complete:boolean;readonly severity:'pass'|'warning'|'error'}
export type CoverageEvidenceRequest={readonly kind:'specification-coverage-path';readonly path:string}|{readonly kind:'specification-coverage-commit';readonly commit:string};
export interface SpecificationAcceptanceResult {readonly schemaVersion:1;readonly mode:string;readonly complete:boolean;readonly missingPlannedTests:readonly string[];
  readonly missingObservedTests:readonly string[];readonly failedCommands:readonly string[];readonly missingRun:boolean;readonly staleRunReasons:readonly string[];readonly latestRunAt:string|null}
export interface CandidateCoverageRecordRequest {readonly kind:'candidate-coverage-records';readonly policy:Readonly<Record<string,unknown>>;
  readonly options:{readonly requireCommitted:false;readonly throughPhase:string|null;readonly excludeObservedPhase:string}}
export interface CandidateSpecificationCoverage {readonly profile:'sflow-candidate-specification-coverage/v1';readonly status:'ready'|'advisory'|'correction-required';
  readonly enforcement:'enforce'|'qualified-ending';readonly final:boolean;readonly owner:string;readonly coverage:SpecificationCoverageResult;readonly open:readonly string[];
  readonly claimGaps:readonly {readonly clauseId:string;readonly verdict:string;readonly missingSourcePaths:readonly string[];readonly missingSourceBindings:readonly string[];
    readonly missingTestPaths:readonly string[];readonly missingConfigurationPaths:readonly string[]}[]}
export declare function codeCoverageEnforcement(policy?:Readonly<Record<string,unknown>>):'enforce'|'qualified-ending'|null;
export declare function plannedClaimsForObservedPhase(workflow:Readonly<Record<string,unknown>>|null,phaseId:string,planned?:readonly PlannedCoverageRecord[]):Readonly<Record<string,CoveragePlannedClaim>>;
export declare function selectActiveSpecRecords(records:SpecificationCoverageRecords,workflow?:Readonly<Record<string,unknown>>|null):Required<SpecificationCoverageRecords>;
export declare function specificationClaimPolicies(paths:VerificationPathSyntax,values:SpecificationTextValues):Readonly<SpecificationClaimValues>;
/** Logical views only. Original accepted plan/publication proof remains a namespace owner. */
export declare const REPOSITORY_PLAN_PROFILE:'sflow-repository-plan/v1';
export declare const REPOSITORY_PLAN_VALUES_PROFILE:'sflow-repository-plan-values/v1';
export interface RepositoryPlanRoot {readonly repositoryId:string;readonly pathPrefix:string}
export interface RepositoryClaimProjection {readonly id:string;readonly claims:Readonly<Record<string,PlannedSpecificationClaim>>;
  readonly supportingFiles:readonly string[];readonly supportingFileDetails:readonly SpecificationSupportingFile[]}
export interface RepositoryPlan {readonly schemaVersion:1;readonly format:typeof REPOSITORY_PLAN_PROFILE;
  readonly roots:readonly RepositoryPlanRoot[];readonly repositories:readonly RepositoryClaimProjection[]}
export interface RepositoryPlanContext {readonly definition?:Readonly<Record<string,unknown>>;readonly workflow?:Readonly<Record<string,unknown>>}
export interface RepositoryPlanValues {readonly profile:typeof REPOSITORY_PLAN_VALUES_PROFILE;
  deriveRepositoryPlan(markdown:string,planned:PlannedSpecificationClaimMap,context?:RepositoryPlanContext):RepositoryPlan|null;
  repositoryPlanValue(value:unknown):RepositoryPlan;
  repositoryPlanProjection(value:RepositoryPlan,repositoryId:string):RepositoryClaimProjection;
  assertRepositoryPlanSources(value:RepositoryPlan|null,phaseId:string,repositories:readonly string[]):void;
  repositoryPlanTestLocation(value:RepositoryPlan,path:string,context?:RepositoryPlanContext):{repositoryId:string;path:string}|null}
export declare function repositoryPlanPolicies(paths:VerificationPathSyntax,roots:readonly string[]):Readonly<RepositoryPlanValues>;
/** Actual declaration/run values; these functions confer no lifecycle or human authority. */
export type TestWitnessOutcome='inconclusive'|'missing'|'ambiguous'|'failed'|'unverified-skipped'|'flaky'|'passed';
export interface TestOccurrence {readonly name?:string|null;readonly outcome:'passed'|'failed'|'skipped';readonly flaky?:boolean;
  readonly suitePath?:readonly string[];readonly ancestorTitles?:readonly string[];readonly className?:string|null;readonly file?:string;
  readonly line?:number;readonly project?:string|null;readonly durationMs?:number|null}
export interface JoinableTestDeclaration {readonly sourcePath?:string;readonly framework?:string;readonly name?:string;
  readonly suitePath?:readonly string[];readonly line?:number;readonly className?:string;readonly packageName?:string;
  readonly classPath?:readonly string[];readonly methodName?:string;readonly gaps?:readonly {readonly code:string}[];
  readonly parameters?:{readonly count:number|null;readonly titlePattern?:string}|null}
export interface JoinedTestDeclaration {readonly outcome:TestWitnessOutcome;readonly reasons:readonly string[];
  readonly occurrences:readonly {readonly name:string|null;readonly outcome:string;readonly flaky:boolean}[];readonly expected?:number|null}
export declare const WITNESS_OUTCOMES:readonly TestWitnessOutcome[];
export declare const IDENTITY_ASSURANCE:readonly ('declared'|'source-bound')[];
export declare const EXECUTION_ASSURANCE:readonly ('none'|'module-observed'|'exact-local-observed'|'exact-authenticated')[];
export declare function combinedAssurance(input:{readonly identity:string;readonly execution:string;readonly passed:boolean}):string;
export declare function joinDeclaration(declaration:JoinableTestDeclaration,occurrences:readonly TestOccurrence[],options?:{
  readonly language?:string;readonly runner?:string|null;readonly run?:{readonly completed:boolean;readonly succeeded:boolean}}):JoinedTestDeclaration;
export interface AcceptanceTestWitness {readonly clauseId:string;readonly testSource:string;readonly profile?:string;readonly commandId?:string|null;
  readonly identity?:{readonly className?:string;readonly methodName?:string;readonly signature?:string;readonly framework?:string;
    readonly suitePath?:readonly string[];readonly name?:string}|null;readonly logicalTestId?:string|null;readonly declarationSha256?:string|null;
  readonly supportSha256?:string|null;readonly line?:number|null;readonly parameters?:JoinableTestDeclaration['parameters'];
  readonly skipped?:boolean;readonly exact?:boolean;readonly gaps?:readonly string[];readonly resultAdapter?:string|null;
  readonly assertions?:Readonly<Record<string,unknown>>;readonly enforceAssertionAdequacy?:boolean}
export interface WitnessAttempt {readonly attemptId?:string|null;readonly terminal?:boolean;readonly timedOut?:boolean;readonly status:string;
  readonly exitCode?:number|null;readonly tests?:Readonly<Record<string,number>>|null;readonly adapter?:string;readonly occurrences?:readonly TestOccurrence[]}
export interface TestWitnessResult {readonly label:string;readonly clauseId:string;readonly testSource:string;readonly profile:string;
  readonly commandId:string|null;readonly identityKey:string|null;readonly requiredAssurance:string;readonly attemptId:string|null;
  readonly outcome:TestWitnessOutcome|'not-run'|'unavailable'|'passed-with-skips';readonly status:'met'|'failed'|'missing'|'pending'|'inconclusive';
  readonly identity:'declared'|'source-bound';readonly execution:string;readonly assurance:string;readonly shortfall:boolean;readonly reasons:readonly string[];
  readonly occurrences?:JoinedTestDeclaration['occurrences'];readonly assertions?:Readonly<Record<string,unknown>>;readonly skipped?:number;readonly expected?:number|null}
export declare function witnessLabel(witness:AcceptanceTestWitness):string;
export declare function witnessResult(witness:AcceptanceTestWitness,attempt:WitnessAttempt|null,options?:{
  readonly submitted?:boolean;readonly enforceAssertionAdequacy?:boolean}):TestWitnessResult;
export interface AggregateTestWitnesses {readonly status:string;readonly assurance:string;readonly identity:string;readonly execution:string}
export declare function aggregateWitnesses(results:readonly TestWitnessResult[]):AggregateTestWitnesses;
export declare function criterionResults(results:readonly TestWitnessResult[]):(AggregateTestWitnesses&{clauseId:string;witnesses:TestWitnessResult[]})[];
export interface WitnessDiscoveryOptions {readonly testPaths:readonly string[];readonly sourcePaths?:readonly string[];readonly requiredAcIds?:readonly string[];
  readonly bindings?:readonly {readonly clauseId:string;readonly testSource:string}[];readonly othersTag?:(value:{testSource:string;clauseId:string;line:number|null})=>boolean;
  readonly executionMode?:string}
export interface WitnessDiscoveryResult {readonly witnesses:readonly AcceptanceTestWitness[];readonly unattachedTags:readonly Readonly<Record<string,unknown>>[];
  readonly profiles:readonly {readonly testSource:string;readonly profile:string;readonly commandId:string|null;readonly resultAdapter:string|null;readonly ceiling:string}[];
  readonly errors:readonly string[];readonly errorFindings:readonly {readonly code:string;readonly value:string}[]}
export type WitnessCommand=Readonly<Record<string,unknown>>;
export interface WitnessDeclarationObservation {readonly declarations:readonly (JoinableTestDeclaration&{readonly clauseIds:readonly string[];readonly logicalTestId:string;readonly declarationSha256:string})[];
  readonly unattachedTags:readonly Readonly<Record<string,unknown>>[];readonly fileGaps:Readonly<Record<string,readonly {readonly code:string;readonly message:string}[]>>}
export type WitnessDiscoveryRequest={readonly kind:'witness-test-commands';readonly phase:Readonly<Record<string,unknown>>;readonly executionMode:string}
  |{readonly kind:'witness-command-for-file';readonly commands:readonly WitnessCommand[];readonly file:string}
  |{readonly kind:'witness-declarations';readonly profile:string;readonly files:readonly string[]};
export interface WitnessRunnerFacts {readonly profile:'sflow-test-delivery-policy-facts/v1';readonly ecosystems:readonly string[];
  posixExtname(value:string):string;ecosystemOfAdapter(value:unknown):string|null;ecosystemOfProgram(value:unknown):string|null}
export interface AcceptanceWitnessValues {
  discoverAcceptanceWitnessesReplay(phase:Readonly<Record<string,unknown>>,options:WitnessDiscoveryOptions):Generator<WitnessDiscoveryRequest,WitnessDiscoveryResult,readonly WitnessCommand[]|WitnessCommand|null|WitnessDeclarationObservation>;
  commandForTestFileReplay(commands:readonly WitnessCommand[],file:string):Generator<{readonly kind:'witness-command-source';readonly file:string},WitnessCommand|null,string>;
}
export declare function acceptanceWitnessPolicies(paths:VerificationPathSyntax,facts:WitnessRunnerFacts):Readonly<AcceptanceWitnessValues>;
export declare const SPECIFICATION_CLAIM_MAP_SCHEMA:Readonly<{id:'specification-claim-map';currentVersion:2;minimumReadableVersion:1;
  maximumReadableVersion:2;unversionedAs:null;immutable:true;migrationPolicy:'migrate-on-read'}>;

/** Analysis is deterministic evidence, never a claim of semantic completeness or human approval. */
export declare const SPECIFICATION_ANALYSIS_DECLARATIONS:'sflow-specification-analysis-declarations/v1';
export type SpecificationQualityMode='off'|'warn'|'enforce';
export type SpecificationMarkerMode='off'|'warn'|'block';
export type SpecificationChecklistDecision='satisfied'|'exception'|'not-applicable';
export interface SpecificationChecklist {readonly id:string;readonly version:number;
  readonly articles:readonly {readonly id:string;readonly title:string;readonly question:string}[]}
export interface SpecificationChecklistAnswer {readonly article:string;readonly decision:SpecificationChecklistDecision;readonly reason?:string}
export interface SpecificationAnalysisDeclarations {readonly profile:typeof SPECIFICATION_ANALYSIS_DECLARATIONS;
  readonly requiredSections:readonly string[];readonly starterChecklist:SpecificationChecklist}
export interface SpecificationAnalysisFinding {readonly kind:string;readonly message:string;readonly [key:string]:unknown}
export interface SpecificationMarker {readonly question:string;readonly questionHash:string;readonly line:number;readonly raw?:string}
export interface SpecificationMalformedMarker {readonly question:string|null;readonly questionHash:string|null;readonly line:number;readonly raw:string;readonly reason:string}
export interface SpecificationMarkerAnswer {readonly questionHash?:string;readonly question?:string}
export interface SpecificationMarkerSets {readonly open:readonly SpecificationMarker[];
  readonly resolved:readonly Pick<SpecificationMarker,'question'|'questionHash'>[];
  readonly vanished:readonly (Pick<SpecificationMarker,'question'|'questionHash'>&{readonly reason:string})[];
  readonly malformed:readonly Pick<SpecificationMalformedMarker,'line'|'reason'>[]}
export interface SpecificationAnalysisReport {readonly schemaVersion:1;readonly resultType:'specification-quality-analysis';
  readonly binding:{readonly artifactPath:string|null;readonly artifactSha256:string;readonly phase:string|null;readonly generation:number|null;
    readonly policySha256:string;readonly checklist:string};readonly mode:SpecificationQualityMode;readonly clauseCount:number;
  readonly clauseIds:readonly string[];readonly markerCount:number;readonly markers:SpecificationMarkerSets;
  readonly findings:readonly SpecificationAnalysisFinding[];readonly advisories?:readonly SpecificationAnalysisFinding[];
  readonly witnessedClauses?:Readonly<Record<string,unknown>>;readonly scenarioCoverage?:{readonly declared:boolean;readonly scenarioCount:number;readonly rowCount:number};
  readonly truncated?:{readonly dropped:number;readonly disclosure:string};readonly advisoryTruncation?:{readonly dropped:number;readonly disclosure:string};readonly disclaimer:string}
export interface SpecificationAnalysisOptions {readonly artifactPath?:string|null;readonly phase?:string|null;readonly generation?:number|null;
  readonly policy?:Readonly<Record<string,unknown>>;readonly checklist?:SpecificationChecklist;readonly namespace?:string|null;
  readonly previousMarkers?:readonly SpecificationMarker[];readonly answers?:readonly SpecificationMarkerAnswer[];readonly limits?:Readonly<Record<string,number>>}
export interface SpecificationChecklistResult {readonly required:boolean;readonly mode:SpecificationQualityMode;readonly checklist?:string;
  readonly checklistSha256?:string;readonly errors:readonly string[];readonly warnings:readonly string[];readonly decisions:readonly SpecificationChecklistAnswer[]}
export interface SpecificationGateResult {readonly applies:boolean;readonly markerMode:SpecificationMarkerMode;readonly qualityMode:SpecificationQualityMode;
  readonly checklist?:string;readonly report:SpecificationAnalysisReport|null;readonly open:readonly SpecificationMarker[];
  readonly errors:readonly string[];readonly warnings:readonly string[];readonly record:Readonly<Record<string,unknown>>|null}
export interface SpecificationAnalysisValues {
  policyHash(policy:Readonly<Record<string,unknown>>,checklist?:SpecificationChecklist):string;
  witnessedClauseReviewFields(body:string):Readonly<{behavior:string|null;observable:string|null;witness:string|null}>;
  analyzeSpecification(markdown:string,options?:SpecificationAnalysisOptions):SpecificationAnalysisReport;
  evaluateSpecificationQuality(report:SpecificationAnalysisReport,options?:{readonly exclude?:readonly string[]}):{errors:string[];warnings:string[]};
  validateChecklistDecisions(decisions?:readonly SpecificationChecklistAnswer[],options?:{readonly checklist?:SpecificationChecklist;readonly mode?:SpecificationQualityMode}):{errors:string[];warnings:string[]};
  evaluateApprovalChecklist(options?:{readonly policy?:Readonly<Record<string,unknown>>;readonly decisions?:readonly SpecificationChecklistAnswer[];
    readonly authorities?:Readonly<Record<string,unknown>>|null;readonly actor?:Readonly<Record<string,unknown>>|null;readonly checklist?:SpecificationChecklist}):SpecificationChecklistResult;
  specificationGateValue(markdown:string,options?:Omit<SpecificationAnalysisOptions,'checklist'|'limits'>&{readonly markerMode?:SpecificationMarkerMode}):SpecificationGateResult;
}
export declare function specificationAnalysisPolicies(values:SpecificationTextValues,declarations:SpecificationAnalysisDeclarations):Readonly<SpecificationAnalysisValues>;
export declare const WITNESS_TYPES:readonly ('test'|'inspection'|'metric'|'runtime'|'manual')[];
export declare const CHECKLIST_DECISIONS:readonly SpecificationChecklistDecision[];
export declare const MARKER_FINDING_KINDS:readonly string[];
export declare const MARKER_LIMITS:Readonly<{maxQuestionChars:300;maxMarkersPerArtifact:200}>;
export declare function markerQuestionHash(question:unknown):string;
export declare function extractMarkers(markdown:string,options?:{readonly limits?:{readonly maxQuestionChars:number;readonly maxMarkersPerArtifact:number}}):{markers:SpecificationMarker[];malformed:SpecificationMalformedMarker[]};
export declare function reconcileMarkers(options?:{readonly current?:readonly SpecificationMarker[];readonly previous?:readonly SpecificationMarker[];readonly answers?:readonly SpecificationMarkerAnswer[]}):{
  open:SpecificationMarker[];resolved:SpecificationMarker[];vanished:(SpecificationMarker&{reason:string})[]};
export declare function evaluateMarkerPolicy(policy:Readonly<{mode?:SpecificationMarkerMode}>|SpecificationMarkerMode|undefined,
  markers?:{readonly open?:readonly SpecificationMarker[];readonly malformed?:readonly SpecificationMalformedMarker[];readonly vanished?:readonly Pick<SpecificationMarker,'question'>[]}):{mode:SpecificationMarkerMode;errors:string[];warnings:string[]};
export declare function inspectSpecificationScenarios(markdown:string,clauses:readonly Pick<SpecificationClause,'id'|'type'|'body'|'source'>[],
  options?:{readonly required?:boolean;readonly clausesKnown?:boolean}):{findings:SpecificationAnalysisFinding[];advisories:SpecificationAnalysisFinding[];declared:boolean;scenarioCount:number;
    rows:{clauseId:string;scenarioId:string;outcome:string}[]};
