import type {JsonValue} from '../namespace.mjs';
import type {SpecificationDigests} from '../specifications.mjs';
export declare const TRP_RISK_CATEGORIES:readonly string[];
export interface TrpRecord {readonly schemaVersion:1;readonly kind:string;readonly id:string;readonly recordSha256:string;
  readonly subject:Readonly<Record<string,JsonValue>>;readonly [key:string]:JsonValue}
export interface TrpAuthorityReceipt {readonly recordSha256:string;readonly principal:string;readonly policyAuthoritySha256:string;
  readonly confirmationSha256:string;readonly capability:'trp-agreement'|'trp-risk-decision'|'trp-scope-confirmation'|'trp-risk-revocation';
  readonly transitions:readonly string[];readonly issuedAt:string;readonly revokedAt:string|null;readonly durable:true;readonly authorizationRef:string}
export interface TrpEvidenceReceipt {readonly recordSha256:string;readonly authenticated:true;readonly reportsAvailable:boolean;readonly verifiedAt:string}
export interface TrpGateInput {
  readonly policy:JsonValue;readonly agreement:TrpRecord|null;readonly subject:Readonly<Record<string,JsonValue>>;readonly operation:string;
  readonly mode?:'current'|'historical';readonly at:string;readonly observations?:readonly TrpRecord[];readonly baselines?:readonly TrpRecord[];
  readonly decisions?:readonly TrpRecord[];readonly selection?:TrpRecord|null;readonly candidateDependencies?:readonly {readonly id:string;readonly sha256:string}[];
  readonly candidateEnvironment?:JsonValue;readonly integrityIssues?:readonly JsonValue[];readonly publicationPending?:boolean;readonly obligationIds?:readonly string[]|null;
  readonly verifyAuthority?:(record:TrpRecord,context:Readonly<Record<string,JsonValue>>)=>TrpAuthorityReceipt;
  readonly verifyEvidence?:(record:TrpRecord,context:Readonly<Record<string,JsonValue>>)=>TrpEvidenceReceipt;
}
export interface TestRecoveryValues {
  readonly TRP_EVALUATOR_VERSION:'trp/1.0';readonly TRP_INTEGRITY_CATEGORIES:readonly string[];readonly TRP_STALE_CATEGORY:'stale-evidence';
  readonly TRP_SCHEMAS:Readonly<Record<string,JsonValue>>;readonly TRP_RECORD_KINDS:readonly string[];readonly TRP_POLICY_SCHEMA:JsonValue;
  trpDigest(value:JsonValue):string;trpEnvironmentDigest(value:JsonValue):string;trpRecordDigest(value:JsonValue):string;
  sealTrpRecord(value:JsonValue):TrpRecord;validateTrpRecord(value:JsonValue,options?:{readonly kind?:string}):TrpRecord;
  trpIssueIdentity(value:{readonly category:string;readonly obligationId:string;readonly message:string;readonly observation?:TrpRecord|null;
    readonly subject?:Readonly<Record<string,JsonValue>>|null}):Readonly<Record<string,string>>;
  /** Original intake wire only; construction does not collect consent, read evidence or grant authority. */
  buildBaselineRiskDecision(agreement:TrpRecord,baseline:TrpRecord,options:{readonly authority:{readonly policy:Readonly<Record<string,JsonValue>>};
    readonly choices:{readonly reason:string;readonly expiresAt:string;readonly followUpOwner:string;readonly remediationRef:string};
    readonly principal:string;readonly planDigest:string;readonly createdAt:string;readonly transitions?:readonly string[];readonly validationEpoch?:number}):TrpRecord;
  evaluateTestRecoveryGate(input:TrpGateInput):TrpRecord;
  /** Value comparison only; a matching baseline does not grant human authority. */
  knownFailureMatches(current:TrpRecord,baseline:TrpRecord,decision:JsonValue,selection:TrpRecord):boolean;
}
/** These rules require actual verifier callbacks; deserialized labels cannot authorize a risk. */
export declare function testRecoveryPolicies(digests:SpecificationDigests):Readonly<TestRecoveryValues>;

export interface NarrowingFilter {readonly option:string;readonly value?:string|null;readonly source?:string;readonly [key:string]:JsonValue|undefined}
export interface NarrowingFocus {readonly path:string;readonly line?:number;readonly name?:string|null}
export interface TestNarrowingFacts {readonly filters?:readonly NarrowingFilter[];readonly focused?:readonly NarrowingFocus[];
  readonly baseline?:number|null;readonly baselineSkipped?:number|null;readonly standing?:{readonly filters:readonly NarrowingFilter[];readonly focused:readonly NarrowingFocus[]};
  readonly addedSkips?:readonly {readonly path:string;readonly added:number}[];readonly paths?:readonly JsonValue[]}
export interface TestNarrowing {readonly reasons:readonly string[];readonly filters:readonly NarrowingFilter[];readonly focused:readonly NarrowingFocus[];
  readonly skipped:number;readonly discovered:number|null;readonly baseline:number|null;readonly shortfall:number;
  readonly standing?:TestNarrowingFacts['standing'];readonly addedSkips?:TestNarrowingFacts['addedSkips'];readonly paths?:readonly JsonValue[]}
