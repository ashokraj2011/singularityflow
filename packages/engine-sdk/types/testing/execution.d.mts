import type {ContentStore} from '../content.mjs';
import type {ExecutionUnit,ExecutionUnitManifest,AgentTaskContract,ExecutionDigest} from '../execution.mjs';
import type {SourceLimits} from '../source.mjs';
export declare const NODE_CHECK_EXECUTION_PROFILE:'sflow-local-check-execution/v1';
export declare const NODE_QUALIFIED_CHECK_EXECUTION_PROFILE:'sflow-local-check-execution/v2';
export declare const NODE_COMMAND_EXECUTION_PROFILE:'sflow-local-command-execution/v1';
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
/** Captures real executor platform, architecture, runtime, environment and report root. */
export declare function createEnvironmentQualifiedNodeCheckExecutionUnit(options:NodeCheckExecutionOptions&{readonly hostId:string}):Promise<ExecutionUnit>;
export interface NodeCommandExecutionOptions extends Omit<NodeCheckExecutionOptions,'report'> {
  readonly commandKind:'compile'|'lint'|'format'|'static-analysis'|'security'|'other';
}
/** Separate non-test observations cannot satisfy an executable-test obligation. */
export declare function createNodeCommandExecutionUnit(options:NodeCommandExecutionOptions):Promise<ExecutionUnit>;
