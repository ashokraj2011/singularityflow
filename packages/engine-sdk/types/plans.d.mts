import type {JsonValue} from './namespace.mjs';
import type {ContentReference} from './content.mjs';
import type {SpecificationDigests,VerificationPathSyntax} from './specifications.mjs';
export type PlanCorrectionOperation = {readonly clauseId:string}&(
  | {readonly op:'add-row';readonly expectedPaths?:readonly string[];readonly tests?:readonly string[];readonly fulfillment?:string;
      readonly steps?:readonly string[];readonly observableResult?:string}
  | {readonly op:'set-fulfillment';readonly fulfillment:string}
  | {readonly op:'add-test'|'remove-test';readonly test:string}
  | {readonly op:'replace-test'|'replace-location';readonly from:string;readonly to:string}
  | {readonly op:'remove-location';readonly path:string});
export type NamespacePlanCorrectionOperation = PlanCorrectionOperation | {readonly op:'reclassify-evidence';readonly clauseId:string;
  readonly path:string;readonly method:'visual'|'inspection';readonly content:ContentReference};
export interface PlanCorrectionValues {
  planCorrectionAuthorities(workflow:unknown,ownerPhase:string):string[];
  evidenceOwnerAuthorities(workflow:unknown,ownerPhase:string):string[];
  evidenceCorrectionProjection(clauseId:string,claim:Readonly<Record<string,JsonValue>>,path:string,method:'visual'|'inspection'):Readonly<Record<string,JsonValue>>;
  previewPlanRowCorrection(workflow:unknown,input:PlanCorrectionDraftInput):Readonly<Record<string,JsonValue>>;
  previewNamespacePlanCorrection(workflow:unknown,input:NamespacePlanCorrectionDraftInput):Readonly<Record<string,JsonValue>>;
  recordNamespacePlanCorrection(workflow:unknown,input:NamespacePlanCorrectionDraftInput&{readonly expectedPreview:string;readonly actor:string;readonly authorityGroup:string;readonly at:string}):Readonly<Record<string,JsonValue>>;
  applyNamespacePlanCorrections(record:unknown,workflow:unknown,observed:readonly JsonValue[],options:{readonly originalMapSha256:string}):unknown;
  namespaceCorrectionRequirements(workflow:unknown,preview:unknown):{readonly status:'owner-required'|'requires-human-review';readonly requiredOwners:readonly string[];readonly affectedPhases:readonly string[]};
  recordPlanRowCorrection(workflow:unknown,input:{readonly ownerRecord:unknown;readonly ownerMapSha256:string;readonly operations?:readonly PlanCorrectionOperation[];
    readonly activeClauseIds?:readonly string[];readonly normalizeRow:(clauseId:string,raw:Readonly<Record<string,JsonValue>>)=>Readonly<Record<string,JsonValue>>;
    readonly validate?:(plan:unknown)=>void;readonly reason:string;readonly actor:string;readonly authorityGroup:string;readonly identityAssurance?:string|null;
    readonly authorizationId:string;readonly at:string;readonly upstreamIssue?:string|null}):Readonly<Record<string,JsonValue>>;
  applyPlanCorrections(record:unknown,workflow:unknown,options?:{readonly evidenceRoot?:string},observed?:readonly JsonValue[]):unknown;
  applyPlanEvidenceAmendments(record:unknown,workflow:unknown,options?:{readonly evidenceRoot?:string},observed?:readonly JsonValue[]):unknown;
  planRowCorrections(workflow:unknown,ownerPhase?:string|null,observed?:readonly JsonValue[]):JsonValue[];
}
export interface PlanCorrectionDraftInput {readonly ownerRecord:unknown;readonly ownerMapSha256:string;readonly operations?:readonly PlanCorrectionOperation[];
  readonly activeClauseIds?:readonly string[];readonly normalizeRow:(clauseId:string,raw:Readonly<Record<string,JsonValue>>)=>Readonly<Record<string,JsonValue>>;
  readonly validate?:(plan:unknown)=>void;readonly reason:string;readonly upstreamIssue?:string|null}
export type NamespacePlanCorrectionDraftInput = Omit<PlanCorrectionDraftInput,'operations'> & {readonly operations?:readonly NamespacePlanCorrectionOperation[];
  readonly namespaceEvidence?:{readonly root:string;readonly phaseId:string;readonly generation:number;readonly protectedPaths?:readonly string[]}};
/** Callers admit exact approved rows and human records; these values grant no authority. */
export declare function planCorrectionPolicies(paths:VerificationPathSyntax,digests:SpecificationDigests):Readonly<PlanCorrectionValues>;
export declare function planCorrectionRecordShapes():Readonly<Record<string,JsonValue>>;