export interface TestNarrowingAttempt {readonly attemptId?:string;readonly commandId?:string;readonly status:string;readonly pin?:{readonly sha256?:string}|null;
  readonly narrowing?:TestNarrowing|null}
export interface TestNarrowingRecord {readonly id:string;readonly phase:string;readonly commandId:string;readonly pinSha256:string;readonly narrowing:TestNarrowing;
  readonly fingerprint:string;readonly observation:{readonly attemptId:string};readonly reason:string;readonly expiresAt:string|null;
  readonly actor:string;readonly authorityGroup:string;readonly identityAssurance:JsonValue;readonly at:string}
export interface TestNarrowingRevocation {readonly revokes:string;readonly phase:string;readonly commandId:string;readonly reason:string;
  readonly actor:string;readonly authorityGroup:string;readonly identityAssurance:JsonValue;readonly at:string}
export type TestNarrowingRow=TestNarrowingRecord|TestNarrowingRevocation;
export interface TestNarrowingWorkflow {testNarrowings?:TestNarrowingRow[];readonly testRecovery?:JsonValue;
  readonly resolution?:{readonly testRecovery?:{readonly enabled?:boolean;readonly enabledRiskCategories?:readonly string[]}}}
export interface NarrowingHumanValues {readonly reason:string;readonly actor:string;readonly authorityGroup:string;readonly identityAssurance?:JsonValue;readonly at:string}
export interface TestNarrowingValues {
  observedNarrowing(facts:TestNarrowingFacts|null,tests?:{readonly discovered?:unknown;readonly skipped?:unknown}|null):TestNarrowing;
  skippedByAgreement(workflow:TestNarrowingWorkflow):boolean;
  narrowingReasons(value:TestNarrowing|null,options?:{readonly skippedAccepted?:boolean}):readonly string[];
  narrowingFingerprint(value:TestNarrowing|null):string;
  narrowingCovers(accepted:TestNarrowing|null,observed:TestNarrowing|null,options?:{readonly skippedAccepted?:boolean}):boolean;
  testNarrowingIneligibility(attempt:TestNarrowingAttempt|null):string|null;
  recordTestNarrowing(workflow:TestNarrowingWorkflow,input:NarrowingHumanValues&{readonly phaseId:string;
    readonly attempt:TestNarrowingAttempt&{readonly attemptId:string;readonly commandId:string;readonly pin:{readonly sha256:string};readonly narrowing:TestNarrowing};
    readonly expires?:string|null}):TestNarrowingRecord;
  recordTestNarrowingRevocation(workflow:TestNarrowingWorkflow,input:NarrowingHumanValues&{readonly narrowingId:string},
    observations:{readonly records:readonly TestNarrowingRow[];readonly revocations?:readonly TestNarrowingRow[]}):TestNarrowingRevocation;
  testNarrowingState(records:readonly TestNarrowingRow[],decision:TestNarrowingRecord,options:{readonly at:string|number}):'active'|'revoked'|'expired';
  testNarrowingBinding(decision:TestNarrowingRecord):{readonly id:string;readonly sha256:string};
}
/** Pure values do not authenticate human observations, collect test files, select a baseline or execute tests. */
export declare function testNarrowingPolicies(digests:SpecificationDigests):Readonly<TestNarrowingValues>;

export interface ObservedCohortCase {readonly id:string;readonly file:string;readonly name:string;readonly suite:readonly string[];
  readonly outcome:'passed'|'failed'|'skipped'|'not-run'}
export interface ObservedCohortCommand {readonly repositoryId:string;readonly commandId:string;readonly pinSha256:string;readonly cases:readonly ObservedCohortCase[]}
export interface ObservedCohortSelection {readonly repositoryId:string;readonly commandId:string;readonly pinSha256:string;
  readonly baselineIds:readonly string[];readonly selectedIds:readonly string[];readonly excludedIds:readonly string[];readonly newIds:readonly string[]}
export interface CohortPermission {readonly id?:string;readonly revokes?:string;readonly expiresAt?:string|null}
export interface NamespaceTestCohortValues {
  hash(value:JsonValue):string;
  cases(tests:{readonly discovered:number}|null,occurrences:readonly {readonly file:string;readonly name:string;readonly ancestorTitles:readonly string[];
    readonly framework?:string|null;readonly outcome:ObservedCohortCase['outcome']}[]|null):readonly ObservedCohortCase[];
  compare(baseline:readonly ObservedCohortCommand[],current:readonly ObservedCohortCommand[]):readonly ObservedCohortSelection[];
  state(rows:readonly CohortPermission[],record:CohortPermission,at:string):'active'|'revoked'|'expired';
  confirm(workflow:Readonly<Record<string,JsonValue>>,request:{readonly phaseId:string;readonly expectedContext?:string;readonly revoke?:string|null;
    readonly reason:string;readonly expires?:string|null},facts:{readonly actorId:string;readonly agentId:string|null;readonly at:string;readonly authorityGroup:string},
    source:{readonly context:{readonly sha256:string;readonly value:{readonly generation:number;readonly baseline:JsonValue;readonly selection:readonly ObservedCohortSelection[]}}}):
    {readonly workflow:Readonly<Record<string,JsonValue>>;readonly outcome:{readonly currentPhase:string|null;readonly record:Readonly<Record<string,JsonValue>>}};
}
/** Observed report identities describe scope; they neither authenticate people nor invent execution. */
export declare function namespaceTestCohortPolicies(digests:SpecificationDigests):Readonly<NamespaceTestCohortValues>;
export interface CodeEnvironmentRiskMatch {readonly witness:{readonly identity:JsonValue;readonly gaps?:readonly JsonValue[];readonly commandId:string;
  readonly enforceAssertionAdequacy?:boolean;readonly assertions?:{readonly adequacy:string}};
  readonly result:{readonly status:string;readonly outcome:string;readonly shortfall?:JsonValue}}
