import type {ContentStore} from '../content.mjs';
import type {ExecutionUnit,ExecutionUnitManifest,AgentTaskContract,ExecutionDigest} from '../execution.mjs';
import type {SourceLimits} from '../source.mjs';
export declare const NODE_CHECK_EXECUTION_PROFILE:'sflow-local-check-execution/v1';
export interface NodeCheckExecutionOptions {
  readonly id:string;readonly version?:string;readonly projectId:string;readonly repositoryId:string;readonly root:string;
  readonly command:{readonly executable:string;readonly executableSha256:ExecutionDigest;
    readonly arguments:readonly string[];readonly environment?:Readonly<Record<string,string>>};
  /** Empty files selects stdout. Paths are relative to the explicitly selected checkout. */
  readonly report:{readonly adapter:string;readonly files:readonly string[]};
  readonly source?:{readonly excludePaths?:readonly string[];readonly limits?:Partial<SourceLimits>};
  readonly timeoutMs?:number;readonly content:ContentStore;
  readonly authorizeCommand:(manifest:ExecutionUnitManifest,contract:AgentTaskContract)=>boolean|ExecutionDigest|Promise<boolean|ExecutionDigest>;
}
/** Retains observations only. A result cannot certify a phase or replace its approval policy. */
export declare function createNodeCheckExecutionUnit(options:NodeCheckExecutionOptions):Promise<ExecutionUnit>;
