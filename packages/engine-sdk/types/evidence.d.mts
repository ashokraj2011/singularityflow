import type {SpecificationDigests,VerificationPathSyntax,SpecificationTextValues} from './specifications.mjs';
export declare const EVIDENCE_EVALUATION_PROFILE:'sflow-evidence-evaluation/v1';
export interface EvidenceObservationOptions {
  readonly at:string;readonly boundary?:string;readonly mode?:'projection'|'decision';readonly requiredAssurance?:string;
  /** Already admitted records, never a readiness or approval flag. Pure values do not authenticate them. */
  readonly admission?:{readonly reviewApprovals?:Readonly<Record<string,readonly Readonly<Record<string,unknown>>[]>>;
    readonly riskDecisions?:readonly Readonly<Record<string,unknown>>[];readonly applicability?:readonly Readonly<Record<string,unknown>>[]};
}
export interface EvidenceAction {readonly kind:string;readonly operation?:string;readonly inputs?:Readonly<Record<string,unknown>>;
  readonly requiredInputs?:readonly string[];readonly dispositions?:readonly string[];readonly subject?:Readonly<Record<string,unknown>>}
export interface EvidenceRow {readonly id:string;readonly result:string;readonly obligations:readonly Readonly<Record<string,unknown>>[];
  readonly actions:readonly EvidenceAction[];readonly findings:readonly Readonly<Record<string,unknown>>[];readonly [key:string]:unknown}
export interface EvidenceEvaluation {readonly schemaVersion:1;readonly profile:typeof EVIDENCE_EVALUATION_PROFILE;
  readonly workId:string;readonly rows:readonly EvidenceRow[];readonly decision:{readonly gate:'allow'|'allow-with-risk'|'block';readonly boundary:string};
  readonly [key:string]:unknown}
export interface EvidenceEvaluationValues {
  /** Input identity only: this does not read or authenticate any record. */
  evidenceGraph(parts:Readonly<Record<string,unknown>>,options?:{readonly completenessReview?:Readonly<Record<string,unknown>>|null}):Readonly<Record<string,unknown>>;
  evaluateEvidence(graph:Readonly<Record<string,unknown>>,options:EvidenceObservationOptions):EvidenceEvaluation;
  reviewFacet(phase:Readonly<Record<string,unknown>>|null,workflow?:Readonly<Record<string,unknown>>|null,
    approvals?:readonly Readonly<Record<string,unknown>>[]):string;
}
export declare function evidenceEvaluationPolicies(pathSyntax:VerificationPathSyntax,utf8:SpecificationTextValues,digests:SpecificationDigests):Readonly<EvidenceEvaluationValues>;
export declare const reviewFacetValue:EvidenceEvaluationValues['reviewFacet'];
export declare const RESPONSIBILITIES:readonly string[],FACETS:readonly string[],OBLIGATION_STATUSES:readonly string[],ROW_RESULTS:readonly string[],GATE_DECISIONS:readonly string[];
export declare const DEFAULT_REQUIRED_ASSURANCE:'module-observed';
export declare function assuranceAtLeast(actual:string,required:string):boolean;
export declare function weakestAssurance(values:readonly string[]):string;
export declare function obligationId(workId:string,responsibility:string,subject:string,slot?:string|null):string;
export declare function resultCounts(rows:readonly {readonly result:string}[]):Record<string,number>;
export declare function lifecycleWords(workflow:Readonly<Record<string,unknown>>|null):string;
export declare const COMPLETION_LABELS:Readonly<Record<string,string>>;
export declare function completionLabel(value:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>>;
export declare function applicabilityStatusValue(workflow:Readonly<Record<string,unknown>>,endpoint?:Readonly<Record<string,unknown>>|null,
  entries?:readonly Readonly<Record<string,unknown>>[]):Readonly<Record<string,unknown>>[];
export declare function staleClausesOf(revision:Readonly<Record<string,unknown>>,clauses?:readonly Readonly<Record<string,unknown>>[]):Set<string>;
export declare function scopeStaleness(workflow:Readonly<Record<string,unknown>>,clauses?:readonly Readonly<Record<string,unknown>>[]):{
  readonly revisions:readonly Readonly<Record<string,unknown>>[];staleBy(clauseId:string,phaseId:string,generation:number):Readonly<Record<string,unknown>>|null};
/** Risk values consume observations; the caller must authenticate their source and human authority. */
export interface ObligationRiskValues {
  readonly RISK_CATEGORIES:readonly string[];readonly RISK_TRANSITIONS:readonly string[];readonly MAX_RISK_DAYS:number;
  observationDigest(obligation:Readonly<Record<string,unknown>>):string;
  riskEligibility(obligation:Readonly<Record<string,unknown>>|null,options?:{readonly untrusted?:boolean}):{readonly eligible:boolean;readonly reason?:string;readonly message?:string};
  riskAuthorities(workflow:Readonly<Record<string,unknown>>,obligation:Readonly<Record<string,unknown>>):string[];
  recordRiskDecision(workflow:Record<string,unknown>,input:Readonly<Record<string,unknown>>):Record<string,unknown>;
  recordRiskRevocation(workflow:Record<string,unknown>,input:Readonly<Record<string,unknown>>,observed?:readonly Readonly<Record<string,unknown>>[]):Record<string,unknown>;
  riskDecisionState(workflow:Readonly<Record<string,unknown>>,obligation:Readonly<Record<string,unknown>>,options:{readonly at:string;readonly transition?:string},
    observed?:readonly Readonly<Record<string,unknown>>[]):Readonly<Record<string,unknown>>|null;
  acceptedImplementationClauses(workflow:Readonly<Record<string,unknown>>,options:{readonly at:string;readonly transition?:string},
    observed?:readonly Readonly<Record<string,unknown>>[]):Set<string>;
}
export declare function obligationRiskPolicies(digests:SpecificationDigests):Readonly<ObligationRiskValues>;
