import type {ExecutionUnit,ExecutionUnitManifest,AgentTaskContract} from '../execution.mjs';
import type {NamespaceScope} from '../namespace.mjs';
import type {ContentStore} from '../content.mjs';
import type {DatasetSnapshot} from '../work-products.mjs';
export declare const SQLITE_DATA_DRIVER_SHA256:`sha256:${string}`;
export interface SqlDataTask {readonly profile:'sflow-sql-data-task/v1';readonly kind:'query'|'batch';readonly query:string;
  readonly datasets:readonly {readonly table:string;readonly data:DatasetSnapshot}[];readonly batchId:string|null;readonly requestSha256:string}
export declare function sqliteDataRequest(options:{readonly kind?:'query'|'batch';readonly query:string;
  readonly datasets:readonly {readonly table:string;readonly data:DatasetSnapshot}[];readonly batchId?:string|null}):SqlDataTask;
/** The concrete runtime needs Node's SQLite authorizer; use an explicitly qualified Node runtime. */
export declare function createSqliteDataExecutionUnit(options:{readonly manifest:ExecutionUnitManifest;readonly executable:string;readonly executableSha256:string;
  readonly authorize:(request:{readonly contract:AgentTaskContract;readonly task:SqlDataTask;readonly stage:'start'|'dispatch'|'reconcile'})=>boolean|Promise<boolean>;
  readonly content:ContentStore;readonly scope:NamespaceScope;readonly timeoutMs?:number;
  readonly sink?:{readonly filename:string;readonly projectId:string;readonly id:string}|null}):ExecutionUnit & {inspectBatch(options:{readonly contract:AgentTaskContract;readonly signal?:AbortSignal|null}):Promise<Readonly<{readonly schemaVersion:1;readonly profile:'sflow-sql-data-sink-observation/v1';readonly projectId:string;readonly executionUnitManifestSha256:string;readonly contractSha256:string;readonly batchId:string;readonly requestSha256:string;readonly sinkId:string;readonly status:'absent'|'committed';readonly observedAt:string;readonly outputSha256?:string;readonly originalContractSha256?:string}>>};
