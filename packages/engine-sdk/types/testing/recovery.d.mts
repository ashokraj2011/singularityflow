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
  evaluateTestRecoveryGate(input:TrpGateInput):TrpRecord;
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
