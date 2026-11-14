import type {ContentReference} from '../content.mjs';
import type {JsonValue} from '../namespace.mjs';
export declare const MAX_EVIDENCE_REUSE_DAYS:90;
export declare const NAMESPACE_EVIDENCE_REUSE_PROFILE:'sflow-namespace-evidence-reuse/v1';
export declare function evidenceReuseReason(value:unknown,options?:{readonly revoking?:boolean}):string;
/** Explicit time; this helper does not consult the host clock. */
export declare function evidenceReuseExpiry(expires:string|null,at:string):string|null;
export interface NamespaceReusedExecution {
  readonly schemaVersion:1;readonly profile:typeof NAMESPACE_EVIDENCE_REUSE_PROFILE;readonly id:string;readonly phase:string;
  readonly producer:{readonly phase:string;readonly generation:number;readonly taskId:string;readonly repositoryId:string;
    readonly command:JsonValue;readonly tests:JsonValue;readonly completedAt:string;readonly executionSha256:string;
    readonly publication:JsonValue;readonly submission:JsonValue;readonly checks:JsonValue};
  readonly observations:readonly {readonly id:string;readonly descriptor:JsonValue;readonly content:ContentReference;readonly inventorySha256:string}[];
  readonly reason:string;readonly expiresAt:string|null;readonly actor:string;readonly authorityGroup:string;readonly at:string;
}
export interface NamespaceQualifiedReusedExecution extends Omit<NamespaceReusedExecution,'schemaVersion'|'profile'> {
  readonly schemaVersion:2;readonly profile:'sflow-namespace-evidence-reuse/v2';
  readonly environments:readonly {readonly repositoryId:string;readonly commandId:string;
    readonly inventorySha256:string;readonly identity:ReuseEnvironmentIdentity}[];
}
/** Actual full producer execution, with separate human permission; no receiving execution is claimed. */
export interface NamespaceCodeReusedExecution extends Omit<NamespaceQualifiedReusedExecution,'schemaVersion'|'profile'> {
  readonly schemaVersion:3;readonly profile:'sflow-namespace-evidence-reuse/v3';
  readonly producer:NamespaceQualifiedReusedExecution['producer']&{readonly retainedExecution?:true};
  readonly producerRequest:{readonly producerPhaseId:string;readonly producerOperationId:string}|null;
  readonly recovery:{readonly agreement:string;readonly records:readonly ContentReference[]}|null;
}
export interface ReuseEnvironmentIdentity {readonly profile:'sflow-evidence-reuse-environment/v1';readonly hostId:string;
  readonly platform:string;readonly arch:string;readonly runtimeSha256:string;readonly environmentSha256:string;readonly argumentsSha256:string}
/** Equality projection only; this function never establishes that a supplied environment was observed. */
export declare function namespaceReuseEnvironment(qualification:unknown,command:unknown):ReuseEnvironmentIdentity;
/** Explicit receiving-time eligibility only; accepted original permission and source still need authentication. */
export declare function namespaceEvidenceReuseAge(workflow:Readonly<Record<string,unknown>>,phaseId:string,completedAt:string,at:string):{
  readonly observedSeconds:number|null;readonly maximumSeconds:number;readonly eligible:boolean}|null;
/** Lifecycle status only; an active result does not establish current source, execution or human acceptance. */
export declare function namespaceEvidenceReuseState(workflow:Readonly<Record<string,unknown>>,decision:NamespaceReusedExecution|NamespaceQualifiedReusedExecution|NamespaceCodeReusedExecution,
  options:{readonly at:string}):'active'|'revoked'|'expired'|'superseded';
