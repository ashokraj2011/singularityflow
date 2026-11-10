import type {JsonValue} from './namespace.mjs';
import type {SpecificationDigests,VerificationPathSyntax} from './specifications.mjs';
export interface PlanCorrectionOperation {readonly op:'add-row'|'set-fulfillment'|'add-test'|'remove-test'|'replace-test'|'remove-location'|'replace-location';
  readonly clauseId:string;readonly expectedPaths?:readonly string[];readonly tests?:readonly string[];readonly fulfillment?:string;
  readonly steps?:readonly string[];readonly observableResult?:string;readonly test?:string;readonly path?:string;readonly from?:string;readonly to?:string}
export interface PlanCorrectionValues {
  planCorrectionAuthorities(workflow:unknown,ownerPhase:string):string[];
  evidenceOwnerAuthorities(workflow:unknown,ownerPhase:string):string[];
  evidenceCorrectionProjection(clauseId:string,claim:Readonly<Record<string,JsonValue>>,path:string,method:'visual'|'inspection'):Readonly<Record<string,JsonValue>>;
  recordPlanRowCorrection(workflow:unknown,input:{readonly ownerRecord:unknown;readonly ownerMapSha256:string;readonly operations?:readonly PlanCorrectionOperation[];
    readonly activeClauseIds?:readonly string[];readonly normalizeRow:(clauseId:string,raw:Readonly<Record<string,JsonValue>>)=>Readonly<Record<string,JsonValue>>;
    readonly validate?:(plan:unknown)=>void;readonly reason:string;readonly actor:string;readonly authorityGroup:string;readonly identityAssurance?:string|null;
    readonly authorizationId:string;readonly at:string;readonly upstreamIssue?:string|null}):Readonly<Record<string,JsonValue>>;
  applyPlanCorrections(record:unknown,workflow:unknown,options?:{readonly evidenceRoot?:string},observed?:readonly JsonValue[]):unknown;
  applyPlanEvidenceAmendments(record:unknown,workflow:unknown,options?:{readonly evidenceRoot?:string},observed?:readonly JsonValue[]):unknown;
  planRowCorrections(workflow:unknown,ownerPhase?:string|null,observed?:readonly JsonValue[]):JsonValue[];
}
/** Callers admit exact approved rows and human records; these values grant no authority. */
export declare function planCorrectionPolicies(paths:VerificationPathSyntax,digests:SpecificationDigests):Readonly<PlanCorrectionValues>;
export declare function planCorrectionRecordShapes():Readonly<Record<string,JsonValue>>;
