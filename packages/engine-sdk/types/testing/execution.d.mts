import type {ContentStore} from '../content.mjs';
import type {ExecutionUnit,ExecutionUnitManifest,AgentTaskContract,ExecutionDigest} from '../execution.mjs';
import type {SourceLimits} from '../source.mjs';
export declare const NODE_CHECK_EXECUTION_PROFILE:'sflow-local-check-execution/v1';
export declare const NODE_QUALIFIED_CHECK_EXECUTION_PROFILE:'sflow-local-check-execution/v2';
export declare const NODE_SELECTIVE_CHECK_EXECUTION_PROFILE:'sflow-local-check-execution/v3';
export declare const NODE_SCRIPT_SELECTIVE_CHECK_EXECUTION_PROFILE:'sflow-local-check-execution/v4';
export declare const NODE_COMMAND_EXECUTION_PROFILE:'sflow-local-command-execution/v1';
export declare const NODE_QUALIFIED_COMMAND_EXECUTION_PROFILE:'sflow-local-command-execution/v2';
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
export interface ObservedNodeCheckExecutionUnit extends ExecutionUnit {
  /** Reads the real pinned runtime and checkout; does not start the test process. */
  observeEnvironment(options?:{readonly signal?:AbortSignal|null}):Promise<{
    readonly schemaVersion:1;readonly profile:'sflow-node-check-environment-observation/v1';
    readonly qualification:Readonly<Record<string,unknown>>;readonly command:Readonly<Record<string,unknown>>;
    readonly repository:import('../source.mjs').SourceDescriptor;
    readonly source:{readonly snapshot:import('../source.mjs').SourceSnapshot;readonly revision:string};
  }>;
}
export interface QualifiedNodeCheckExecutionUnit extends ObservedNodeCheckExecutionUnit {
  /** SGOS narrows only complete files from this pinned direct Node JUnit command. This grants no lifecycle permission. */
  selectTestFiles(input:{readonly files:readonly string[];readonly selectionSha256:ExecutionDigest;
    readonly originalArgumentsSha256:ExecutionDigest}):Promise<ObservedNodeCheckExecutionUnit>;
}
export declare function createEnvironmentQualifiedNodeCheckExecutionUnit(options:NodeCheckExecutionOptions&{readonly hostId:string}):Promise<QualifiedNodeCheckExecutionUnit>;
export interface NodeCommandExecutionOptions extends Omit<NodeCheckExecutionOptions,'report'> {
  readonly commandKind:'compile'|'lint'|'format'|'static-analysis'|'security'|'other';
}
/** Separate non-test observations cannot satisfy an executable-test obligation. */
export declare function createNodeCommandExecutionUnit(options:NodeCommandExecutionOptions):Promise<ExecutionUnit>;
export declare function createEnvironmentQualifiedNodeCommandExecutionUnit(options:NodeCommandExecutionOptions&{readonly hostId:string}):Promise<ObservedNodeCheckExecutionUnit>;
export interface TestImpactObservation {
  readonly schemaVersion:1;readonly profile:'sflow-test-impact-observation/v1';
  readonly analyzer:{readonly id:string;readonly version:string;readonly implementationSha256:ExecutionDigest};
  readonly sources:readonly {readonly repositoryId:string;readonly revision:string}[];
  readonly nodes:readonly {readonly repositoryId:string;readonly path:string;readonly sha256:string;
    readonly dependencies:readonly {readonly repositoryId:string;readonly path:string}[]}[];
  readonly unknown:readonly {readonly repositoryId:string;readonly path:string;readonly reason:string}[];
}
export interface TestImpactUnit {readonly descriptor:Readonly<Record<string,unknown>>;
  observe(input:{readonly sources:readonly {readonly repositoryId:string;readonly revision:string}[]},options?:{readonly signal?:AbortSignal|null}):Promise<TestImpactObservation>}
/** Reads exact captured bytes before calling the host's existing language/AST analyzer. */
export declare function createSourceTestImpactUnit(options:{readonly maximumDurationMs?:number;readonly sources:readonly {readonly unit:import('../source.mjs').SourceUnit;
  readonly content:import('../source.mjs').SourceContentReader}[];readonly analyzer:{readonly descriptor:TestImpactObservation['analyzer'];
  analyze(input:{readonly sources:TestImpactObservation['sources'];readonly files:readonly {readonly repositoryId:string;readonly path:string;readonly sha256:string;readonly bytes:Uint8Array}[]},
    options?:{readonly signal?:AbortSignal|null}):Promise<Pick<TestImpactObservation,'nodes'|'unknown'>>|Pick<TestImpactObservation,'nodes'|'unknown'>}}):TestImpactUnit;
