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
/** Lifecycle status only; an active result does not establish current source, execution or human acceptance. */
export declare function namespaceEvidenceReuseState(workflow:Readonly<Record<string,unknown>>,decision:NamespaceReusedExecution,
  options:{readonly at:string}):'active'|'revoked'|'expired'|'superseded';
