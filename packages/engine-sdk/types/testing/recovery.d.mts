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
