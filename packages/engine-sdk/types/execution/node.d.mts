import type {ExecutionUnitManifestInput,ExecutionUnitManifest,AgentTaskInput,AgentTaskContract,ExecutionUnit,ExecutionDigest} from '../execution.mjs';
export declare function createExecutionUnitManifest(input:ExecutionUnitManifestInput):ExecutionUnitManifest;
export declare function validateExecutionUnitManifest(value:unknown):ExecutionUnitManifest;
export declare function createAgentTaskContract(input:AgentTaskInput):AgentTaskContract;
export declare function validateAgentTaskContract(value:unknown,manifest?:ExecutionUnitManifest|null):AgentTaskContract;
export declare function createDeterministicTranslatorExecutionUnit():ExecutionUnit;
/** Registry authorization and sandbox attestation are supplied by the trusted embedding host. */
export declare function createGenericProcessExecutionUnit(manifest:ExecutionUnitManifest,options:{readonly root:string;
  readonly authorizeManifest:(manifest:ExecutionUnitManifest)=>boolean|ExecutionDigest|Promise<boolean|ExecutionDigest>}):ExecutionUnit;