export declare function namespaceCodeEnvironmentRiskCoverage(matches:readonly CodeEnvironmentRiskMatch[],repositoryId:string,report:{readonly profile:string;
  readonly observations:readonly {readonly repositoryId:string;readonly commandId:string;readonly decision:{readonly record:{readonly id:string}}|null;
    readonly cause?:{readonly category:string}}[]}|null,options?:{readonly enforceAssertionAdequacy?:boolean}):
  {readonly profile:'sflow-namespace-code-execution-exception/v1';readonly decisions:readonly string[];readonly testsPassed:false}|null;
export interface NamespaceKnownTestRecoveryValues {
  hash(value:JsonValue):string;
  testInputCases(occurrences:readonly {readonly file:string;readonly name:string;readonly ancestorTitles?:readonly string[];readonly line?:number|null}[]):
    {readonly count:number;readonly sha256:string;readonly names:readonly string[]};
  observed(facts:Readonly<Record<string,JsonValue>>):Readonly<Record<string,JsonValue>>;
  project(facts:Readonly<Record<string,JsonValue>>):{readonly policy:JsonValue;readonly agreement:TrpRecord;readonly baseline:TrpRecord;readonly selection:TrpRecord;readonly observation:TrpRecord};
  risk(projection:ReturnType<NamespaceKnownTestRecoveryValues['project']>,record:Readonly<Record<string,JsonValue>>,
    authority:{readonly principal:string;readonly authorizationRef:string}):TrpRecord;
  eligible(projection:ReturnType<NamespaceKnownTestRecoveryValues['project']>):boolean;
  comparison(projection:ReturnType<NamespaceKnownTestRecoveryValues['project']>):Readonly<Record<string,JsonValue>>;
  state(rows:readonly Readonly<Record<string,JsonValue>>[],record:Readonly<Record<string,JsonValue>>,at:string):'active'|'revoked'|'expired';
  confirm(workflow:Readonly<Record<string,JsonValue>>,request:Readonly<Record<string,JsonValue>>,facts:Readonly<Record<string,JsonValue>>,
    source:Readonly<Record<string,JsonValue>>):{readonly workflow:Readonly<Record<string,JsonValue>>;readonly outcome:Readonly<Record<string,JsonValue>>};
}
/** These values compare inventories only; original execution and human receipts remain mandatory. */
export declare function namespaceKnownTestRecoveryPolicies(digests:SpecificationDigests):Readonly<NamespaceKnownTestRecoveryValues>;

export interface SelectiveTestFileSet {readonly repositoryId:string;readonly commandId:string;readonly files:readonly string[]}
export interface NamespaceSelectiveTestRecoveryValues {
  hash(value:JsonValue):string;
  selection(value:readonly SelectiveTestFileSet[]):readonly SelectiveTestFileSet[];
  narrow(command:JsonValue,declaration:JsonValue,files:readonly string[],options?:{readonly requiredFiles?:readonly string[]}):{
    readonly repositoryMode:'reviewed-file-selection';readonly argv:readonly string[];readonly files:readonly string[];
    readonly selectedIds:readonly string[];readonly excludedIds:readonly string[];readonly inventoryIds:readonly string[];
    readonly effectiveMinimums:{readonly minimumDiscovered:number;readonly minimumPassed:number};readonly impactComplete:false;readonly failuresWaived:false};
  state(rows:readonly Readonly<Record<string,JsonValue>>[],record:Readonly<Record<string,JsonValue>>,at:string):'active'|'revoked'|'expired';
  confirm(workflow:Readonly<Record<string,JsonValue>>,request:Readonly<Record<string,JsonValue>>,facts:Readonly<Record<string,JsonValue>>,
    source:Readonly<Record<string,JsonValue>>):{readonly workflow:Readonly<Record<string,JsonValue>>;readonly outcome:Readonly<Record<string,JsonValue>>};
}
/** Selection values never claim dependency-complete impact analysis or authenticate a reviewer. */
export declare function namespaceSelectiveTestRecoveryPolicies(digests:SpecificationDigests):Readonly<NamespaceSelectiveTestRecoveryValues>;
