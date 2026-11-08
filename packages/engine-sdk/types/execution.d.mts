import type {JsonValue} from './namespace.mjs';
export type ExecutionDigest=`sha256:${string}`;
export type ExecutionObject={readonly [name:string]:JsonValue};
export interface ExecutionUnitManifestInput {
  readonly id:string;readonly version:string;readonly publisher:string;readonly provider:string;readonly models:readonly string[];
  readonly capabilities:ExecutionObject;readonly sandbox:ExecutionObject;readonly network:ExecutionObject;
  readonly toolPolicy:ExecutionObject;readonly risk:ExecutionObject;
  readonly tests:ExecutionObject&{readonly conformanceReceiptSha256:ExecutionDigest};
  readonly command?:{readonly executable:string;readonly executableSha256:ExecutionDigest;
    readonly arguments:readonly string[];readonly environmentAllowlist:readonly string[]};
}
export interface ExecutionUnitManifest extends ExecutionUnitManifestInput {
  readonly schemaVersion:1;readonly kind:'execution-unit-manifest';readonly manifestSha256:ExecutionDigest;
}
export interface AgentTaskInput {
  readonly taskId:string;readonly processId:string;readonly instructionId:string;readonly objective:string;
  readonly acceptanceClauses:readonly string[];readonly policySnapshotSha256:ExecutionDigest;readonly programSha256:ExecutionDigest;
  readonly inputs:readonly string[];readonly readScope:readonly string[];readonly writeScope:readonly string[];
  readonly forbiddenScope:readonly string[];readonly allowedDevices:readonly string[];
  readonly environmentManifestSha256:ExecutionDigest;readonly candidatePolicy:'immutable-snapshot';
  readonly outputSchema:ExecutionObject;readonly requiredEvidence:readonly string[];
  readonly budgets:{readonly activeMinutes:number;readonly modelInvocations:number;readonly touchedResources:number};
  readonly stopConditions:readonly string[];readonly humanRequestPolicy?:ExecutionObject|null;
  readonly subagentPolicy?:ExecutionObject|null;readonly rawEvidencePolicy?:ExecutionObject|null;
  readonly workingSet?:ExecutionObject|null;readonly executionUnitManifestSha256:ExecutionDigest;
}
export interface AgentTaskContract extends AgentTaskInput {
  readonly schemaVersion:1;readonly kind:'agent-task-contract';readonly contractSha256:ExecutionDigest;
}
export interface ExecutionHandle {readonly schemaVersion:1;readonly kind:'execution-handle';readonly handleSha256:ExecutionDigest;
  readonly executionUnitManifestSha256:ExecutionDigest;readonly contractSha256:ExecutionDigest;readonly adapterHandle:ExecutionObject}
export interface ExecutionEvent {readonly schemaVersion:1;readonly kind:'execution-event';readonly eventSha256:ExecutionDigest;
  readonly handleSha256:ExecutionDigest;readonly sequence:number;readonly priorEventSha256:ExecutionDigest|null;
  readonly type:string;readonly data:ExecutionObject;readonly recordedAt:string}
export interface ExecutionAttestation {readonly schemaVersion:1;readonly kind:'execution-unit-attestation';readonly attestationSha256:ExecutionDigest;
  readonly executionUnitManifestSha256:ExecutionDigest;readonly status:'ready'|'unavailable';readonly capabilities:ExecutionObject;
  readonly observedAt:string;readonly diagnosticCode:string|null}
export interface ExecutionStopReceipt {readonly schemaVersion:1;readonly kind:'stop-receipt';readonly stopReceiptSha256:ExecutionDigest;
  readonly handleSha256:ExecutionDigest;readonly reasonSha256:ExecutionDigest;readonly acknowledged:boolean;readonly requestedAt:string}
export interface ExecutionQuiescenceReceipt {readonly schemaVersion:1;readonly kind:'quiescence-receipt';readonly quiescenceReceiptSha256:ExecutionDigest;
  readonly handleSha256:ExecutionDigest;readonly quiescent:true;readonly eventHeadSha256:ExecutionDigest|null;readonly observedAt:string}
export interface ExecutionCandidate {readonly kind:'candidate-result';readonly executionUnitManifestSha256:ExecutionDigest;
  readonly contractSha256:ExecutionDigest;readonly output:JsonValue;readonly outputSha256:ExecutionDigest;
  readonly candidate:JsonValue;readonly usage:JsonValue;readonly eventHeadSha256:ExecutionDigest|null}
export interface ExecutionUnit {
  descriptor():ExecutionUnitManifest;doctor(context?:ExecutionObject):Promise<ExecutionAttestation>;
  planCapability(request:{readonly requiredCapabilities?:readonly string[]}):Promise<{readonly capable:boolean;readonly unavailable:readonly string[]}>;
  start(contract:AgentTaskContract):Promise<ExecutionHandle>;observe(handle:ExecutionHandle,cursor?:number):AsyncIterable<ExecutionEvent>;
  requestStop(handle:ExecutionHandle,request?:{readonly reason?:string}):Promise<ExecutionStopReceipt>;
  quiesce(handle:ExecutionHandle):Promise<ExecutionQuiescenceReceipt>;collect(handle:ExecutionHandle):Promise<ExecutionCandidate>;
}
export declare const EXECUTION_UNIT_CONTRACT:'sflow-execution-unit/v1';
export declare const EXECUTION_UNIT_METHODS:readonly (keyof ExecutionUnit)[];
export declare function captureExecutionUnit(unit:ExecutionUnit):Readonly<ExecutionUnit>;
