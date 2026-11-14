import type {ContentReference} from './content.mjs';
export type WorkProductKind='source-code'|'document'|'report'|'query'|'notebook'|'dataset-snapshot'|'schema'|'pipeline-definition'|'pipeline-output';
export declare const WORK_PRODUCT_POLICY_PROFILE:'sflow-work-product-policy/v1';
export declare const WORK_PRODUCT_REFERENCE_PROFILE:'sflow-work-product-reference/v1';
export declare const DATA_EXECUTION_PROFILE:'sflow-data-execution/v1';
export declare const WORK_PRODUCT_KINDS:readonly WorkProductKind[];
export interface WorkProductReference {
  readonly schemaVersion:1;readonly profile:typeof WORK_PRODUCT_REFERENCE_PROFILE;readonly projectId:string;readonly id:string;readonly kind:WorkProductKind;readonly mimeType:string;
  readonly content:ContentReference;readonly revision:{readonly scheme:'sha256'|'snapshot'|'opaque';readonly value:string};
  readonly observation:{readonly at:string;readonly consistency:'retained-content'|'snapshot'|'live';readonly expiresAt:string|null};
  readonly producer:{readonly operationId:string;readonly adapterId:string};
}
export interface DataCriterion {readonly id:string;readonly description:string;readonly metric:{readonly kind:'rows'|'distinct'|'nulls'|'sum';readonly column:string|null};readonly operator:'eq'|'lte'|'gte';readonly expected:number}
export interface DataCheck {readonly criterionId:string;readonly metric:DataCriterion['metric'];readonly operator:DataCriterion['operator'];readonly expected:number;readonly observed:number|null;
  readonly status:'passed'|'failed'|'unavailable';readonly diagnostic:string|null}
export interface DatasetSnapshot {readonly schemaVersion:1;readonly profile:'sflow-tabular-snapshot/v1';readonly columns:readonly {readonly name:string;readonly type:'text'|'integer'|'number'|'boolean';readonly nullable:boolean}[];
  readonly rows:readonly Readonly<Record<string,string|number|boolean|null>>[]}
export interface WorkProductPolicy {readonly schemaVersion:1;readonly profile:typeof WORK_PRODUCT_POLICY_PROFILE;
  readonly requirements:readonly {readonly id:string;readonly statement:string;readonly criteria:readonly string[]}[];
  readonly assets:readonly {readonly id:string;readonly kind:WorkProductKind;readonly mimeType:string}[];
  readonly phases:readonly {readonly id:string;readonly inputs:readonly string[];readonly outputs:readonly string[];
    readonly execution:null|{readonly adapterId:string;readonly kind:'query'|'batch';readonly query:string;readonly inputs:readonly {readonly assetId:string;readonly table:string}[];readonly output:string};
    readonly criteria:readonly DataCriterion[]}[];
}
export declare function workProductPolicy(value:unknown,options?:{readonly phaseIds?:readonly string[]|null}):WorkProductPolicy;
export declare function workProductReference(value:unknown,options?:{readonly projectId?:string|null}):WorkProductReference;
export declare function datasetSnapshot(value:unknown):DatasetSnapshot;
export declare function evaluateDataCriteria(criteria:readonly DataCriterion[],snapshot:DatasetSnapshot):readonly DataCheck[];
