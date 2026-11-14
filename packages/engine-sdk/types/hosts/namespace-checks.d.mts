import type {Engine} from '../index.mjs';
import type {NamespaceStore} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {ExecutionUnit,ExecutionDigest} from '../execution.mjs';
import type {ExecutionOwner} from '../execution/runtime.mjs';
import type {NamespaceEngineOptions} from './namespace-engine.mjs';
export interface NamespaceCheckBinding {
  readonly phaseId:string;readonly commandId:string;readonly repositoryId:string;
  readonly executable:string;readonly executableSha256:ExecutionDigest;
  readonly environment:Readonly<Record<string,string>>;readonly unit:ExecutionUnit;
}
export interface NamespaceChecksBindings {readonly mode?:never;readonly owner:ExecutionOwner;readonly bindings:readonly NamespaceCheckBinding[];
  /** Opt-in reuse v2: current SGOS runtime/environment/source observation is mandatory. */
  readonly environmentSensitiveReuse?:boolean;
  /** Opt-in v3: exact qualified Code/recovery reuse still needs its genuine human decisions. */
  readonly codeRecoveryReuse?:boolean;
}
export type NamespacePhaseChecksOptions=Omit<NamespaceEngineOptions,'working'>&{
  readonly localRecords?:NamespaceStore|null;readonly localContent?:ContentStore|null;
};
export declare const NAMESPACE_PHASE_CHECK_PROFILE:'sflow-namespace-phase-checks/v1';
export declare function createNamespacePhaseChecksEngine(options:NamespacePhaseChecksOptions):Engine;
